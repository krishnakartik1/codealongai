import { access, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

export async function resolveNodeExecutable(configured: string | undefined): Promise<string> {
  const candidate = configured ?? await findNodeOnPath();
  if (!candidate || !path.isAbsolute(candidate)) throw new Error('Configure an absolute Node executable or add Node to the extension-host PATH.');
  await access(candidate, constants.X_OK);
  const executable = await realpath(candidate);
  const version = await nodeVersion(executable);
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) !== 22 || Number(match[2]) < 14) throw new Error('TrueForge setup requires Node >=22.14.0 and <23.');
  return executable;
}

async function findNodeOnPath(): Promise<string | undefined> {
  for (const entry of process.env.PATH?.split(path.delimiter) ?? []) {
    const candidate = path.join(entry, 'node');
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Continue through the extension-host PATH. */ }
  }
  return undefined;
}

function nodeVersion(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Timed out reading the configured Node version.')); }, 5_000);
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error('Could not read the configured Node version.')); });
  });
}

export async function isUbuntuX64(readOsRelease: () => Promise<string> = () => readFile('/etc/os-release', 'utf8'), platform = process.platform, architecture = process.arch): Promise<boolean> {
  if (platform !== 'linux' || architecture !== 'x64') return false;
  const osRelease = await readOsRelease().catch(() => '');
  return /^ID=ubuntu$/m.test(osRelease) || /^ID="ubuntu"$/m.test(osRelease);
}
