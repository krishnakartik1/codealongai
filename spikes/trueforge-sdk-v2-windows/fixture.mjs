import { createServer as createHttpServer } from "node:http";
import process from "node:process";

import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = Number(portIndex >= 0 ? args[portIndex + 1] : 8890);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid --port value: ${String(args[portIndex + 1])}`);
}

const observations = {
  initialize: 0,
  toolsList: 0,
  toolsCall: 0,
  initializeProtocolVersions: [],
  protocolVersionHeaders: [],
  sessionHeaderCount: 0,
};

function createFixtureServer() {
  const server = new McpServer({
    name: "codealongai-sdk-v2-loopback-fixture",
    version: "0.0.0",
  });

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Inert discovery-only fixture tool.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );

  return server;
}

const mcpHandler = createMcpHandler(createFixtureServer, {
  legacy: "stateless",
  onerror: (error) => console.error("MCP fixture error", error),
});
const handleMcpRequest = toNodeHandler(mcpHandler);

function recordRequest(request, body) {
  const sessionHeader = request.headers["mcp-session-id"];
  if (typeof sessionHeader === "string") {
    observations.sessionHeaderCount += 1;
  }

  const protocolHeader = request.headers["mcp-protocol-version"];
  if (typeof protocolHeader === "string") {
    observations.protocolVersionHeaders.push(protocolHeader);
  }

  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (message?.method === "initialize") {
      observations.initialize += 1;
      const requestedVersion = message.params?.protocolVersion;
      if (typeof requestedVersion === "string") {
        observations.initializeProtocolVersions.push(requestedVersion);
      }
    } else if (message?.method === "tools/list") {
      observations.toolsList += 1;
    } else if (message?.method === "tools/call") {
      observations.toolsCall += 1;
    }
  }
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const httpServer = createHttpServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/observations") {
      sendJson(response, 200, observations);
      return;
    }

    if (requestUrl.pathname !== "/mcp") {
      sendJson(response, 404, { error: "not found" });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request);
      recordRequest(request, body);
      await handleMcpRequest(request, response, body);
      return;
    }

    await handleMcpRequest(request, response);
  } catch (error) {
    console.error("fixture request failed", error);
    if (!response.headersSent) {
      sendJson(response, 500, { error: "fixture request failed" });
    } else {
      response.end();
    }
  }
});

httpServer.listen(port, "127.0.0.1", () => {
  console.log(`fixture listening at http://127.0.0.1:${port}/mcp`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await mcpHandler.close();
  await new Promise((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
}

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
