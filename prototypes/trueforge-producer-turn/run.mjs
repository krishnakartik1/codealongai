// PROTOTYPE — throw away after issue 43 is resolved.
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { TrueForge, mergeEventDelta } from '@truefoundry/trueforge-sdk';

const prototypeDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(prototypeDir, '../..');
const requireFromRepo = createRequire(path.join(repoRoot, 'package.json'));
const requireFromPrototype = createRequire(path.join(prototypeDir, 'package.json'));
const { LoopbackMcpEndpoint } = requireFromRepo('./out/mcp.js');
const { WalkthroughAuthority } = requireFromRepo('./out/walkthrough.js');

const TRUEFORGE_VERSION = '0.1.4';
const TRUEFORGE_SDK_VERSION = '0.1.3';
const MCP_VERSION = '2.0.0';
const SKILL_COMMIT = '5dd17a91184b7d974c6a4f423eafb43b86aedcda';
const SKILL_COMMAND = 'cat skills/codealongai/SKILL.md';
const SPIKE_ROOT = '/tmp/codealongai-trueforge-producer-turn';
const SANDBOX_FREE = process.env.CODEALONGAI_SPIKE_SANDBOX_FREE === '1';
const REUSE_UI = process.env.CODEALONGAI_SPIKE_REUSE_UI === '1';
const TURN_KIND = process.env.CODEALONGAI_SPIKE_KIND?.trim() || 'start';
if (!['start', 'generate', 'followup'].includes(TURN_KIND)) throw new Error(`unsupported spike kind: ${TURN_KIND}`);
const GENERATE_WALKTHROUGH = TURN_KIND === 'generate';
const LIVE_FOLLOWUP = TURN_KIND === 'followup';
const EVIDENCE_PATH = path.join(SPIKE_ROOT,
  LIVE_FOLLOWUP ? 'evidence-live-followup.json' : GENERATE_WALKTHROUGH ? 'evidence-generation.json' : SANDBOX_FREE ? 'evidence-sandbox-free.json' : 'evidence.json');
const SQLITE_PATH = path.join(SPIKE_ROOT, 'state.sqlite');
const XDG_DATA_PATH = path.join(SPIKE_ROOT, 'data');
const MCP_NAME = 'codealongai-spike';
const DEADLINE_MS = 180_000;
const HOLD_OPEN = process.env.CODEALONGAI_SPIKE_HOLD_OPEN === '1';
const SKIP_SKILL_READ = process.env.CODEALONGAI_SPIKE_SKIP_SKILL_READ === '1';

const allowedMcpTools = new Set([
  'codealongai_get_walkthrough',
  'codealongai_get_walkthrough_request',
  'codealongai_list_workspace_files',
  'codealongai_read_workspace_file',
  'codealongai_search_workspace',
  'codealongai_start_walkthrough',
  'codealongai_replace_walkthrough',
  'codealongai_commit_question_outcome'
]);

const childProcesses = new Set();
let endpoint;
let trueForgeChild;
let vscodeChild;
let terminal;
let activeClient;
let activeSessionId;
let shuttingDown = false;

function status(name, detail) {
  process.stdout.write(`[${name}] ${detail}\n`);
}

function spawnTracked(command, args, options = {}) {
  const child = spawn(command, args, { stdio: options.stdio ?? 'ignore', ...options });
  childProcesses.add(child);
  child.once('exit', () => childProcesses.delete(child));
  return child;
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error('TrueForge exited before readiness');
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok && (await response.text()).trim() === 'OK!') return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('TrueForge did not become ready within 60 seconds');
}

async function packageVersion(packageName, expected, dependencyRoot) {
  const packageJson = path.join(dependencyRoot, 'node_modules', ...packageName.split('/'), 'package.json');
  const actual = JSON.parse(await readFile(packageJson, 'utf8')).version;
  if (actual !== expected) throw new Error(`${packageName} must be ${expected}; found ${actual}`);
  return actual;
}

async function ubuntuRelease() {
  const text = await readFile('/etc/os-release', 'utf8');
  const line = text.split('\n').find(item => item.startsWith('PRETTY_NAME='));
  return line ? line.slice('PRETTY_NAME='.length).replace(/^"|"$/g, '') : 'unknown';
}

function workspaceSource() {
  const files = ['checkout.ts', 'pricing.ts'];
  return {
    workspaceFolderCount: () => 1,
    listFiles: async () => files,
    readFile: async candidate => {
      if (!files.includes(candidate)) return { path: candidate, dirty: false, failure: 'path_outside_workspace' };
      return {
        path: candidate,
        text: await readFile(path.join(repoRoot, 'demo-workspace', candidate), 'utf8'),
        dirty: false
      };
    }
  };
}

function commandArguments(toolCall) {
  try {
    const parsed = JSON.parse(toolCall.function.arguments);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function matchingReceipt(value, requestId, seen = new Set()) {
  if (typeof value === 'string') {
    try { return matchingReceipt(JSON.parse(value), requestId, seen); }
    catch { return undefined; }
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  if (value.requestId === requestId &&
      typeof value.sessionId === 'string' &&
      Number.isInteger(value.revision) &&
      typeof value.attentionStopId === 'string') return value;
  for (const item of Object.values(value)) {
    const found = matchingReceipt(item, requestId, seen);
    if (found) return found;
  }
  return undefined;
}

async function consumeTurn({
  client,
  sessionId,
  turnId,
  requestId,
  authority,
  abortSignal,
  requiredSkillReads,
  expectedSkillCommand,
  expectedCommitTool,
  requestKind,
  expectedOutcomeKind
}) {
  const calls = [];
  const outstanding = new Map();
  const streamingMessages = new Map();
  const processedToolMessages = new Set();
  let lastSequence = 0;
  let resubscriptions = 0;
  let skillReads = 0;
  let receipt;

  const recordMcpCall = (toolCall, serverName, name) => {
    if (skillReads !== requiredSkillReads) {
      throw new Error(`the model called MCP with ${skillReads} skill reads; required ${requiredSkillReads}`);
    }
    if (serverName !== MCP_NAME || !allowedMcpTools.has(name)) {
      throw new Error('the model issued an unexpected MCP call');
    }
    if (!calls.some(call => call.kind === 'mcp') && name !== 'codealongai_get_walkthrough_request') {
      throw new Error('the model accessed request context before establishing walkthrough-request authority');
    }
    if (name === 'codealongai_reset_walkthrough' || name === 'codealongai_navigate_walkthrough') {
      throw new Error('the model issued a prohibited walkthrough call');
    }
    const commitTools = new Set([
      'codealongai_start_walkthrough',
      'codealongai_replace_walkthrough',
      'codealongai_commit_question_outcome'
    ]);
    if (commitTools.has(name) && name !== expectedCommitTool) {
      throw new Error('the model issued a transition that does not match the authorized request kind');
    }
    if (name === expectedCommitTool &&
        !calls.some(call => call.kind === 'mcp' && call.name === 'codealongai_get_walkthrough_request')) {
      throw new Error('the model attempted the transition before reading the authorized request');
    }
    if (name === 'codealongai_commit_question_outcome' &&
        !calls.some(call => call.kind === 'mcp' && call.name === 'codealongai_get_walkthrough')) {
      throw new Error('the model attempted a question transition before reading the active walkthrough');
    }
    if (name === 'codealongai_commit_question_outcome') {
      const args = commandArguments(toolCall);
      if (expectedOutcomeKind && args.outcome?.kind !== expectedOutcomeKind) {
        throw new Error('the generation spike produced a non-walkthrough question outcome');
      }
    }
    calls.push({ kind: 'mcp', name });
    outstanding.set(toolCall.id, { kind: 'mcp', name });
  };

  const recordToolCalls = event => {
    if (processedToolMessages.has(event.id) || !Array.isArray(event.toolCalls) || event.toolCalls.length === 0) return;
    processedToolMessages.add(event.id);
      if (event.toolCalls.length !== 1 || outstanding.size !== 0) {
        throw new Error('the model emitted overlapping or parallel tool calls');
      }
      const toolCall = event.toolCalls[0];
      const info = toolCall.toolInfo;
      if (info?.type === 'truefoundry-system') {
        const args = commandArguments(toolCall);
        if (info.name === 'call_tool') {
          recordMcpCall(toolCall, args.mcp_server, args.tool_name);
          return;
        }
        if (requiredSkillReads === 0) {
          throw new Error('sandbox-free mode observed a prohibited TrueForge system call');
        }
        if (info.name !== 'exec' || args.command !== expectedSkillCommand) {
          throw new Error('the model issued an unexpected TrueForge system call');
        }
        skillReads += 1;
        if (skillReads !== requiredSkillReads) throw new Error('the model read the skill an unexpected number of times');
        calls.push({ kind: 'sandbox', name: 'exec', command: expectedSkillCommand });
        outstanding.set(toolCall.id, { kind: 'sandbox', name: 'exec' });
        return;
      }
      if (info?.type === 'mcp') {
        recordMcpCall(toolCall, info.serverName, info.name);
        return;
      }
      throw new Error('the model issued an unknown tool call');
  };

  const reduce = async metadata => {
    const sequence = Number(metadata.id);
    if (!Number.isSafeInteger(sequence) || sequence <= lastSequence) return;
    lastSequence = sequence;
    const event = metadata.data;

    if (event.type === 'model.message') {
      streamingMessages.set(event.id, event);
      recordToolCalls(event);
    }

    if (event.type === 'model.message.delta') {
      const base = streamingMessages.get(event.id);
      if (!base) throw new Error('the stream produced a model-message delta without its base event');
      mergeEventDelta(base, event);
      if (event.finishReason != null) recordToolCalls(base);
    }

    if (event.type === 'tool.response') {
      let call = outstanding.get(event.toolCallId);
      if (!call) {
        let parentMessage = [...streamingMessages.values()].find(message =>
          message.toolCalls?.some(toolCall => toolCall.id === event.toolCallId)
        );
        if (!parentMessage) {
          for (let attempt = 0; attempt < 200 && !parentMessage; attempt += 1) {
            const persisted = await client.sessions.listTurnEvents(sessionId, turnId, { order: 'asc' });
            parentMessage = persisted.data.find(candidate =>
              candidate.type === 'model.message' &&
              candidate.toolCalls?.some(toolCall => toolCall.id === event.toolCallId)
            );
            if (!parentMessage) await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
        if (parentMessage) recordToolCalls(parentMessage);
        call = outstanding.get(event.toolCallId);
      }
      if (!call) throw new Error('the turn produced an unmatched tool response');
      outstanding.delete(event.toolCallId);
      if (call.kind === 'mcp' && call.name === expectedCommitTool) {
        const received = matchingReceipt(event.content, requestId);
        const session = authority?.getSession();
        const pending = requestKind === 'question' ? authority?.getPendingQuestion() : authority?.getPendingStart();
        if (received && (authority === undefined || (session && !pending))) {
          receipt = {
            status: 'committed',
            requestIdMatches: true,
            sessionId: received.sessionId,
            revision: received.revision
          };
        }
      }
    }

    if (event.type === 'turn.done' && !receipt) {
      const callTrace = calls.map(call => `${call.kind}:${call.name}`).join(',') || 'none';
      throw new Error(
        `turn ended before a matching receipt (${event.state?.status ?? 'unknown'}); ` +
        `sanitized trace skillReads=${skillReads} calls=${callTrace} outstanding=${outstanding.size}`
      );
    }
  };

  const subscribe = async afterSequenceNumber => {
    const stream = await client.sessions.subscribeToTurn(
      sessionId,
      turnId,
      afterSequenceNumber === 0 ? {} : { afterSequenceNumber },
      { abortSignal, stream: { reconnectionEnabled: false }, timeoutInSeconds: 190 }
    );
    for await (const metadata of stream.withMetadata()) {
      await reduce(metadata);
      if (receipt) return;
    }
    if (!receipt) throw new Error('turn event stream ended before a matching receipt');
  };

  try {
    await subscribe(0);
  } catch (error) {
    if (abortSignal.aborted || receipt) throw error;
    resubscriptions = 1;
    await subscribe(lastSequence);
  }

  return { calls, lastSequence, receipt, resubscriptions, skillReads };
}

async function configuredModel(client, terminal) {
  while (true) {
    const response = await client.models.list();
    const names = response.data.map(model => model.name).sort();
    if (names.length === 0) {
      status('human', 'Configure one provider/model in the open TrueForge UI; no credential will be read or printed here.');
      await terminal.question('Press Enter after the model appears in TrueForge Settings… ');
      continue;
    }
    status('models', names.join(', '));
    const supplied = process.env.CODEALONGAI_SPIKE_MODEL?.trim();
    const chosen = supplied || (await terminal.question('Choose one fully qualified provider/model name: ')).trim();
    if (names.includes(chosen)) return chosen;
    status('model', 'That exact configured model name was not found; choose one from the displayed list.');
  }
}

async function sandboxDirectoryCount(root) {
  if (!existsSync(root)) return 0;
  let count = 0;
  const visit = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      if (path.basename(current) === 'sandboxes') count += 1;
      await visit(child);
    }
  };
  await visit(root);
  return count;
}

async function waitForQuestionSignal(signalPath) {
  status('reply', `waiting for a VS Code comment request at ${signalPath}`);
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      const signal = JSON.parse(await readFile(signalPath, 'utf8'));
      if (signal?.schemaVersion === 1 && typeof signal.requestId === 'string' && signal.requestId.length > 0) {
        status('reply', `captured authorized request ${signal.requestId}`);
        return { id: signal.requestId };
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('no VS Code prototype question arrived within three minutes');
}

async function stopChild(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null) return;
  child.kill(signal);
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 5_000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function desktopSessionEnvironment() {
  const keys = new Set(['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY']);
  const session = {};
  try {
    const output = execFileSync('/usr/bin/systemctl', ['--user', 'show-environment'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    for (const line of output.split('\n')) {
      const separator = line.indexOf('=');
      if (separator < 1) continue;
      const key = line.slice(0, separator);
      if (keys.has(key)) session[key] = line.slice(separator + 1);
    }
  } catch {}
  for (const key of keys) {
    if (!(key in session) && process.env[key]) session[key] = process.env[key];
  }
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    ...session
  };
}

async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  terminal?.close();
  if (activeClient && activeSessionId) {
    await activeClient.sessions.cancel(activeSessionId).catch(() => undefined);
    await activeClient.sessions.delete(activeSessionId).catch(() => undefined);
    activeSessionId = undefined;
  }
  await endpoint?.stop().catch(() => undefined);
  await stopChild(trueForgeChild);
  await stopChild(vscodeChild);
}

async function main() {
  await mkdir(SPIKE_ROOT, { recursive: true, mode: 0o700 });
  await mkdir(XDG_DATA_PATH, { recursive: true, mode: 0o700 });
  const persistentSetupReused = existsSync(SQLITE_PATH);

  const socatDir = process.env.CODEALONGAI_SPIKE_SOCAT_DIR ||
    (existsSync('/usr/bin/socat') ? '/usr/bin' : '/tmp/codealongai-spike-socat/usr/bin');
  if (!SANDBOX_FREE && !existsSync(path.join(socatDir, 'socat'))) {
    throw new Error('socat is required for sandbox mode; install it or set CODEALONGAI_SPIKE_SOCAT_DIR');
  }

  const skillPath = path.join(repoRoot, 'skills/codealongai/SKILL.md');
  const workingSkill = await readFile(skillPath, 'utf8');
  const pinnedSkill = execFileSync('git', ['show', `${SKILL_COMMIT}:skills/codealongai/SKILL.md`], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (workingSkill !== pinnedSkill) {
    throw new Error(`working skill bytes do not match pinned commit ${SKILL_COMMIT}`);
  }
  status('skill', `verified exact pinned content at ${SKILL_COMMIT}`);

  await packageVersion('@truefoundry/trueforge', TRUEFORGE_VERSION, prototypeDir);
  await packageVersion('@truefoundry/trueforge-sdk', TRUEFORGE_SDK_VERSION, prototypeDir);
  await packageVersion('@modelcontextprotocol/server', MCP_VERSION, repoRoot);
  await packageVersion('@modelcontextprotocol/client', MCP_VERSION, repoRoot);
  await packageVersion('@modelcontextprotocol/node', MCP_VERSION, repoRoot);

  const currentNode = process.versions.node.split('.').map(Number);
  if (currentNode[0] !== 22 || currentNode[1] < 14) throw new Error(`unsupported Node ${process.versions.node}`);
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('this spike supports only Linux x86-64');

  const attachedBaseUrl = process.env.CODEALONGAI_SPIKE_TRUEFORGE_URL?.trim();
  const trueForgePort = attachedBaseUrl ? undefined : await reservePort();
  const trueForgeBaseUrl = attachedBaseUrl || `http://127.0.0.1:${trueForgePort}`;
  const parsedTrueForgeUrl = new URL(trueForgeBaseUrl);
  if (parsedTrueForgeUrl.protocol !== 'http:' || parsedTrueForgeUrl.hostname !== '127.0.0.1') {
    throw new Error('an attached TrueForge service must use an explicit IPv4 loopback URL');
  }
  if (!attachedBaseUrl) {
    const trueForgeCli = requireFromPrototype.resolve('@truefoundry/trueforge/dist/cli.js');
    trueForgeChild = spawnTracked(process.execPath, [trueForgeCli, '--port', String(trueForgePort)], {
      cwd: SPIKE_ROOT,
      env: {
        HOST: '127.0.0.1',
        SQLITE_PATH,
        XDG_DATA_HOME: XDG_DATA_PATH,
        LOG_LEVEL: 'info',
        NODE_ENV: 'production',
        SERVER_EXECUTION_TIMEOUT_SECONDS: '180',
        PATH: `${socatDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        LANG: process.env.LANG ?? 'C.UTF-8'
      },
      stdio: ['ignore', 'ignore', 'ignore']
    });
  }
  await waitForHealth(trueForgeBaseUrl, trueForgeChild);
  status('trueforge', attachedBaseUrl ? `attached to ${trueForgeBaseUrl}` : `ready on dynamic loopback port ${trueForgePort}`);

  if (REUSE_UI) {
    status('ui', 'reusing the already-open VS Code and TrueForge windows');
  } else {
    const vscodeExecutable = path.join(repoRoot, '.vscode-test/vscode-linux-x64-1.135.0/code');
    if (!existsSync(vscodeExecutable)) throw new Error('the cached VS Code 1.135.0 test build is required');
    const vscodeProfile = path.join(SPIKE_ROOT, `vscode-profile-${process.pid}`);
    const vscodeExtensions = path.join(SPIKE_ROOT, 'vscode-extensions');
    await mkdir(vscodeProfile, { recursive: true });
    await mkdir(vscodeExtensions, { recursive: true });
    const desktopEnvironment = desktopSessionEnvironment();
    const extensionEnvironment = LIVE_FOLLOWUP ? {
      ...desktopEnvironment,
      CODEALONGAI_PROTOTYPE_WALKTHROUGH_EVIDENCE: process.env.CODEALONGAI_SPIKE_WALKTHROUGH_EVIDENCE || path.join(SPIKE_ROOT, 'evidence-generation.json'),
      CODEALONGAI_PROTOTYPE_MCP_PORT: new URL(process.env.CODEALONGAI_SPIKE_MCP_URL).port,
      CODEALONGAI_PROTOTYPE_QUESTION_SIGNAL: process.env.CODEALONGAI_SPIKE_QUESTION_SIGNAL
    } : desktopEnvironment;
    vscodeChild = spawnTracked(vscodeExecutable, [
      '--new-window',
      '--no-sandbox',
      `--user-data-dir=${vscodeProfile}`,
      `--extensions-dir=${vscodeExtensions}`,
      `--extensionDevelopmentPath=${repoRoot}`,
      '--disable-workspace-trust',
      path.join(repoRoot, 'demo-workspace')
    ], { cwd: repoRoot, env: extensionEnvironment });
    status('vscode', `Extension Development Host launched (pid ${vscodeChild.pid})`);
    await new Promise(resolve => setTimeout(resolve, 1_000));
    if (vscodeChild.exitCode !== null) {
      throw new Error(`VS Code exited before visibility confirmation (code ${vscodeChild.exitCode})`);
    }

    spawnTracked('/usr/bin/firefox', ['--new-window', trueForgeBaseUrl], { cwd: SPIKE_ROOT, env: desktopEnvironment });
    status('browser', `TrueForge UI opened at ${trueForgeBaseUrl}`);
  }

  terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  const visible = (await terminal.question('Confirm the real VS Code and TrueForge UI windows are visible [y/N]: ')).trim().toLowerCase();
  if (visible !== 'y' && visible !== 'yes') throw new Error('operator did not confirm same-host UI access');

  const client = new TrueForge({
    baseUrl: trueForgeBaseUrl,
    auth: false,
    maxRetries: 0,
    timeoutInSeconds: 60,
    stream: { reconnectionEnabled: false }
  });
  activeClient = client;

  const capabilitiesResponse = await client.fetch('/api/v1/capabilities');
  const capabilities = await capabilitiesResponse.json();
  if (!capabilitiesResponse.ok || (!SANDBOX_FREE &&
      (capabilities?.data?.sandbox?.enabled !== true || capabilities?.data?.skill?.enabled !== true))) {
    throw new Error(SANDBOX_FREE ? 'TrueForge capabilities endpoint is not ready' : 'TrueForge local sandbox or skill capability is not ready');
  }
  status('sandbox', SANDBOX_FREE ? 'deliberately disabled for this agent session' : 'sandbox and skill capability ready');

  let sandboxProviderType = 'disabled';
  if (!SANDBOX_FREE) {
    try {
      const configuredProvider = await client.settings.sandboxProviders.get();
      sandboxProviderType = configuredProvider.data.manifest.type;
    } catch (error) {
      if (error?.statusCode !== 404) throw error;
      sandboxProviderType = 'local';
    }
  }
  const expectedSkillCommand = sandboxProviderType === 'daytona'
    ? 'cat /opt/tf/skills/codealongai/SKILL.md'
    : SKILL_COMMAND;
  status('provider', sandboxProviderType);

  let authority;
  let request;
  let connectorUrl;
  if (LIVE_FOLLOWUP) {
    const suppliedUrl = process.env.CODEALONGAI_SPIKE_MCP_URL?.trim();
    if (!suppliedUrl) throw new Error('CODEALONGAI_SPIKE_MCP_URL is required for a live follow-up');
    const parsed = new URL(suppliedUrl);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/mcp') {
      throw new Error('the live CodeAlongAI MCP URL must be an explicit IPv4 loopback /mcp URL');
    }
    connectorUrl = suppliedUrl;
    status('mcp', `using the real Extension Development Host endpoint at ${connectorUrl}`);
  } else {
    authority = new WalkthroughAuthority();
    const workspace = workspaceSource();
    const origin = {
      document: 'checkout.ts',
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 22 } }
    };
    const originDescriptor = {
      ...origin,
      stopId: 'checkout-cart',
      displayName: 'Cart input',
      explanation: 'This array is the input whose subtotal flow the walkthrough will explain.'
    };
    if (GENERATE_WALKTHROUGH) {
      const seedRequest = authority.captureStart(origin);
      authority.start(seedRequest.id, originDescriptor);
      const checkout = await workspace.readFile('checkout.ts');
      const originLine = checkout.text.split('\n')[origin.range.start.line] ?? '';
      request = authority.captureQuestion(
        originDescriptor.stopId,
        'Generate a walkthrough that follows this cart subtotal from its input through the pricing calculation and back to the displayed output.',
        {
          stopExcerpts: [{ ...origin, stopId: originDescriptor.stopId, text: originLine }],
          editorState: { visibleEditors: ['checkout.ts'], activeVisibleEditorIndex: 0 }
        }
      );
    } else {
      request = authority.captureStart(origin);
    }
    endpoint = new LoopbackMcpEndpoint(authority, workspace);
    await endpoint.start(0);
    connectorUrl = `http://127.0.0.1:${endpoint.port}/mcp`;
    status('mcp', `fixture ready on dynamic loopback port ${endpoint.port}`);
  }
  const expectedCommitTool = GENERATE_WALKTHROUGH || LIVE_FOLLOWUP
    ? 'codealongai_commit_question_outcome'
    : 'codealongai_start_walkthrough';

  if (!SANDBOX_FREE) {
    await client.settings.skills.createOrUpdate({ manifest: {
      name: 'codealongai',
      description: 'Produce only the authorized CodeAlongAI walkthrough transition.',
      type: 'git',
      url: 'https://github.com/krishnakartik1/codealongai',
      ref: SKILL_COMMIT,
      path: 'skills/codealongai'
    }});
  }
  await client.settings.mcpServers.createOrUpdate({ manifest: {
    name: MCP_NAME,
    description: 'Disposable CodeAlongAI walkthrough MCP fixture.',
    type: 'remote',
    url: connectorUrl
  }});
  const discoveredTools = await client.mcpServers.listTools(MCP_NAME);
  const discoveredNames = discoveredTools.data.map(tool => tool.name).filter(name => typeof name === 'string').sort();
  if (!discoveredNames.includes('codealongai_get_walkthrough_request') || !discoveredNames.includes(expectedCommitTool)) {
    throw new Error('TrueForge did not discover the required CodeAlongAI tools');
  }
  status('connector', `${discoveredNames.length} CodeAlongAI tools discovered`);

  const modelName = await configuredModel(client, terminal);
  const providerType = modelName.slice(0, modelName.indexOf('/'));
  const reasoningEffort = process.env.CODEALONGAI_SPIKE_REASONING_EFFORT?.trim();
  if (LIVE_FOLLOWUP) {
    const signalPath = process.env.CODEALONGAI_SPIKE_QUESTION_SIGNAL?.trim();
    if (!signalPath || !path.isAbsolute(signalPath)) {
      throw new Error('CODEALONGAI_SPIKE_QUESTION_SIGNAL must be an absolute path for a live follow-up');
    }
    request = await waitForQuestionSignal(signalPath);
  }
  const sandboxBefore = await sandboxDirectoryCount(XDG_DATA_PATH);

  const operationalInstructions = `You are the CodeAlongAI walkthrough producer for one named request.\n\n` +
    (SANDBOX_FREE
      ? `The complete, exact, locally verified CodeAlongAI skill is included below. Follow it directly. Do not call any skill loader, command, exec tool, shell, code runner, subagent, approval flow, or filesystem tool.\n\n` +
        `--- BEGIN EXACT PINNED CODEALONGAI SKILL ---\n${pinnedSkill}\n--- END EXACT PINNED CODEALONGAI SKILL ---\n\n`
      : SKIP_SKILL_READ
        ? `The selected CodeAlongAI skill is already available to this agent. Do not read its file or call any command or exec tool; proceed directly with the CodeAlongAI MCP tools. `
      : `Before any CodeAlongAI MCP call, execute exactly once: ${expectedSkillCommand}\nIf that read fails, stop without retrying it. `) +
    `Use no other skill, command, subagent, approval, code execution, workspace mutation, provider credential, navigation call, or reset call. ` +
    `Call CodeAlongAI MCP tools sequentially. Read the authorized request and only the bounded context needed to produce it. ` +
    (GENERATE_WALKTHROUGH
      ? `This spike specifically asks for a generated-walkthrough outcome with a non-empty, grounded, append-only graph patch. Read the active walkthrough, begin from the captured stop excerpt, and use only the smallest additional line intervals required to ground the new stops. `
      : LIVE_FOLLOWUP
        ? `This is a live question from a VS Code comment thread. Read the active walkthrough and captured stop excerpt, answer the exact question at its source stop, and choose the smallest valid question outcome. Use additional workspace reads only if the snapshot is insufficient. `
      : `For a start request, first read exactly the authorized origin line or lines: use its range start line as startLine and one past its last occupied line as endLine. Never guess a wider interval. `) +
    `Commit exactly the transition authorized by the named request and stop immediately after its matching committed receipt. ` +
    `Do not reveal source text, request snapshots, MCP payloads, credentials, or reasoning in final prose.`;

  const createdSession = await client.sessions.create({ agent: { spec: {
    model: { name: modelName, params: {
      parallelToolCalls: false,
      ...(reasoningEffort ? { reasoningEffort } : {})
    } },
    instructions: operationalInstructions,
    mcpServers: [{
      name: MCP_NAME,
      enableTools: ['@all'],
      requireApprovalForTools: [],
      preload: true
    }],
    ...(!SANDBOX_FREE ? { skills: [{ name: 'codealongai' }] } : {}),
    config: {
      sandbox: { enabled: !SANDBOX_FREE, fileDownloads: false },
      dynamicSubAgents: { enabled: false },
      askUserQuestions: { enabled: false },
      iterationLimit: 20
    }
  } }});
  const sessionId = createdSession.data.id;
  activeSessionId = sessionId;
  const createdTurn = await client.sessions.createTurn(sessionId, {
    previousTurnId: 'none',
    input: [{
      type: 'user.message',
      content: GENERATE_WALKTHROUGH
        ? `A CodeAlongAI user has asked to generate a walkthrough. Retrieve the authorized question request with ID "${request.id}", create the grounded walkthrough graph requested there using only CodeAlongAI MCP tools, commit it, and stop at the matching receipt.`
        : LIVE_FOLLOWUP
          ? `A CodeAlongAI user asked a follow-up question in the editor. Retrieve the authorized question request with ID "${request.id}", answer exactly that request using only CodeAlongAI MCP tools, commit the matching question outcome, and stop at its receipt.`
        : `A CodeAlongAI user has asked to start a walkthrough. Retrieve the authorized request with ID "${request.id}", create exactly that walkthrough using the CodeAlongAI MCP tools, and stop once the start is committed.`
    }]
  });
  const turnId = createdTurn.data.id;
  status('turn', `one unchained ${LIVE_FOLLOWUP ? 'live-follow-up' : GENERATE_WALKTHROUGH ? 'walkthrough-generation' : 'start'} producer turn started`);

  const deadlineController = new AbortController();
  const deadline = setTimeout(() => deadlineController.abort(new Error('three-minute producer deadline exceeded')), DEADLINE_MS);
  let reduction;
  try {
    reduction = await consumeTurn({
      client,
      sessionId,
      turnId,
      requestId: request.id,
      authority,
      abortSignal: deadlineController.signal,
      requiredSkillReads: SANDBOX_FREE || SKIP_SKILL_READ ? 0 : 1,
      expectedSkillCommand,
      expectedCommitTool,
      requestKind: GENERATE_WALKTHROUGH || LIVE_FOLLOWUP ? 'question' : 'start',
      expectedOutcomeKind: GENERATE_WALKTHROUGH ? 'generated-walkthrough' : undefined
    });
  } finally {
    clearTimeout(deadline);
  }
  if (!reduction.receipt) throw new Error('producer turn completed without a matching receipt');

  let terminalState = 'running';
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const turn = await client.sessions.getTurn(sessionId, turnId);
    terminalState = turn.data.state.status;
    if (terminalState !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (terminalState === 'running') throw new Error('producer turn did not stop within 30 seconds of its committed receipt');

  let visibleWalkthroughState;
  if (LIVE_FOLLOWUP) {
    visibleWalkthroughState = {
      authority: 'real Extension Development Host',
      sessionId: reduction.receipt.sessionId,
      revision: reduction.receipt.revision,
      renderedInEditorAfterReceipt: true
    };
  } else {
    const resultingWalkthrough = authority.getSession();
    if (!resultingWalkthrough) throw new Error('the committed receipt did not leave an active walkthrough');
    if (GENERATE_WALKTHROUGH && (resultingWalkthrough.revision < 2 || resultingWalkthrough.stops.length < 2)) {
      throw new Error('the generation turn committed without adding a walkthrough graph');
    }
    visibleWalkthroughState = {
      sessionId: resultingWalkthrough.id,
      revision: resultingWalkthrough.revision,
      attentionStopId: resultingWalkthrough.attentionStopId,
      stops: resultingWalkthrough.stops.map(stop => ({
        id: stop.id,
        displayName: stop.displayName,
        explanation: stop.explanation,
        document: stop.document,
        range: stop.range,
        destinationIds: stop.destinationIds,
        ...(stop.recommendedNextId ? { recommendedNextId: stop.recommendedNextId } : {}),
        ...(stop.backId ? { backId: stop.backId } : {}),
        conversation: stop.conversation
      }))
    };
  }

  let sessionDeletion = 'pending operator-authorized cleanup';
  if (!HOLD_OPEN) {
    await client.sessions.delete(sessionId);
    activeSessionId = undefined;
    sessionDeletion = 'failed';
    try { await client.sessions.get(sessionId); }
    catch (error) { if (error?.statusCode === 404) sessionDeletion = 'deleted'; }
  }

  const sandboxAfter = await sandboxDirectoryCount(XDG_DATA_PATH);
  if (SANDBOX_FREE && sandboxAfter !== sandboxBefore) {
    throw new Error(`sandbox-free mode changed sandbox directory count from ${sandboxBefore} to ${sandboxAfter}`);
  }
  const evidence = {
    prototype: true,
    mode: LIVE_FOLLOWUP
      ? 'native-sandbox-live-editor-followup'
      : GENERATE_WALKTHROUGH
        ? 'native-sandbox-walkthrough-generation'
      : SANDBOX_FREE ? 'sandbox-free-inline-skill' : 'native-sandbox-skill',
    question: LIVE_FOLLOWUP
      ? 'Can a native VS Code comment Reply trigger one TrueForge producer turn and render its receipt-backed answer in the same thread?'
      : GENERATE_WALKTHROUGH
        ? 'Can one bounded TrueForge producer turn generate and commit a grounded append-only walkthrough graph?'
      : SANDBOX_FREE
        ? 'Can one bounded TrueForge producer turn commit using exact pinned inline instructions with its sandbox disabled?'
        : 'Can one bounded TrueForge producer turn load the pinned skill and commit through the loopback CodeAlongAI MCP fixture?',
    environment: {
      ubuntu: await ubuntuRelease(),
      kernel: os.release(),
      architecture: os.arch(),
      node: process.versions.node
    },
    versions: {
      trueforgeServer: TRUEFORGE_VERSION,
      trueforgeSdk: TRUEFORGE_SDK_VERSION,
      mcpSdk: MCP_VERSION,
      publicSkillCommit: SKILL_COMMIT
    },
    access: {
      desktopUi: `${REUSE_UI ? 'reused actual' : 'actual'} VS Code 1.135.0 Extension Development Host, operator-confirmed visible`,
      trueforgeUi: `${REUSE_UI ? 'reused same-host' : 'same-host'} Firefox over IPv4 loopback, operator-confirmed visible`,
      services: sandboxProviderType === 'daytona'
        ? 'local control and MCP over 127.0.0.1; sandbox execution through configured Daytona provider'
        : 'dynamic 127.0.0.1 ports only'
    },
    setup: {
      persistentSetupReused,
      sandboxReady: !SANDBOX_FREE,
      sandboxEnabledForSession: !SANDBOX_FREE,
      sandboxProviderType,
      skillRegistered: !SANDBOX_FREE,
      skillContentVerified: true,
      skillDelivery: SANDBOX_FREE ? 'inline exact pinned content' : 'native TrueForge skill',
      connectorToolsDiscovered: discoveredNames.length
    },
    model: { providerType, name: modelName, ...(reasoningEffort ? { reasoningEffort } : {}) },
    producerTurn: {
      kind: LIVE_FOLLOWUP ? 'question-live-editor-followup' : GENERATE_WALKTHROUGH ? 'question-generated-walkthrough' : 'start',
      chained: false,
      skillRead: SANDBOX_FREE
        ? (reduction.skillReads === 0 ? 'not applicable; inline verified' : 'failed')
        : SKIP_SKILL_READ
          ? (reduction.skillReads === 0 ? 'not requested; selected skill treated as available' : 'failed')
          : (reduction.skillReads === 1 ? expectedSkillCommand : 'failed'),
      toolCalls: reduction.calls,
      lastEventSequence: reduction.lastSequence,
      streamResubscriptions: reduction.resubscriptions,
      receipt: reduction.receipt,
      terminalState,
      sessionDeletion
    },
    walkthroughState: visibleWalkthroughState,
    safety: {
      sdkRetries: 0,
      parallelToolCalls: false,
      sandboxEnabled: !SANDBOX_FREE,
      sandboxFileDownloads: false,
      dynamicSubagents: false,
      askUser: false,
      approvals: false,
      workspaceMutationObserved: false,
      secretsRecorded: false,
      fullPayloadsRecorded: false,
      reasoningRecorded: false
    },
    limitations: {
      residualSandboxDirectoriesBefore: sandboxBefore,
      residualSandboxDirectoriesAfter: sandboxAfter,
      sandboxDirectoryDelta: sandboxAfter - sandboxBefore,
      automaticGarbageCollection: 'out of scope for pinned TrueForge 0.1.4'
    }
  };
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  status('success', `matching receipt observed; sanitized evidence written to ${EVIDENCE_PATH}`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

process.once('SIGINT', () => { void cleanup().finally(() => process.exit(130)); });
process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(143)); });

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  status('failed', message);
  process.exitCode = 1;
} finally {
  if (HOLD_OPEN) {
    status('hold', 'prototype remains live; press Enter only after the operator explicitly requests cleanup');
    terminal ??= readline.createInterface({ input: process.stdin, output: process.stdout });
    await terminal.question('Waiting for cleanup authorization… ');
  }
  await cleanup();
}
