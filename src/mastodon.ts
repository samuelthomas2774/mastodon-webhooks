import createDebug from 'debug';
import EventSource from 'eventsource';
import WebhookManager from './webhooks.js';

const debug = createDebug('mastodon');

export default class MastodonStream {
    events: EventSource;

    constructor(
        readonly webhooks: WebhookManager,
        readonly server_url: string,
        token: string,
        readonly account_host: string,
    ) {
        // const stream_url = new URL('/api/v1/streaming/user', server_url);
        const stream_url = new URL('/api/v1/streaming/public', server_url);
        stream_url.searchParams.append('access_token', token);

        debug('connecting to %s', stream_url.origin + stream_url.pathname);

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

    handleConnected(event: MessageEvent) {
        debug('connected', event);
    }

    handleError(event: MessageEvent) {
        debug('error', event);
    }

    handleMessage(event: MessageEvent) {
        debug('event', event);
    }

    handleStatusMessage(event: MessageEvent) {
        const status: Status = JSON.parse(event.data);
        this.handleStatus(status, event);
    }

    async handleStatus(status: Status, event?: MessageEvent) {
        debug('status from %s @%s', status.account.display_name, status.account.acct, event);

        let did_find_webhook = false;

        for await (const webhook of this.webhooks.getWebhooksForStatus(status, this.account_host)) {
            this.webhooks.executeWebhookForStatus(webhook, status, this);
            did_find_webhook = true;
        }

        if (!did_find_webhook) {
            debug('No webhooks for status %d', status.id);
        }
    }

    handleStatusDeletedMessage(event: MessageEvent) {
        const status_id = event.data;
        this.handleStatusDeleted(status_id, event);
    }

    handleStatusDeleted(status_id: string, event?: MessageEvent) {
        debug('status deleted', status_id, event);
    }

    handleNotificationMessage(event: MessageEvent) {
        const notification: AnyNotification = JSON.parse(event.data);
        this.handleNotification(notification, event);
    }

    handleNotification(notification: AnyNotification, event: MessageEvent) {
        if ('account' in notification) debug('notification from %s', notification.account.acct, event);
        else debug('notification', notification, event);
    }
}

interface Account {
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
    fields: unknown[];
}

interface MediaAttachmentImageMeta {
    width: number;
    height: number;
    size: string;
    aspect: number;
}
interface MediaAttachmentImage {
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
    visibility: 'direct';
    language: string;
    /** Identifier */
    uri: string;
    /** HTML URL */
    url: string;
    replies_count: number;
    reblogs_count: number;
    favourites_count: number;
    edited_at: string | null;
    /** HTML content */
    content: string;
    reblog: unknown | null;
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

interface Notification {
    id: string;
    type: string;
    created_at: string;
}

interface MentionNotification extends Notification {
    // id: string;
    type: 'mention',
    // created_at: string;
    account: Account;
    status: Status;
}

type AnyNotification = Notification |
    MentionNotification;
