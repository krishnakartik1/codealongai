import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { runTests } from '@vscode/test-electron';
import { nativeUbuntuPreflight, safeNativeEvidence } from '../out/acceptance/native-ubuntu-preflight.js';

const run = promisify(execFile);
const root = resolve(new URL('..', import.meta.url).pathname);
const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const osRelease = await readFile('/etc/os-release', 'utf8').catch(() => '');
const buildCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root }).catch(() => ({ stdout: '' }))).stdout.trim();
const input = {
  enabled: process.env.CODEALONGAI_NATIVE_ACCEPTANCE === '1', ubuntuX64: process.platform === 'linux' && process.arch === 'x64' && /^ID=?"?ubuntu"?$/m.test(osRelease), nodeVersion: process.version, buildCommit,
  trueforgeVersion: packageMetadata.dependencies?.['@truefoundry/trueforge'], sdkVersion: packageMetadata.dependencies?.['@truefoundry/trueforge-sdk'], mcpServerVersion: packageMetadata.dependencies?.['@modelcontextprotocol/server'],
  dataPath: process.env.CODEALONGAI_TRUEFORGE_DATA_PATH, model: process.env.CODEALONGAI_NATIVE_ACCEPTANCE_MODEL, reasoningEffort: process.env.CODEALONGAI_NATIVE_ACCEPTANCE_REASONING_EFFORT, reply: process.env.CODEALONGAI_NATIVE_ACCEPTANCE_REPLY
};
const preflight = nativeUbuntuPreflight(input);
if (preflight.status === 'skip') { process.stdout.write(`SKIP native-ubuntu-acceptance: ${preflight.reason}.\n`); process.exit(0); }
if (preflight.status === 'blocked') { process.stderr.write(`BLOCKED native-ubuntu-acceptance: ${preflight.reason}.\n`); process.exit(2); }
try { if (!(await stat(input.dataPath)).isDirectory()) throw new Error('not a directory'); }
catch { process.stderr.write('BLOCKED native-ubuntu-acceptance: configuration.\n'); process.exit(2); }

const temporary = await mkdtemp(join(tmpdir(), 'codealongai-native-ubuntu-'));
const profile = join(temporary, 'profile');
const observation = join(temporary, 'observation.json');
const sink = { write() { return true; } };
let result = 'FAIL';
let cleanup = [];
let observed = { phases: [], calls: [], turns: [], receiptMatched: false, terminalDone: false, cleanup: [] };
try {
  await mkdir(join(profile, 'User'), { recursive: true });
  await writeFile(join(profile, 'User', 'settings.json'), `${JSON.stringify({ 'codealongai.mcp.enabled': true, 'codealongai.trueforge.dataPath': input.dataPath, 'codealongai.trueforge.model': input.model, 'codealongai.trueforge.reasoningEffort': input.reasoningEffort })}\n`);
  await run('npm', ['run', 'package'], { cwd: root });
  await run('unzip', ['-q', join(root, 'codealongai.vsix'), '-d', join(temporary, 'vsix')]);
  const extensionPath = join(temporary, 'vsix', 'extension'); const packagedRequire = createRequire(join(extensionPath, 'package.json'));
  for (const [name, version] of [['@truefoundry/trueforge', '0.1.4'], ['@truefoundry/trueforge-sdk', '0.1.3'], ['@modelcontextprotocol/server', '2.0.0'], ['@modelcontextprotocol/node', '2.0.0'], ['zod', '4.5.4']]) { const manifest = JSON.parse(await readFile(packagedRequire.resolve(`${name}/package.json`), 'utf8')); if (manifest.version !== version) throw new Error('packaged dependency mismatch'); }
  const code = await runTests({ extensionDevelopmentPath: extensionPath, extensionTestsPath: join(root, 'out', 'acceptance', 'native-ubuntu.runner.js'), launchArgs: [join(root, 'demo-workspace'), `--user-data-dir=${profile}`, '--disable-extensions'], extensionTestsEnv: { ...process.env, CODEALONGAI_NATIVE_ACCEPTANCE: '1', CODEALONGAI_NATIVE_ACCEPTANCE_BUILD_COMMIT: buildCommit, CODEALONGAI_NATIVE_ACCEPTANCE_OBSERVATION: observation }, stdout: sink, stderr: sink });
  if (code === 0) { observed = JSON.parse(await readFile(observation, 'utf8')); if (!observed.terminalDone || !observed.receiptMatched || observed.phases.length === 0 || observed.calls.length === 0 || observed.turns?.length !== 2) throw new Error('incomplete observation'); result = 'PASS'; }
} catch { result = 'FAIL'; }
try { await rm(temporary, { recursive: true, force: true }); cleanup = ['profile-delete']; }
catch { result = 'FAIL'; }
process.stdout.write(JSON.stringify(safeNativeEvidence({ result, versions: { trueforge: input.trueforgeVersion ?? 'unknown', sdk: input.sdkVersion ?? 'unknown', mcp: input.mcpServerVersion ?? 'unknown' }, ...observed, cleanup: [...observed.cleanup, ...cleanup] })) + '\n');
process.exitCode = result === 'PASS' ? 0 : 1;
