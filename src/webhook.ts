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

    formatPayload(_status: Status) {
        const embeds: APIEmbed[] = [];

        let content = '';
        let status: Status | null = _status;

        while (status) {
            const markdown = status.spoiler_text ?
                turndown.turndown(status.spoiler_text) + '\n\n' +
                    turndown.turndown(status.content).replace(/^(.+)$/gm, '||$1||') :
                turndown.turndown(status.content);

            const image = status.media_attachments.find(a => a.type === 'image');

            const footer_text =
                status.media_attachments.find(a => a.type !== 'image') ?
                    status.media_attachments.length + ' attachment' +
                    (status.media_attachments.length === 1 ? '' : 's') :
                (status.spoiler_text || status.sensitive) && status.media_attachments.length ?
                    status.media_attachments.length + ' image' +
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
                image: image && !status.spoiler_text && !status.sensitive ? {
                    url: image.url,
                    width: image.meta.original.width,
                    height: image.meta.original.height,
                } : undefined,
            };

            debug('Status %d embed', status.id, embed);

            embeds.push(embed);
            if (status.url) content += '\n' + status.url;
            status = status.reblog;
        }

        status = _status;

        const status_acct = status.account.acct.includes('@') ?
            status.account.acct : status.account.acct + '@' + this.mastodon.account_host;

        let username = status.account.display_name
            .replace(/:[0-9a-z-_]+:/gi, '')
            .replace(/\s+/g, ' ')
            .trim() + ' - @' + status_acct;

        if (username.includes('discord')) {
            username = status_acct.includes('discord') ? '???' : '@' + status_acct;
        }

        const message /* : WebhookCreateMessageOptions */ = {
            username,
            avatar_url: status.account.avatar,

            content,
            embeds,
            allowedMentions: {},
        };

        return message;
    }

    async send(webhook: Webhook, status: Status) {
        if (status.media_attachments.find(a => a.type === 'image')) {
            debugDiscord('Waiting 15s before posting status %d to Discord webhook %d', status.id, webhook.id);
            await new Promise(rs => setTimeout(rs, 15000));
        }

        return super.send(webhook, status);
    }
}
