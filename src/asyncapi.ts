// AsyncAPI ingestion: converts an AsyncAPI 2.x/3.x document into OpenAPI schemas plus
// sdkgen resources whose methods are WebSocket channels, so an event-driven API description
// generates the same typed bidirectional clients as a hand-written `websocket` config.
import type { OpenApiSchema, ResourceConfig } from "./types.js";
import { isRecord, pascalCase, snakeCase } from "./utils.js";

export interface AsyncApiConversion {
  schemas: Record<string, OpenApiSchema>;
  models: Record<string, string>;
  resources: Record<string, ResourceConfig>;
  channels: number;
}

interface ChannelOps {
  /** message the server publishes to the client (subscribe in 2.x). */
  server?: OpenApiSchema;
  /** message the client sends to the server (publish in 2.x). */
  client?: OpenApiSchema;
}

export function convertAsyncApi(doc: unknown): AsyncApiConversion {
  const result: AsyncApiConversion = { schemas: {}, models: {}, resources: {}, channels: 0 };
  if (!isRecord(doc)) return result;
  const channels = isRecord(doc.channels) ? doc.channels : {};
  const isV3 = typeof doc.asyncapi === "string" && doc.asyncapi.startsWith("3");

  // Pull any reusable component schemas through verbatim.
  const components = isRecord(doc.components) ? doc.components : {};
  for (const [name, schema] of Object.entries(isRecord(components.schemas) ? components.schemas : {})) {
    if (isRecord(schema)) {
      result.schemas[pascalCase(name)] = schema as OpenApiSchema;
      result.models[pascalCase(name)] = `#/components/schemas/${pascalCase(name)}`;
    }
  }

  for (const [channelName, channelValue] of Object.entries(channels)) {
    if (!isRecord(channelValue)) continue;
    result.channels += 1;
    const ops = isV3 ? extractV3(doc, channelValue) : extractV2(channelValue);
    const resourceName = channelResourceName(isV3 && typeof channelValue.address === "string" ? channelValue.address : channelName);
    const base = pascalCase(resourceName);

    const clientModel = ops.client ? registerSchema(result, `${base}ClientEvent`, ops.client) : undefined;
    const serverModel = ops.server ? registerSchema(result, `${base}ServerEvent`, ops.server) : undefined;

    const path = normalizeChannelPath(isV3 && typeof channelValue.address === "string" ? channelValue.address : channelName);
    result.resources[resourceName] = {
      methods: {
        connect: {
          endpoint: `get ${path}`,
          type: "websocket",
          websocket: {
            client_event_model: clientModel,
            server_event_model: serverModel,
          },
        },
      },
    };
  }

  return result;
}

function extractV2(channel: Record<string, unknown>): ChannelOps {
  return {
    server: messagePayload(channel.subscribe),
    client: messagePayload(channel.publish),
  };
}

function extractV3(doc: Record<string, unknown>, channel: Record<string, unknown>): ChannelOps {
  // In 3.x the channel lists messages; without operation direction we expose the first
  // message both ways (a pragmatic default for a bidirectional client).
  const messages = isRecord(channel.messages) ? channel.messages : {};
  const first = Object.values(messages).find(isRecord);
  const payload = first ? resolvePayload(doc, first) : undefined;
  return { server: payload, client: payload };
}

function messagePayload(operation: unknown): OpenApiSchema | undefined {
  if (!isRecord(operation)) return undefined;
  const message = isRecord(operation.message) ? operation.message : undefined;
  if (!message) return undefined;
  return isRecord(message.payload) ? (message.payload as OpenApiSchema) : undefined;
}

function resolvePayload(_doc: Record<string, unknown>, message: Record<string, unknown>): OpenApiSchema | undefined {
  return isRecord(message.payload) ? (message.payload as OpenApiSchema) : undefined;
}

function registerSchema(result: AsyncApiConversion, name: string, schema: OpenApiSchema): string {
  // If the payload is a $ref to a component, reuse that model name.
  if (typeof schema.$ref === "string") {
    const refName = pascalCase(schema.$ref.split("/").at(-1) ?? name);
    if (result.models[refName]) return refName;
  }
  result.schemas[name] = schema;
  result.models[name] = `#/components/schemas/${name}`;
  return name;
}

function channelResourceName(channel: string): string {
  const segment = channel.split("/").filter(Boolean).at(-1) ?? "events";
  return snakeCase(segment.replace(/[{}]/g, ""));
}

function normalizeChannelPath(channel: string): string {
  return channel.startsWith("/") ? channel : `/${channel}`;
}
