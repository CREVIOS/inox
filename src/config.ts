import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseDocument, stringify } from "yaml";
import type { Diagnostic, SdkConfig, TargetName } from "./types.js";
import { assertObject } from "./utils.js";

export interface LoadedConfig {
  config: SdkConfig;
  diagnostics: Diagnostic[];
  path: string;
  raw: string;
}

const targetNames: TargetName[] = ["typescript", "python", "go", "ruby", "java", "csharp"];

export async function readConfig(configPath = "sdkgen.yml"): Promise<LoadedConfig> {
  const absolutePath = resolve(configPath);
  const raw = await readFile(absolutePath, "utf8");
  const doc = parseDocument(raw);
  const diagnostics: Diagnostic[] = [];

  for (const error of doc.errors) {
    diagnostics.push({
      severity: "error",
      code: "config.yaml.invalid",
      message: error.message,
      location: configPath,
    });
  }

  for (const warning of doc.warnings) {
    diagnostics.push({
      severity: "warning",
      code: "config.yaml.warning",
      message: warning.message,
      location: configPath,
    });
  }

  const value = doc.toJS();
  assertObject(value, "sdkgen.yml");
  const config = value as unknown as SdkConfig;
  diagnostics.push(...validateConfig(config, configPath));
  return { config, diagnostics, path: absolutePath, raw };
}

export function validateConfig(config: SdkConfig, configPath = "sdkgen.yml"): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (config.sdkgen !== 1) {
    diagnostics.push({
      severity: "error",
      code: "config.version.unsupported",
      message: "`sdkgen` must be 1 for this generator edition.",
      location: `${configPath}:sdkgen`,
    });
  }

  if (!config.project?.name) {
    diagnostics.push({
      severity: "error",
      code: "config.project.name.missing",
      message: "`project.name` is required.",
      location: `${configPath}:project.name`,
    });
  }

  if (!config.spec?.path) {
    diagnostics.push({
      severity: "error",
      code: "config.spec.path.missing",
      message: "`spec.path` is required.",
      location: `${configPath}:spec.path`,
    });
  }

  if (!config.targets || Object.keys(config.targets).length === 0) {
    diagnostics.push({
      severity: "error",
      code: "config.targets.missing",
      message: "At least one target must be configured.",
      location: `${configPath}:targets`,
    });
  }

  for (const target of Object.keys(config.targets ?? {})) {
    if (!targetNames.includes(target as TargetName)) {
      diagnostics.push({
        severity: "warning",
        code: "config.target.unknown",
        message: `Unknown target ${target}; supported targets are typescript, python, go, ruby, java, and csharp.`,
        location: `${configPath}:targets.${target}`,
      });
    }
  }

  if (config.webhooks?.tolerance_seconds !== undefined && config.webhooks.tolerance_seconds <= 0) {
    diagnostics.push({
      severity: "error",
      code: "config.webhooks.tolerance.invalid",
      message: "`webhooks.tolerance_seconds` must be a positive number of seconds.",
      location: `${configPath}:webhooks.tolerance_seconds`,
    });
  }

  return diagnostics;
}

export function hasBlockingDiagnostics(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error" || diagnostic.severity === "blocker");
}

export function enabledTargets(config: SdkConfig, requested: TargetName | "all"): TargetName[] {
  const configured = targetNames.filter((target) => Boolean(config.targets?.[target]));
  if (requested === "all") return configured;
  return configured.includes(requested) ? [requested] : [];
}

export function resolveSpecPath(config: SdkConfig, configPath: string): string {
  return resolve(dirname(configPath), config.spec.path);
}

export async function writeSampleFiles(force: boolean): Promise<void> {
  const configPath = resolve("sdkgen.yml");
  const specPath = resolve("openapi.yaml");
  const { access } = await import("node:fs/promises");

  async function exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  if (!force && ((await exists(configPath)) || (await exists(specPath)))) {
    throw new Error("sdkgen.yml or openapi.yaml already exists. Re-run with --force to overwrite sample files.");
  }

  const config: SdkConfig = {
    sdkgen: 1,
    organization: { name: "acme" },
    project: { name: "acme-api", display_name: "Acme API" },
    spec: { path: "./openapi.yaml" },
    targets: {
      typescript: {
        package_name: "@acme/acme",
        edition: "typescript.2026-05-25",
      },
      python: {
        package_name: "acme",
        project_name: "acme-sdk",
        edition: "python.2026-05-25",
      },
      go: {
        module_path: "github.com/acme/acme-go",
        edition: "go.2026-05-25",
      },
      ruby: {
        gem_name: "acme",
        edition: "ruby.2026-05-25",
      },
      java: {
        namespace: "com.acme",
        maven_group: "com.acme",
        maven_artifact: "acme-java",
        edition: "java.2026-05-25",
      },
      csharp: {
        namespace: "Acme",
        edition: "csharp.2026-05-25",
      },
    },
    client: {
      class_name: "Acme",
      env_prefix: "ACME",
      base_url: { default: "https://api.acme.test" },
      auth: {
        bearer: {
          env: "ACME_API_KEY",
          security_scheme: "BearerAuth",
        },
        oauth2: {
          token_url: "/oauth/token",
          auth_style: "post",
          client_id_env: "ACME_CLIENT_ID",
          client_secret_env: "ACME_CLIENT_SECRET",
        },
      },
      retries: {
        max_retries: 2,
        retry_statuses: [408, 409, 429, 500, 502, 503, 504],
      },
      timeout: { seconds: 60 },
      idempotency: { header: "Idempotency-Key" },
    },
    webhooks: {
      signing_secret_env: "ACME_WEBHOOK_SECRET",
      signature_header: "Acme-Signature",
      timestamp_header: "Acme-Timestamp",
      tolerance_seconds: 300,
      payload_type: "WebhookEvent",
    },
    environments: {
      production: "https://api.acme.test",
      sandbox: "https://sandbox.acme.test",
    },
    mcp: {
      tools: "auto",
      enable_docs_tool: true,
      enable_code_tool: true,
    },
    resources: {
      customers: {
        model: "Customer",
        methods: {
          list: {
            endpoint: "get /v1/customers",
            pagination: "customers_cursor",
          },
          create: {
            endpoint: "post /v1/customers",
          },
          retrieve: {
            endpoint: "get /v1/customers/{customer_id}",
          },
        },
        subresources: {
          invoices: {
            model: "Invoice",
            methods: {
              list: {
                endpoint: "get /v1/customers/{customer_id}/invoices",
                pagination: "invoices_pages",
              },
            },
          },
        },
      },
      events: {
        model: "Event",
        methods: {
          // No explicit pagination ref: exercises list_* auto-detection of events_offset.
          list: {
            endpoint: "get /v1/events",
            deprecated: "Use the v2 events stream instead",
          },
        },
      },
      files: {
        model: "FileObject",
        methods: {
          upload: {
            endpoint: "post /v1/files",
          },
          delete: {
            endpoint: "delete /v1/files/{file_id}",
            skip: ["go"],
          },
        },
      },
      completions: {
        methods: {
          create: {
            endpoint: "post /v1/completions",
            streaming: {
              event_model: "CompletionChunk",
              param_discriminator: "stream",
              protocol: "sse",
              done_sentinel: "[DONE]",
            },
          },
        },
      },
      realtime: {
        methods: {
          connect: {
            endpoint: "get /v1/realtime",
            type: "websocket",
            websocket: {
              client_event_model: "ClientEvent",
              server_event_model: "ServerEvent",
            },
          },
        },
      },
    },
    models: {
      Customer: "#/components/schemas/Customer",
      CustomerList: "#/components/schemas/CustomerList",
      WebhookEvent: "#/components/schemas/WebhookEvent",
      Invoice: "#/components/schemas/Invoice",
      InvoiceList: "#/components/schemas/InvoiceList",
      Event: "#/components/schemas/Event",
      EventList: "#/components/schemas/EventList",
      FileObject: "#/components/schemas/FileObject",
      Completion: "#/components/schemas/Completion",
      CompletionChunk: "#/components/schemas/CompletionChunk",
      ClientEvent: "#/components/schemas/ClientEvent",
      ServerEvent: "#/components/schemas/ServerEvent",
    },
    pagination: {
      customers_cursor: {
        type: "cursor",
        items: "$.data",
        request_cursor: "cursor",
        response_next_cursor: "$.next_cursor",
      },
      invoices_pages: {
        type: "page_number",
        items: "$.data",
        page_param: "page",
        page_size_param: "page_size",
        current_page: "$.page",
        total_pages: "$.total_pages",
      },
      events_offset: {
        type: "offset",
        items: "$.data",
        offset_param: "offset",
        limit_param: "limit",
        total_count: "$.total",
      },
    },
  };

  const spec = `openapi: 3.1.0
info:
  title: Acme API
  version: 1.0.0
servers:
  - url: https://api.acme.test
components:
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
  schemas:
    Customer:
      type: object
      required: [id, email, status]
      properties:
        id:
          type: string
        email:
          type: string
          format: email
        status:
          type: string
          enum: [active, archived]
        metadata:
          type: object
          additionalProperties:
            type: string
    CustomerCreateParams:
      type: object
      required: [email]
      properties:
        email:
          type: string
          format: email
        metadata:
          type: object
          additionalProperties:
            type: string
    CustomerList:
      type: object
      required: [data]
      properties:
        data:
          type: array
          items:
            $ref: '#/components/schemas/Customer'
        next_cursor:
          type: string
          nullable: true
    Invoice:
      type: object
      required: [id, amount, status]
      properties:
        id:
          type: string
        amount:
          type: integer
        status:
          type: string
          enum: [open, paid, void]
    InvoiceList:
      type: object
      required: [data, page, total_pages]
      properties:
        data:
          type: array
          items:
            $ref: '#/components/schemas/Invoice'
        page:
          type: integer
        total_pages:
          type: integer
    Event:
      type: object
      required: [id, type, created]
      properties:
        id:
          type: string
        type:
          type: string
        created:
          type: integer
    EventList:
      type: object
      required: [data, total]
      properties:
        data:
          type: array
          items:
            $ref: '#/components/schemas/Event'
        total:
          type: integer
    FileObject:
      type: object
      required: [id, filename, bytes]
      properties:
        id:
          type: string
        filename:
          type: string
        bytes:
          type: integer
    FileUploadParams:
      type: object
      required: [file]
      properties:
        file:
          type: string
          format: binary
        purpose:
          type: string
    CompletionCreateParams:
      type: object
      required: [prompt]
      properties:
        prompt:
          type: string
        stream:
          type: boolean
    Completion:
      type: object
      required: [id, text]
      properties:
        id:
          type: string
        text:
          type: string
    CompletionChunk:
      type: object
      required: [id, delta]
      properties:
        id:
          type: string
        delta:
          type: string
    ClientEvent:
      type: object
      required: [action]
      properties:
        action:
          type: string
        data:
          type: object
          additionalProperties: true
    ServerEvent:
      type: object
      required: [type]
      properties:
        type:
          type: string
        payload:
          type: object
          additionalProperties: true
    WebhookEvent:
      type: object
      required: [id, type, created, data]
      properties:
        id:
          type: string
        type:
          type: string
          enum: [customer.created, customer.updated]
        created:
          type: integer
        data:
          type: object
          additionalProperties: true
paths:
  /v1/customers:
    get:
      operationId: listCustomers
      tags: [customers]
      summary: List customers
      parameters:
        - name: limit
          in: query
          schema:
            type: integer
        - name: cursor
          in: query
          schema:
            type: string
      responses:
        '200':
          description: Customers page
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CustomerList'
    post:
      operationId: createCustomer
      tags: [customers]
      summary: Create a customer
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CustomerCreateParams'
      responses:
        '200':
          description: Created customer
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Customer'
  /v1/customers/{customer_id}:
    get:
      operationId: retrieveCustomer
      tags: [customers]
      summary: Retrieve a customer
      parameters:
        - name: customer_id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Customer
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Customer'
  /v1/customers/{customer_id}/invoices:
    get:
      operationId: listCustomerInvoices
      summary: List customer invoices
      parameters:
        - name: customer_id
          in: path
          required: true
          schema:
            type: string
        - name: page
          in: query
          schema:
            type: integer
        - name: page_size
          in: query
          schema:
            type: integer
      responses:
        '200':
          description: Invoice page
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/InvoiceList'
  /v1/events:
    get:
      operationId: listEvents
      summary: List events
      parameters:
        - name: offset
          in: query
          schema:
            type: integer
        - name: limit
          in: query
          schema:
            type: integer
      responses:
        '200':
          description: Event page
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/EventList'
  /v1/files:
    post:
      operationId: uploadFile
      summary: Upload a file
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              $ref: '#/components/schemas/FileUploadParams'
      responses:
        '200':
          description: Uploaded file
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/FileObject'
  /v1/files/{file_id}:
    delete:
      operationId: deleteFile
      summary: Delete a file
      parameters:
        - name: file_id
          in: path
          required: true
          schema:
            type: string
      responses:
        '204':
          description: Deleted
  /v1/completions:
    post:
      operationId: createCompletion
      summary: Create a completion
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CompletionCreateParams'
      responses:
        '200':
          description: Completion
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Completion'
  /v1/realtime:
    get:
      operationId: connectRealtime
      summary: Realtime WebSocket channel
      responses:
        '101':
          description: Switching Protocols
`;

  await writeFile(configPath, stringify(config), "utf8");
  await writeFile(specPath, spec, "utf8");
}
