import path from 'node:path';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import createDebug from 'debug';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import MastodonStream from './mastodon.js';
import WebhookManager from './webhooks.js';

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

    const mastodon = new MastodonStream(webhooks, process.env.MASTODON_URL!, process.env.MASTODON_TOKEN!,
        process.env.MASTODON_ACCT_HOST ?? new URL(process.env.MASTODON_URL!).hostname);

    debug('acct host', mastodon.account_host);

    process.on('SIGINT', () => {
        debug('SIGINT, closing stream');
        mastodon.events.close();
    });

    process.on('SIGTERM', () => {
        debug('SIGTERM, closing stream');
        mastodon.events.close();
    });

    process.on('beforeExit', () => {
        mastodon.events.close();
    });
}
