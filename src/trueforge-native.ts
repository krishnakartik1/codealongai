import { mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import * as http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isUbuntuX64, resolveNodeExecutable } from './trueforge-environment';
import { processStartTime, recoverStaleOwnership, type OwnershipRecord } from './trueforge-ownership';
import { SdkTrueForgeProducerRuntime } from './trueforge-sdk';
import type { TrueForgeProducerRuntime, TrueForgeRuntime, TrueForgeStartOptions } from './trueforge-contract';

const terminationGraceMs = 5_000;
export const loopbackUrl = (port: number): string => `http://127.0.0.1:${String(port)}/`;

export class NativeTrueForgeRuntime implements TrueForgeRuntime {
  private child: ChildProcess | undefined; private ownership: FileHandle | undefined; private ownershipPath: string | undefined; private port: number | undefined; private childExited = false;
  public constructor(private readonly openExternal: (url: string) => Promise<boolean>, private readonly configuredNodePath: () => string | undefined) {}
  public get producer(): TrueForgeProducerRuntime { if (this.port === undefined) throw new Error('The owned TrueForge sidecar is not running.'); return new SdkTrueForgeProducerRuntime(loopbackUrl(this.port)); }
  public async start(options: TrueForgeStartOptions): Promise<void> {
    if (this.child && this.child.exitCode === null) throw new Error('The owned TrueForge sidecar is already running.');
    if (!await isUbuntuX64()) throw new Error('TrueForge setup requires Ubuntu x86-64.');
    const node = await resolveNodeExecutable(this.configuredNodePath()); const cli = require.resolve('@truefoundry/trueforge/dist/cli.js');
    await mkdir(options.dataPath, { recursive: true }); const dataPath = await import('node:fs/promises').then(({ realpath }) => realpath(options.dataPath));
    await this.acquireOwnership(dataPath);
    const launchId = randomUUID(); const record: OwnershipRecord = { ownerPid: process.pid, launchId, executable: node, cli, port: options.port, dataPath };
    try {
      await this.writeOwnership(record);
      const child = spawn(node, [cli, '--port', String(options.port)], { cwd: dataPath, detached: false, stdio: 'ignore', env: { ...process.env, HOST: '127.0.0.1', SQLITE_PATH: path.join(dataPath, 'trueforge.sqlite'), XDG_DATA_HOME: dataPath, CODEALONGAI_TRUEFORGE_LAUNCH_ID: launchId } });
      this.child = child; this.port = options.port; this.childExited = false;
      child.once('error', () => { this.childExited = true; this.child = undefined; this.port = undefined; void this.releaseOwnership(); });
      child.once('exit', () => { this.childExited = true; this.child = undefined; this.port = undefined; void this.releaseOwnership(); });
      if (!child.pid) throw new Error('TrueForge could not start.');
      await this.writeOwnership({ ...record, childPid: child.pid, childStartTime: await processStartTime(child.pid) });
    } catch (error) { await this.stop(); throw error; }
  }
  public health(port: number): Promise<boolean> { return requestStatus(`${loopbackUrl(port)}healthz`, (status, body) => status === 200 && body === 'OK!'); }
  public verifyCapability(port: number): Promise<boolean> { return requestStatus(`${loopbackUrl(port)}api/v1/capabilities`, (status, body) => status === 200 && body.trimStart().startsWith('{')); }
  public async open(url: string): Promise<void> { if (!await this.openExternal(url)) throw new Error('VS Code could not open the TrueForge setup UI.'); }
  public async stop(): Promise<void> { const child = this.child; this.child = undefined; this.port = undefined; if (child && child.exitCode === null) { child.kill('SIGTERM'); if (!await waitForExit(child, terminationGraceMs) && child.exitCode === null) { child.kill('SIGKILL'); await waitForExit(child, terminationGraceMs); } } await this.releaseOwnership(); }
  public hasExited(): boolean { return this.childExited || this.child === undefined || this.child.exitCode !== null; }
  private async acquireOwnership(dataPath: string): Promise<void> { const lockPath = path.join(dataPath, 'codealongai-trueforge.lock'); try { await this.openOwnership(lockPath); } catch { if (!await recoverStaleOwnership(lockPath)) throw new Error('Another CodeAlongAI window owns TrueForge setup.'); await this.openOwnership(lockPath); } }
  private async openOwnership(lockPath: string): Promise<void> { this.ownership = await open(lockPath, 'wx'); this.ownershipPath = lockPath; }
  private async writeOwnership(record: OwnershipRecord): Promise<void> { await this.ownership?.truncate(0); await this.ownership?.writeFile(JSON.stringify(record)); await this.ownership?.sync(); }
  private async releaseOwnership(): Promise<void> { const ownershipPath = this.ownershipPath; await this.ownership?.close(); this.ownership = undefined; this.ownershipPath = undefined; if (ownershipPath) await unlink(ownershipPath).catch(() => undefined); }
}

function requestStatus(url: string, accepts: (status: number | undefined, body: string) => boolean): Promise<boolean> { return new Promise((resolve) => { const request = http.get(url, (response) => { let body = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve(accepts(response.statusCode, body))); }); request.once('error', () => resolve(false)); request.setTimeout(1_000, () => { request.destroy(); resolve(false); }); }); }
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> { if (child.exitCode !== null) return Promise.resolve(true); return new Promise((resolve) => { const timer = setTimeout(() => resolve(false), timeoutMs); child.once('exit', () => { clearTimeout(timer); resolve(true); }); }); }
