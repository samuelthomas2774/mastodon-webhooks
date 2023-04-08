import * as fs from 'node:fs/promises';
import * as child_process from 'node:child_process';
import * as util from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = util.promisify(child_process.execFile);
const options = {cwd: fileURLToPath(new URL('..', import.meta.url))};
const git = (...args) => execFile('git', args, options).then(({stdout}) => stdout.toString().trim());

const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf-8'));

const [revision, branch, changed_files] = await Promise.all([
    git('rev-parse', 'HEAD'),
    git('rev-parse', '--abbrev-ref', 'HEAD'),
    git('diff', '--name-only', 'HEAD'),
]);

pkg.version = process.env.VERSION || pkg.version;

if (process.argv[2] === 'docker') {
    pkg.__docker = process.argv[3];
}

pkg.__git = pkg.__git ?? {
    revision,
    branch: branch && branch !== 'HEAD' ? branch : null,
    changed_files: changed_files.length ? changed_files.split('\n') : [],
};

await fs.writeFile(new URL('../package.json', import.meta.url), JSON.stringify(pkg, null, 4) + '\n', 'utf-8');
