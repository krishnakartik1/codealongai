import { access, mkdir, open, readFile, readlink, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { TrueForge } from '@truefoundry/trueforge-sdk';

const healthTimeoutMs = 60_000;
const terminationGraceMs = 5_000;

export interface TrueForgeStartOptions {
  readonly port: number;
  readonly dataPath: string;
}

/** The only boundary between CodeAlongAI and the external TrueForge runtime. */
export interface TrueForgeRuntime {
  start(options: TrueForgeStartOptions): Promise<void>;
  health(port: number): Promise<boolean>;
  open(url: string): Promise<void>;
  stop(): Promise<void>;
  readonly producer: TrueForgeProducerRuntime;
}

/**
 * The producer-facing portion of the same external runtime boundary. Setup
 * does not invoke it; later producer work must use this contract rather than
 * creating another walkthrough or MCP authority.
 */
export interface TrueForgeProducerRuntime {
  discoverConfiguration(): Promise<unknown>;
  discoverProviders(): Promise<unknown>;
  discoverModels(): Promise<unknown>;
  discoverSkills(): Promise<unknown>;
  createSession(input: unknown): Promise<unknown>;
  runTurn(input: unknown): Promise<unknown>;
  events(sessionId: string, turnId: string): AsyncIterable<unknown>;
  cancelTurn(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

/** Starts only a runtime owned by this extension instance; it never discovers or adopts another process. */
export class TrueForgeSidecar {
  private port: number | undefined;
  private started = false;

  public constructor(
    private readonly runtime: TrueForgeRuntime,
    private readonly dataPath: string,
    private readonly allocatePort: () => Promise<number> = reserveLoopbackPort
  ) {}

  public get url(): string | undefined {
    return this.port === undefined ? undefined : loopbackUrl(this.port);
  }
  /** Later producer work uses the same owned runtime that setup started. */
  public get producer(): TrueForgeProducerRuntime { return this.runtime.producer; }

  public async configure(): Promise<void> {
    if (this.started && this.port !== undefined && await this.runtime.health(this.port)) {
      await this.runtime.open(loopbackUrl(this.port));
      return;
    }
    if (this.started) await this.runtime.stop();
    this.started = false;
    this.port = await this.allocatePort();
    try {
      await this.runtime.start({ port: this.port, dataPath: this.dataPath });
      await waitForHealthy(this.runtime, this.port);
      this.started = true;
      await this.runtime.open(loopbackUrl(this.port));
    } catch (error) {
      await this.runtime.stop().catch(() => undefined);
      this.port = undefined;
      throw error;
    }
  }

  public async dispose(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.port = undefined;
    await this.runtime.stop();
  }
}

export class NativeTrueForgeRuntime implements TrueForgeRuntime {
  private child: ChildProcess | undefined;
  private ownership: FileHandle | undefined;
  private ownershipPath: string | undefined;
  private port: number | undefined;

  public get producer(): TrueForgeProducerRuntime {
    if (this.port === undefined) throw new Error('The owned TrueForge sidecar is not running.');
    return new SdkTrueForgeProducerRuntime(loopbackUrl(this.port));
  }

  public constructor(
    private readonly openExternal: (url: string) => Promise<boolean>,
    private readonly configuredNodePath: () => string | undefined
  ) {}

  public async start(options: TrueForgeStartOptions): Promise<void> {
    if (this.child && this.child.exitCode === null) return;
    if (!await isUbuntuX64()) throw new Error('TrueForge setup requires Ubuntu x86-64.');
    const node = await resolveNodeExecutable(this.configuredNodePath());
    const cli = require.resolve('@truefoundry/trueforge/dist/cli.js');
    await mkdir(options.dataPath, { recursive: true });
    await this.acquireOwnership(options.dataPath);
    const sqlitePath = path.join(options.dataPath, 'trueforge.sqlite');
    try {
      this.child = spawn(node, [cli, '--port', String(options.port)], {
        cwd: options.dataPath,
        detached: false,
        stdio: 'ignore',
        env: { ...process.env, HOST: '127.0.0.1', SQLITE_PATH: sqlitePath, XDG_DATA_HOME: options.dataPath }
      });
      this.port = options.port;
      await this.ownership?.truncate(0);
      await this.ownership?.writeFile(JSON.stringify({ ownerPid: process.pid, childPid: this.child.pid, executable: node, cli }));
      if (!this.child.pid) throw new Error('TrueForge could not start.');
      this.child.once('error', () => { this.child = undefined; this.port = undefined; void this.releaseOwnership(); });
    } catch (error) {
      await this.releaseOwnership();
      throw error;
    }
  }

  public health(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const request = http.get(`${loopbackUrl(port)}healthz`, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      request.once('error', () => resolve(false));
      request.setTimeout(1_000, () => { request.destroy(); resolve(false); });
    });
  }

  public async open(url: string): Promise<void> {
    if (!await this.openExternal(url)) throw new Error('VS Code could not open the TrueForge setup UI.');
  }

  public async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.port = undefined;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      const exited = await waitForExit(child, terminationGraceMs);
      if (!exited && child.exitCode === null) {
        child.kill('SIGKILL');
        await waitForExit(child, terminationGraceMs);
      }
    }
    await this.releaseOwnership();
  }

  private async acquireOwnership(dataPath: string): Promise<void> {
    const lockPath = path.join(dataPath, 'codealongai-trueforge.lock');
    try {
      this.ownership = await open(lockPath, 'wx');
      this.ownershipPath = lockPath;
      await this.ownership.writeFile(JSON.stringify({ ownerPid: process.pid }));
    } catch {
      if (!await recoverStaleOwnership(lockPath)) throw new Error('Another CodeAlongAI window owns TrueForge setup.');
      this.ownership = await open(lockPath, 'wx');
      this.ownershipPath = lockPath;
      await this.ownership.writeFile(JSON.stringify({ ownerPid: process.pid }));
    }
  }

  private async releaseOwnership(): Promise<void> {
    const ownershipPath = this.ownershipPath;
    await this.ownership?.close();
    this.ownership = undefined;
    this.ownershipPath = undefined;
    if (ownershipPath) await unlink(ownershipPath).catch(() => undefined);
  }
}

interface OwnershipRecord { ownerPid: number; childPid?: number; executable?: string; cli?: string; }

export async function recoverStaleOwnership(lockPath: string): Promise<boolean> {
  let record: OwnershipRecord;
  try { record = JSON.parse(await readFile(lockPath, 'utf8')) as OwnershipRecord; } catch { return false; }
  if (!Number.isInteger(record.ownerPid) || processIsAlive(record.ownerPid)) return false;
  if (record.childPid !== undefined) {
    if (!Number.isInteger(record.childPid) || !record.executable || !record.cli) return false;
    try {
      const [actualExecutable, command] = await Promise.all([realpath(`/proc/${String(record.childPid)}/exe`), readFile(`/proc/${String(record.childPid)}/cmdline`, 'utf8')]);
      if (actualExecutable !== await realpath(record.executable) || !command.includes(record.cli)) return false;
      if (!await terminateOwnedProcess(record.childPid)) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      // The recorded child is gone with its dead owner (for example after a
      // host crash or reboot), so there is nothing to signal or attach to.
    }
  }
  await unlink(lockPath).catch(() => undefined);
  return true;
}

function processIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function terminateOwnedProcess(pid: number): Promise<boolean> {
  process.kill(pid, 'SIGTERM');
  if (await waitForPidExit(pid, terminationGraceMs)) return true;
  if (processIsAlive(pid)) process.kill(pid, 'SIGKILL');
  return waitForPidExit(pid, terminationGraceMs);
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  return !processIsAlive(pid);
}

/** Pinned 0.1.3 SDK adapter. It owns no credentials and passes none to CodeAlongAI. */
export class SdkTrueForgeProducerRuntime implements TrueForgeProducerRuntime {
  private readonly client: TrueForgeSdkClient;

  public constructor(baseUrl: string, createClient: TrueForgeSdkClientFactory = (url) => new TrueForge({ baseUrl: url }) as unknown as TrueForgeSdkClient) { this.client = createClient(baseUrl); }
  public async discoverConfiguration(): Promise<unknown> {
    return Promise.all([this.client.settings.modelProviders.list(), this.client.settings.skills.list(), this.client.settings.sandboxProviders.get()]);
  }
  public discoverProviders(): Promise<unknown> { return this.client.catalogs.modelProviders.list(); }
  public discoverModels(): Promise<unknown> { return this.client.models.list(); }
  public discoverSkills(): Promise<unknown> { return this.client.skills.list(); }
  public createSession(input: unknown): Promise<unknown> { return this.client.sessions.create(input as never); }
  public runTurn(input: unknown): Promise<unknown> {
    const value = input as { sessionId: string; request: unknown };
    return this.client.sessions.createTurn(value.sessionId, value.request as never);
  }
  public async *events(sessionId: string, turnId: string): AsyncIterable<unknown> {
    for await (const event of await this.client.sessions.subscribeToTurn(sessionId, turnId)) yield event;
  }
  public async cancelTurn(sessionId: string): Promise<void> { await this.client.sessions.cancel(sessionId); }
  public async deleteSession(sessionId: string): Promise<void> { await this.client.sessions.delete(sessionId); }
}

/** Narrow structural seam over the pinned SDK: tests replace only this external client. */
export interface TrueForgeSdkClient {
  settings: { modelProviders: { list(): Promise<unknown> }; skills: { list(): Promise<unknown> }; sandboxProviders: { get(): Promise<unknown> } };
  catalogs: { modelProviders: { list(): Promise<unknown> } };
  models: { list(): Promise<unknown> };
  skills: { list(): Promise<unknown> };
  sessions: {
    create(input: unknown): Promise<unknown>;
    createTurn(sessionId: string, input: unknown): Promise<unknown>;
    subscribeToTurn(sessionId: string, turnId: string): Promise<AsyncIterable<unknown>>;
    cancel(sessionId: string): Promise<unknown>;
    delete(sessionId: string): Promise<unknown>;
  };
}
export type TrueForgeSdkClientFactory = (baseUrl: string) => TrueForgeSdkClient;

export const loopbackUrl = (port: number): string => `http://127.0.0.1:${String(port)}/`;

async function waitForHealthy(runtime: TrueForgeRuntime, port: number): Promise<void> {
  const deadline = Date.now() + healthTimeoutMs;
  while (Date.now() < deadline) {
    if (await runtime.health(port)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('The owned TrueForge sidecar did not become healthy within 60 seconds.');
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Could not allocate a loopback port.')); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function resolveNodeExecutable(configured: string | undefined): Promise<string> {
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
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* Continue looking through the extension-host PATH. */ }
  }
  return undefined;
}

function nodeVersion(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output.trim()) : reject(new Error('Could not read the configured Node version.')));
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
    if (child.exitCode !== null) { clearTimeout(timer); resolve(true); }
  });
}

export async function isUbuntuX64(readOsRelease: () => Promise<string> = () => readFile('/etc/os-release', 'utf8')): Promise<boolean> {
  if (process.platform !== 'linux' || process.arch !== 'x64') return false;
  const osRelease = await readOsRelease().catch(() => '');
  return /^ID=ubuntu$/m.test(osRelease) || /^ID="ubuntu"$/m.test(osRelease);
}
