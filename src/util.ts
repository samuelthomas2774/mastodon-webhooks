import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import createDebug from 'debug';

const debug = createDebug('util');

export const dir = path.resolve(fileURLToPath(import.meta.url), '..', '..');

export const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf-8'));
export const version: string = pkg.version;

export const docker: string | true | null = pkg.__docker ?? await (async () => {
    try {
        await fs.stat('/.dockerenv');
        return true;
    } catch (err) {
        return null;
    }
})();

export const git: {
    revision: string;
    branch: string | null;
    changed_files: string[];
} | null = pkg.__git ?? await (async () => {
    try {
        await fs.stat(path.join(dir, '.git'));
    } catch (err) {
        debug('Unable to find revision');
        return null;
    }

    const child_process = await import('node:child_process');
    const util = await import('node:util');
    const execFile = util.promisify(child_process.execFile);
    const git = (...args: string[]) => execFile('git', args, {cwd: dir}).then(({stdout}) => stdout.toString().trim());

    const [revision, branch, changed_files] = await Promise.all([
        git('rev-parse', 'HEAD'),
        git('rev-parse', '--abbrev-ref', 'HEAD'),
        git('diff', '--name-only', 'HEAD'),
    ]);

    return {
        revision,
        branch: branch && branch !== 'HEAD' ? branch : null,
        changed_files: changed_files.length ? changed_files.split('\n') : [],
    };
})();

export const http_user_agent = 'mastodon-webhooks/' + version + ' (' +
    (git ? 'git ' + git.revision.substr(0, 8) + ' ' : '') +
    (docker ? 'docker ' + (typeof docker === 'string' ? docker + ' ' : '') : '') +
    '+https://gitlab.fancy.org.uk/samuel/mastodon-webhooks +https://github.com/samuelthomas2774/mastodon-webhooks)';

export const data_path = path.join(fileURLToPath(import.meta.url), '..', '..', 'data');
