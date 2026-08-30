import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { runTests } from '@vscode/test-electron';

const run = promisify(execFile); const root = resolve(new URL('..', import.meta.url).pathname);
const required = ['CODEALONGAI_NATIVE_ACCEPTANCE_MODEL', 'CODEALONGAI_NATIVE_ACCEPTANCE_REASONING_EFFORT', 'CODEALONGAI_NATIVE_ACCEPTANCE_REPLY']; const missing = required.filter((name) => !process.env[name]);
if (process.env.CODEALONGAI_NATIVE_ACCEPTANCE !== '1') { process.stdout.write('SKIP native-ubuntu-acceptance: set CODEALONGAI_NATIVE_ACCEPTANCE=1 to opt in.\n'); process.exit(0); }
if (process.platform !== 'linux' || process.arch !== 'x64' || !(await readFile('/etc/os-release', 'utf8').catch(() => '')).match(/^ID=?"?ubuntu"?$/m)) { process.stdout.write('SKIP native-ubuntu-acceptance: requires Ubuntu x86-64.\n'); process.exit(0); }
if (missing.length > 0) { process.stderr.write(`BLOCKED native-ubuntu-acceptance: missing operator configuration (${missing.join(', ')}).\n`); process.exit(2); }
const temporary = await mkdtemp(join(tmpdir(), 'codealongai-native-ubuntu-')); const profile = join(temporary, 'profile'); const sink = { write() { return true; } };
try {
  await mkdir(join(profile, 'User'), { recursive: true }); await writeFile(join(profile, 'User', 'settings.json'), '{}\n');
  await run('npm', ['run', 'package'], { cwd: root }); await run('unzip', ['-q', join(root, 'codealongai.vsix'), '-d', join(temporary, 'vsix')]);
  const code = await runTests({ extensionDevelopmentPath: join(temporary, 'vsix', 'extension'), extensionTestsPath: join(root, 'out', 'acceptance', 'native-ubuntu.acceptance.test.js'), launchArgs: [join(root, 'demo-workspace'), `--user-data-dir=${profile}`, '--disable-extensions'], extensionTestsEnv: { ...process.env, CODEALONGAI_NATIVE_ACCEPTANCE: '1' }, stdout: sink, stderr: sink });
  process.stdout.write(JSON.stringify({ result: code === 0 ? 'PASS' : 'FAIL', checks: ['packaged-build', 'fresh-profile', 'loopback-mcp', 'model-ask', 'graph-reply', 'workspace-unchanged'] }) + '\n'); process.exitCode = code === 0 ? 0 : 1;
} catch { process.stderr.write('BLOCKED native-ubuntu-acceptance: the operator-configured TrueForge/Daytona/model precondition did not complete.\n'); process.exitCode = 2; }
finally { await rm(temporary, { recursive: true, force: true }); }
