import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runTests } from '@vscode/test-electron';
import { nativeUbuntuPreflight, safeNativeEvidence } from '../out/acceptance/native-ubuntu-preflight.js';
import { ownershipReleased } from '../out/trueforge-ownership.js';

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const osRelease = await readFile('/etc/os-release', 'utf8').catch(() => '');
const buildCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root }).catch(() => ({ stdout: '' }))).stdout.trim();
const nativeAcceptanceInput = {
  enabled: process.env.CODEALONGAI_NATIVE_ACCEPTANCE === '1', ubuntuX64: process.platform === 'linux' && process.arch === 'x64' && /^ID=?"?ubuntu"?$/m.test(osRelease), nodeVersion: process.version, buildCommit,
  trueforgeVersion: packageMetadata.dependencies?.['@truefoundry/trueforge'], sdkVersion: packageMetadata.dependencies?.['@truefoundry/trueforge-sdk'], mcpServerVersion: packageMetadata.dependencies?.['@modelcontextprotocol/server'],
  dataPath: process.env.CODEALONGAI_TRUEFORGE_DATA_PATH, model: process.env.CODEALONGAI_NATIVE_ACCEPTANCE_MODEL, reasoningEffort: process.env.CODEALONGAI_NATIVE_ACCEPTANCE_REASONING_EFFORT, reply: process.env.CODEALONGAI_NATIVE_ACCEPTANCE_REPLY
};
const preflight = nativeUbuntuPreflight(nativeAcceptanceInput);
if (preflight.status === 'skip') { process.stdout.write(`SKIP native-ubuntu-acceptance: ${preflight.reason}.\n`); process.exit(0); }
if (preflight.status === 'blocked') { process.stderr.write(`BLOCKED native-ubuntu-acceptance: ${preflight.reason}.\n`); process.exit(2); }
try { if (!(await stat(nativeAcceptanceInput.dataPath)).isDirectory()) throw new Error('not a directory'); }
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
  await writeFile(join(profile, 'User', 'settings.json'), `${JSON.stringify({ 'codealongai.mcp.enabled': true, 'codealongai.trueforge.dataPath': nativeAcceptanceInput.dataPath, 'codealongai.trueforge.model': nativeAcceptanceInput.model, 'codealongai.trueforge.reasoningEffort': nativeAcceptanceInput.reasoningEffort })}\n`);
  await run('npm', ['run', 'package'], { cwd: root });
  await run('unzip', ['-q', join(root, 'codealongai.vsix'), '-d', join(temporary, 'vsix')]);
  const extensionPath = join(temporary, 'vsix', 'extension'); const packagedRequire = createRequire(join(extensionPath, 'package.json'));
  const packagedManifest = async (name) => { const seed = name === '@truefoundry/trueforge' ? '@truefoundry/trueforge/dist/cli.js' : name; let directory = dirname(packagedRequire.resolve(seed)); while (true) { try { const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); if (manifest.name === name) return manifest; } catch {} const parent = dirname(directory); if (parent === directory) throw new Error('packaged dependency missing'); directory = parent; } };
  for (const [name, version] of [['@truefoundry/trueforge', '0.1.4'], ['@truefoundry/trueforge-sdk', '0.1.3'], ['@modelcontextprotocol/server', '2.0.0'], ['@modelcontextprotocol/node', '2.0.0'], ['zod', '4.5.4']]) { if ((await packagedManifest(name)).version !== version) throw new Error('packaged dependency mismatch'); }
  // Mocha may fail before loading the acceptance test module. Seed the same
  // safe first checkpoint here so that rejection cannot erase launch evidence.
  await writeFile(observation, JSON.stringify({ checkpoint: 'extension', phases: [], calls: [], turns: [], receiptMatched: false, terminalDone: false, cleanup: [] }) + '\n');
  await runTests({ extensionDevelopmentPath: extensionPath, extensionTestsPath: join(root, 'out', 'acceptance', 'native-ubuntu.runner.js'), launchArgs: [join(root, 'demo-workspace'), `--user-data-dir=${profile}`, '--disable-extensions'], extensionTestsEnv: { ...process.env, CODEALONGAI_NATIVE_ACCEPTANCE: '1', CODEALONGAI_NATIVE_ACCEPTANCE_BUILD_COMMIT: buildCommit, CODEALONGAI_NATIVE_ACCEPTANCE_OBSERVATION: observation }, stdout: sink, stderr: sink });
  observed = JSON.parse(await readFile(observation, 'utf8')); const deadline = Date.now() + 5_000; while (!await ownershipReleased(nativeAcceptanceInput.dataPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25)); if (!await ownershipReleased(nativeAcceptanceInput.dataPath)) throw new Error('owned sidecar was not released after Extension Host exit'); if (!observed.terminalDone || !observed.receiptMatched || observed.phases.length === 0 || observed.calls.length === 0 || observed.turns?.length !== 2 || !Array.isArray(observed.lifecycle) || !observed.lifecycle.includes('restart:1') || !observed.lifecycle.includes('replay:0')) throw new Error('incomplete observation'); observed.cleanup = [...(observed.cleanup ?? []), 'owned-sidecar']; result = 'PASS';
} catch { observed = JSON.parse(await readFile(observation, 'utf8').catch(() => JSON.stringify(observed))); result = 'FAIL'; }
try { await rm(temporary, { recursive: true, force: true }); cleanup = ['profile-delete']; }
catch { result = 'FAIL'; }
process.stdout.write(JSON.stringify(safeNativeEvidence({ result, runtime: { platform: nativeAcceptanceInput.ubuntuX64 ? 'ubuntu' : 'unknown', architecture: process.arch, nodeVersion: nativeAcceptanceInput.nodeVersion, model: nativeAcceptanceInput.model ?? '', reasoningEffort: nativeAcceptanceInput.reasoningEffort ?? '' }, versions: { trueforge: nativeAcceptanceInput.trueforgeVersion ?? 'unknown', sdk: nativeAcceptanceInput.sdkVersion ?? 'unknown', mcp: nativeAcceptanceInput.mcpServerVersion ?? 'unknown' }, ...observed, cleanup: [...observed.cleanup, ...cleanup] })) + '\n');
process.exitCode = result === 'PASS' ? 0 : 1;
