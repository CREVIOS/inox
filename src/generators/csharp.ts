import type { ApiIR, GenerationResult, OperationIR, ResourceIR, TypeRefIR } from "../types.js";
import { pascalCase, quote, snakeCase } from "../utils.js";
import { renderCsharpConformanceTest } from "../conformance.js";
import { renderReleaseWorkflow } from "../release.js";
import {
  childResources,
  createTargetWriter,
  emittedResources,
  paginationShape,
  resourceFileSlug,
  targetOperationsForResource,
  topLevelResources,
} from "./common.js";

function namespaceName(ir: ApiIR): string {
  return ir.targets.csharp?.namespace ?? pascalCase(ir.api.package_prefix.replace(/-api$/, ""));
}

export async function generateCsharp(ir: ApiIR, rootOutDir: string): Promise<GenerationResult> {
  const writer = createTargetWriter("csharp", rootOutDir);
  const ns = namespaceName(ir);
  const version = ir.api.version ?? "0.1.0";

  await writer.write(
    `${ns}.csproj`,
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <LangVersion>latest</LangVersion>
    <RootNamespace>${ns}</RootNamespace>
    <AssemblyName>${ns}</AssemblyName>
    <Version>${version}</Version>
  </PropertyGroup>
  <ItemGroup>
    <Compile Remove="Conformance/**/*.cs" />
  </ItemGroup>
</Project>
`,
  );

  await writer.write("ApiException.cs", renderCsharpException(ns));
  await writer.write("Client.cs", renderCsharpClient(ir, ns));
  await writer.write("Otel.cs", renderCsharpOtel(ns));
  if (ir.webhooks) await writer.write("Webhooks.cs", renderCsharpWebhooks(ir, ns));
  for (const resource of emittedResources(ir, "csharp")) {
    await writer.write(`Resources/${resource.class_name}Resource.cs`, renderCsharpResource(ir, ns, resource));
  }
  await writer.write("Conformance/Conformance.csproj", renderCsharpConformanceProject(ns));
  await writer.write("Conformance/Program.cs", renderCsharpConformanceTest(ir, ns));
  await writer.write(".github/workflows/release.yml", renderReleaseWorkflow("csharp", ir));
  await writer.write("README.md", `# ${ir.api.name} C# SDK\n\n\`\`\`csharp\nvar client = new ${ns}.Client();\n\`\`\`\n`);
  return writer.result();
}

function renderCsharpOtel(ns: string): string {
  return `using System;
using System.Collections.Generic;

namespace ${ns};

// Optional OpenTelemetry instrumentation (zero dependency). Implement IOtelTracer/IOtelSpan
// over your tracer and call Otel.Install(options, tracer). One CLIENT span per HTTP attempt.
public interface IOtelSpan
{
    void SetAttribute(string key, object? value);
    void SetStatus(int code);
    void End();
}

public interface IOtelTracer
{
    IOtelSpan StartSpan(string name, int kind);
}

public static class Otel
{
    public const int SpanKindClient = 3;
    public const int StatusError = 2;

    public static void Install(ClientOptions options, IOtelTracer tracer)
    {
        var spans = new Dictionary<string, IOtelSpan>();
        static string Key(IDictionary<string, object?> info) => $"{info["method"]} {info["url"]} #{info["attempt"]}";
        options.OnRequest = info =>
        {
            var span = tracer.StartSpan(Convert.ToString(info["method"]) ?? "", SpanKindClient);
            span.SetAttribute("http.request.method", info["method"]);
            span.SetAttribute("url.full", info["url"]);
            try
            {
                var host = new Uri(Convert.ToString(info["url"]) ?? "").Host;
                if (!string.IsNullOrEmpty(host)) span.SetAttribute("server.address", host);
            }
            catch { }
            if (info.TryGetValue("attempt", out var a) && a is int ai && ai > 0) span.SetAttribute("http.request.resend_count", ai);
            spans[Key(info)] = span;
        };
        options.OnResponse = info =>
        {
            if (!spans.Remove(Key(info), out var span)) return;
            span.SetAttribute("http.response.status_code", info["status"]);
            if (info.TryGetValue("status", out var s) && s is int si && si >= 400) span.SetStatus(StatusError);
            span.End();
        };
        options.OnError = info =>
        {
            if (!spans.Remove(Key(info), out var span)) return;
            info.TryGetValue("error", out var err);
            span.SetAttribute("error.type", err?.GetType().Name ?? "error");
            span.SetStatus(StatusError);
            span.End();
        };
    }
}
`;
}

function renderCsharpException(ns: string): string {
  return `namespace ${ns};

public sealed class ApiException : Exception
{
    public int StatusCode { get; }
    public string Body { get; }

    public ApiException(int statusCode, string body)
        : base($"API request failed with status {statusCode}")
    {
        StatusCode = statusCode;
        Body = body;
    }
}
`;
}

function renderCsharpClient(ir: ApiIR, ns: string): string {
  const resources = topLevelResources(ir, "csharp");
  const oauth = ir.client.oauth2;
  const props = resources.map((resource) => `    public ${resource.class_name}Resource ${pascalCase(resource.name)} { get; }`).join("\n");
  const init = resources.map((resource) => `        ${pascalCase(resource.name)} = new ${resource.class_name}Resource(this);`).join("\n");
  const webhookProp = ir.webhooks ? "    public WebhookClient Webhooks { get; }\n" : "";
  const webhookInit = ir.webhooks ? "        Webhooks = new WebhookClient(options.WebhookSecret);\n" : "";

  return `using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ${ns};

public sealed class ClientOptions
{
    public string? ApiKey;
    public string? ClientId;
    public string? ClientSecret;
    public string? BaseUrl;
    public string? Environment;
    public double TimeoutSeconds = ${ir.client.timeout_ms / 1000};
    public int MaxRetries = ${ir.client.retry_policy.max_retries};
    public bool OmitStainlessHeaders = ${ir.client.omit_stainless_headers ? "true" : "false"};
    public string? WebhookSecret;
    public Action<IDictionary<string, object?>>? OnRequest;
    public Action<IDictionary<string, object?>>? OnResponse;
    public Action<IDictionary<string, object?>>? OnError;
}

public class Client
{
    private const string DefaultBaseUrl = ${quote(ir.client.base_url)};
    private static readonly Dictionary<string, string> _environments = new() { ${Object.entries(ir.client.environments).map(([key, url]) => `[${quote(key)}] = ${quote(url)}`).join(", ")} };
    private readonly HttpClient _http = new();
    private readonly string _baseUrl;
    private readonly string? _apiKey;
    private readonly string? _clientId;
    private readonly string? _clientSecret;
    private readonly int _maxRetries;
    private readonly bool _omitStainlessHeaders;
    private readonly string? _idempotencyHeader = ${ir.client.idempotency_header ? quote(ir.client.idempotency_header) : "null"};
    private readonly string _packageVersion = ${quote(ir.api.version ?? "0.1.0")};
    private readonly int[] _retryStatuses = new int[] { ${ir.client.retry_policy.retry_statuses.join(", ")} };
    private readonly string _oauthTokenUrl = ${quote(oauth?.token_url ?? "")};
    private readonly string[] _oauthScopes = new string[] { ${(oauth?.scopes ?? []).map((scope) => quote(scope)).join(", ")} };
    private readonly string _oauthAuthStyle = ${quote(oauth?.auth_style ?? "post")};
    private string? _cachedToken;
    private DateTimeOffset _tokenExpiry = DateTimeOffset.MinValue;
    private readonly Action<IDictionary<string, object?>>? _onRequest;
    private readonly Action<IDictionary<string, object?>>? _onResponse;
    private readonly Action<IDictionary<string, object?>>? _onError;

${webhookProp}${props}

    public Client(ClientOptions? options = null)
    {
        options ??= new ClientOptions();
        _baseUrl = (options.BaseUrl ?? (options.Environment != null && _environments.TryGetValue(options.Environment, out var envUrl) ? envUrl : DefaultBaseUrl)).TrimEnd('/');
        _apiKey = options.ApiKey ?? Environment.GetEnvironmentVariable(${quote(`${ir.client.env_prefix}_API_KEY`)});
        _clientId = options.ClientId ?? Environment.GetEnvironmentVariable(${quote(oauth?.client_id_env ?? `${ir.client.env_prefix}_CLIENT_ID`)});
        _clientSecret = options.ClientSecret ?? Environment.GetEnvironmentVariable(${quote(oauth?.client_secret_env ?? `${ir.client.env_prefix}_CLIENT_SECRET`)});
        _maxRetries = options.MaxRetries;
        _omitStainlessHeaders = options.OmitStainlessHeaders;
        _onRequest = options.OnRequest;
        _onResponse = options.OnResponse;
        _onError = options.OnError;
        _http.Timeout = TimeSpan.FromSeconds(options.TimeoutSeconds);
${webhookInit}${init}
    }

    private async Task<string?> GetTokenAsync(bool force = false)
    {
        if (string.IsNullOrEmpty(_clientId) || string.IsNullOrEmpty(_clientSecret)) return null;
        if (!force && _cachedToken != null && DateTimeOffset.UtcNow < _tokenExpiry) return _cachedToken;
        var tokenUrl = _oauthTokenUrl.StartsWith("http") ? _oauthTokenUrl : _baseUrl + _oauthTokenUrl;
        var form = new Dictionary<string, string> { ["grant_type"] = "client_credentials" };
        if (_oauthScopes.Length > 0) form["scope"] = string.Join(" ", _oauthScopes);
        using var req = new HttpRequestMessage(HttpMethod.Post, tokenUrl);
        if (_oauthAuthStyle == "basic")
            req.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{_clientId}:{_clientSecret}")));
        else
        {
            form["client_id"] = _clientId!;
            form["client_secret"] = _clientSecret!;
        }
        req.Content = new FormUrlEncodedContent(form);
        var resp = await _http.SendAsync(req);
        var node = JsonNode.Parse(await resp.Content.ReadAsStringAsync());
        _cachedToken = node?["access_token"]?.GetValue<string>();
        var expires = node?["expires_in"]?.GetValue<int>() ?? 3600;
        _tokenExpiry = DateTimeOffset.UtcNow.AddSeconds(expires - 30);
        return _cachedToken;
    }

    private async Task<string?> ResolveBearerAsync()
        => (!string.IsNullOrEmpty(_clientId) && !string.IsNullOrEmpty(_clientSecret)) ? await GetTokenAsync() : _apiKey;

    private static string BuildQuery(IDictionary<string, object?>? query)
    {
        if (query == null) return "";
        var parts = new List<string>();
        foreach (var kv in query)
        {
            if (kv.Value == null) continue;
            parts.Add($"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(kv.Value.ToString() ?? "")}");
        }
        return parts.Count > 0 ? "?" + string.Join("&", parts) : "";
    }

    private void ApplyHeaders(HttpRequestMessage req, IDictionary<string, string>? headers, string? bearer, int attempt, bool streaming)
    {
        req.Headers.Accept.ParseAdd(streaming ? "text/event-stream" : "application/json");
        if (!_omitStainlessHeaders)
        {
            req.Headers.TryAddWithoutValidation("x-stainless-lang", "csharp");
            req.Headers.TryAddWithoutValidation("x-stainless-package-version", _packageVersion);
            req.Headers.TryAddWithoutValidation("x-stainless-runtime", ".net");
            req.Headers.TryAddWithoutValidation("x-stainless-retry-count", attempt.ToString());
        }
        if (!string.IsNullOrEmpty(bearer)) req.Headers.TryAddWithoutValidation("authorization", $"Bearer {bearer}");
        if (headers != null)
            foreach (var kv in headers) req.Headers.TryAddWithoutValidation(kv.Key, kv.Value);
    }

    public static JsonObject WithField(object body, string key, JsonNode? value)
    {
        var node = JsonSerializer.SerializeToNode(body)?.AsObject() ?? new JsonObject();
        node[key] = value;
        return node;
    }

    private HttpContent BuildMultipart(IDictionary<string, object?> form)
    {
        var content = new MultipartFormDataContent();
        foreach (var kv in form)
        {
            if (kv.Value == null) continue;
            if (kv.Value is byte[] bytes) content.Add(new ByteArrayContent(bytes), kv.Key, kv.Key);
            else content.Add(new StringContent(kv.Value.ToString() ?? ""), kv.Key);
        }
        return content;
    }

    public async Task<JsonNode?> RequestAsync(string method, string path, IDictionary<string, object?>? query = null, object? body = null, bool multipart = false, IDictionary<string, string>? headers = null, string? idempotencyKey = null, int? maxRetries = null, double? timeoutSeconds = null)
    {
        var url = _baseUrl + path + BuildQuery(query);
        var bearer = await ResolveBearerAsync();
        var refreshed = false;
        var effectiveRetries = maxRetries ?? _maxRetries;
        for (var attempt = 0; attempt <= effectiveRetries; attempt++)
        {
            using var req = new HttpRequestMessage(new HttpMethod(method.ToUpperInvariant()), url);
            ApplyHeaders(req, headers, bearer, attempt, false);
            if (multipart && body is IDictionary<string, object?> form) req.Content = BuildMultipart(form);
            else if (body != null) req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
            if (_idempotencyHeader != null && method.ToLowerInvariant() != "get" && !req.Headers.Contains(_idempotencyHeader))
                req.Headers.TryAddWithoutValidation(_idempotencyHeader, idempotencyKey ?? "stainless-retry-" + Guid.NewGuid().ToString("N"));

            var info = new Dictionary<string, object?> { ["method"] = method.ToUpperInvariant(), ["url"] = url, ["attempt"] = attempt };
            _onRequest?.Invoke(info);
            HttpResponseMessage resp;
            using var cts = timeoutSeconds.HasValue ? new System.Threading.CancellationTokenSource(TimeSpan.FromSeconds(timeoutSeconds.Value)) : null;
            try
            {
                resp = await _http.SendAsync(req, cts?.Token ?? default);
            }
            catch (Exception error)
            {
                _onError?.Invoke(new Dictionary<string, object?>(info) { ["error"] = error });
                if (attempt >= effectiveRetries) throw;
                await Task.Delay(Backoff(attempt, null));
                continue;
            }
            var status = (int)resp.StatusCode;
            _onResponse?.Invoke(new Dictionary<string, object?>(info) { ["status"] = status });
            var text = await resp.Content.ReadAsStringAsync();
            if (status == 401 && !string.IsNullOrEmpty(_clientId) && !string.IsNullOrEmpty(_clientSecret) && !refreshed)
            {
                refreshed = true;
                bearer = await GetTokenAsync(true);
                continue;
            }
            if (status is >= 200 and < 300) return string.IsNullOrEmpty(text) ? null : JsonNode.Parse(text);
            if (attempt < effectiveRetries && ShouldRetry(resp, status))
            {
                await Task.Delay(Backoff(attempt, resp));
                continue;
            }
            throw new ApiException(status, text);
        }
        throw new ApiException(0, "retry loop exited unexpectedly");
    }

    // Binary download: returns the raw response bytes (octet-stream/audio/image/pdf).
    public async Task<byte[]> RequestBytesAsync(string method, string path, IDictionary<string, object?>? query = null, IDictionary<string, string>? headers = null)
    {
        var url = _baseUrl + path + BuildQuery(query);
        var bearer = await ResolveBearerAsync();
        var refreshed = false;
        for (var attempt = 0; attempt <= _maxRetries; attempt++)
        {
            using var req = new HttpRequestMessage(new HttpMethod(method.ToUpperInvariant()), url);
            ApplyHeaders(req, headers, bearer, attempt, false);
            HttpResponseMessage resp;
            try { resp = await _http.SendAsync(req); }
            catch (Exception) { if (attempt >= _maxRetries) throw; await Task.Delay(Backoff(attempt, null)); continue; }
            var status = (int)resp.StatusCode;
            if (status == 401 && !string.IsNullOrEmpty(_clientId) && !string.IsNullOrEmpty(_clientSecret) && !refreshed)
            {
                refreshed = true;
                bearer = await GetTokenAsync(true);
                continue;
            }
            if (status is >= 200 and < 300) return await resp.Content.ReadAsByteArrayAsync();
            if (attempt < _maxRetries && ShouldRetry(resp, status)) { await Task.Delay(Backoff(attempt, resp)); continue; }
            throw new ApiException(status, await resp.Content.ReadAsStringAsync());
        }
        throw new ApiException(0, "retry loop exited unexpectedly");
    }

    public async IAsyncEnumerable<JsonNode?> StreamAsync(string method, string path, IDictionary<string, object?>? query = null, object? body = null, IDictionary<string, string>? headers = null, bool sse = true, string? doneSentinel = null, [EnumeratorCancellation] CancellationToken ct = default)
    {
        var url = _baseUrl + path + BuildQuery(query);
        var bearer = await ResolveBearerAsync();
        using var req = new HttpRequestMessage(new HttpMethod(method.ToUpperInvariant()), url);
        ApplyHeaders(req, headers, bearer, 0, true);
        if (body != null) req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        var status = (int)resp.StatusCode;
        if (status is < 200 or >= 300) throw new ApiException(status, await resp.Content.ReadAsStringAsync(ct));
        using var stream = await resp.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream);
        var dataLines = new List<string>();
        string? line;
        while ((line = await reader.ReadLineAsync(ct)) != null)
        {
            if (sse)
            {
                if (line.Length == 0)
                {
                    if (dataLines.Count > 0)
                    {
                        var payload = string.Join("\\n", dataLines);
                        dataLines.Clear();
                        if (!(doneSentinel != null && payload == doneSentinel)) yield return JsonNode.Parse(payload);
                    }
                    continue;
                }
                if (line.StartsWith("data:")) dataLines.Add(line.Substring(5).TrimStart(' '));
            }
            else
            {
                var trimmed = line.Trim();
                if (trimmed.Length == 0) continue;
                if (doneSentinel != null && trimmed == doneSentinel) yield break;
                yield return JsonNode.Parse(trimmed);
            }
        }
    }

    private bool ShouldRetry(HttpResponseMessage resp, int status)
    {
        if (resp.Headers.TryGetValues("x-should-retry", out var values))
        {
            var value = string.Join("", values).ToLowerInvariant();
            if (value == "true") return true;
            if (value == "false") return false;
        }
        return Array.IndexOf(_retryStatuses, status) >= 0 || status >= 500;
    }

    private static readonly Random _rng = new();

    private int Backoff(int attempt, HttpResponseMessage? resp)
    {
        if (resp != null && resp.Headers.TryGetValues("retry-after-ms", out var ms) && double.TryParse(string.Join("", ms), out var msv) && msv >= 0 && msv < 60000)
            return (int)msv;
        var baseMs = Math.Min(8000, 500 * Math.Pow(2, attempt));
        return (int)(baseMs * (0.75 + _rng.NextDouble() * 0.5));
    }
}
`;
}

function renderCsharpWebhooks(ir: ApiIR, ns: string): string {
  const webhook = ir.webhooks;
  if (!webhook) return "";
  return `using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace ${ns};

public sealed class WebhookVerificationException : Exception
{
    public WebhookVerificationException(string message) : base(message) { }
}

public sealed class WebhookClient
{
    private readonly string? _secret;
    private readonly int _tolerance;

    public WebhookClient(string? secret = null, int toleranceSeconds = ${webhook.tolerance_seconds})
    {
        _secret = secret ?? Environment.GetEnvironmentVariable(${quote(webhook.signing_secret_env)});
        _tolerance = toleranceSeconds;
    }

    public JsonNode? Unwrap(string payload, IDictionary<string, string> headers)
    {
        VerifySignature(payload, headers);
        return JsonNode.Parse(payload);
    }

    public bool VerifySignature(string payload, IDictionary<string, string> headers)
    {
        if (string.IsNullOrEmpty(_secret)) throw new WebhookVerificationException("Missing webhook signing secret");
        var signatureHeader = HeaderValue(headers, ${quote(webhook.signature_header)});
        if (signatureHeader == null) throw new WebhookVerificationException("Missing webhook signature header");
        var parsed = ParseSignatureHeader(signatureHeader);
        var timestamp = HeaderValue(headers, ${quote(webhook.timestamp_header)}) ?? (parsed.TryGetValue("t", out var t) ? t : null);
        if (timestamp == null) throw new WebhookVerificationException("Missing webhook timestamp");
        AssertFresh(timestamp);
        var signature = First(parsed, "v1", "sha256", "signature", "raw");
        if (signature == null) throw new WebhookVerificationException("Missing webhook signature value");
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(_secret!));
        var expected = Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes($"{timestamp}.{payload}"))).ToLowerInvariant();
        if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(signature.ToLowerInvariant())))
            throw new WebhookVerificationException("Webhook signature mismatch");
        return true;
    }

    private static string? HeaderValue(IDictionary<string, string> headers, string name)
    {
        foreach (var kv in headers)
            if (string.Equals(kv.Key, name, StringComparison.OrdinalIgnoreCase)) return kv.Value;
        return null;
    }

    private static Dictionary<string, string> ParseSignatureHeader(string value)
    {
        var result = new Dictionary<string, string>();
        foreach (var part in value.Split(','))
        {
            var trimmed = part.Trim();
            if (trimmed.Length == 0) continue;
            var idx = trimmed.IndexOf('=');
            if (idx < 0) result["raw"] = trimmed;
            else result[trimmed[..idx].Trim().ToLowerInvariant()] = trimmed[(idx + 1)..].Trim();
        }
        return result;
    }

    private static string? First(Dictionary<string, string> map, params string[] keys)
    {
        foreach (var key in keys) if (map.TryGetValue(key, out var value)) return value;
        return null;
    }

    private void AssertFresh(string value)
    {
        if (!long.TryParse(value, out var ts)) throw new WebhookVerificationException("Invalid webhook timestamp");
        if (Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds() - ts) > _tolerance)
            throw new WebhookVerificationException("Webhook timestamp outside tolerance");
    }
}
`;
}

function csType(ref: TypeRefIR): string {
  if (ref.kind === "primitive") {
    if (ref.name === "integer") return "long?";
    if (ref.name === "number") return "double?";
    if (ref.name === "boolean") return "bool?";
    return "string?";
  }
  if (ref.kind === "file") return "byte[]?";
  return "string?";
}

interface CsPlan {
  pathParams: { name: string }[];
  queryParams: { name: string; wire: string; type: string }[];
  pathExpr: string;
}

function csPlan(operation: OperationIR): CsPlan {
  const pathParams = operation.params.filter((param) => param.location === "path");
  const queryParams = operation.params.filter((param) => param.location === "query");
  const pathExpr = operation.path.replace(/\{([^}]+)\}/g, (_m, name: string) => `{Uri.EscapeDataString(${snakeCase(name).replace(/_([a-z])/g, (_x, c) => c.toUpperCase())})}`);
  return {
    pathParams: pathParams.map((param) => ({ name: csIdent(param.name) })),
    queryParams: queryParams.map((param) => ({ name: csIdent(param.name), wire: param.wire_name, type: csType(param.type) })),
    pathExpr,
  };
}

function csIdent(name: string): string {
  const camel = snakeCase(name).replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  return camel;
}

function csParamList(plan: CsPlan, extra: string[]): string {
  return [
    ...plan.pathParams.map((param) => `string ${param.name}`),
    ...extra,
    ...plan.queryParams.map((param) => `${param.type} ${param.name} = null`),
    "IDictionary<string, string>? headers = null",
  ].join(", ");
}

function csQueryArg(plan: CsPlan): string {
  if (plan.queryParams.length === 0) return "null";
  return `new Dictionary<string, object?> { ${plan.queryParams.map((param) => `[${quote(param.wire)}] = ${param.name}`).join(", ")} }`;
}

function renderCsharpResource(ir: ApiIR, ns: string, resource: ResourceIR): string {
  const operations = targetOperationsForResource(ir, resource, "csharp");
  const children = childResources(ir, resource, "csharp");
  const childProps = children.map((child) => `    public ${child.class_name}Resource ${pascalCase(child.name)} { get; }`).join("\n");
  const childInit = children.map((child) => `        ${pascalCase(child.name)} = new ${child.class_name}Resource(client);`).join("\n");
  const methods = operations.flatMap((operation) => renderCsharpOperation(ir, operation)).filter(Boolean).join("\n\n");

  return `using System.Text.Json.Nodes;

namespace ${ns};

public sealed class ${resource.class_name}Resource
{
    private readonly Client _client;
${childProps}

    public ${resource.class_name}Resource(Client client)
    {
        _client = client;
${childInit}
    }

${methods}
}
`;
}

function renderCsharpOperation(ir: ApiIR, operation: OperationIR): string[] {
  if (operation.websocket) return [];
  const out: string[] = [];
  if (operation.streaming) {
    if (!operation.streaming.always) out.push(renderCsharpMethod(operation, "non-stream"));
    out.push(renderCsharpStreamingMethod(operation));
  } else {
    out.push(renderCsharpMethod(operation, "plain"));
  }
  const pager = renderCsharpPager(ir, operation);
  if (pager) out.push(pager);
  return out;
}

function renderCsharpMethod(operation: OperationIR, mode: "plain" | "non-stream"): string {
  const plan = csPlan(operation);
  const name = `${pascalCase(operation.name)}Async`;
  const extra = operation.request ? ["object body"] : [];
  const params = csParamList(plan, [...extra, ...(operation.request ? ["string? idempotencyKey = null"] : [])]);
  const discriminator = mode === "non-stream" ? operation.streaming?.param_discriminator : undefined;
  const bodyArg = operation.request
    ? discriminator
      ? `body: Client.WithField(body, ${quote(discriminator)}, false)`
      : "body: body"
    : "";
  const multipart = operation.request?.multipart ? ", multipart: true" : "";
  const idem = operation.request ? ", idempotencyKey: idempotencyKey" : "";
  const callArgs = [`query: ${csQueryArg(plan)}`, bodyArg, "headers: headers"].filter(Boolean).join(", ");
  const dep = operation.deprecated ? `    [Obsolete(${typeof operation.deprecated === "string" ? quote(operation.deprecated) : '"Deprecated"'})]\n` : "";
  if (operation.binary_response) {
    return `${dep}    public Task<byte[]> ${name}(${params})
        => _client.RequestBytesAsync(${quote(operation.http_method)}, $"${plan.pathExpr}", query: ${csQueryArg(plan)}, headers: headers);`;
  }
  return `${dep}    public Task<JsonNode?> ${name}(${params})
        => _client.RequestAsync(${quote(operation.http_method)}, $"${plan.pathExpr}", ${callArgs}${multipart}${idem});`;
}

function renderCsharpStreamingMethod(operation: OperationIR): string {
  const streaming = operation.streaming;
  if (!streaming) return "";
  const plan = csPlan(operation);
  const name = streaming.always ? `${pascalCase(operation.name)}Async` : `${pascalCase(operation.name)}StreamingAsync`;
  const extra = operation.request ? ["object body"] : [];
  const params = csParamList(plan, extra);
  const discriminator = streaming.param_discriminator;
  const bodyArg = operation.request
    ? discriminator
      ? `body: Client.WithField(body, ${quote(discriminator)}, true)`
      : "body: body"
    : "";
  const sse = streaming.protocol === "sse" ? "true" : "false";
  const done = streaming.done_sentinel ? `, doneSentinel: ${quote(streaming.done_sentinel)}` : "";
  const callArgs = [`query: ${csQueryArg(plan)}`, bodyArg, "headers: headers", `sse: ${sse}${done}`].filter(Boolean).join(", ");
  return `    public IAsyncEnumerable<JsonNode?> ${name}(${params})
        => _client.StreamAsync(${quote(operation.http_method)}, $"${plan.pathExpr}", ${callArgs});`;
}

function renderCsharpPager(ir: ApiIR, operation: OperationIR): string {
  const shape = paginationShape(ir, operation);
  if (!shape) return "";
  const plan = csPlan(operation);
  const name = `${pascalCase(operation.name)}AutoPagingAsync`;
  const params = csParamList(plan, []);
  const listArgs = [...plan.pathParams.map((p) => p.name), ...plan.queryParams.map((p) => p.name), "headers"].join(", ");
  const itemsKey = quote(shape.itemsField.wire_name);
  const advance = csPagerAdvance(shape);
  const init = shape.kind === "offset" && shape.offsetParam
    ? `        ${csIdent(shape.offsetParam)} ??= 0;\n`
    : shape.kind === "page_number" && shape.pageParam
      ? `        ${csIdent(shape.pageParam)} ??= 1;\n`
      : "";
  return `    public async IAsyncEnumerable<JsonNode?> ${name}(${params})
    {
${init}        while (true)
        {
            var pageNode = await ${pascalCase(operation.name)}Async(${listArgs});
            var items = pageNode?[${itemsKey}]?.AsArray() ?? new JsonArray();
            foreach (var item in items) yield return item;
${advance}
        }
    }`;
}

function csPagerAdvance(shape: NonNullable<ReturnType<typeof paginationShape>>): string {
  switch (shape.kind) {
    case "cursor": {
      if (!shape.nextCursorField || !shape.requestCursorParam) return "            yield break;";
      return `            ${csIdent(shape.requestCursorParam)} = pageNode?[${quote(shape.nextCursorField.wire_name)}]?.GetValue<string>();
            if (string.IsNullOrEmpty(${csIdent(shape.requestCursorParam)})) yield break;`;
    }
    case "cursor_id": {
      if (!shape.cursorIdParam || !shape.cursorItemIdField) return "            yield break;";
      return `            if (items.Count == 0) yield break;
            ${csIdent(shape.cursorIdParam)} = items[items.Count - 1]?[${quote(shape.cursorItemIdField.wire_name)}]?.GetValue<string>();
            if (string.IsNullOrEmpty(${csIdent(shape.cursorIdParam)})) yield break;`;
    }
    case "offset": {
      if (!shape.offsetParam) return "            yield break;";
      const total = shape.totalCountField
        ? `\n            var total = pageNode?[${quote(shape.totalCountField.wire_name)}]?.GetValue<long>();
            if (total != null && ${csIdent(shape.offsetParam)} + items.Count >= total) yield break;`
        : "";
      return `            if (items.Count == 0) yield break;${total}
            ${csIdent(shape.offsetParam)} += items.Count;`;
    }
    case "page_number": {
      if (!shape.pageParam) return "            yield break;";
      const current = shape.currentPageField
        ? `pageNode?[${quote(shape.currentPageField.wire_name)}]?.GetValue<long>() ?? ${csIdent(shape.pageParam)} ?? 1`
        : `${csIdent(shape.pageParam)} ?? 1`;
      const total = shape.totalPagesField
        ? `\n            var totalPages = pageNode?[${quote(shape.totalPagesField.wire_name)}]?.GetValue<long>();
            if (totalPages != null && current >= totalPages) yield break;`
        : "";
      return `            if (items.Count == 0) yield break;
            var current = ${current};${total}
            ${csIdent(shape.pageParam)} = current + 1;`;
    }
    default:
      return "            yield break;";
  }
}

function renderCsharpConformanceProject(ns: string): string {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <LangVersion>latest</LangVersion>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../${ns}.csproj" />
  </ItemGroup>
</Project>
`;
}
