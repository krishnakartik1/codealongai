import { randomUUID } from "node:crypto";
import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

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
};
const sessions = new Map();
const app = express();

app.use(express.json());

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.get("/observations", (_request, response) => {
  response.json(observations);
});

function recordMethod(request) {
  const requests = Array.isArray(request.body) ? request.body : [request.body];

  for (const message of requests) {
    if (message?.method === "initialize") {
      observations.initialize += 1;
    } else if (message?.method === "tools/list") {
      observations.toolsList += 1;
    } else if (message?.method === "tools/call") {
      observations.toolsCall += 1;
    }
  }
}

function createServer() {
  const server = new McpServer({
    name: "codealongai-loopback-fixture",
    version: "0.0.0",
  });

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Inert discovery-only fixture tool.",
      inputSchema: {},
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

app.post("/mcp", async (request, response) => {
  recordMethod(request);

  try {
    const sessionId = request.headers["mcp-session-id"];
    let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

    if (!session && request.body?.method === "initialize") {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, { server, transport });
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
      };

      await server.connect(transport);
      session = { server, transport };
    }

    if (!session) {
      response.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Missing or invalid MCP session" },
        id: request.body?.id ?? null,
      });
      return;
    }

    await session.transport.handleRequest(request, response, request.body);
  } catch (error) {
    console.error("fixture request failed", error);
    if (!response.headersSent) {
      response.status(500).json({ error: "fixture request failed" });
    }
  }
});

async function handleSessionRequest(request, response) {
  const sessionId = request.headers["mcp-session-id"];
  const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

  if (!session) {
    response.status(400).send("Missing or invalid MCP session");
    return;
  }

  await session.transport.handleRequest(request, response);
}

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

const httpServer = app.listen(port, "127.0.0.1", () => {
  console.log(`fixture listening at http://127.0.0.1:${port}/mcp`);
});

async function shutdown() {
  await Promise.allSettled(
    [...sessions.values()].map(async ({ server, transport }) => {
      await transport.close();
      await server.close();
    }),
  );
  await new Promise((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
}

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
