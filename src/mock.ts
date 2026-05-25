import { join } from "node:path";
import type { ApiIR, FieldIR, TypeIR, TypeRefIR } from "./types.js";
import { writeTextFile } from "./utils.js";

export interface MockGenerationResult {
  outDir: string;
  files: string[];
}

export async function generateMockServer(ir: ApiIR, rootOutDir: string): Promise<MockGenerationResult> {
  const files = ["mock/server.mjs"];
  await writeTextFile(rootOutDir, files[0]!, renderMockServer(ir));
  return { outDir: join(rootOutDir, "mock"), files };
}

function renderMockServer(ir: ApiIR): string {
  const tokenRoutes = ir.client.oauth2
    ? [
        {
          id: "oauth_token",
          method: "POST",
          path: ir.client.oauth2.token_url,
          regex: pathToRegex(ir.client.oauth2.token_url),
          status: 200,
          body: { access_token: "mock_oauth_token", token_type: "Bearer", expires_in: 3600 },
          requestBody: undefined as unknown,
          multipart: false,
          streaming: null,
        },
      ]
    : [];
  const operationRoutes = ir.operations
    .filter((operation) => !operation.websocket)
    .map((operation) => ({
      id: operation.id,
      method: operation.http_method.toUpperCase(),
      path: operation.path,
      regex: pathToRegex(operation.path),
      status: operation.response ? 200 : 204,
      body: operation.response ? exampleForRef(ir, operation.response) : undefined,
      requestBody: operation.request ? exampleForRef(ir, operation.request.type) : undefined,
      multipart: operation.request?.multipart ?? false,
      streaming: operation.streaming
        ? {
            sse: operation.streaming.protocol === "sse",
            done: operation.streaming.done_sentinel ?? null,
            event: exampleForRef(ir, { kind: "ref", id: operation.streaming.event_type_id }),
          }
        : null,
    }));
  const routes = [...tokenRoutes, ...operationRoutes];
  const wsRoutes = ir.operations
    .filter((operation) => operation.websocket)
    .map((operation) => ({
      id: operation.id,
      path: operation.path,
      regex: pathToRegex(operation.path),
      event: operation.websocket?.server_event_type_id
        ? exampleForRef(ir, { kind: "ref", id: operation.websocket.server_event_type_id })
        : {},
    }));

  return `#!/usr/bin/env node
import http from "node:http";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const routes = ${JSON.stringify(routes, null, 2)};
const wsRoutes = ${JSON.stringify(wsRoutes, null, 2)};

function sendWsFrame(socket, text) {
  const payload = Buffer.from(text, "utf8");
  const length = payload.length;
  const header = length < 126 ? Buffer.from([0x81, length]) : Buffer.from([0x81, 126, (length >> 8) & 0xff, length & 0xff]);
  socket.write(Buffer.concat([header, payload]));
}

function handleUpgrade(request, socket) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const route = wsRoutes.find((candidate) => new RegExp(candidate.regex).test(url.pathname));
  const key = request.headers["sec-websocket-key"];
  if (!route || !key) {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n");
  for (let index = 0; index < 2; index += 1) {
    sendWsFrame(socket, JSON.stringify({ ...route.event, index }));
  }
  socket.on("data", () => {});
  socket.on("error", () => {});
  setTimeout(() => { try { socket.end(); } catch { /* closed */ } }, 250);
}

export function createMockServer() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = routes.find((candidate) => candidate.method === request.method && new RegExp(candidate.regex).test(url.pathname));
    if (!route) {
      sendJson(response, 404, { error: "No mock route matched", method: request.method, path: url.pathname });
      return;
    }

    await drain(request);
    response.setHeader("x-sdkgen-mock-route", route.id);

    const accept = String(request.headers["accept"] ?? "");
    if (route.streaming && accept.includes("text/event-stream")) {
      sendStream(response, route.streaming);
      return;
    }

    if (route.status === 204) {
      response.writeHead(204, { "connection": "close" });
      response.end();
      return;
    }
    sendJson(response, route.status, route.body);
  });
  server.on("upgrade", handleUpgrade);
  return server;
}

function sendStream(response, streaming) {
  response.writeHead(200, {
    "content-type": streaming.sse ? "text/event-stream" : "application/x-ndjson",
    "cache-control": "no-store",
    "connection": "close",
  });
  for (let index = 0; index < 2; index += 1) {
    const payload = JSON.stringify({ ...streaming.event, index });
    response.write(streaming.sse ? \`data: \${payload}\\n\\n\` : \`\${payload}\\n\`);
  }
  if (streaming.done) {
    response.write(streaming.sse ? \`data: \${streaming.done}\\n\\n\` : \`\${streaming.done}\\n\`);
  }
  response.end();
}

async function drain(request) {
  for await (const _chunk of request) {
    // Drain the request body so clients can reuse connections during tests.
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "connection": "close",
  });
  response.end(JSON.stringify(body ?? null));
}

function samplePath(path) {
  return path.replace(/\\{[^}]+\\}/g, "test");
}

async function selfTest() {
  const server = createMockServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    for (const route of routes) {
      const response = await fetch(\`http://127.0.0.1:\${port}\${samplePath(route.path)}\`, {
        method: route.method,
        headers: route.requestBody ? { "content-type": "application/json" } : undefined,
        body: route.requestBody && route.method !== "GET" && route.method !== "HEAD" ? JSON.stringify(route.requestBody) : undefined,
      });
      if (response.status !== route.status) {
        throw new Error(\`\${route.method} \${route.path} returned \${response.status}, expected \${route.status}\`);
      }
      if (route.status !== 204) {
        JSON.parse(await response.text());
      }
    }
    console.log(\`mock self-test passed (\${routes.length} routes)\`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  if (process.argv.includes("--check")) {
    console.log(\`mock server contains \${routes.length} routes\`);
    return;
  }
  if (process.argv.includes("--self-test")) {
    await selfTest();
    return;
  }

  const portIndex = process.argv.indexOf("--port");
  const port = portIndex === -1 ? 4010 : Number(process.argv[portIndex + 1] ?? "4010");
  const server = createMockServer();
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(\`mock server listening on http://127.0.0.1:\${actualPort}\`);
  });
  // Safety auto-shutdown so a conformance run that is killed before it can stop the
  // server never leaves an orphaned process lingering on the machine.
  const lifetime = Number(process.env.SDKGEN_MOCK_LIFETIME_MS ?? "60000");
  if (lifetime > 0) setTimeout(() => process.exit(0), lifetime).unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
`;
}

export function exampleForRef(ir: ApiIR, ref: TypeRefIR, seen = new Set<string>()): unknown {
  if (ref.nullable) return null;
  if (ref.kind === "primitive") {
    if (ref.name === "string") return exampleString(ref.format);
    if (ref.name === "integer") return 1;
    if (ref.name === "number") return 1.23;
    if (ref.name === "boolean") return true;
    return {};
  }
  if (ref.kind === "array") return [exampleForRef(ir, ref.items, seen)];
  if (ref.kind === "map") return { key: exampleForRef(ir, ref.values, seen) };
  if (ref.kind === "file") return null;
  const type = typeById(ir, ref.id);
  if (!type || seen.has(type.id)) return {};
  seen.add(type.id);
  const value = exampleForType(ir, type, seen);
  seen.delete(type.id);
  return value;
}

function exampleForType(ir: ApiIR, type: TypeIR, seen: Set<string>): unknown {
  if (type.kind === "object") {
    const out: Record<string, unknown> = {};
    for (const field of type.fields) {
      out[field.wire_name] = exampleForField(ir, field, seen);
    }
    return out;
  }
  if (type.kind === "enum") return type.values[0] ?? "value";
  if (type.kind === "union") return type.variants[0] ? exampleForRef(ir, type.variants[0], seen) : {};
  return exampleForRef(ir, type.target, seen);
}

function exampleForField(ir: ApiIR, field: FieldIR, seen: Set<string>): unknown {
  if (field.nullable || field.type.nullable) return null;
  if (field.wire_name === "id" || field.name === "id") return "mock_id";
  if (field.wire_name.includes("email")) return "dev@example.com";
  if (field.wire_name.includes("cursor")) return null;
  if (field.wire_name === "created") return 1_772_361_600;
  return exampleForRef(ir, field.type, seen);
}

function exampleString(format: string | undefined): string {
  if (format === "date-time") return "2026-05-25T00:00:00.000Z";
  if (format === "date") return "2026-05-25";
  if (format === "email") return "dev@example.com";
  if (format === "uuid") return "00000000-0000-4000-8000-000000000000";
  return "string";
}

function typeById(ir: ApiIR, id: string): TypeIR | undefined {
  return ir.types.find((type) => type.id === id);
}

function pathToRegex(path: string): string {
  const segments = path.split("/").map((segment) => {
    if (/^\{[^}]+\}$/.test(segment)) return "[^/]+";
    return escapeRegex(segment);
  });
  return `^${segments.join("/")}$`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
