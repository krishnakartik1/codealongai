import { mkdir } from 'node:fs/promises';
import * as http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isUbuntuX64, resolveNodeExecutable } from './trueforge-environment';
import { createOwnershipLock, ownsRecordedChild, processStartTime, recoverStaleOwnership, releaseOwnershipIfCurrent as releaseCurrentOwnership, writeOwnership, type OwnershipRecord } from './trueforge-ownership';
import { SdkTrueForgeProducerRuntime } from './trueforge-sdk';
import type { TrueForgeProducerRuntime, TrueForgeRuntime, TrueForgeStartOptions } from './trueforge-contract';
import { loopbackUrl } from './trueforge-url';

const terminationGraceMs = 5_000;
export class NativeTrueForgeRuntime implements TrueForgeRuntime {
  private child: ChildProcess | undefined; private ownershipPath: string | undefined; private ownershipLaunchId: string | undefined; private port: number | undefined; private childExited = false; private record: OwnershipRecord | undefined; private stopping = false;
  public constructor(private readonly openExternal: (url: string) => Promise<boolean>, private readonly configuredNodePath: () => string | undefined, private readonly reportUnexpectedExit: (message: string) => void = () => undefined) {}
  public get producer(): TrueForgeProducerRuntime { if (this.port === undefined) throw new Error('The owned TrueForge sidecar is not running.'); return new SdkTrueForgeProducerRuntime(loopbackUrl(this.port)); }
  public async start(options: TrueForgeStartOptions): Promise<void> {
    if (this.child && this.child.exitCode === null) throw new Error('The owned TrueForge sidecar is already running.');
    if (!await isUbuntuX64()) throw new Error('TrueForge setup requires Ubuntu x86-64.');
    const node = await resolveNodeExecutable(this.configuredNodePath()); const cli = require.resolve('@truefoundry/trueforge/dist/cli.js');
    await mkdir(options.dataPath, { recursive: true }); const dataPath = await import('node:fs/promises').then(({ realpath }) => realpath(options.dataPath));
    const launchId = randomUUID(); const record: OwnershipRecord = { ownerPid: process.pid, ownerStartTime: await processStartTime(process.pid), launchId, executable: node, cli, port: options.port, dataPath };
    await this.acquireOwnership(dataPath, record);
    try {
      const child = spawn(node, [cli, '--port', String(options.port)], { cwd: dataPath, detached: false, stdio: 'ignore', env: { ...process.env, HOST: '127.0.0.1', SQLITE_PATH: path.join(dataPath, 'trueforge.sqlite'), XDG_DATA_HOME: dataPath, CODEALONGAI_TRUEFORGE_LAUNCH_ID: launchId } });
      this.child = child; this.port = options.port; this.childExited = false;
      child.once('error', (error) => { this.reportExit(`TrueForge sidecar failed: ${error.message}`); });
      child.once('exit', (code, signal) => { this.reportExit(`TrueForge sidecar exited unexpectedly (${signal ?? `code ${String(code)}`}).`); });
      if (!child.pid) throw new Error('TrueForge could not start.');
      this.record = { ...record, childPid: child.pid, childStartTime: await processStartTime(child.pid) };
      await this.writeOwnership(this.record);
    } catch (error) { await this.stop(); throw error; }
  }
  public health(port: number): Promise<boolean> { return requestStatus(`${loopbackUrl(port)}healthz`, (status, body) => status === 200 && body === 'OK!'); }
  public verifyCapability(port: number): Promise<boolean> { return requestStatus(`${loopbackUrl(port)}api/v1/capabilities`, (status, body) => status === 200 && body.trimStart().startsWith('{')); }
  public async open(url: string): Promise<void> { if (!await this.openExternal(url)) throw new Error('VS Code could not open the TrueForge setup UI.'); }
  public async stop(): Promise<void> { const child = this.child; const record = this.record; this.stopping = true; this.child = undefined; this.port = undefined; this.record = undefined; if (child && child.exitCode === null && record && await ownsRecordedChild(record)) { child.kill('SIGTERM'); if (!await waitForExit(child, terminationGraceMs) && child.exitCode === null && await ownsRecordedChild(record)) { child.kill('SIGKILL'); await waitForExit(child, terminationGraceMs); } } await this.releaseOwnership(); this.stopping = false; }
  public hasExited(): boolean { return this.childExited || this.child === undefined || this.child.exitCode !== null; }
  public async ownsRunningChild(): Promise<boolean> { return !this.hasExited() && this.record !== undefined && ownsRecordedChild(this.record); }
  private async acquireOwnership(dataPath: string, ownershipRecord: OwnershipRecord): Promise<void> { const lockPath = path.join(dataPath, 'codealongai-trueforge.lock'); try { await this.openOwnership(lockPath, ownershipRecord); } catch { if (!await recoverStaleOwnership(lockPath)) throw new Error('Another CodeAlongAI window owns TrueForge setup.'); await this.openOwnership(lockPath, ownershipRecord); } this.ownershipLaunchId = ownershipRecord.launchId; }
  private async openOwnership(lockPath: string, ownershipRecord: OwnershipRecord): Promise<void> { await createOwnershipLock(lockPath, ownershipRecord); this.ownershipPath = lockPath; }
  private async writeOwnership(record: OwnershipRecord): Promise<void> { const ownershipPath = this.ownershipPath; if (!ownershipPath) throw new Error('TrueForge ownership is unavailable.'); await writeOwnership(ownershipPath, record); }
  private async releaseOwnership(): Promise<void> { const ownershipPath = this.ownershipPath; const launchId = this.ownershipLaunchId; this.ownershipPath = undefined; this.ownershipLaunchId = undefined; if (ownershipPath && launchId) await releaseCurrentOwnership(ownershipPath, launchId); }
  private reportExit(message: string): void { this.childExited = true; this.child = undefined; this.port = undefined; if (!this.stopping) this.reportUnexpectedExit(message); void this.releaseOwnership(); }
}

/** Narrow filesystem seam: cleanup removes only the lock record it published. */
export { releaseOwnershipIfCurrent } from './trueforge-ownership';

function requestStatus(url: string, accepts: (status: number | undefined, body: string) => boolean): Promise<boolean> { return new Promise((resolve) => { const request = http.get(url, (response) => { let body = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve(accepts(response.statusCode, body))); }); request.once('error', () => resolve(false)); request.setTimeout(1_000, () => { request.destroy(); resolve(false); }); }); }
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> { if (child.exitCode !== null) return Promise.resolve(true); return new Promise((resolve) => { const timer = setTimeout(() => resolve(false), timeoutMs); child.once('exit', () => { clearTimeout(timer); resolve(true); }); }); }
