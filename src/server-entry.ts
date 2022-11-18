import * as path from 'node:path';
import createDebug from 'debug';
import dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';
import { fileURLToPath } from 'node:url';

createDebug.log = console.warn.bind(console);

dotenvExpand.expand(dotenv.config({
    path: path.join(fileURLToPath(import.meta.url), '..', '..', '.env'),
}));

if (process.env.DEBUG) createDebug.enable(process.env.DEBUG);

import('./server.js').then(cli => cli.main.call(null));
