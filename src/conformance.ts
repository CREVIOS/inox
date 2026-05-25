// Generates per-language endpoint conformance tests that boot the spec-derived mock
// server and exercise every generated method (including pagination and streaming)
// at runtime. The mock is a Node script reused across all targets, so Python and Go
// tests spawn `node ../mock/server.mjs`.
import type { ApiIR, OperationIR, ResourceIR, TargetName, TypeRefIR } from "./types.js";
import { pascalCase, snakeCase } from "./utils.js";
import { operationAppliesToTarget, paginationShape, streamEventType } from "./generators/common.js";

type ExampleValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "file" }
  | { kind: "enum"; value: string | number }
  | { kind: "array"; items: ExampleValue }
  | { kind: "object"; typeName?: string; fields: Array<{ name: string; value: ExampleValue }> }
  | { kind: "unknown" };

function resourceById(ir: ApiIR, id: string): ResourceIR | undefined {
  return ir.resources.find((resource) => resource.id === id);
}

function accessorPath(ir: ApiIR, operation: OperationIR, casing: "camel" | "pascal"): string {
  const resource = resourceById(ir, operation.resource_id);
  const segments = resource?.path_segments ?? [];
  return segments.map((segment) => (casing === "pascal" ? pascalCase(segment) : segment)).join(".");
}

function typeById(ir: ApiIR, id: string) {
  return ir.types.find((type) => type.id === id);
}

function exampleValue(ir: ApiIR, ref: TypeRefIR, depth = 0): ExampleValue {
  if (depth > 6) return { kind: "unknown" };
  switch (ref.kind) {
    case "primitive":
      if (ref.name === "string") return { kind: "string", value: "test" };
      if (ref.name === "integer" || ref.name === "number") return { kind: "number", value: 1 };
      if (ref.name === "boolean") return { kind: "bool", value: true };
      return { kind: "unknown" };
    case "file":
      return { kind: "file" };
    case "array":
      return { kind: "array", items: exampleValue(ir, ref.items, depth + 1) };
    case "map":
      return { kind: "object", fields: [] };
    case "ref": {
      const type = typeById(ir, ref.id);
      if (!type) return { kind: "unknown" };
      if (type.kind === "enum") return { kind: "enum", value: type.values[0] ?? "value" };
      if (type.kind === "alias") return exampleValue(ir, type.target, depth + 1);
      if (type.kind === "union") return { kind: "object", fields: [] };
      if (type.kind === "object") {
        return {
          kind: "object",
          typeName: type.name,
          fields: type.fields
            .filter((field) => field.required)
            .map((field) => ({ name: field.name, value: exampleValue(ir, field.type, depth + 1) })),
        };
      }
      return { kind: "unknown" };
    }
    default:
      return { kind: "unknown" };
  }
}

/** Operations we can synthesize valid arguments for (no unknown required shapes). */
function isCallable(value: ExampleValue): boolean {
  if (value.kind === "unknown") return false;
  if (value.kind === "array") return isCallable(value.items);
  if (value.kind === "object") return value.fields.every((field) => isCallable(field.value));
  return true;
}

// ---------- TypeScript ----------

function tsValue(value: ExampleValue): string {
  switch (value.kind) {
    case "string":
      return JSON.stringify(value.value);
    case "number":
      return String(value.value);
    case "bool":
      return String(value.value);
    case "file":
      return "new Blob([new Uint8Array([1, 2, 3])])";
    case "enum":
      return JSON.stringify(value.value);
    case "array":
      return `[${tsValue(value.items)}]`;
    case "object":
      return `{ ${value.fields.map((field) => `${JSON.stringify(field.name)}: ${tsValue(field.value)}`).join(", ")} }`;
    default:
      return "undefined";
  }
}

function tsCall(ir: ApiIR, operation: OperationIR, methodName: string): string | undefined {
  const accessor = accessorPath(ir, operation, "camel");
  const pathParams = operation.params.filter((param) => param.location === "path");
  const queryParams = operation.params.filter((param) => param.location === "query");
  const hasParamsObject = Boolean(operation.request) || queryParams.length > 0 || pathParams.length > 1;
  const singlePathParam = pathParams.length === 1 && !hasParamsObject ? pathParams[0] : undefined;

  if (singlePathParam) {
    return `client.${accessor}.${methodName}("test")`;
  }
  if (hasParamsObject) {
    const fields: string[] = [];
    for (const param of pathParams) {
      const value = exampleValue(ir, param.type);
      if (!isCallable(value)) return undefined;
      fields.push(`${JSON.stringify(param.name)}: ${tsValue(value)}`);
    }
    if (operation.request) {
      const value = exampleValue(ir, operation.request.type);
      if (!isCallable(value)) return undefined;
      fields.push(`body: ${tsValue(value)}`);
    }
    return `client.${accessor}.${methodName}({ ${fields.join(", ")} })`;
  }
  return `client.${accessor}.${methodName}()`;
}

export function renderTsConformanceTest(ir: ApiIR): string {
  const clientName = ir.client.name;
  const lines: string[] = [];
  for (const operation of ir.operations.filter((op) => operationAppliesToTarget(ir, op, "typescript"))) {
    if (operation.websocket) continue;
    if (operation.streaming) {
      const methodName = operation.streaming.always ? operation.name : `${operation.name}Streaming`;
      const call = tsCall(ir, operation, methodName);
      if (!call) continue;
      lines.push(`    {
      const stream = await ${call};
      let chunks = 0;
      for await (const _event of stream) chunks += 1;
      assert.ok(chunks >= 1, "${operation.id} streamed at least one event");
    }`);
      if (!operation.streaming.always) {
        const plain = tsCall(ir, operation, operation.name);
        if (plain) lines.push(`    await ${plain};`);
      }
      continue;
    }
    const call = tsCall(ir, operation, operation.name);
    if (call) lines.push(`    await ${call};`);
    const shape = paginationShape(ir, operation);
    if (shape) {
      const pagerCall = tsCall(ir, operation, `${operation.name}AutoPaging`);
      if (pagerCall) {
        lines.push(`    {
      let count = 0;
      for await (const _item of ${pagerCall}) { count += 1; if (count > 20) break; }
    }`);
      }
    }
  }

  let wsBlock = "";
  {
    const wsOp = ir.operations.find((op) => operationAppliesToTarget(ir, op, "typescript") && op.websocket);
    if (wsOp) {
      const accessor = accessorPath(ir, wsOp, "camel");
      wsBlock = `    {
      const conn = client.${accessor}.${wsOp.name}();
      let received = 0;
      await new Promise((resolve) => {
        conn.onMessage(() => { received += 1; if (received >= 1) { conn.close(); resolve(undefined); } });
        setTimeout(() => { conn.close(); resolve(undefined); }, 3000);
      });
      assert.ok(received >= 1, "websocket received a server event");
    }`;
    }
  }

  let rawBlock = "";
  {
    const rawOp = ir.operations.find((op) => operationAppliesToTarget(ir, op, "typescript") && !op.streaming && !op.websocket && Boolean(op.response));
    const call = rawOp ? tsCall(ir, rawOp, rawOp.name) : undefined;
    if (rawOp && call) {
      const rawCall = call.replace(`.${rawOp.name}(`, `.withRawResponse.${rawOp.name}(`);
      rawBlock = `    {
      const raw = await ${rawCall};
      assert.equal(raw.response.status, 200, "raw response exposes status");
      assert.ok(raw.data !== undefined, "raw response exposes parsed data");
    }`;
    }
  }

  let oauthBlock = "";
  if (ir.client.oauth2) {
    const op = ir.operations.find((candidate) => operationAppliesToTarget(ir, candidate, "typescript") && !candidate.streaming && !candidate.websocket);
    const call = op ? tsCall(ir, op, op.name) : undefined;
    if (call) {
      oauthBlock = `    const oauthClient = new ${clientName}({ clientId: "client-id", clientSecret: "client-secret", baseUrl: \`http://127.0.0.1:\${port}\` });
    await ${call.replace("client.", "oauthClient.")};`;
    }
  }

  return `import assert from "node:assert/strict";
import test from "node:test";
import { createMockServer } from "../../mock/server.mjs";
import ${clientName} from "../dist/index.js";

test("generated SDK calls every endpoint against the mock server", async () => {
  const server = createMockServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    let observed = 0;
    const client = new ${clientName}({ apiKey: "test", baseUrl: \`http://127.0.0.1:\${port}\`, validateResponses: true, hooks: { onResponse: () => { observed += 1; } } });
${lines.join("\n")}
${rawBlock}
${wsBlock}
${oauthBlock}
    assert.ok(observed > 0, "observability hook fired");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
`;
}

// ---------- Python ----------

function pyValue(value: ExampleValue): string {
  switch (value.kind) {
    case "string":
      return JSON.stringify(value.value);
    case "number":
      return String(value.value);
    case "bool":
      return value.value ? "True" : "False";
    case "file":
      return "b\"\\x01\\x02\\x03\"";
    case "enum":
      return JSON.stringify(value.value);
    case "array":
      return `[${pyValue(value.items)}]`;
    case "object":
      return `{${value.fields.map((field) => `${JSON.stringify(field.name)}: ${pyValue(field.value)}`).join(", ")}}`;
    default:
      return "None";
  }
}

function pyCall(ir: ApiIR, operation: OperationIR, methodName: string): string | undefined {
  const accessor = accessorPath(ir, operation, "camel");
  const pathParams = operation.params.filter((param) => param.location === "path");
  const args: string[] = [];
  for (const param of pathParams) {
    const value = exampleValue(ir, param.type);
    if (!isCallable(value)) return undefined;
    args.push(pyValue(value));
  }
  if (operation.request) {
    const value = exampleValue(ir, operation.request.type);
    if (!isCallable(value)) return undefined;
    args.push(pyValue(value));
  }
  return `client.${accessor}.${snakeCase(methodName)}(${args.join(", ")})`;
}

export function renderPyConformanceTest(ir: ApiIR, packageName: string): string {
  const clientName = ir.client.name;
  const lines: string[] = [];
  for (const operation of ir.operations.filter((op) => operationAppliesToTarget(ir, op, "python") && !op.websocket)) {
    if (operation.streaming) {
      const methodName = operation.streaming.always ? operation.name : `${operation.name}_streaming`;
      const call = pyCall(ir, operation, methodName);
      if (!call) continue;
      lines.push(`            chunks = list(${call})
            self.assertGreaterEqual(len(chunks), 1)`);
      if (!operation.streaming.always) {
        const plain = pyCall(ir, operation, operation.name);
        if (plain) lines.push(`            ${plain}`);
      }
      continue;
    }
    const call = pyCall(ir, operation, operation.name);
    if (call) lines.push(`            ${call}`);
    const shape = paginationShape(ir, operation);
    if (shape) {
      const pagerCall = pyCall(ir, operation, `${operation.name}_auto_paging`);
      if (pagerCall) {
        lines.push(`            count = 0
            for _item in ${pagerCall}:
                count += 1
                if count > 20:
                    break`);
      }
    }
  }

  let oauthBlock = "";
  if (ir.client.oauth2) {
    const op = ir.operations.find((candidate) => operationAppliesToTarget(ir, candidate, "python") && !candidate.streaming);
    const call = op ? pyCall(ir, op, op.name) : undefined;
    if (call) {
      oauthBlock = `            oauth_client = ${clientName}(client_id="client-id", client_secret="client-secret", base_url=f"http://127.0.0.1:{port}")
            ${call.replace("client.", "oauth_client.")}`;
    }
  }

  return `import pathlib
import re
import subprocess
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from ${packageName} import ${clientName}  # noqa: E402


class EndpointConformanceTest(unittest.TestCase):
    def test_endpoints(self) -> None:
        proc = subprocess.Popen(
            ["node", "../mock/server.mjs", "--port", "0"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        try:
            port = None
            for _ in range(50):
                line = proc.stdout.readline()
                if not line:
                    break
                match = re.search(r"127\\.0\\.0\\.1:(\\d+)", line)
                if match:
                    port = int(match.group(1))
                    break
            self.assertIsNotNone(port, "mock server did not start")
            observed = []
            client = ${clientName}(api_key="test", base_url=f"http://127.0.0.1:{port}", on_response=lambda info: observed.append(info))
${lines.join("\n")}
${oauthBlock}
            self.assertGreater(len(observed), 0, "observability hook fired")
        finally:
            proc.terminate()


if __name__ == "__main__":
    unittest.main()
`;
}

// ---------- Ruby ----------

function rbValue(value: ExampleValue): string {
  switch (value.kind) {
    case "string":
      return JSON.stringify(value.value);
    case "number":
      return String(value.value);
    case "bool":
      return value.value ? "true" : "false";
    case "file":
      return `{ filename: "upload.bin", content: "\\x01\\x02\\x03" }`;
    case "enum":
      return JSON.stringify(value.value);
    case "array":
      return `[${rbValue(value.items)}]`;
    case "object":
      return `{ ${value.fields.map((field) => `${JSON.stringify(field.name)} => ${rbValue(field.value)}`).join(", ")} }`;
    default:
      return "nil";
  }
}

function rbCall(ir: ApiIR, operation: OperationIR, methodName: string): string | undefined {
  const accessor = accessorPath(ir, operation, "camel");
  const pathParams = operation.params.filter((param) => param.location === "path");
  const args: string[] = [];
  for (const param of pathParams) {
    const value = exampleValue(ir, param.type);
    if (!isCallable(value)) return undefined;
    args.push(rbValue(value));
  }
  if (operation.request) {
    const value = exampleValue(ir, operation.request.type);
    if (!isCallable(value)) return undefined;
    args.push(rbValue(value));
  }
  const argStr = args.length ? `(${args.join(", ")})` : "";
  return `client.${accessor}.${methodName}${argStr}`;
}

export function renderRubyConformanceTest(ir: ApiIR, gem: string, mod: string): string {
  const lines: string[] = [];
  for (const operation of ir.operations.filter((op) => operationAppliesToTarget(ir, op, "ruby") && !op.websocket)) {
    if (operation.streaming) {
      const methodName = operation.streaming.always ? snakeCase(operation.name) : `${snakeCase(operation.name)}_streaming`;
      const call = rbCall(ir, operation, methodName);
      if (!call) continue;
      lines.push(`  chunks = ${call}.to_a
  assert(chunks.length >= 1, "${operation.id} streamed at least one event")`);
      if (!operation.streaming.always) {
        const plain = rbCall(ir, operation, snakeCase(operation.name));
        if (plain) lines.push(`  ${plain}`);
      }
      continue;
    }
    const call = rbCall(ir, operation, snakeCase(operation.name));
    if (call) lines.push(`  ${call}`);
    const shape = paginationShape(ir, operation);
    if (shape) {
      const pagerCall = rbCall(ir, operation, `${snakeCase(operation.name)}_auto_paging`);
      if (pagerCall) {
        lines.push(`  count = 0
  ${pagerCall} { |_item| count += 1; break if count > 20 }`);
      }
    }
  }

  let oauthBlock = "";
  if (ir.client.oauth2) {
    const op = ir.operations.find((candidate) => operationAppliesToTarget(ir, candidate, "ruby") && !candidate.streaming);
    const call = op ? rbCall(ir, op, snakeCase(op.name)) : undefined;
    if (call) {
      oauthBlock = `  oauth_client = ${mod}::Client.new(client_id: "client-id", client_secret: "client-secret", base_url: "http://127.0.0.1:#{port}")
  ${call.replace("client.", "oauth_client.")}`;
    }
  }

  return `require_relative "../lib/${gem}"

def assert(condition, message)
  raise message unless condition
end

io = IO.popen(["node", "../mock/server.mjs", "--port", "0"])
port = nil
50.times do
  line = io.gets
  break unless line
  if line =~ /127\\.0\\.0\\.1:(\\d+)/
    port = Regexp.last_match(1)
    break
  end
end
assert(port, "mock server did not start")

begin
  observed = 0
  client = ${mod}::Client.new(api_key: "test", base_url: "http://127.0.0.1:#{port}", on_response: ->(_info) { observed += 1 })
${lines.join("\n")}
${oauthBlock}
  assert(observed > 0, "observability hook fired")
  puts "ruby conformance passed"
ensure
  begin
    Process.kill("TERM", io.pid)
  rescue StandardError
    nil
  end
  io.close rescue nil
end
`;
}

// ---------- Java ----------

function javaValue(value: ExampleValue): string {
  switch (value.kind) {
    case "string":
      return JSON.stringify(value.value);
    case "number":
      return `${value.value}L`;
    case "bool":
      return value.value ? "true" : "false";
    case "file":
      return "new byte[] { 1, 2, 3 }";
    case "enum":
      return JSON.stringify(value.value);
    case "array":
      return `java.util.List.of(${javaValue(value.items)})`;
    case "object":
      return `java.util.Map.of(${value.fields.map((field) => `${JSON.stringify(field.name)}, ${javaValue(field.value)}`).join(", ")})`;
    default:
      return "null";
  }
}

function javaConformanceCall(ir: ApiIR, operation: OperationIR, methodName: string): string | undefined {
  const accessor = ir.resources.find((r) => r.id === operation.resource_id)?.path_segments.map((s) => snakeCase(s).replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase())).join(".");
  if (!accessor) return undefined;
  const pathParams = operation.params.filter((param) => param.location === "path");
  const queryParams = operation.params.filter((param) => param.location === "query");
  const args: string[] = [];
  for (const param of pathParams) {
    const value = exampleValue(ir, param.type);
    if (!isCallable(value)) return undefined;
    args.push(javaValue(value));
  }
  if (operation.request) {
    const value = exampleValue(ir, operation.request.type);
    if (!isCallable(value)) return undefined;
    args.push(javaValue(value));
  }
  for (const _ of queryParams) args.push("null");
  return `client.${accessor}.${methodName}(${args.join(", ")})`;
}

export function renderJavaConformanceTest(ir: ApiIR, pkg: string): string {
  const ident = (name: string) => snakeCase(name).replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  const lines: string[] = [];
  for (const operation of ir.operations.filter((op) => operationAppliesToTarget(ir, op, "java") && !op.websocket)) {
    if (operation.streaming) {
      const methodName = operation.streaming.always ? ident(operation.name) : `${ident(operation.name)}Streaming`;
      const call = javaConformanceCall(ir, operation, methodName);
      if (!call) continue;
      lines.push(`            if (${call}.size() < 1) throw new RuntimeException("${operation.id} streamed no events");`);
      if (!operation.streaming.always) {
        const plain = javaConformanceCall(ir, operation, ident(operation.name));
        if (plain) lines.push(`            ${plain};`);
      }
      continue;
    }
    const call = javaConformanceCall(ir, operation, ident(operation.name));
    if (call) lines.push(`            ${call};`);
    const shape = paginationShape(ir, operation);
    if (shape) {
      const pagerCall = javaConformanceCall(ir, operation, `${ident(operation.name)}AutoPaging`);
      if (pagerCall) lines.push(`            ${pagerCall};`);
    }
  }

  let oauthBlock = "";
  if (ir.client.oauth2) {
    const op = ir.operations.find((candidate) => operationAppliesToTarget(ir, candidate, "java") && !candidate.streaming);
    const call = op ? javaConformanceCall(ir, op, ident(op.name)) : undefined;
    if (call) {
      oauthBlock = `            ClientOptions oauthOpts = new ClientOptions();
            oauthOpts.clientId = "client-id";
            oauthOpts.clientSecret = "client-secret";
            oauthOpts.baseUrl = "http://127.0.0.1:" + port;
            Client oauthClient = new Client(oauthOpts);
            ${call.replace("client.", "oauthClient.")};`;
    }
  }

  return `package ${pkg};

import java.io.File;
import java.nio.file.Files;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class Conformance {
    public static void main(String[] args) throws Exception {
        File mock = new File(System.getProperty("user.dir"), "../mock/server.mjs");
        File log = File.createTempFile("sdkgen-mock", ".log");
        Process proc = new ProcessBuilder("node", mock.getCanonicalPath(), "--port", "0")
            .redirectOutput(log)
            .redirectError(ProcessBuilder.Redirect.DISCARD)
            .start();
        String port = null;
        Pattern pattern = Pattern.compile("127\\\\.0\\\\.0\\\\.1:(\\\\d+)");
        for (int i = 0; i < 100 && port == null; i++) {
            for (String l : Files.readAllLines(log.toPath())) {
                Matcher m = pattern.matcher(l);
                if (m.find()) { port = m.group(1); break; }
            }
            if (port == null) Thread.sleep(50);
        }
        if (port == null) throw new RuntimeException("mock server did not start");
        boolean success = false;
        try {
            final int[] observed = { 0 };
            ClientOptions opts = new ClientOptions();
            opts.apiKey = "test";
            opts.baseUrl = "http://127.0.0.1:" + port;
            opts.onResponse = info -> observed[0]++;
            Client client = new Client(opts);
${lines.join("\n")}
${oauthBlock}
            if (observed[0] == 0) throw new RuntimeException("observability hook did not fire");
            System.out.println("java conformance passed");
            success = true;
        } finally {
            try {
                proc.destroy();
                if (!proc.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) {
                    proc.destroyForcibly();
                    proc.waitFor();
                }
            } catch (Exception cleanupError) {
                if (!success) throw cleanupError;
            } finally {
                log.delete();
            }
        }
    }
}
`;
}

// ---------- C# ----------

function csValue(value: ExampleValue): string {
  switch (value.kind) {
    case "string":
      return JSON.stringify(value.value);
    case "number":
      return `${value.value}L`;
    case "bool":
      return value.value ? "true" : "false";
    case "file":
      return "new byte[] { 1, 2, 3 }";
    case "enum":
      return JSON.stringify(value.value);
    case "array":
      return `new object?[] { ${csValue(value.items)} }`;
    case "object":
      return `new Dictionary<string, object?> { ${value.fields.map((field) => `[${JSON.stringify(field.name)}] = ${csValue(field.value)}`).join(", ")} }`;
    default:
      return "null";
  }
}

function csCall(ir: ApiIR, operation: OperationIR, methodName: string): string | undefined {
  const accessor = accessorPath(ir, operation, "pascal");
  const pathParams = operation.params.filter((param) => param.location === "path");
  const args: string[] = [];
  for (const param of pathParams) {
    const value = exampleValue(ir, param.type);
    if (!isCallable(value)) return undefined;
    args.push(csValue(value));
  }
  if (operation.request) {
    const value = exampleValue(ir, operation.request.type);
    if (!isCallable(value)) return undefined;
    args.push(csValue(value));
  }
  return `client.${accessor}.${methodName}(${args.join(", ")})`;
}

export function renderCsharpConformanceTest(ir: ApiIR, ns: string): string {
  const lines: string[] = [];
  for (const operation of ir.operations.filter((op) => operationAppliesToTarget(ir, op, "csharp") && !op.websocket)) {
    if (operation.streaming) {
      const methodName = operation.streaming.always ? `${pascalCase(operation.name)}Async` : `${pascalCase(operation.name)}StreamingAsync`;
      const call = csCall(ir, operation, methodName);
      if (!call) continue;
      lines.push(`        var ${csVar(operation, "chunks")} = 0;
        await foreach (var _ev in ${call}) ${csVar(operation, "chunks")}++;
        if (${csVar(operation, "chunks")} < 1) throw new Exception("${operation.id} streamed no events");`);
      if (!operation.streaming.always) {
        const plain = csCall(ir, operation, `${pascalCase(operation.name)}Async`);
        if (plain) lines.push(`        await ${plain};`);
      }
      continue;
    }
    const call = csCall(ir, operation, `${pascalCase(operation.name)}Async`);
    if (call) lines.push(`        await ${call};`);
    const shape = paginationShape(ir, operation);
    if (shape) {
      const pagerCall = csCall(ir, operation, `${pascalCase(operation.name)}AutoPagingAsync`);
      if (pagerCall) {
        lines.push(`        var ${csVar(operation, "count")} = 0;
        await foreach (var _it in ${pagerCall}) { ${csVar(operation, "count")}++; if (${csVar(operation, "count")} > 20) break; }`);
      }
    }
  }

  let oauthBlock = "";
  if (ir.client.oauth2) {
    const op = ir.operations.find((candidate) => operationAppliesToTarget(ir, candidate, "csharp") && !candidate.streaming);
    const call = op ? csCall(ir, op, `${pascalCase(op.name)}Async`) : undefined;
    if (call) {
      oauthBlock = `        var oauthClient = new Client(new ClientOptions { ClientId = "client-id", ClientSecret = "client-secret", BaseUrl = $"http://127.0.0.1:{port}" });
        await ${call.replace("client.", "oauthClient.")};`;
    }
  }

  return `using System.Diagnostics;
using System.Text.RegularExpressions;
using ${ns};

static string FindMock()
{
    var dir = AppContext.BaseDirectory;
    for (var i = 0; i < 10 && dir != null; i++)
    {
        var candidate = Path.Combine(dir, "..", "mock", "server.mjs");
        if (File.Exists(candidate)) return Path.GetFullPath(candidate);
        dir = Directory.GetParent(dir)?.FullName;
    }
    throw new Exception("mock server not found");
}

var psi = new ProcessStartInfo("node", $"\\"{FindMock()}\\" --port 0") { RedirectStandardOutput = true, UseShellExecute = false };
var proc = Process.Start(psi)!;
string? port = null;
for (var i = 0; i < 50; i++)
{
    var line = proc.StandardOutput.ReadLine();
    if (line == null) break;
    var match = Regex.Match(line, @"127\\.0\\.0\\.1:(\\d+)");
    if (match.Success) { port = match.Groups[1].Value; break; }
}
if (port == null) throw new Exception("mock server did not start");

try
{
    var observed = 0;
    var client = new Client(new ClientOptions { ApiKey = "test", BaseUrl = $"http://127.0.0.1:{port}", OnResponse = _ => observed++ });
${lines.join("\n")}
${oauthBlock}
    if (observed == 0) throw new Exception("observability hook did not fire");
    Console.WriteLine("csharp conformance passed");
}
finally
{
    try { proc.Kill(); } catch { }
}
`;
}

function csVar(operation: OperationIR, base: string): string {
  return `${base}_${pascalCase(operation.id)}`;
}

// ---------- Go ----------

function goValue(value: ExampleValue): string {
  switch (value.kind) {
    case "string":
      return `"test"`;
    case "number":
      return "1";
    case "bool":
      return "true";
    case "file":
      return "[]byte{1, 2, 3}";
    case "enum":
      return JSON.stringify(String(value.value));
    case "array":
      return `[]any{${goValue(value.items)}}`;
    case "object":
      return `${value.typeName ?? "map[string]any"}{${value.fields.map((field) => `${pascalCase(field.name)}: ${goValue(field.value)}`).join(", ")}}`;
    default:
      return "nil";
  }
}

function goParamsLiteral(ir: ApiIR, operation: OperationIR, paramsName: string): string | undefined {
  const pathParams = operation.params.filter((param) => param.location === "path");
  const fields: string[] = [];
  for (const param of pathParams) {
    const value = exampleValue(ir, param.type);
    if (!isCallable(value)) return undefined;
    fields.push(`${pascalCase(param.name)}: ${goValue(value)}`);
  }
  if (operation.request) {
    const value = exampleValue(ir, operation.request.type);
    if (!isCallable(value)) return undefined;
    fields.push(`Body: ${goValue(value)}`);
  }
  return `${paramsName}{${fields.join(", ")}}`;
}

export function renderGoConformanceTest(ir: ApiIR, packageName: string): string {
  const lines: string[] = [];
  for (const operation of ir.operations.filter((op) => operationAppliesToTarget(ir, op, "go") && !op.websocket)) {
    const resource = resourceById(ir, operation.resource_id);
    if (!resource) continue;
    const accessor = accessorPath(ir, operation, "pascal");
    const hasParams = operation.params.length > 0 || Boolean(operation.request);
    const paramsName = `${resource.class_name}${pascalCase(operation.name)}Params`;
    const paramsLiteral = hasParams ? goParamsLiteral(ir, operation, paramsName) : "";
    if (paramsLiteral === undefined) continue;
    const argSuffix = hasParams ? `, ${paramsLiteral}` : "";

    if (operation.streaming) {
      const methodName = operation.streaming.always ? pascalCase(operation.name) : `${pascalCase(operation.name)}Streaming`;
      lines.push(`	stream, err := client.${accessor}.${methodName}(ctx${argSuffix})
	if err != nil {
		t.Fatalf("${operation.id} streaming: %v", err)
	}
	chunks := 0
	for stream.Next() {
		chunks++
	}
	if err := stream.Err(); err != nil {
		t.Fatalf("${operation.id} stream err: %v", err)
	}
	if chunks < 1 {
		t.Fatalf("${operation.id} streamed no events")
	}`);
      if (!operation.streaming.always) {
        lines.push(`	if _, err := client.${accessor}.${pascalCase(operation.name)}(ctx${argSuffix}); err != nil {
		t.Fatalf("${operation.id}: %v", err)
	}`);
      }
      continue;
    }

    const responseType = operation.response;
    if (responseType) {
      lines.push(`	if _, err := client.${accessor}.${pascalCase(operation.name)}(ctx${argSuffix}); err != nil {
		t.Fatalf("${operation.id}: %v", err)
	}`);
    } else {
      lines.push(`	if err := client.${accessor}.${pascalCase(operation.name)}(ctx${argSuffix}); err != nil {
		t.Fatalf("${operation.id}: %v", err)
	}`);
    }

    const shape = paginationShape(ir, operation);
    if (shape && paramsLiteral) {
      lines.push(`	{
		pager := client.${accessor}.${pascalCase(operation.name)}AutoPaging(ctx, ${paramsLiteral})
		count := 0
		for pager.Next() {
			count++
			if count > 20 {
				break
			}
		}
		if err := pager.Err(); err != nil {
			t.Fatalf("${operation.id} paging: %v", err)
		}
	}`);
    }
  }

  let oauthBlock = "";
  if (ir.client.oauth2) {
    const op = ir.operations.find(
      (candidate) => operationAppliesToTarget(ir, candidate, "go") && !candidate.streaming && candidate.response,
    );
    const resource = op ? resourceById(ir, op.resource_id) : undefined;
    if (op && resource) {
      const accessor = accessorPath(ir, op, "pascal");
      const hasParams = op.params.length > 0 || Boolean(op.request);
      const paramsName = `${resource.class_name}${pascalCase(op.name)}Params`;
      const literal = hasParams ? goParamsLiteral(ir, op, paramsName) : "";
      if (literal !== undefined) {
        const argSuffix = hasParams ? `, ${literal}` : "";
        oauthBlock = `	oauthClient := NewClient(WithClientCredentials("client-id", "client-secret"), WithBaseURL("http://127.0.0.1:"+port))
	if _, err := oauthClient.${accessor}.${pascalCase(op.name)}(ctx${argSuffix}); err != nil {
		t.Fatalf("oauth: %v", err)
	}`;
      }
    }
  }

  return `package ${packageName}

import (
	"bufio"
	"context"
	"os/exec"
	"regexp"
	"testing"
	"time"
)

func TestEndpointConformance(t *testing.T) {
	cmd := exec.Command("node", "../mock/server.mjs", "--port", "0")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Skipf("node not available: %v", err)
	}
	defer cmd.Process.Kill()

	scanner := bufio.NewScanner(stdout)
	pattern := regexp.MustCompile(\`127\\.0\\.0\\.1:(\\d+)\`)
	port := ""
	deadline := time.Now().Add(5 * time.Second)
	for scanner.Scan() {
		if match := pattern.FindStringSubmatch(scanner.Text()); match != nil {
			port = match[1]
			break
		}
		if time.Now().After(deadline) {
			break
		}
	}
	if port == "" {
		t.Fatal("mock server did not start")
	}

	observed := 0
	client := NewClient(WithAPIKey("test"), WithBaseURL("http://127.0.0.1:"+port), WithOnResponse(func(map[string]any) { observed++ }))
	ctx := context.Background()
${lines.join("\n")}
${oauthBlock}
	if observed == 0 {
		t.Fatal("observability hook did not fire")
	}
}
`;
}
