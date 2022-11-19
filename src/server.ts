import path from 'node:path';
import * as fs from 'node:fs/promises';
import * as fs_sync from 'node:fs';
import { fileURLToPath } from 'node:url';
import createDebug from 'debug';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import MastodonApi from './mastodon.js';
import WebhookManager from './webhooks.js';
import DiscordBot from './discord.js';

const debug = createDebug('server');

const data_path = path.join(fileURLToPath(import.meta.url), '..', '..', 'data');

export async function main() {
    debug('path', data_path);

    await fs.mkdir(data_path, {recursive: true});

    const db = await open({
        filename: path.join(data_path, 'database.db'),
        driver: sqlite3.Database,
    });

    await db.migrate({
        migrationsPath: path.join(fileURLToPath(import.meta.url), '..', '..', 'migrations'),
    });

    const webhooks = new WebhookManager(db);

    const mastodon = new MastodonApi(process.env.MASTODON_URL!, process.env.MASTODON_TOKEN!,
        process.env.MASTODON_ACCT_HOST ?? new URL(process.env.MASTODON_URL!).hostname);

    const discord = process.env.DISCORD_TOKEN ? new DiscordBot(db, mastodon, process.env.DISCORD_TOKEN) : null;

    const state = await tryReadJson<{
        last_status_id: string | null;
    }>(path.join(data_path, 'state.json'));

    const updateSavedState = (sync = false) => {
        const data = JSON.stringify({
            last_status_id: stream?.last_status_id ?? state?.last_status_id,
        }, null, 4) + '\n';

        if (sync) fs_sync.writeFileSync(path.join(data_path, 'state.json'), data, 'utf-8');
        else return fs.writeFile(path.join(data_path, 'state.json'), data, 'utf-8');
    };

    process.on('exit', () => {
        updateSavedState(true);
    });

    if (state?.last_status_id) {
        debug('Checking for missed statuses since', state.last_status_id);

        for await (const status of mastodon.getTimelineStatusesSince(state.last_status_id, 'public')) {
            debug('Processing missed status %d from %s @%s',
                status.id, status.account.display_name, status.account.acct);

            state.last_status_id = status.id;

            let did_find_webhook = false;

            for await (const webhook of webhooks.getWebhooksForStatus(status, mastodon.account_host)) {
                webhooks.executeWebhookForStatus(webhook, status, mastodon);
                did_find_webhook = true;
            }

            if (!did_find_webhook) {
                debug('No webhooks for status %d', status.id);
            }
        }
    }

    const stream = mastodon.createEventStream(webhooks, 'public');

    debug('acct host', mastodon.account_host);

    process.on('SIGINT', () => {
        debug('SIGINT, shutting down');
        stream.events.close();
        discord?.client.destroy();
    });

    process.on('SIGTERM', () => {
        debug('SIGTERM, shutting down');
        stream.events.close();
        discord?.client.destroy();
    });

    // Update saved state every minute
    setInterval(() => updateSavedState(), 60000).unref();
}

async function tryReadJson<T>(file: string): Promise<T | null> {
    try {
        return JSON.parse(await fs.readFile(file, 'utf-8'));
    } catch (err) {
        return null;
    }
}
