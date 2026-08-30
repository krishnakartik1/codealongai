import * as path from 'node:path';
import { readdir } from 'node:fs/promises';

export type NativeAcceptancePreflight = { readonly status: 'skip'; readonly reason: 'opt-in' | 'platform'; } | { readonly status: 'blocked'; readonly reason: 'configuration' | 'node' | 'build'; } | { readonly status: 'ready'; };
export interface NativeAcceptanceInput { readonly enabled: boolean; readonly ubuntuX64: boolean; readonly nodeVersion: string; readonly buildCommit: string | undefined; readonly trueforgeVersion: string | undefined; readonly sdkVersion: string | undefined; readonly mcpServerVersion: string | undefined; readonly dataPath: string | undefined; readonly model: string | undefined; readonly reasoningEffort: string | undefined; readonly reply: string | undefined; }

/** Pure, credential-free gate for the operator-run acceptance process. */
export function nativeUbuntuPreflight(input: NativeAcceptanceInput): NativeAcceptancePreflight {
  if (!input.enabled) return { status: 'skip', reason: 'opt-in' };
  if (!input.ubuntuX64) return { status: 'skip', reason: 'platform' };
  const node = /^v(\d+)\.(\d+)\.(\d+)$/.exec(input.nodeVersion);
  if (!node || Number(node[1]) !== 22 || Number(node[2]) < 14) return { status: 'blocked', reason: 'node' };
  if (!input.buildCommit || !/^[0-9a-f]{40}$/i.test(input.buildCommit) || input.trueforgeVersion !== '0.1.4' || input.sdkVersion !== '0.1.3' || input.mcpServerVersion !== '2.0.0') return { status: 'blocked', reason: 'build' };
  if (!input.dataPath || !path.isAbsolute(input.dataPath) || !input.model || !/^[^/\s]+\/[^/\s]+$/.test(input.model) || !input.reasoningEffort || !input.reply) return { status: 'blocked', reason: 'configuration' };
  return { status: 'ready' };
}

export interface NativeTurnEvidence { readonly kind: 'ask' | 'reply'; readonly calls: readonly string[]; readonly policy: string | undefined; readonly sandboxCreated: boolean; readonly sessionCreated: boolean; readonly sessionDeleted: boolean; readonly receiptMatched: boolean; readonly terminalDone: boolean; }
export interface SafeNativeRuntimeEvidence { readonly platform: string; readonly architecture: string; readonly nodeVersion: string; readonly model: string; readonly reasoningEffort: string; }
export type NativeFailureCheckpoint = 'extension' | 'activation' | 'configure' | 'ask' | 'stream-subscribe' | 'stream-read' | 'stream-unknown';
export interface SafeNativeEvidence { readonly result: 'PASS' | 'FAIL'; readonly runtime: SafeNativeRuntimeEvidence; readonly versions: { readonly trueforge: string; readonly sdk: string; readonly mcp: string; }; readonly phases: readonly string[]; readonly calls: readonly string[]; readonly checkpoint?: NativeFailureCheckpoint; readonly turns?: readonly NativeTurnEvidence[]; readonly lifecycle?: readonly string[]; readonly policies?: readonly string[]; readonly readiness?: { readonly provider: 'daytona'; readonly skillCommit: string; readonly connectorDiscovered: boolean; readonly mcpDiscovered: boolean; readonly ownedSidecar: boolean; readonly probeCleaned: boolean; }; readonly receiptMatched: boolean; readonly terminalDone: boolean; readonly cleanup: readonly string[]; }
/** Removes all values except the fixed public vocabulary permitted in acceptance output. */
export function safeNativeEvidence(input: SafeNativeEvidence): SafeNativeEvidence {
  const runtime = {
    platform: input.runtime.platform === 'ubuntu' ? 'ubuntu' : 'unknown',
    architecture: input.runtime.architecture === 'x64' ? 'x64' : 'unknown',
    nodeVersion: /^v?\d+\.\d+\.\d+$/.test(input.runtime.nodeVersion) ? input.runtime.nodeVersion.replace(/^v/, '') : 'unknown',
    model: /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}$/i.test(input.runtime.model) ? input.runtime.model : 'unknown',
    reasoningEffort: /^[a-z][a-z0-9-]{0,31}$/i.test(input.runtime.reasoningEffort) ? input.runtime.reasoningEffort : 'unknown'
  };
  const names = input.calls.filter((name) => /^codealongai_[a-z_]+$/.test(name));
  const phases = input.phases.filter((phase) => /^(provider|snapshots|sandboxes|ready|model|reasoning|skill|connector|mcp-discovery)$/.test(phase));
  const cleanup = input.cleanup.filter((value) => /^(owned-sidecar|session-delete|probe-delete|profile-delete)$/.test(value));
  const policies = input.policies?.filter((value) => /^(start|question|replacement)$/.test(value));
  const lifecycle = input.lifecycle?.filter((value) => /^(restart:1|replay:0)$/.test(value));
  const turns = input.turns?.flatMap((turn) => (turn.kind === 'ask' || turn.kind === 'reply') && Array.isArray(turn.calls) && turn.calls.every((name) => /^codealongai_[a-z_]+$/.test(name)) && (turn.policy === 'start' || turn.policy === 'question') && turn.sandboxCreated === true && turn.sessionCreated === true && turn.sessionDeleted === true && turn.receiptMatched === true && turn.terminalDone === true ? [{ kind: turn.kind, calls: [...turn.calls], policy: turn.policy, sandboxCreated: true, sessionCreated: true, sessionDeleted: true, receiptMatched: true, terminalDone: true }] : []);
  const readiness = input.readiness && input.readiness.provider === 'daytona' && /^[0-9a-f]{40}$/i.test(input.readiness.skillCommit) ? input.readiness : undefined;
  const version = (value: string): string => /^\d+\.\d+\.\d+$/.test(value) ? value : 'unknown';
  const checkpoint = input.checkpoint && ['extension', 'activation', 'configure', 'ask', 'stream-subscribe', 'stream-read', 'stream-unknown'].includes(input.checkpoint) ? input.checkpoint : undefined;
  return { result: input.result, runtime, versions: { trueforge: version(input.versions.trueforge), sdk: version(input.versions.sdk), mcp: version(input.versions.mcp) }, phases, calls: names, ...(checkpoint ? { checkpoint } : {}), ...(turns ? { turns } : {}), ...(lifecycle ? { lifecycle } : {}), ...(policies ? { policies } : {}), ...(readiness ? { readiness } : {}), receiptMatched: input.receiptMatched, terminalDone: input.terminalDone, cleanup };
}

const readTools = new Set(['codealongai_get_walkthrough_request', 'codealongai_get_walkthrough', 'codealongai_list_workspace_files', 'codealongai_read_workspace_file', 'codealongai_search_workspace']);
/** Complete bounded producer policy: authority first, one transition last, no post-transition calls. */
export function validTurnCallSequence(kind: 'ask' | 'reply', calls: readonly string[], forbidden: boolean): boolean {
  const transition = kind === 'ask' ? 'codealongai_start_walkthrough' : 'codealongai_commit_question_outcome';
  if (forbidden || calls.length < (kind === 'ask' ? 3 : 2) || calls.length > 13 || calls[0] !== 'codealongai_get_walkthrough_request' || calls[calls.length - 1] !== transition) return false;
  if (calls.slice(0, -1).some((name) => !readTools.has(name)) || calls.slice(1).includes('codealongai_get_walkthrough_request')) return false;
  return new Set(calls.slice(0, -1).filter((name) => name === 'codealongai_list_workspace_files')).size <= 1;
}

/** Counts only local Sandbox Runtime directory markers beneath the operator-owned store. Names never leave this function. */
export async function localSandboxRuntimeDirectoryCount(store: string): Promise<number> {
  let count = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const child = path.join(directory, entry.name);
      if (entry.name === 'sandbox-runtime' || entry.name === '.sandbox-runtime') count += 1;
      await visit(child);
    }
  };
  await visit(store);
  return count;
}

export interface NativeReadinessFacts { readonly skillCommit: string; readonly connectorDiscovered: boolean; readonly ownership: boolean; }
/** Whitelist-only configuration evidence. Sandbox evidence comes from actual producer turns. */
export function validNativeReadinessFacts(facts: NativeReadinessFacts, buildCommit: string): boolean {
  return facts.skillCommit === buildCommit && /^[0-9a-f]{40}$/i.test(facts.skillCommit) && facts.connectorDiscovered && facts.ownership;
}
