import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const spikeDirectory = dirname(fileURLToPath(import.meta.url));
const children = new Set();
const logs = new Map();

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const { port } = address;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function launch(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: spikeDirectory,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output = [];
  const capture = (chunk) => output.push(chunk.toString());
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  children.add(child);
  logs.set(child, { name, output });
  child.once("exit", () => children.delete(child));
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const timedOut = new Promise((resolve) => setTimeout(() => resolve("timeout"), 5_000));
  if ((await Promise.race([exited, timedOut])) === "timeout") {
    child.kill("SIGKILL");
    await exited;
  }
}

async function waitFor(url, { timeoutMs = 30_000, accepted = (status) => status < 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (accepted(response.status)) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`);
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { response, body };
}

function discoveredTools(body) {
  if (Array.isArray(body)) {
    return body;
  }
  if (Array.isArray(body?.tools)) {
    return body.tools;
  }
  if (Array.isArray(body?.data)) {
    return body.data;
  }
  throw new Error(`Unexpected discovery response: ${JSON.stringify(body)}`);
}

function assertPingOnly(body) {
  const tools = discoveredTools(body);
  assert.deepEqual(tools.map((tool) => tool.name), ["ping"]);
  assert.equal(tools[0].description, "Inert discovery-only fixture tool.");
  assert.deepEqual(tools[0].inputSchema, {
    type: "object",
    properties: {},
    $schema: "http://json-schema.org/draft-07/schema#",
  });
}

async function fixtureObservations(port) {
  const { response, body } = await requestJson(`http://127.0.0.1:${port}/observations`);
  assert.equal(response.status, 200);
  return body;
}

function assertDiscoveryTraffic(observations) {
  assert.ok(observations.initialize >= 1, "fixture did not observe initialize");
  assert.ok(observations.toolsList >= 1, "fixture did not observe tools/list");
  assert.equal(observations.toolsCall, 0, "fixture unexpectedly observed tools/call");
}

function printLogs(child) {
  const record = logs.get(child);
  if (record?.output.length) {
    console.error(`\n--- ${record.name} output ---\n${record.output.join("")}`);
  }
}

const temporaryDirectory = await mkdtemp(join(process.cwd(), ".trueforge-spike-"));
let fixture;
let trueforge;

try {
  const fixturePort = await reservePort();
  const trueforgePort = await reservePort();
  const fixtureHealth = `http://127.0.0.1:${fixturePort}/health`;
  const trueforgeBase = `http://127.0.0.1:${trueforgePort}`;
  const connectorName = "codealongai-loopback-spike";
  const discoveryUrl = `${trueforgeBase}/api/v1/mcp-servers/${connectorName}/tools`;

  fixture = launch("fixture (first process)", process.execPath, [
    join(spikeDirectory, "fixture.mjs"),
    "--port",
    String(fixturePort),
  ]);
  await waitFor(fixtureHealth);

  trueforge = launch("TrueForge 0.1.4", process.execPath, [
    join(spikeDirectory, "node_modules", "@truefoundry", "trueforge", "dist", "cli.js"),
    "--port",
    String(trueforgePort),
  ], {
    env: {
      SQLITE_PATH: join(temporaryDirectory, "trueforge.sqlite"),
      LOG_LEVEL: "debug",
      MCP_CONNECT_TIMEOUT_MS: "2000",
      MCP_REQUEST_TIMEOUT_MS: "5000",
    },
  });
  await waitFor(`${trueforgeBase}/api/v1/settings/mcp-servers`, { timeoutMs: 60_000 });

  const registration = await requestJson(`${trueforgeBase}/api/v1/settings/mcp-servers`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      manifest: {
        type: "remote",
        name: connectorName,
        url: `http://127.0.0.1:${fixturePort}/mcp`,
        description: "Disposable model-free loopback discovery fixture.",
      },
    }),
  });
  assert.equal(registration.response.status, 200, JSON.stringify(registration.body));

  const firstDiscovery = await requestJson(discoveryUrl);
  assert.equal(firstDiscovery.response.status, 200, JSON.stringify(firstDiscovery.body));
  assertPingOnly(firstDiscovery.body);
  const firstObservations = await fixtureObservations(fixturePort);
  assertDiscoveryTraffic(firstObservations);

  await stop(fixture);
  fixture = undefined;

  const disconnectedDiscovery = await requestJson(discoveryUrl);
  assert.equal(disconnectedDiscovery.response.status, 502, JSON.stringify(disconnectedDiscovery.body));

  fixture = launch("fixture (restarted process)", process.execPath, [
    join(spikeDirectory, "fixture.mjs"),
    "--port",
    String(fixturePort),
  ]);
  await waitFor(fixtureHealth);

  const rediscovery = await requestJson(discoveryUrl);
  assert.equal(rediscovery.response.status, 200, JSON.stringify(rediscovery.body));
  assertPingOnly(rediscovery.body);
  const restartedObservations = await fixtureObservations(fixturePort);
  assertDiscoveryTraffic(restartedObservations);

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        trueforgeVersion: "0.1.4",
        transport: "Streamable HTTP",
        modelConfigured: false,
        toolInvoked: false,
        registrationStatus: registration.response.status,
        firstDiscoveryStatus: firstDiscovery.response.status,
        disconnectedDiscoveryStatus: disconnectedDiscovery.response.status,
        rediscoveryStatus: rediscovery.response.status,
        discoveredTools: discoveredTools(rediscovery.body).map((tool) => tool.name),
        firstFixtureObservations: firstObservations,
        restartedFixtureObservations: restartedObservations,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (fixture) {
    printLogs(fixture);
  }
  if (trueforge) {
    printLogs(trueforge);
  }
  throw error;
} finally {
  await Promise.allSettled([...children].map(stop));
  await rm(temporaryDirectory, { recursive: true, force: true });
}
