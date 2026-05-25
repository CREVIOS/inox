// Connect-protocol (gRPC-web compatible) client product. Maps each IR resource to a service
// and each operation to a unary RPC over Connect's HTTP+JSON binding (POST /{Service}/{Method}),
// so the same IR that powers the REST SDKs also yields a gRPC-style typed client. Full
// protobuf/binary framing is a follow-up; the JSON binding is wire-compatible with Connect.
import type { ApiIR, OperationIR, ResourceIR } from "./types.js";
import { pascalCase, snakeCase } from "./utils.js";

function resourceById(ir: ApiIR, id: string): ResourceIR | undefined {
  return ir.resources.find((resource) => resource.id === id);
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
    "README.md": `# ${ir.api.name} Connect Client\n\ngRPC-web compatible client using Connect's HTTP+JSON binding.\n\n\`\`\`ts\nimport { createConnectClient } from "${pkg.name}";\nconst client = createConnectClient();\n\`\`\`\n`,
  };
}
