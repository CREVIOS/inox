// Connect-protocol (gRPC-web compatible) client product. Maps each IR resource to a service
// and each operation to a unary RPC. Two wire bindings are generated: Connect HTTP+JSON, and
// real gRPC-web with protobuf binary encoding + 5-byte length-prefix envelope framing
// (zero dependency — see proto.ts). The same IR that powers the REST SDKs yields the gRPC client.
import type { ApiIR, OperationIR, ResourceIR, TypeRefIR } from "./types.js";
import { pascalCase, quote, snakeCase } from "./utils.js";

function resourceById(ir: ApiIR, id: string): ResourceIR | undefined {
  return ir.resources.find((resource) => resource.id === id);
}

function typeById(ir: ApiIR, id: string) {
  return ir.types.find((type) => type.id === id);
}

/** Map an IR value ref to a protobuf field descriptor (kind + optional nested type / element). */
function protoFieldKind(ir: ApiIR, ref: TypeRefIR): string {
  if (ref.kind === "array") return `{ kind: "repeated", item: ${protoFieldKind(ir, ref.items)} }`;
  if (ref.kind === "map") return `{ kind: "map", value: ${protoFieldKind(ir, ref.values)} }`;
  if (ref.kind === "file") return `{ kind: "bytes" }`;
  if (ref.kind === "ref") {
    const type = typeById(ir, ref.id);
    if (type?.kind === "object") return `{ kind: "message", ref: ${quote(type.name)} }`;
    if (type?.kind === "enum") return `{ kind: "string" }`;
    if (type?.kind === "alias") return protoFieldKind(ir, type.target);
    return `{ kind: "string" }`; // union -> JSON string fallback
  }
  if (ref.name === "integer") return `{ kind: "int" }`;
  if (ref.name === "number") return `{ kind: "double" }`;
  if (ref.name === "boolean") return `{ kind: "bool" }`;
  return `{ kind: "string" }`;
}

/** Generate the protobuf schema map: each object type -> ordered fields with proto field numbers. */
function renderProtoSchemas(ir: ApiIR): string {
  const entries = ir.types
    .filter((type) => type.kind === "object")
    .map((type) => {
      const fields = (type.kind === "object" ? type.fields : [])
        .map((field, index) => `    { name: ${quote(field.wire_name)}, number: ${index + 1}, type: ${protoFieldKind(ir, field.type)} }`)
        .join(",\n");
      return `  ${quote(type.name)}: [\n${fields}\n  ]`;
    })
    .join(",\n");
  return `export const PROTO_SCHEMAS: Record<string, ProtoField[]> = {\n${entries}\n};\n`;
}

function serviceName(ir: ApiIR, operation: OperationIR): string {
  const resource = resourceById(ir, operation.resource_id);
  return `${(resource?.path_segments ?? []).map((segment) => pascalCase(segment)).join("")}Service`;
}

export function renderConnectFiles(ir: ApiIR): Record<string, string> {
  const pkgBase = snakeCase(ir.api.package_prefix).replace(/_/g, "-");
  const operations = ir.operations.filter((operation) => !operation.websocket && !operation.streaming);

  const services = new Map<string, string[]>();
  for (const operation of operations) {
    const service = serviceName(ir, operation);
    const rpc = pascalCase(operation.name);
    const list = services.get(service) ?? [];
    list.push(
      `      ${operation.name}: (input: Record<string, unknown> = {}) => unary(${JSON.stringify(service)}, ${JSON.stringify(rpc)}, input),`,
    );
    services.set(service, list);
  }

  const serviceLiterals = [...services.entries()]
    .map(([service, rpcs]) => {
      // accessor: lowerCamel of service without the trailing "Service"
      const accessor = service.replace(/Service$/, "");
      const lower = accessor.slice(0, 1).toLowerCase() + accessor.slice(1);
      return `    ${lower}: {\n${rpcs.join("\n")}\n    },`;
    })
    .join("\n");

  const client = `// Generated Connect (gRPC-web compatible) client for ${ir.api.name}.
export interface ConnectOptions {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export class ConnectError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = "ConnectError";
  }
}

export function createConnectClient(options: ConnectOptions = {}) {
  const baseUrl = (options.baseUrl ?? ${JSON.stringify(ir.client.base_url)}).replace(/\\/$/, "");
  const apiKey = options.apiKey ?? process.env.${ir.client.env_prefix}_API_KEY;

  async function unary(service: string, method: string, input: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "connect-protocol-version": "1",
      ...options.headers,
    };
    if (apiKey) headers.authorization = \`Bearer \${apiKey}\`;
    const response = await fetch(\`\${baseUrl}/\${service}/\${method}\`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const message = parsed && typeof parsed === "object" && "message" in parsed ? String((parsed as { message: unknown }).message) : \`Connect call failed: \${response.status}\`;
      throw new ConnectError(response.status, message);
    }
    return parsed;
  }

  return {
${serviceLiterals}
  };
}
`;

  const pkg = {
    name: `${pkgBase}-connect`,
    version: ir.api.version ?? "0.1.0",
    private: true,
    type: "module",
    scripts: { typecheck: "tsc -p tsconfig.json --noEmit" },
    devDependencies: { "@types/node": "^25.9.1", typescript: "^6.0.3" },
  };
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022", "DOM"],
      strict: true,
      noEmit: true,
      types: ["node"],
      skipLibCheck: true,
    },
    include: ["src/**/*.ts"],
  };

  return {
    "package.json": JSON.stringify(pkg, null, 2),
    "tsconfig.json": JSON.stringify(tsconfig, null, 2),
    "src/client.ts": client,
    "src/proto.ts": renderProtoRuntime(ir),
    "src/grpcweb.ts": renderGrpcWebClient(ir),
    "README.md": `# ${ir.api.name} Connect Client\n\nTwo bindings from one IR:\n- **Connect HTTP+JSON** — \`import { createConnectClient } from "${pkg.name}"\`\n- **gRPC-web (protobuf binary + length-prefix framing)** — \`import { createGrpcWebClient } from "${pkg.name}/grpcweb"\`\n\n\`\`\`ts\nimport { createConnectClient } from "${pkg.name}";\nconst client = createConnectClient();\n\`\`\`\n`,
  };
}

/** Zero-dependency protobuf wire codec + gRPC-web length-prefix envelope framing. */
function renderProtoRuntime(ir: ApiIR): string {
  return `// Zero-dependency protobuf wire codec (varint / fixed64 / length-delimited) plus gRPC-web
// 5-byte length-prefix envelope framing. Field numbers are assigned by IR field order.

export type ProtoFieldType =
  | { kind: "string" }
  | { kind: "int" }
  | { kind: "double" }
  | { kind: "bool" }
  | { kind: "bytes" }
  | { kind: "message"; ref: string }
  | { kind: "repeated"; item: ProtoFieldType }
  | { kind: "map"; value: ProtoFieldType };

export interface ProtoField {
  name: string;
  number: number;
  type: ProtoFieldType;
}

${renderProtoSchemas(ir)}

function writeVarint(out: number[], value: number | bigint): void {
  let v = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  if (v < 0n) v += 1n << 64n;
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
}

function writeTag(out: number[], fieldNumber: number, wireType: number): void {
  writeVarint(out, (fieldNumber << 3) | wireType);
}

function writeLengthDelimited(out: number[], bytes: Uint8Array): void {
  writeVarint(out, bytes.length);
  for (const byte of bytes) out.push(byte);
}

function writeDouble(out: number[], value: number): void {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, true);
  for (const byte of new Uint8Array(buffer)) out.push(byte);
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeField(out: number[], field: ProtoField, type: ProtoFieldType, value: unknown): void {
  if (value === undefined || value === null) return;
  switch (type.kind) {
    case "repeated":
      if (Array.isArray(value)) for (const item of value) encodeField(out, field, type.item, item);
      return;
    case "map":
      if (typeof value === "object") {
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
          const entry: number[] = [];
          encodeField(entry, { name: "key", number: 1, type: { kind: "string" } }, { kind: "string" }, key);
          encodeField(entry, { name: "value", number: 2, type: type.value }, type.value, val);
          writeTag(out, field.number, 2);
          writeLengthDelimited(out, new Uint8Array(entry));
        }
      }
      return;
    case "message": {
      writeTag(out, field.number, 2);
      writeLengthDelimited(out, encodeMessage(type.ref, value as Record<string, unknown>));
      return;
    }
    case "string":
      writeTag(out, field.number, 2);
      writeLengthDelimited(out, textEncoder.encode(String(value)));
      return;
    case "bytes":
      writeTag(out, field.number, 2);
      writeLengthDelimited(out, value instanceof Uint8Array ? value : textEncoder.encode(String(value)));
      return;
    case "int":
      writeTag(out, field.number, 0);
      writeVarint(out, Math.trunc(Number(value)));
      return;
    case "bool":
      writeTag(out, field.number, 0);
      writeVarint(out, value ? 1 : 0);
      return;
    case "double":
      writeTag(out, field.number, 1);
      writeDouble(out, Number(value));
      return;
  }
}

export function encodeMessage(typeName: string, value: Record<string, unknown>): Uint8Array {
  const schema = PROTO_SCHEMAS[typeName];
  if (!schema) return new Uint8Array();
  const out: number[] = [];
  for (const field of schema) encodeField(out, field, field.type, value[field.name]);
  return new Uint8Array(out);
}

class Reader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  get done(): boolean {
    return this.pos >= this.buf.length;
  }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    while (true) {
      const byte = this.buf[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }
    return result;
  }
  double(): number {
    const value = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true);
    this.pos += 8;
    return value;
  }
  bytes(): Uint8Array {
    const length = Number(this.varint());
    const slice = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }
  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.pos += 8;
    else if (wireType === 2) this.bytes();
    else if (wireType === 5) this.pos += 4;
  }
}

export function decodeMessage(typeName: string, bytes: Uint8Array): Record<string, unknown> {
  const schema = PROTO_SCHEMAS[typeName];
  const byNumber = new Map<number, ProtoField>();
  for (const field of schema ?? []) byNumber.set(field.number, field);
  const out: Record<string, unknown> = {};
  const reader = new Reader(bytes);
  while (!reader.done) {
    const tag = Number(reader.varint());
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;
    const field = byNumber.get(fieldNumber);
    if (!field) {
      reader.skip(wireType);
      continue;
    }
    const value = decodeValue(reader, field.type, wireType);
    applyDecoded(out, field, value);
  }
  return out;
}

function decodeValue(reader: Reader, type: ProtoFieldType, wireType: number): unknown {
  switch (type.kind) {
    case "repeated":
      return decodeValue(reader, type.item, wireType);
    case "map": {
      const entry = decodeMessageBytes(reader.bytes(), [
        { name: "key", number: 1, type: { kind: "string" } },
        { name: "value", number: 2, type: type.value },
      ]);
      return entry;
    }
    case "message":
      return decodeMessage(type.ref, reader.bytes());
    case "string":
      return textDecoder.decode(reader.bytes());
    case "bytes":
      return reader.bytes();
    case "int":
      return Number(reader.varint());
    case "bool":
      return reader.varint() !== 0n;
    case "double":
      return reader.double();
  }
}

function decodeMessageBytes(bytes: Uint8Array, schema: ProtoField[]): Record<string, unknown> {
  const byNumber = new Map<number, ProtoField>();
  for (const field of schema) byNumber.set(field.number, field);
  const out: Record<string, unknown> = {};
  const reader = new Reader(bytes);
  while (!reader.done) {
    const tag = Number(reader.varint());
    const field = byNumber.get(tag >>> 3);
    if (!field) {
      reader.skip(tag & 0x7);
      continue;
    }
    applyDecoded(out, field, decodeValue(reader, field.type, tag & 0x7));
  }
  return out;
}

function applyDecoded(out: Record<string, unknown>, field: ProtoField, value: unknown): void {
  if (field.type.kind === "repeated") {
    if (!Array.isArray(out[field.name])) out[field.name] = [];
    (out[field.name] as unknown[]).push(value);
  } else if (field.type.kind === "map") {
    const entry = value as { key?: string; value?: unknown };
    if (typeof out[field.name] !== "object" || out[field.name] === null) out[field.name] = {};
    const map = out[field.name] as Record<string, unknown>;
    if (entry.key !== undefined) map[entry.key] = entry.value;
  } else {
    out[field.name] = value;
  }
}

// gRPC-web envelope: [flag:1][length:4 big-endian][payload].
export function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

export function unframe(data: Uint8Array): { flag: number; payload: Uint8Array }[] {
  const frames: { flag: number; payload: Uint8Array }[] = [];
  let offset = 0;
  while (offset + 5 <= data.length) {
    const flag = data[offset];
    const length = new DataView(data.buffer, data.byteOffset + offset + 1, 4).getUint32(0, false);
    frames.push({ flag, payload: data.subarray(offset + 5, offset + 5 + length) });
    offset += 5 + length;
  }
  return frames;
}
`;
}

/** gRPC-web client: real protobuf binary + length-prefix framing over HTTP POST. */
function renderGrpcWebClient(ir: ApiIR): string {
  const operations = ir.operations.filter((operation) => !operation.websocket && !operation.streaming);
  const services = new Map<string, string[]>();
  for (const operation of operations) {
    const service = serviceName(ir, operation);
    const rpc = pascalCase(operation.name);
    const reqType = operation.request?.type.kind === "ref" ? typeById(ir, operation.request.type.id)?.name : undefined;
    const resType = operation.response?.kind === "ref" ? typeById(ir, operation.response.id)?.name : undefined;
    const list = services.get(service) ?? [];
    list.push(
      `      ${operation.name}: (input: Record<string, unknown> = {}) => unary(${quote(service)}, ${quote(rpc)}, input, ${reqType ? quote(reqType) : "undefined"}, ${resType ? quote(resType) : "undefined"}),`,
    );
    services.set(service, list);
  }
  const serviceLiterals = [...services.entries()]
    .map(([service, rpcs]) => {
      const accessor = service.replace(/Service$/, "");
      const lower = accessor.slice(0, 1).toLowerCase() + accessor.slice(1);
      return `    ${lower}: {\n${rpcs.join("\n")}\n    },`;
    })
    .join("\n");

  return `// gRPC-web client for ${ir.api.name}: protobuf binary messages with 5-byte length-prefix framing.
import { encodeMessage, decodeMessage, frame, unframe } from "./proto.js";

export interface GrpcWebOptions {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export class GrpcWebError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = "GrpcWebError";
  }
}

export function createGrpcWebClient(options: GrpcWebOptions = {}) {
  const baseUrl = (options.baseUrl ?? ${quote(ir.client.base_url)}).replace(/\\/$/, "");
  const apiKey = options.apiKey ?? process.env.${ir.client.env_prefix}_API_KEY;

  async function unary(service: string, method: string, input: Record<string, unknown>, requestType?: string, responseType?: string): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/grpc-web+proto",
      "x-grpc-web": "1",
      ...options.headers,
    };
    if (apiKey) headers.authorization = \`Bearer \${apiKey}\`;
    const payload = requestType ? encodeMessage(requestType, input) : new Uint8Array();
    const response = await fetch(\`\${baseUrl}/\${service}/\${method}\`, {
      method: "POST",
      headers,
      body: frame(payload) as unknown as BodyInit,
    });
    if (!response.ok) throw new GrpcWebError(response.status, \`gRPC-web call failed: \${response.status}\`);
    const data = new Uint8Array(await response.arrayBuffer());
    for (const f of unframe(data)) {
      // data frames have the low bit clear; trailer frames set flag bit 0x80.
      if ((f.flag & 0x80) === 0) return responseType ? decodeMessage(responseType, f.payload) : f.payload;
    }
    return undefined;
  }

  return {
${serviceLiterals}
  };
}
`;
}
