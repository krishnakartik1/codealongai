import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';

interface WalkthroughSession { readonly stops: readonly { readonly id: string }[]; }
interface WalkthroughAcceptanceApi { readonly endpointState: string; readonly session: WalkthroughSession | undefined; replyTargetAt(stopId: string): object | undefined; }
const enabled = process.env.CODEALONGAI_NATIVE_ACCEPTANCE === '1';
const model = process.env.CODEALONGAI_NATIVE_ACCEPTANCE_MODEL;
const reasoningEffort = process.env.CODEALONGAI_NATIVE_ACCEPTANCE_REASONING_EFFORT;
const reply = process.env.CODEALONGAI_NATIVE_ACCEPTANCE_REPLY;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
async function eventually<T>(read: () => T | undefined, message: string, timeoutMs = 180_000): Promise<T> { const until = Date.now() + timeoutMs; while (Date.now() < until) { const value = read(); if (value !== undefined) return value; await new Promise<void>((resolve) => setTimeout(resolve, 100)); } throw new Error(message); }

suite('Native Ubuntu production acceptance', () => {
  test('proves a model-backed Ask and graph-producing Reply without changing the workspace', async function (this: Mocha.Context) {
    this.timeout(420_000);
    if (!enabled) this.skip();
    assert.match(model ?? '', /^[^/\s]+\/[^/\s]+$/, 'CODEALONGAI_NATIVE_ACCEPTANCE_MODEL must name the operator-selected provider/model.');
    assert.ok(reasoningEffort, 'CODEALONGAI_NATIVE_ACCEPTANCE_REASONING_EFFORT is required.');
    assert.ok(reply, 'CODEALONGAI_NATIVE_ACCEPTANCE_REPLY is required.');
    const extension = vscode.extensions.getExtension<WalkthroughAcceptanceApi>('krishnakartik1.codealongai'); assert.ok(extension, 'the packaged CodeAlongAI extension must be installed in the Extension Development Host.'); assert.equal(extension.isActive, true, 'the extension must survive Extension Development Host startup.');
    const api = await extension.activate(); assert.equal(api.session, undefined, 'a fresh profile must start without a walkthrough session.');
    const workspace = vscode.workspace.workspaceFolders?.[0]; assert.ok(workspace, 'the disposable acceptance workspace must be open.');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspace.uri, 'checkout.ts')); const before = digest(await readFile(document.uri.fsPath, 'utf8'));
    const configuration = vscode.workspace.getConfiguration('codealongai');
    await configuration.update('mcp.enabled', true, vscode.ConfigurationTarget.Global); await configuration.update('trueforge.model', model, vscode.ConfigurationTarget.Global); await configuration.update('trueforge.reasoningEffort', reasoningEffort, vscode.ConfigurationTarget.Global);
    const editor = await vscode.window.showTextDocument(document); editor.selection = new vscode.Selection(2, 0, 2, document.lineAt(2).text.length);
    await vscode.commands.executeCommand('codealongai.walkthrough.ask');
    const asked = await eventually(() => api.session, 'Ask did not produce a walkthrough session.'); assert.ok(asked.stops.length > 0, 'Ask must produce a model-backed walkthrough.'); assert.equal(api.endpointState, 'ready', 'Ask must use the real loopback MCP endpoint.');
    const replyTarget = await eventually(() => api.replyTargetAt(asked.stops[0].id), 'Ask did not render a native Reply target.');
    await vscode.commands.executeCommand('codealongai.walkthrough.submitComment', { thread: replyTarget, text: reply });
    const replied = await eventually(() => api.session && api.session.stops.length > asked.stops.length ? api.session : undefined, 'Reply did not produce a walkthrough graph.');
    assert.ok(replied.stops.length > asked.stops.length, 'Reply must add graph stops.'); assert.equal(digest(await readFile(document.uri.fsPath, 'utf8')), before, 'acceptance must not mutate the workspace document.'); assert.equal(vscode.workspace.textDocuments.some((candidate) => candidate.isDirty), false, 'acceptance must leave no dirty editor buffer.');
  });
});
