import createDebug from 'debug';
import sql from 'sql-template-strings';
import { Database } from 'sqlite';
import { Status } from './mastodon-types.js';
import MastodonApi from './mastodon.js';
import { executeStatusWebhook, Webhook, WebhookType } from './webhook.js';

const debug = createDebug('webhooks');

export interface ConfigData {
    webhooks: ConfigWebhook[];
}
export interface ConfigWebhook {
    url: string;
    type?: WebhookType;
    acct?: string | string[];
    host?: string | string[];
}

export default class WebhookManager {
    constructor(
        readonly db: Database,
        readonly config_webhooks?: ConfigData,
    ) {}

    async *getWebhooksForStatus(status: Status, acct_host: string): AsyncGenerator<Webhook> {
        const status_acct = status.account.acct.includes('@') ?
            status.account.acct : status.account.acct + '@' + acct_host;
        const status_acct_host = status.account.acct.includes('@') ?
            status.account.acct.substr(status.account.acct.lastIndexOf('@') + 1) : acct_host;

        for (const webhook of this.config_webhooks?.webhooks ?? []) {
            if (this.checkWebhookMatchesStatus(webhook, status, status_acct, status_acct_host)) {
                yield {
                    id: -1,
                    type: webhook.type ?? WebhookType.MASTODON,
                    url: webhook.url,
                };
            }
        }

        const ids = new Set<number>();

        const matching_ids_acct: {id: number; webhook_id: number}[] =
            await this.db.all(sql`SELECT id,webhook_id FROM webhook_filter_acct WHERE acct = ${status_acct}`);

        for (const {id, webhook_id} of matching_ids_acct) {
            debug('Status %d matched filter %d', status.id, id);
            ids.add(webhook_id);
        }

        const matching_ids_host: {id: number; webhook_id: number}[] =
            await this.db.all(sql`SELECT id,webhook_id FROM webhook_filter_host WHERE host = ${status_acct_host}`);

        for (const {id, webhook_id} of matching_ids_host) {
            debug('Status %d matched filter %d', status.id, id);
            ids.add(webhook_id);
        }

        for (const id of ids) {
            const webhook = await this.db.get<Webhook>(sql`SELECT id,type,url FROM webhooks WHERE id = ${id}`);
            if (webhook) yield webhook;
        }
    }

    protected checkWebhookMatchesStatus(webhook: ConfigWebhook, status: Status, acct: string, host: string) {
        for (const filter_acct of typeof webhook.acct === 'string' ? [webhook.acct] : webhook.acct ?? []) {
            if (filter_acct === acct) return true;
        }

        for (const filter_host of typeof webhook.host === 'string' ? [webhook.host] : webhook.host ?? []) {
            if (filter_host === host) return true;
        }

        return false;
    }

    async executeWebhookForStatus(webhook: Webhook, status: Status, mastodon: MastodonApi) {
        try {
            await executeStatusWebhook(webhook, status, mastodon);

            // TODO: log the successful delivery in the database
        } catch (err) {
            // TODO: log the error in the database and queue another attempt
        }
    }
}
