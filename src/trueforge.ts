import * as net from 'node:net';
import type { TrueForgeRuntime } from './trueforge-contract';

export type { TrueForgeProducerRuntime, TrueForgeRuntime, TrueForgeStartOptions, TrueForgeTurnRequest } from './trueforge-contract';
export { NativeTrueForgeRuntime } from './trueforge-native';
export { recoverStaleOwnership } from './trueforge-ownership';
export { SdkTrueForgeProducerRuntime, type TrueForgeSdkClient, type TrueForgeSdkClientFactory } from './trueforge-sdk';
export { isUbuntuX64 } from './trueforge-environment';
export { loopbackUrl } from './trueforge-url';
import { loopbackUrl } from './trueforge-url';

const healthTimeoutMs = 60_000;
const startupAttempts = 3;

/** Starts only a runtime owned by this extension instance; it never adopts another process. */
export class TrueForgeSidecar {
  private port: number | undefined;
  private started = false;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();
  public constructor(private readonly runtime: TrueForgeRuntime, private readonly dataPath: string, private readonly allocatePort: () => Promise<number> = reserveLoopbackPort) {}
  public get url(): string | undefined { return this.port === undefined ? undefined : loopbackUrl(this.port); }
  public get producer() { return this.runtime.producer; }
  public async configure(): Promise<void> { if (this.disposed) throw new Error('The TrueForge sidecar is disposed.'); const operation = this.queue.catch(() => undefined).then(() => this.configureOwned()); this.queue = operation; return operation; }
  private async configureOwned(): Promise<void> {
    if (this.started && this.port !== undefined && !this.runtime.hasExited() && await this.runtime.ownsRunningChild() && await this.runtime.health(this.port) && await this.runtime.verifyCapability(this.port)) { await this.runtime.open(loopbackUrl(this.port)); return; }
    if (this.started) await this.runtime.stop();
    this.started = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < startupAttempts; attempt += 1) {
      try {
        this.port = await this.allocatePort();
        await this.runtime.start({ port: this.port, dataPath: this.dataPath });
        await waitForOwnedCapability(this.runtime, this.port);
        if (!await this.runtime.ownsRunningChild()) throw new Error('The owned TrueForge sidecar exited before its setup UI could open.');
        this.started = true;
        await this.runtime.open(loopbackUrl(this.port));
        return;
      } catch (error) { lastError = error; await this.runtime.stop().catch(() => undefined); this.port = undefined; }
    }
    throw lastError instanceof Error ? lastError : new Error('The owned TrueForge sidecar could not start.');
  }
  public async dispose(): Promise<void> { this.disposed = true; const operation = this.queue.catch(() => undefined).then(async () => { this.started = false; this.port = undefined; await this.runtime.stop(); }); this.queue = operation; await operation; }
}

async function waitForOwnedCapability(runtime: TrueForgeRuntime, port: number): Promise<void> {
  const deadline = Date.now() + healthTimeoutMs;
  while (Date.now() < deadline) {
    if (runtime.hasExited()) throw new Error('The owned TrueForge sidecar exited before becoming healthy.');
    if (await runtime.ownsRunningChild() && await runtime.health(port) && await runtime.verifyCapability(port) && await runtime.ownsRunningChild()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('The owned TrueForge sidecar did not become healthy within 60 seconds.');
}

async function reserveLoopbackPort(): Promise<number> { return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, () => { const address = server.address(); if (!address || typeof address === 'string') { server.close(); reject(new Error('Could not allocate a loopback port.')); return; } server.close((error) => error ? reject(error) : resolve(address.port)); }); }); }
