import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const packageUrl = new URL('../package.json', import.meta.url);
const original = await readFile(packageUrl, 'utf8');
const { stdout } = await run('git', ['rev-parse', 'HEAD']);
const head = stdout.trim();
const requested = process.env.CODEALONGAI_BUILD_COMMIT ?? head;
if (!/^[0-9a-f]{40}$/i.test(requested) || requested !== head) throw new Error('Packaging build identity must equal checked-out HEAD.');

const metadata = JSON.parse(original);
metadata.codealongai = { ...(metadata.codealongai ?? {}), buildCommit: requested };
try {
  await writeFile(packageUrl, `${JSON.stringify(metadata, null, 2)}\n`);
  await run('npm', ['run', 'build'], { cwd: new URL('..', import.meta.url).pathname });
  await run('./node_modules/.bin/vsce', ['package', '--out', 'codealongai.vsix'], { cwd: new URL('..', import.meta.url).pathname });
} finally {
  await writeFile(packageUrl, original);
}
