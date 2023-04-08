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
    roles: {
        id: string;
        name: string;
        color: string;
    }[];
    fields: {
        name: string;
        /** HTML */
        value: string;
        verified_at: string | null;
    }[];
}

export interface CredentialAccount extends Account {
    source: {
        privacy: Status['visibility'];
        sensitive: boolean;
        language: string;
        note: string;
        fields: Account['fields'];
        follow_requests_count: number;
    };
    role: {
        id: string;
        name: string;
        permissions: string;
        color: string;
        highlighted: boolean;
    };
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
    } | null;
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
    type: 'mention',
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

export interface InstanceInfo {
    domain: string;
    title: string;
    version: string;
    source_url: string;
    description: string;
    usage: {
        users: {
            active_month: number;
        };
    };
    thumbnail: {
        url: string;
    },
    languages: string[];
    configuration: {
        urls: {
            streaming: string;
            status?: string | null;
        },
        accounts: {
            max_featured_tags: number;
        },
        statuses: {
            max_characters: number;
            max_media_attachments: number;
            characters_reserved_per_url: number;
        },
        media_attachments: {
            supported_mime_types: string[];
            image_size_limit: number;
            image_matrix_limit: number;
            video_size_limit: number;
            video_frame_rate_limit: number;
            video_matrix_limit: number;
        },
        polls: {
            max_options: number;
            max_characters_per_option: number;
            min_expiration: number;
            max_expiration: number;
        },
        translation: {
            enabled: boolean;
        };
    };
    registrations: {
        enabled: boolean;
        approval_required: boolean;
        message: string | null;
    };
    contact: {
        email: string;
        account: Account | null;
    };
    rules: unknown[];
}

export const MastodonStreamPayloadTypeSymbol = Symbol();
export type MastodonStreamPayloadTypeSymbol = typeof MastodonStreamPayloadTypeSymbol;

export type MastodonStreamWebSocketMessage =
    MastodonStreamWebSocketMessageUpdate |
    MastodonStreamWebSocketMessageDelete |
    MastodonStreamWebSocketMessageNotification |
    MastodonStreamWebSocketMessageFiltersChanged |
    MastodonStreamWebSocketMessageConversation |
    MastodonStreamWebSocketMessageAnnouncement |
    MastodonStreamWebSocketMessageAnnouncementReaction |
    MastodonStreamWebSocketMessageAnnouncementDelete |
    MastodonStreamWebSocketMessageStatusUpdate |
    MastodonStreamWebSocketMessageEncryptedMessage;

interface MastodonStreamWebSocketMessageUpdate {
    stream: string[];
    event: 'update';
    /** JSON-encoded Status */
    payload: string;
    [MastodonStreamPayloadTypeSymbol]: Status;
}
interface MastodonStreamWebSocketMessageDelete {
    stream: string[];
    event: 'delete';
    /** Status ID */
    payload: string;
}
interface MastodonStreamWebSocketMessageNotification {
    stream: string[];
    event: 'notification';
    /** JSON-encoded Notification */
    payload: string;
    [MastodonStreamPayloadTypeSymbol]: AnyNotification;
}
interface MastodonStreamWebSocketMessageFiltersChanged {
    stream: string[];
    event: 'filters_changed';
}
interface MastodonStreamWebSocketMessageConversation {
    stream: string[];
    event: 'conversation';
    /** JSON-encoded Conversation */
    payload: string;
    [MastodonStreamPayloadTypeSymbol]: unknown;
}
interface MastodonStreamWebSocketMessageAnnouncement {
    stream: string[];
    event: 'announcement';
    /** JSON-encoded Announcement */
    payload: string;
    [MastodonStreamPayloadTypeSymbol]: unknown;
}
interface MastodonStreamWebSocketMessageAnnouncementReaction {
    stream: string[];
    event: 'announcement.reaction';
    /** JSON-encoded data */
    payload: string;
    [MastodonStreamPayloadTypeSymbol]: {
        name: string;
        count: number;
        announcement_id: string;
    };
}
interface MastodonStreamWebSocketMessageAnnouncementDelete {
    stream: string[];
    event: 'announcement.delete';
    /** Announcement ID */
    payload: string;
}
interface MastodonStreamWebSocketMessageStatusUpdate {
    stream: string[];
    event: 'status.update';
    /** JSON-encoded Status */
    payload: string;
    [MastodonStreamPayloadTypeSymbol]: Status;
}
interface MastodonStreamWebSocketMessageEncryptedMessage {
    stream: string[];
    event: 'encrypted_message';
    payload: string;
    [MastodonStreamPayloadTypeSymbol]: unknown;
}
