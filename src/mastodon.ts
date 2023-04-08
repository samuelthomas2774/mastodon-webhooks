import createDebug from 'debug';
import WebSocket from 'ws';
import EventSource from 'eventsource';
import WebhookManager from './webhooks.js';
import { http_user_agent } from './util.js';
import { AnyNotification, CredentialAccount, InstanceInfo, MastodonStreamWebSocketMessage, MastodonStreamWebSocketMessagePayloadType, Status } from './mastodon-types.js';

const debug = createDebug('mastodon');
const debugWebSocket = createDebug('mastodon:ws');
const debugEventSource = createDebug('mastodon:es');

export default class MastodonApi {
    constructor(
        readonly server_url: string,
        private token: string | undefined,
        readonly account_host: string,
    ) {}

    get authenticated() {
        return !!this.token;
    }

    async fetch(url: URL | string, method = 'GET', body?: string | object) {
        const headers = new Headers({
            'User-Agent': http_user_agent,
        });

        if (this.token) {
            headers.set('Authorization', 'Bearer ' + this.token);
        }

        if (body) {
            headers.set('Content-Type', 'application/json');
            body = JSON.stringify(body);
        }

        url = new URL(url, this.server_url);

        const response = await fetch(url, {
            method,
            headers,
            body,
        });

        if (!response.ok) {
            debug('Non-200 status code from %s %s', method, url.pathname, response);
            throw new Error('Non-200 status code: ' + response.status + ' ' + response.statusText);
        }

        return response.json();
    }

    async getAccount() {
        if (!this.token) {
            throw new Error('verify_credentials requires authentication');
        }

        const account: CredentialAccount = await this.fetch('/api/v1/accounts/verify_credentials');
        return account;
    }

    async *getTimelineStatusesSince(last_status_id: string, timeline = this.token ? 'home' : 'public') {
        let statuses: Status[];

        do {
            statuses = await this.fetch('/api/v1/timelines/' + timeline + '?' + new URLSearchParams({
                min_id: last_status_id,
            }).toString());

            statuses.sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)));

            for (const status of statuses) {
                yield status;
                last_status_id = status.id;
            }
        } while (statuses.length);
    }

    createEventStream(webhooks: WebhookManager, type = this.token ? 'user' : 'public') {
        return new MastodonStreamEventSource(this, webhooks,
            this.server_url, this.token, this.account_host, null, type);
    }

    async createSocketStream(webhooks: WebhookManager, type: readonly string[] = ['user', 'public']) {
        if (!this.token) {
            throw new Error('WebSocket streams require authentication');
        }

        const account = await this.getAccount();
        const instance: InstanceInfo = await this.fetch('/api/v2/instance');

        return new MastodonStreamWebSocket(this, webhooks,
            instance.configuration.urls.streaming,
            this.token, this.account_host, account.id, type);
    }
}

export abstract class MastodonStream {
    last_status_id: string | null = null;

    constructor(
        readonly api: MastodonApi,
        readonly webhooks: WebhookManager,
        server_url: string,
        readonly account_host: string,
        readonly account_id: string | null,
    ) {}

    abstract close(): void;

    async handleStatus(status: Status, event?: MessageEvent | string[], skip_public = false) {
        const mentions_webhooks_user = !!(this.account_id && status.mentions.find(m => m.id === this.account_id));

        debug('status %d from %s @%s', status.id, status.account.display_name, status.account.acct,
            status.visibility, mentions_webhooks_user, event);

        if (status.visibility === 'private' && status.account.locked && !mentions_webhooks_user) {
            debug('Skipping followers-only status that doesn\'t mention webhooks bot user from user that requires follow requests', status.id);
            return;
        }

        if (skip_public && status.visibility === 'public' && this.isStatusDiscoverable(status)) {
            debug('Skipping public status %d from non-public stream, status will also be sent to public stream', status.id);
            return;
        }

        this.last_status_id = status.id;
        let did_find_webhook = false;

        for await (const webhook of this.webhooks.getWebhooksForStatus(status, this.account_host)) {
            this.webhooks.executeWebhookForStatus(webhook, status, this.api);
            did_find_webhook = true;
        }

        if (!did_find_webhook) {
            debug('No webhooks for status %d', status.id);
        }
    }

    /**
     * Returns true if the status should be sent to the public stream
     */
    isStatusDiscoverable(status: Status) {
        // Statuses are sent to the public (timeline:public) stream in broadcast_to_public_streams
        // if broadcastable is true, broadcast_to_public_streams also checks if the status is a reply:
        // https://github.com/mastodon/mastodon/blob/main/app/services/fan_out_on_write_service.rb

        // broadcastable
        if (status.visibility !== 'public') return false;
        if (status.reblog) return false;

        // broadcast_to_public_streams
        if (status.in_reply_to_id && status.in_reply_to_account_id !== status.account.id) return false;

        return true;
    }

    handleStatusDeleted(status_id: string, event?: MessageEvent | string[]) {
        debug('status deleted', status_id, event);
    }

    handleNotification(notification: AnyNotification, event?: MessageEvent | string[]) {
        if ('account' in notification) debug('notification from %s', notification.account.acct, event);
        else debug('notification', notification, event);
    }

    handleStatusUpdated(status: Status, event?: MessageEvent | string[], skip_public = false) {
        const mentions_webhooks_user = !!(this.account_id && status.mentions.find(m => m.id === this.account_id));

        debug('status %d from %s @%s updated', status.id, status.account.display_name, status.account.acct,
            status.visibility, mentions_webhooks_user, event);

        if (status.visibility === 'private' && status.account.locked && !mentions_webhooks_user) {
            debug('Skipping followers-only status that doesn\'t mention webhooks bot user from user that requires follow requests', status.id);
            return;
        }

        if (skip_public && status.visibility === 'public' && this.isStatusDiscoverable(status)) {
            debug('Skipping public status %d from non-public stream, status will also be sent to public stream', status.id);
            return;
        }

        //
    }
}

class MastodonStreamWebSocket extends MastodonStream {
    protected socket: WebSocket | null;
    private readonly socket_url: string;
    protected _closed = false;

    constructor(
        api: MastodonApi,
        webhooks: WebhookManager,
        server_url: string,
        token: string,
        account_host: string,
        account_id: string | null,
        readonly streams: readonly string[] = ['user', 'public'],
    ) {
        super(api, webhooks, server_url, account_host, account_id);

        const socket_url = new URL('/api/v1/streaming', server_url.replace(/^http(s)?:/, 'ws$1:'));
        socket_url.searchParams.append('access_token', token);

        this.socket_url = socket_url.href;
        this.socket = this.createSocket();
    }

    createSocket() {
        debugWebSocket('WebSocket connecting');

        const ws = new WebSocket(this.socket_url);

        let interval: NodeJS.Timeout | null = null;

        ws.onopen = event => {
            debugWebSocket('WebSocket connected');

            interval = setInterval(() => ws.ping(), 10000);
            this.handleOpen(event);
        };

        ws.onclose = event => {
            debugWebSocket('WebSocket connection closed', event);

            this.socket = null;
            clearInterval(interval!);
            interval = null;
            this.handleClose(event);
        };

        ws.onmessage = event => {
            const data = JSON.parse(event.data.toString());
            debugWebSocket('WebSocket received', data);

            this.handleMessage(event, data);
        };

        return ws;
    }

    close() {
        this._closed = true;
        this.socket?.close();
    }

    handleOpen(event: WebSocket.Event) {
        for (const stream of this.streams) {
            this.socket?.send(JSON.stringify({
                type: 'subscribe',
                stream,
            }));
        }
    }

    handleClose(event: WebSocket.CloseEvent) {
        if (this._closed) return;

        this.socket = this.createSocket();
    }

    handleMessage(event: WebSocket.MessageEvent, data: MastodonStreamWebSocketMessage) {
        if (data.event === 'update') {
            const status = JSON.parse(data.payload) as MastodonStreamWebSocketMessagePayloadType<typeof data>;
            this.handleStatus(status, data.stream, !data.stream.includes('public') && this.streams.includes('public'));
        }
        if (data.event === 'notification') {
            const notification = JSON.parse(data.payload) as MastodonStreamWebSocketMessagePayloadType<typeof data>;
            this.handleNotification(notification, data.stream);
        }
        if (data.event === 'delete') {
            const status_id: string = data.payload;
            this.handleStatusDeleted(status_id, data.stream);
        }
        if (data.event === 'status.update') {
            const status = JSON.parse(data.payload) as MastodonStreamWebSocketMessagePayloadType<typeof data>;
            this.handleStatusUpdated(status, data.stream,
                !data.stream.includes('public') && this.streams.includes('public'));
        }
    }
}

class MastodonStreamEventSource extends MastodonStream {
    events: EventSource;

    constructor(
        api: MastodonApi,
        webhooks: WebhookManager,
        server_url: string,
        token: string | undefined,
        account_host: string,
        account_id: string | null,
        type = 'user',
    ) {
        super(api, webhooks, server_url, account_host, account_id);

        const stream_url = new URL('/api/v1/streaming/' + type, server_url);
        if (token) stream_url.searchParams.append('access_token', token);

        debugEventSource('connecting to %s', stream_url.origin + stream_url.pathname);

        this.events = new EventSource(stream_url.href, {
            headers: {
                'User-Agent': 'mastodon-webhooks/0.0.0',
            },
        });

        this.events.onopen = event => this.handleConnected(event);
        this.events.onerror = event => this.handleError(event);
        this.events.onmessage = event => this.handleMessage(event);

        this.events.addEventListener('update', event => this.handleStatusMessage(event));
        this.events.addEventListener('delete', event => this.handleStatusDeletedMessage(event));
        this.events.addEventListener('notification', event => this.handleNotificationMessage(event));
        this.events.addEventListener('status.update', event => this.handleStatusUpdateMessage(event));
    }

    close() {
        this.events.close();
    }

    handleConnected(event: MessageEvent) {
        debugEventSource('connected', event);
    }

    handleError(event: MessageEvent) {
        debugEventSource('error', event);
    }

    handleMessage(event: MessageEvent) {
        debugEventSource('event', event);
    }

    handleStatusMessage(event: MessageEvent) {
        const status: Status = JSON.parse(event.data);
        this.handleStatus(status, event);
    }

    handleStatusDeletedMessage(event: MessageEvent) {
        const status_id = event.data;
        this.handleStatusDeleted(status_id, event);
    }

    handleNotificationMessage(event: MessageEvent) {
        const notification: AnyNotification = JSON.parse(event.data);
        this.handleNotification(notification, event);
    }

    handleStatusUpdateMessage(event: MessageEvent) {
        const status: Status = JSON.parse(event.data);
        this.handleStatusUpdated(status, event);
    }
}
