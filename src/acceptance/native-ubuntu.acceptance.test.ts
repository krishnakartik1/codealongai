import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface WalkthroughSession { readonly revision: number; readonly attentionStopId: string; readonly origin: { readonly stopId: string }; readonly stops: readonly { readonly id: string; readonly destinationIds: readonly string[]; readonly recommendedNextId?: string }[]; }
interface WalkthroughAcceptanceApi { readonly endpointState: string; readonly session: WalkthroughSession | undefined; replyTargetAt(stopId: string): object | undefined; }
const enabled = process.env.CODEALONGAI_NATIVE_ACCEPTANCE === '1';
const model = process.env.CODEALONGAI_NATIVE_ACCEPTANCE_MODEL;
const reasoningEffort = process.env.CODEALONGAI_NATIVE_ACCEPTANCE_REASONING_EFFORT;
const reply = process.env.CODEALONGAI_NATIVE_ACCEPTANCE_REPLY;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
async function eventually<T>(read: () => T | undefined, message: string, timeoutMs = 180_000): Promise<T> { const until = Date.now() + timeoutMs; while (Date.now() < until) { const value = read(); if (value !== undefined) return value; await new Promise<void>((resolve) => setTimeout(resolve, 100)); } throw new Error(message); }
async function workspaceSnapshot(folder: string): Promise<readonly string[]> { const entries = await readdir(folder, { withFileTypes: true }); const snapshots: string[] = []; for (const entry of entries) { const file = path.join(folder, entry.name); if (entry.isDirectory()) snapshots.push(...await workspaceSnapshot(file)); else if ((await stat(file)).isFile()) snapshots.push(digest(await readFile(file, 'utf8'))); } return snapshots.sort(); }
function editorSnapshot(): readonly string[] { return vscode.window.visibleTextEditors.map((editor) => `${digest(editor.document.getText())}:${editor.selection.anchor.line}:${editor.selection.anchor.character}:${editor.selection.active.line}:${editor.selection.active.character}:${editor.viewColumn ?? 0}`).sort(); }

suite('Native Ubuntu production acceptance', () => {
  test('proves a model-backed Ask and graph-producing Reply without changing the workspace', async function (this: Mocha.Context) {
    this.timeout(420_000);
    if (!enabled) this.skip();
    assert.match(model ?? '', /^[^/\s]+\/[^/\s]+$/, 'CODEALONGAI_NATIVE_ACCEPTANCE_MODEL must name the operator-selected provider/model.');
    assert.ok(reasoningEffort, 'CODEALONGAI_NATIVE_ACCEPTANCE_REASONING_EFFORT is required.');
    assert.ok(reply, 'CODEALONGAI_NATIVE_ACCEPTANCE_REPLY is required.');
    const extension = vscode.extensions.getExtension<WalkthroughAcceptanceApi>('krishnakartik1.codealongai'); assert.ok(extension, 'the packaged CodeAlongAI extension must be installed in the Extension Development Host.'); assert.equal(extension.isActive, true, 'the extension must survive Extension Development Host startup.');
    const api = await extension.activate(); assert.equal(api.session, undefined, 'a fresh profile must start without a walkthrough session.');
    const workspace = vscode.workspace.workspaceFolders?.[0]; assert.ok(workspace, 'the disposable acceptance workspace must be open.'); const filesBefore = await workspaceSnapshot(workspace.uri.fsPath); const dirtyBefore = vscode.workspace.textDocuments.map((candidate) => `${candidate.uri.toString()}:${candidate.isDirty}`).sort();
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspace.uri, 'checkout.ts')); const before = digest(await readFile(document.uri.fsPath, 'utf8'));
    const configuration = vscode.workspace.getConfiguration('codealongai');
    await configuration.update('mcp.enabled', true, vscode.ConfigurationTarget.Global); await configuration.update('trueforge.model', model, vscode.ConfigurationTarget.Global); await configuration.update('trueforge.reasoningEffort', reasoningEffort, vscode.ConfigurationTarget.Global);
    const editor = await vscode.window.showTextDocument(document); editor.selection = new vscode.Selection(2, 0, 2, document.lineAt(2).text.length); const editorsBefore = editorSnapshot();
    await vscode.commands.executeCommand('codealongai.walkthrough.ask');
    const asked = await eventually(() => api.session, 'Ask did not produce a walkthrough session.'); assert.ok(asked.stops.length > 0, 'Ask must produce a model-backed walkthrough.'); assert.equal(api.endpointState, 'ready', 'Ask must use the real loopback MCP endpoint.');
    const replyTarget = await eventually(() => api.replyTargetAt(asked.stops[0].id), 'Ask did not render a native Reply target.');
    await vscode.commands.executeCommand('codealongai.walkthrough.submitComment', { thread: replyTarget, text: reply });
    const replied = await eventually(() => api.session && api.session.stops.length > asked.stops.length ? api.session : undefined, 'Reply did not produce a walkthrough graph.');
    assert.ok(replied.stops.length > asked.stops.length, 'Reply must add graph stops.'); assert.ok(replied.revision > asked.revision, 'Reply must advance the walkthrough revision.'); assert.equal(replied.origin.stopId, asked.origin.stopId, 'Reply must preserve the immutable origin.'); assert.equal(replied.attentionStopId, asked.attentionStopId, 'Reply must preserve named attention until navigation.');
    assert.equal(digest(await readFile(document.uri.fsPath, 'utf8')), before, 'acceptance must not mutate the workspace document.'); assert.deepEqual(await workspaceSnapshot(workspace.uri.fsPath), filesBefore, 'acceptance must not mutate workspace files.'); assert.deepEqual(vscode.workspace.textDocuments.map((candidate) => `${candidate.uri.toString()}:${candidate.isDirty}`).sort(), dirtyBefore, 'acceptance must preserve dirty-buffer state.'); assert.deepEqual(editorSnapshot(), editorsBefore, 'Ask and Reply must preserve visible editor layout and selection.');
    const source = replied.stops.find((stop) => stop.id === replied.attentionStopId); assert.ok(source?.recommendedNextId, 'Reply graph must offer an explicit Next destination.'); await vscode.commands.executeCommand('codealongai.walkthrough.next'); await eventually(() => api.session?.attentionStopId === source.recommendedNextId ? true : undefined, 'Next did not move named attention.'); assert.ok(await eventually(() => api.replyTargetAt(source.recommendedNextId!) ? true : undefined, 'the target thread must render only after explicit navigation.')); await vscode.commands.executeCommand('codealongai.walkthrough.back'); await eventually(() => api.session?.attentionStopId === replied.attentionStopId ? true : undefined, 'Back did not restore named attention.');
  });
});
