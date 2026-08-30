import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'out');
const packagedOut = join(root, '.package-out');
try {
  // The build directory is generated and explicitly scoped; source is never cleaned.
  await rm(out, { recursive: true, force: true });
  await writeFile(packageUrl, `${JSON.stringify(metadata, null, 2)}\n`);
  await run('npm', ['run', 'build'], { cwd: root });
  await cp(out, packagedOut, { recursive: true, filter: (source) => !/(?:^|\/)(?:acceptance|integration|test|prototype)(?:\/|$)|\.map$/.test(source) });
  metadata.main = './.package-out/extension.js';
  await writeFile(packageUrl, `${JSON.stringify(metadata, null, 2)}\n`);
  await run('./node_modules/.bin/vsce', ['package', '--no-dependencies', '--out', 'codealongai.vsix'], { cwd: root });
  const staging = await mkdtemp(join(tmpdir(), 'codealongai-vsix-dependencies-'));
  try {
    await mkdir(join(staging, 'extension', 'node_modules'), { recursive: true });
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
    for (const entry of Object.keys(lock.packages ?? {}).filter((value) => value.startsWith('node_modules/') && lock.packages?.[value]?.dev !== true)) await cp(join(root, entry), join(staging, 'extension', entry), { recursive: true });
    await run('zip', ['-q', '-r', join(root, 'codealongai.vsix'), 'extension/node_modules'], { cwd: staging });
  } finally { await rm(staging, { recursive: true, force: true }); }
} finally {
  await rm(packagedOut, { recursive: true, force: true });
  await writeFile(packageUrl, original);
}
