import createDebug from 'debug';
import WebSocket, { Event } from 'ws';
import EventSource from 'eventsource';
import WebhookManager from './webhooks.js';

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
        const headers = new Headers();

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
        return new MastodonStreamEventSource(this, webhooks, this.server_url, this.token, this.account_host, type);
    }

    createSocketStream(webhooks: WebhookManager, type: readonly string[] = ['user', 'public']) {
        if (!this.token) {
            throw new Error('WebSocket streams require authentication');
        }

        // TODO: fetch streaming URL in case it's a separate host
        return new MastodonStreamWebSocket(this, webhooks, this.server_url, this.token, this.account_host, type);
    }
}

export abstract class MastodonStream {
    last_status_id: string | null = null;

    constructor(
        readonly api: MastodonApi,
        readonly webhooks: WebhookManager,
        readonly server_url: string,
        readonly account_host: string,
    ) {}

    abstract close(): void;

    async handleStatus(status: Status, event?: MessageEvent, skip_public = false) {
        debug('status %d from %s @%s', status.id, status.account.display_name, status.account.acct, event);

        if (skip_public && status.visibility === 'public') {
            debug('Skipping public status %d from non-public stream, status will also be sent to home stream', status.id);
            return;
        }

        // if (this.last_status_id && BigInt(this.last_status_id) >= BigInt(status.id)) {
        //     debug('Skipping handling status %d, already processed this/newer status (did Mastodon send this status twice??)', status.id);
        //     return;
        // }

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

    handleStatusDeleted(status_id: string, event?: MessageEvent) {
        debug('status deleted', status_id, event);
    }

    handleNotification(notification: AnyNotification, event?: MessageEvent) {
        if ('account' in notification) debug('notification from %s', notification.account.acct, event);
        else debug('notification', notification, event);
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
        readonly streams: readonly string[] = ['user', 'public'],
    ) {
        super(api, webhooks, server_url, account_host);

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

            interval = setInterval(() => ws.ping(), 10000)
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
            const status: Status = JSON.parse(data.payload);
            this.handleStatus(status, undefined, !data.stream.includes('public') && this.streams.includes('public'));
        }
        if (data.event === 'notification') {
            const notification: AnyNotification = JSON.parse(data.payload);
            this.handleNotification(notification);
        }
        if (data.event === 'delete') {
            const status_id: string = data.payload;
            this.handleStatusDeleted(status_id);
        }
    }
}

interface MastodonStreamWebSocketMessage {
    stream: string[];
    event: 'update' | 'notification' | 'delete';
    // JSON-encoded data
    payload: string;
}

class MastodonStreamEventSource extends MastodonStream {
    events: EventSource;

    constructor(
        api: MastodonApi,
        webhooks: WebhookManager,
        server_url: string,
        token: string | undefined,
        account_host: string,
        type = 'user',
    ) {
        super(api, webhooks, server_url, account_host);

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
        this.events.addEventListener('notification', event => this.handleNotificationMessage(event));
        this.events.addEventListener('delete', event => this.handleStatusDeletedMessage(event));
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
}

export interface Account {
    id: string;
    username: string;
    acct: string;
    display_name: string;
    locked: boolean;
    bot: boolean;
    discoverable: boolean;
    group: boolean;
    created_at: string;
    note: string;
    url: string;
    avatar: string;
    avatar_static: string;
    header: string;
    header_static: string;
    followers_count: number;
    following_count: number;
    statuses_count: number;
    last_status_at: string;
    noindex: boolean;
    emojis: unknown[];
    fields: {
        name: string;
        /** HTML */
        value: string;
        verified_at: string | null;
    }[];
}

export interface FollowResult {
    id: string;
    following: boolean;
    showing_reblogs: boolean;
    notifying: boolean;
    followed_by: boolean;
    blocking: boolean;
    blocked_by: boolean;
    muting: boolean;
    muting_notifications: boolean;
    requested: boolean;
    domain_blocking: boolean;
    endorsed: boolean;
}

export interface MediaAttachmentImageMeta {
    width: number;
    height: number;
    size: string;
    aspect: number;
}
export interface MediaAttachmentImage {
    id: string;
    type: 'image';
    url: string;
    preview_url: string;
    remote_url: string | null;
    preview_remote_url: string | null;
    text_url: string | null;
    meta: {
        original: MediaAttachmentImageMeta;
        small: MediaAttachmentImageMeta;
    };
    description: string;
    blurhash: string;
}

export interface Status {
    id: string;
    created_at: string;
    in_reply_to_id: string | null;
    in_reply_to_account_id: string | null;
    sensitive: boolean;
    spoiler_text: string;
    /**
     * - public: Visible to everyone, shown in public timelines.
     * - unlisted: Visible to public, but not included in public timelines.
     * - private: Visible to followers only, and to any mentioned users.
     * - direct: Visible only to mentioned users.
     */
    visibility: 'public' | 'unlisted' | 'private' | 'direct';
    language: string | null;
    /** Identifier */
    uri: string;
    /** HTML URL */
    url: string | null;
    replies_count: number;
    reblogs_count: number;
    favourites_count: number;
    edited_at: string | null;
    /** HTML content */
    content: string;
    reblog: Status | null;
    application: {
        name: string;
        website: string | null;
    };
    account: Account;
    media_attachments: MediaAttachmentImage[];
    mentions: {
        id: string;
        username: string;
        url: string;
        acct: string;
    }[];
    tags: unknown[];
    emojis: unknown[];
    card: unknown | null;
    poll: unknown | null;
    favourited: boolean;
    reblogged: boolean;
    muted: boolean;
    bookmarked: boolean;
    filtered: unknown[];
}

export interface Notification {
    id: string;
    type: string;
    created_at: string;
}

export interface MentionNotification extends Notification {
    // id: string;
    type: 'mention',
    // created_at: string;
    account: Account;
    status: Status;
}

export type AnyNotification = Notification |
    MentionNotification;

export interface SearchResults {
    accounts: Account[];
    statuses: Status[];
    hashtags: unknown[];
}
