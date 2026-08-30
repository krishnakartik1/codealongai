import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
const sink = { write() { return true; } };
try {
  await mkdir(join(profile, 'User'), { recursive: true });
  await writeFile(join(profile, 'User', 'settings.json'), `${JSON.stringify({ 'codealongai.mcp.enabled': true, 'codealongai.trueforge.dataPath': input.dataPath, 'codealongai.trueforge.model': input.model, 'codealongai.trueforge.reasoningEffort': input.reasoningEffort })}\n`);
  await run('npm', ['run', 'package'], { cwd: root });
  await run('unzip', ['-q', join(root, 'codealongai.vsix'), '-d', join(temporary, 'vsix')]);
  const code = await runTests({ extensionDevelopmentPath: join(temporary, 'vsix', 'extension'), extensionTestsPath: join(root, 'out', 'acceptance', 'native-ubuntu.runner.js'), launchArgs: [join(root, 'demo-workspace'), `--user-data-dir=${profile}`, '--disable-extensions'], extensionTestsEnv: { ...process.env, CODEALONGAI_NATIVE_ACCEPTANCE: '1' }, stdout: sink, stderr: sink });
  process.stdout.write(JSON.stringify(safeNativeEvidence({ result: code === 0 ? 'PASS' : 'FAIL', phases: [], calls: [], receiptMatched: false, terminalDone: false, cleanup: code === 0 ? ['profile-delete'] : [] })) + '\n');
  process.exitCode = code === 0 ? 0 : 1;
} catch {
  process.stderr.write(JSON.stringify(safeNativeEvidence({ result: 'FAIL', phases: [], calls: [], receiptMatched: false, terminalDone: false, cleanup: [] })) + '\n');
  process.exitCode = 1;
} finally { await rm(temporary, { recursive: true, force: true }); }
