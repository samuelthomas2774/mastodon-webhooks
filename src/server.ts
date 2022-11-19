import path from 'node:path';
import * as fs from 'node:fs/promises';
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
    const stream = mastodon.createEventStream(webhooks);

    const discord = process.env.DISCORD_TOKEN ? new DiscordBot(db, mastodon, process.env.DISCORD_TOKEN) : null;

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

    process.on('beforeExit', () => {
        stream.events.close();
        discord?.client.destroy();
    });
}
