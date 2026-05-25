// Unit tests for the feature wave: typed models (Ruby/Java/C#), basic auth (Go/Ruby/Java/C#),
// bidirectional pagination, multi-content request bodies, OAuth auth-code/device flows, gRPC
// protobuf framing, and the IR collision/de-duplication fixes surfaced by the real-spec gallery.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildIR } from "../src/ir.js";
import { generateTargets } from "../src/generators/index.js";
import { renderConnectFiles } from "../src/connectgen.js";
import { paginationShape } from "../src/generators/common.js";

const SPEC = {
  openapi: "3.0.0",
  info: { title: "Feature API", version: "1.0.0" },
  paths: {
    "/items": {
      get: {
        operationId: "listItems",
        parameters: [
          { name: "cursor", in: "query", schema: { type: "string" } },
          { name: "before", in: "query", schema: { type: "string" } },
          // Two query params that collapse to the same camelCase identifier.
          { name: "start_time", in: "query", schema: { type: "string" } },
          { name: "startTime", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/ItemList" } } } },
        },
      },
    },
    "/charges": {
      post: {
        operationId: "createCharge",
        requestBody: {
          required: true,
          content: { "application/x-www-form-urlencoded": { schema: { $ref: "#/components/schemas/Charge" } } },
        },
        responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Charge" } } } } },
      },
    },
  },
  components: {
    schemas: {
      Item: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          // Distinct wire names that collapse to one camelCase identifier.
          created_at: { type: "integer" },
          createdAt: { type: "string" },
        },
      },
      ItemList: {
        type: "object",
        properties: {
          data: { type: "array", items: { $ref: "#/components/schemas/Item" } },
          next_cursor: { type: "string", nullable: true },
          prev_cursor: { type: "string", nullable: true },
        },
      },
      Charge: { type: "object", properties: { amount: { type: "integer" }, currency: { type: "string" } } },
    },
  },
};

const CONFIG = {
  sdkgen: 1,
  organization: { name: "feat" },
  project: { name: "feat", display_name: "Feature" },
  spec: { path: "./spec.json" },
  targets: {
    typescript: { package_name: "@feat/feat", edition: "typescript.2026-05-25" },
    python: { package_name: "feat_sdk", project_name: "feat-sdk", edition: "python.2026-05-25" },
    go: { module_path: "github.com/feat/feat-go", edition: "go.2026-05-25" },
    ruby: { gem_name: "feat", edition: "ruby.2026-05-25" },
    java: { namespace: "com.feat", maven_group: "com.feat", maven_artifact: "feat", edition: "java.2026-05-25" },
    csharp: { namespace: "Feat", edition: "csharp.2026-05-25" },
  },
  client: {
    class_name: "Feat",
    env_prefix: "FEAT",
    base_url: { default: "https://api.feat.test" },
    auth: {
      basic: { username_env: "FEAT_USERNAME", password_env: "FEAT_PASSWORD" },
      oauth2: {
        token_url: "/oauth/token",
        authorization_url: "/oauth/authorize",
        device_authorization_url: "/oauth/device",
        client_id_env: "FEAT_CLIENT_ID",
        client_secret_env: "FEAT_CLIENT_SECRET",
      },
    },
  },
  pagination: {
    items_cursor: {
      type: "cursor",
      items: "$.data",
      request_cursor: "cursor",
      response_next_cursor: "$.next_cursor",
      request_prev_cursor: "before",
      response_prev_cursor: "$.prev_cursor",
    },
  },
};

function buildFeatureIR() {
  return buildIR({
    config: CONFIG as never,
    configRaw: JSON.stringify(CONFIG),
    spec: SPEC as never,
    specRaw: JSON.stringify(SPEC),
    diagnostics: [],
  });
}

async function read(dir: string, rel: string): Promise<string> {
  return readFile(join(dir, rel), "utf8");
}

async function main(): Promise<void> {
  const ir = buildFeatureIR();

  // --- IR: field-name de-duplication (created_at / createdAt) ---
  const item = ir.types.find((type) => type.name === "Item");
  assert.ok(item && item.kind === "object", "Item type exists");
  if (item.kind === "object") {
    const names = item.fields.map((field) => field.name);
    assert.equal(new Set(names).size, names.length, `field names must be unique: ${names.join(",")}`);
    const wires = item.fields.map((field) => field.wire_name);
    assert.ok(wires.includes("created_at") && wires.includes("createdAt"), "both wire names preserved");
  }

  // --- IR: param-name de-duplication (start_time / startTime) ---
  const list = ir.operations.find((operation) => operation.id === "listItems");
  assert.ok(list, "listItems op exists");
  if (list) {
    const paramNames = list.params.map((param) => param.name);
    assert.equal(new Set(paramNames).size, paramNames.length, `param names must be unique: ${paramNames.join(",")}`);
  }

  // --- IR: bidirectional cursor pagination ---
  if (list) {
    const shape = paginationShape(ir, list);
    assert.ok(shape, "list has a pagination shape");
    assert.ok(shape?.prevCursorField, "bidirectional: prev cursor field detected");
    assert.equal(shape?.requestPrevCursorParam, "before", "bidirectional: prev cursor request param");
  }

  // --- IR: multi-content request body (form-urlencoded) ---
  const charge = ir.operations.find((operation) => operation.id === "createCharge");
  assert.ok(charge?.request?.form_urlencoded, "createCharge body is form-urlencoded");

  // --- IR: OAuth auth-code + device flow endpoints ---
  assert.equal(ir.client.oauth2?.authorization_url, "/oauth/authorize", "oauth authorization_url");
  assert.equal(ir.client.oauth2?.device_authorization_url, "/oauth/device", "oauth device_authorization_url");
  assert.ok(ir.client.auth?.basic, "basic auth configured");

  // --- Generated output across languages ---
  const dir = await mkdtemp("/tmp/feat-test-");
  try {
    await generateTargets(ir, ["typescript", "python", "go", "ruby", "java", "csharp"], dir);

    // Typed response models for Ruby / Java / C#.
    assert.match(await read(dir, "csharp/Models/Item.cs"), /\[JsonPropertyName\("created_at"\)\]/, "C# model maps wire name");
    assert.match(await read(dir, "ruby/lib/feat/models/item.rb"), /Data\.define/, "Ruby typed model");
    assert.match(await read(dir, "java/src/main/java/com/feat/models/Item.java"), /public record Item/, "Java typed record");

    // Bidirectional pagination present in every language.
    assert.match(await read(dir, "typescript/src/resources/items.ts"), /listItemsAutoPagingBackward/, "TS backward pager");
    assert.match(await read(dir, "python/src/feat_sdk/resources/items.py"), /list_items_auto_paging_backward/, "Python backward pager");
    assert.match(await read(dir, "go/resource_items.go"), /ListItemsAutoPagingBackward/, "Go backward pager");

    // Multi-content: form-urlencoded wiring.
    assert.match(await read(dir, "typescript/src/resources/charges.ts"), /formUrlencoded: true/, "TS form-urlencoded");

    // Basic auth in Go / Ruby / Java / C#.
    assert.match(await read(dir, "go/client.go"), /WithBasicAuth/, "Go basic auth");
    assert.match(await read(dir, "csharp/Client.cs"), /_basicUser/, "C# basic auth");

    // OAuth auth-code + device flow helpers.
    assert.match(await read(dir, "typescript/src/client.ts"), /authorizationUrl/, "TS authorizationUrl");
    assert.match(await read(dir, "python/src/feat_sdk/_client.py"), /def poll_device_token/, "Python device flow");
    assert.match(await read(dir, "go/client.go"), /RequestDeviceCode/, "Go device flow");

    // gRPC: real protobuf codec + framing.
    const connect = renderConnectFiles(ir);
    const proto = connect["src/proto.ts"] ?? "";
    const grpcweb = connect["src/grpcweb.ts"] ?? "";
    assert.match(proto, /export function encodeMessage/, "protobuf encoder");
    assert.match(proto, /export function frame/, "gRPC-web framing");
    assert.match(grpcweb, /application\/grpc-web\+proto/, "gRPC-web transport");

    // Parity: typed error hierarchy in every language.
    assert.match(await read(dir, "typescript/src/core.ts"), /class NotFoundError extends ApiError/, "TS NotFoundError");
    assert.match(await read(dir, "python/src/feat_sdk/_exceptions.py"), /class RateLimitError\(ApiError\)/, "Python RateLimitError");
    assert.match(await read(dir, "go/client.go"), /type NotFoundError struct/, "Go NotFoundError");
    assert.match(await read(dir, "ruby/lib/feat/errors.rb"), /class NotFoundError < ApiError/, "Ruby NotFoundError");
    assert.match(await read(dir, "java/src/main/java/com/feat/ApiException.java"), /class NotFoundError extends ApiException/, "Java NotFoundError");
    assert.match(await read(dir, "csharp/ApiException.cs"), /class NotFoundError : ApiException/, "C# NotFoundError");

    // Parity: request-id extraction.
    assert.match(await read(dir, "go/client.go"), /x-request-id/, "Go request-id");
    assert.match(await read(dir, "python/src/feat_sdk/_client.py"), /x-request-id/, "Python request-id");

    // Parity: raw response access in every non-TS language.
    assert.match(await read(dir, "python/src/feat_sdk/resources/charges.py"), /with_raw_response/, "Python with_raw_response");
    assert.match(await read(dir, "ruby/lib/feat/resources/charges.rb"), /with_raw_response/, "Ruby with_raw_response");
    assert.match(await read(dir, "go/resource_charges.go"), /WithRawResponse/, "Go WithRawResponse");
    assert.match(await read(dir, "java/src/main/java/com/feat/resources/ChargesResource.java"), /withRawResponse/, "Java withRawResponse");
    assert.match(await read(dir, "csharp/Resources/ChargesResource.cs"), /WithRawResponse/, "C# WithRawResponse");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("features unit test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
