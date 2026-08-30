import * as path from 'node:path';
import { readdir } from 'node:fs/promises';

export type NativeAcceptancePreflight = { readonly status: 'skip'; readonly reason: 'opt-in' | 'platform'; } | { readonly status: 'blocked'; readonly reason: 'configuration' | 'node' | 'build'; } | { readonly status: 'ready'; };
export interface NativeAcceptanceInput { readonly enabled: boolean; readonly ubuntuX64: boolean; readonly nodeVersion: string; readonly buildCommit: string | undefined; readonly trueforgeVersion: string | undefined; readonly sdkVersion: string | undefined; readonly mcpServerVersion: string | undefined; readonly dataPath: string | undefined; readonly model: string | undefined; readonly reasoningEffort: string | undefined; readonly reply: string | undefined; }

/** Pure, credential-free gate for the operator-run acceptance process. */
export function nativeUbuntuPreflight(input: NativeAcceptanceInput): NativeAcceptancePreflight {
  if (!input.enabled) return { status: 'skip', reason: 'opt-in' };
  if (!input.ubuntuX64) return { status: 'skip', reason: 'platform' };
  if (!/^v22\./.test(input.nodeVersion)) return { status: 'blocked', reason: 'node' };
  if (!input.buildCommit || !/^[0-9a-f]{40}$/i.test(input.buildCommit) || input.trueforgeVersion !== '0.1.4' || input.sdkVersion !== '0.1.3' || input.mcpServerVersion !== '2.0.0') return { status: 'blocked', reason: 'build' };
  if (!input.dataPath || !path.isAbsolute(input.dataPath) || !input.model || !/^[^/\s]+\/[^/\s]+$/.test(input.model) || !input.reasoningEffort || !input.reply) return { status: 'blocked', reason: 'configuration' };
  return { status: 'ready' };
}

export interface SafeNativeEvidence { readonly result: 'PASS' | 'FAIL'; readonly versions: { readonly trueforge: string; readonly sdk: string; readonly mcp: string; }; readonly phases: readonly string[]; readonly calls: readonly string[]; readonly policies?: readonly string[]; readonly readiness?: { readonly provider: 'daytona'; readonly skillCommit: string; readonly connectorDiscovered: boolean; readonly mcpDiscovered: boolean; readonly ownedSidecar: boolean; readonly probeCleaned: boolean; }; readonly receiptMatched: boolean; readonly terminalDone: boolean; readonly cleanup: readonly string[]; }
/** Removes all values except the fixed public vocabulary permitted in acceptance output. */
export function safeNativeEvidence(input: SafeNativeEvidence): SafeNativeEvidence {
  const names = input.calls.filter((name) => /^codealongai_[a-z_]+$/.test(name));
  const phases = input.phases.filter((phase) => /^(provider|snapshots|sandboxes|ready|model|reasoning|skill|connector|mcp-discovery)$/.test(phase));
  const cleanup = input.cleanup.filter((value) => /^(owned-sidecar|session-delete|probe-delete|profile-delete)$/.test(value));
  const policies = input.policies?.filter((value) => /^(start|question|replacement)$/.test(value));
  const readiness = input.readiness && input.readiness.provider === 'daytona' && /^[0-9a-f]{40}$/i.test(input.readiness.skillCommit) ? input.readiness : undefined;
  const version = (value: string): string => /^\d+\.\d+\.\d+$/.test(value) ? value : 'unknown';
  return { result: input.result, versions: { trueforge: version(input.versions.trueforge), sdk: version(input.versions.sdk), mcp: version(input.versions.mcp) }, phases, calls: names, ...(policies ? { policies } : {}), ...(readiness ? { readiness } : {}), receiptMatched: input.receiptMatched, terminalDone: input.terminalDone, cleanup };
}

const readTools = new Set(['codealongai_get_walkthrough_request', 'codealongai_get_walkthrough', 'codealongai_list_workspace_files', 'codealongai_read_workspace_file', 'codealongai_search_workspace']);
/** Complete bounded producer policy: authority first, one transition last, no post-transition calls. */
export function validTurnCallSequence(kind: 'ask' | 'reply', calls: readonly string[], forbidden: boolean): boolean {
  const transition = kind === 'ask' ? 'codealongai_start_walkthrough' : 'codealongai_commit_question_outcome';
  if (forbidden || calls.length < (kind === 'ask' ? 3 : 4) || calls.length > 9 || calls[0] !== 'codealongai_get_walkthrough_request' || calls[calls.length - 1] !== transition) return false;
  if (kind === 'reply' && calls[1] !== 'codealongai_get_walkthrough') return false;
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

export interface NativeReadinessFacts { readonly provider: 'daytona'; readonly phases: readonly string[]; readonly skillCommit: string; readonly connectorDiscovered: boolean; readonly ownership: boolean; readonly probeCleaned: boolean; }
/** Whitelist-only readiness evidence; rejects missing selected provider, build pin, connector, ownership, or cleanup. */
export function validNativeReadinessFacts(facts: NativeReadinessFacts, buildCommit: string): boolean {
  return facts.provider === 'daytona' && facts.phases.includes('snapshots') && facts.phases.includes('sandboxes') && facts.phases.includes('ready') && facts.skillCommit === buildCommit && /^[0-9a-f]{40}$/i.test(facts.skillCommit) && facts.connectorDiscovered && facts.ownership && facts.probeCleaned;
}
