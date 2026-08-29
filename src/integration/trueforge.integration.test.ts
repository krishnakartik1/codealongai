import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { NativeTrueForgeRuntime } from '../trueforge';

const within = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => await Promise.race([promise, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(message)), ms))]);

test('the bundled pinned TrueForge adapter serves a credential-free discovery route and cleans up', { timeout: 35_000 }, async () => {
  const dataPath = await mkdtemp(path.join(os.tmpdir(), 'codealongai-trueforge-integration-'));
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') return reject(new Error('no loopback port')); server.close((error) => error ? reject(error) : resolve(address.port)); });
  });
  const workspaceBefore = readFileSync('demo-workspace/checkout.ts', 'utf8');
  const runtime = new NativeTrueForgeRuntime(async () => true, () => undefined);
  try {
    await within(runtime.start({ port, dataPath }), 8_000, 'sidecar did not spawn');
    for (let attempt = 0; attempt < 100 && !await runtime.health(port); attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(await runtime.health(port), true);
    const catalog = await within(runtime.producer.discoverProviders() as Promise<{ data?: unknown[] }>, 5_000, 'catalog discovery timed out');
    assert.ok(Array.isArray(catalog.data));
    assert.equal(readFileSync('demo-workspace/checkout.ts', 'utf8'), workspaceBefore);
  } finally {
    await within(runtime.stop(), 8_000, 'sidecar did not stop');
    assert.equal(await runtime.health(port), false);
    await rm(dataPath, { recursive: true, force: true });
  }
});
