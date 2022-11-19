import createDebug from 'debug';
import { WebhookCreateMessageOptions } from 'discord.js';
import { APIEmbed } from 'discord-api-types/v9';
import Turndown from 'turndown';
import MastodonApi, { Status } from './mastodon.js';

const debug = createDebug('webhook');
const debugDiscord = createDebug('webhook:discord');

const turndown = new Turndown();

export interface Webhook {
    id: number;
    type: WebhookType;
    url: string;
}
export enum WebhookType {
    MASTODON = 'mastodon',
    DISCORD = 'discord',
}

export async function executeStatusWebhook(webhook: Webhook, status: Status, mastodon: MastodonApi) {
    debug('Posting status %d to %s webhook %d %s', status.id, webhook.type, webhook.id, new URL(webhook.url).origin);

    try {
        await StatusWebhookExecutor.create(webhook.type, mastodon).send(webhook, status);
    } catch (err) {
        debug('Error sending webhook for status %d', status.id, err);
        throw err;
    }
}

class StatusWebhookExecutor {
    static create(type: WebhookType, mastodon: MastodonApi) {
        if (type === WebhookType.MASTODON) return new StatusWebhookExecutor();
        if (type === WebhookType.DISCORD) return new StatusWebhookExecutorDiscord(mastodon);

        throw new Error('Invalid webhook type');
    }

    formatPayload(status: Status): unknown {
        return status;
    }

    async send(webhook: Webhook, status: Status) {
        const payload = this.formatPayload(status);

        await fetch(webhook.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });
    }
}

class StatusWebhookExecutorDiscord extends StatusWebhookExecutor {
    constructor(
        readonly mastodon: MastodonApi
    ) {
        super();
    }

    formatPayload(status: Status) {
        const markdown = turndown.turndown(status.content);

        const image = status.media_attachments.find(a => a.type === 'image');

        const footer_text =
            status.media_attachments.find(a => a.type !== 'image') ?
                status.media_attachments.length + ' attachment' +
                (status.media_attachments.length === 1 ? '' : 's') :
            image && status.media_attachments.length > 1 ?
                '+ ' + (status.media_attachments.length - 1) + ' image' +
                (status.media_attachments.length === 2 ? '' : 's') :
            null;

        const embed: APIEmbed = {
            author: {
                name: status.account.display_name,
                icon_url: status.account.avatar,
                url: status.account.url,
            },
            description: markdown,
            url: status.uri,
            footer: footer_text ? {
                text: footer_text,
            } : undefined,
            timestamp: status.created_at,
            image: image ? {
                url: image.url,
                width: image.meta.original.width,
                height: image.meta.original.height,
            } : undefined,
        };

        const status_acct = status.account.acct.includes('@') ?
            status.account.acct : status.account.acct + '@' + this.mastodon.account_host;

        const message /* : WebhookCreateMessageOptions */ = {
            username: status.account.display_name + ' - @' + status_acct,
            avatar_url: status.account.avatar,

            // content: status.content,
            content: status.url,
            embeds: [embed],
            allowedMentions: {},
        };

        return message;
    }

    async send(webhook: Webhook, status: Status) {
        if (status.media_attachments.find(a => a.type === 'image')) {
            debugDiscord('Waiting 10s before posting status %d to Discord webhook %d', status.id, webhook.id);
            await new Promise(rs => setTimeout(rs, 10000));
        }

        return super.send(webhook, status);
    }
}
