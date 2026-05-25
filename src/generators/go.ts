import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ApiIR, FieldIR, GenerationResult, ObjectTypeIR, OperationIR, ParamIR, ResourceIR, TypeIR, TypeRefIR } from "../types.js";
import { pascalCase, quote, snakeCase } from "../utils.js";
import { renderGoConformanceTest } from "../conformance.js";
import { renderReleaseWorkflow } from "../release.js";
import {
  childResources,
  createTargetWriter,
  emittedResources,
  operationTypeName,
  paginationShape,
  pathTemplateForGo,
  resourceFileSlug,
  streamEventType,
  targetOperationsForResource,
  topLevelResources,
  typeById,
} from "./common.js";

const execFileAsync = promisify(execFile);

export async function generateGo(ir: ApiIR, rootOutDir: string): Promise<GenerationResult> {
  const writer = createTargetWriter("go", rootOutDir);
  const modulePath = ir.targets.go?.module_path ?? `github.com/generated/${snakeCase(ir.api.package_prefix).replace(/_/g, "-")}`;
  const packageName = goPackageName(modulePath);

  await writer.write(
    "go.mod",
    `module ${modulePath}

go 1.23
`,
  );
  await writer.write("client.go", renderGoClient(ir, packageName));
  await writer.write("models.go", renderGoModels(ir, packageName));
  if (ir.webhooks) {
    await writer.write("webhooks.go", renderGoWebhooks(ir, packageName));
    await writer.write("webhooks_test.go", renderGoWebhookTest(ir, packageName));
  }

  // Resource files share the package root with reserved files (models.go, client.go,
  // webhooks.go, endpoints_test.go). Prefix them so a resource whose slug matches a
  // reserved name (e.g. a `models` resource) can't clobber the shared types file.
  for (const resource of emittedResources(ir, "go")) {
    await writer.write(`resource_${resourceFileSlug(resource)}.go`, renderGoResource(ir, packageName, resource));
  }

  await writer.write("endpoints_test.go", renderGoConformanceTest(ir, packageName));
  await writer.write(".github/workflows/release.yml", renderReleaseWorkflow("go", ir));
  await writer.write("README.md", renderGoReadme(ir, modulePath));
  await formatGoFiles(writer.outDir, writer.files);
  return writer.result();
}

async function formatGoFiles(outDir: string, files: string[]): Promise<void> {
  const goFiles = files.filter((file) => file.endsWith(".go")).map((file) => join(outDir, file));
  if (goFiles.length > 0) {
    await execFileAsync("gofmt", ["-w", ...goFiles]);
  }
}

function renderGoClient(ir: ApiIR, packageName: string): string {
  const resources = topLevelResources(ir, "go");
  const resourceFields = resources.map((resource) => `\t${resource.class_name} *${resource.class_name}Service`).join("\n");
  const resourceInit = resources.map((resource) => `\tclient.${resource.class_name} = new${resource.class_name}Service(client)`).join("\n");
  const webhookField = ir.webhooks ? "\tWebhooks *WebhookClient\n\twebhookSecret string" : "";
  const webhookConfig = ir.webhooks
    ? `
\t\twebhookSecret: os.Getenv(${quote(ir.webhooks.signing_secret_env)}),`
    : "";
  const webhookInit = ir.webhooks ? "\tclient.Webhooks = NewWebhookClient(client.webhookSecret)" : "";
  const oauth = ir.client.oauth2;
  const oauthInit = oauth
    ? `
\t\tclientID: os.Getenv(${quote(oauth.client_id_env)}),
\t\tclientSecret: os.Getenv(${quote(oauth.client_secret_env)}),
\t\toauth2TokenURL: ${quote(oauth.token_url)},
\t\toauth2Scopes: []string{${oauth.scopes.map((scope) => quote(scope)).join(", ")}},
\t\toauth2AuthStyle: ${quote(oauth.auth_style)},`
    : "";
  const webhookOption = ir.webhooks
    ? `
func WithWebhookSecret(secret string) ClientOption {
\treturn func(client *Client) {
\t\tclient.webhookSecret = secret
\t}
}
`
    : "";
  const basic = ir.client.auth?.basic;
  const basicImport = basic ? '\t"encoding/base64"\n' : "";
  const basicFields = basic ? "\n\tbasicUser string\n\tbasicPass string" : "";
  const basicInit = basic
    ? `
\t\tbasicUser: os.Getenv(${quote(basic.username_env ?? `${ir.client.env_prefix}_USERNAME`)}),
\t\tbasicPass: os.Getenv(${quote(basic.password_env ?? `${ir.client.env_prefix}_PASSWORD`)}),`
    : "";
  const basicOption = basic
    ? `
func WithBasicAuth(username, password string) ClientOption {
\treturn func(client *Client) {
\t\tclient.basicUser = username
\t\tclient.basicPass = password
\t}
}
`
    : "";
  return `package ${packageName}

import (
\t"bufio"
\t"bytes"
\t"context"
\tcryptorand "crypto/rand"
${basicImport}\t"encoding/hex"
\t"encoding/json"
\t"fmt"
\t"io"
\t"math/rand"
\t"mime/multipart"
\t"net/http"
\t"net/url"
\t"os"
\t"strings"
\t"time"
)

type Client struct {
\tbaseURL    string
\tapiKey     string
\thttpClient *http.Client
\tmaxRetries int
\tretryStatuses map[int]bool
\tpackageVersion string
\tomitStainlessHeaders bool
\tidempotencyHeader string
\tclientID string
\tclientSecret string${basicFields}
\toauth2TokenURL string
\toauth2Scopes []string
\toauth2AuthStyle string
\tcachedToken string
\ttokenExpiry time.Time
\tonRequest func(map[string]any)
\tonResponse func(map[string]any)
\tonError func(map[string]any)
${webhookField}
${resourceFields}
}

type ClientOption func(*Client)

func NewClient(options ...ClientOption) *Client {
\tclient := &Client{
\t\tbaseURL: ${quote(ir.client.base_url)},
\t\tapiKey: os.Getenv(${quote(`${ir.client.env_prefix}_API_KEY`)}),
\t\thttpClient: &http.Client{Timeout: ${Math.ceil(ir.client.timeout_ms / 1000)} * time.Second},
\t\tmaxRetries: ${ir.client.retry_policy.max_retries},
\t\tretryStatuses: map[int]bool{${ir.client.retry_policy.retry_statuses.map((status) => `${status}: true`).join(", ")}},
\t\tpackageVersion: ${quote(ir.api.version ?? "0.1.0")},
\t\tomitStainlessHeaders: ${ir.client.omit_stainless_headers ? "true" : "false"},
\t\tidempotencyHeader: ${quote(ir.client.idempotency_header ?? "")},${oauthInit}${basicInit}
${webhookConfig}
\t}
\tfor _, option := range options {
\t\toption(client)
\t}
${resourceInit}
${webhookInit}
\treturn client
}

func WithAPIKey(apiKey string) ClientOption {
\treturn func(client *Client) {
\t\tclient.apiKey = apiKey
\t}
}

func WithBaseURL(baseURL string) ClientOption {
\treturn func(client *Client) {
\t\tclient.baseURL = strings.TrimRight(baseURL, "/")
\t}
}

// WithEnvironment selects a named base URL (e.g. "production", "sandbox").
func WithEnvironment(name string) ClientOption {
\treturn func(client *Client) {
\t\tenvironments := map[string]string{${Object.entries(ir.client.environments).map(([key, url]) => `${quote(key)}: ${quote(url)}`).join(", ")}}
\t\tif url, ok := environments[name]; ok {
\t\t\tclient.baseURL = strings.TrimRight(url, "/")
\t\t}
\t}
}

func WithMaxRetries(maxRetries int) ClientOption {
\treturn func(client *Client) {
\t\tclient.maxRetries = maxRetries
\t}
}

func WithHTTPClient(httpClient *http.Client) ClientOption {
\treturn func(client *Client) {
\t\tclient.httpClient = httpClient
\t}
}

func WithClientCredentials(clientID string, clientSecret string) ClientOption {
\treturn func(client *Client) {
\t\tclient.clientID = clientID
\t\tclient.clientSecret = clientSecret
\t}
}

// Observability hooks. Wire OpenTelemetry/metrics/logging here; default is no-op.
func WithOnRequest(hook func(map[string]any)) ClientOption {
\treturn func(client *Client) { client.onRequest = hook }
}

func WithOnResponse(hook func(map[string]any)) ClientOption {
\treturn func(client *Client) { client.onResponse = hook }
}

func WithOnError(hook func(map[string]any)) ClientOption {
\treturn func(client *Client) { client.onError = hook }
}

// OtelSpan and OtelTracer are the minimal interfaces for optional OpenTelemetry
// instrumentation (zero dependency). Adapt your tracer to these and pass OtelHooks(...).
type OtelSpan interface {
\tSetAttribute(key string, value any)
\tSetStatus(code int)
\tEnd()
}

type OtelTracer interface {
\tStartSpan(name string, kind int) OtelSpan
}

// OtelHooks returns client options emitting one CLIENT span per HTTP attempt with stable
// HTTP semantic-convention attributes. Usage: client := NewClient(OtelHooks(tracer)...).
func OtelHooks(tracer OtelTracer) []ClientOption {
\tspans := map[string]OtelSpan{}
\tkeyOf := func(info map[string]any) string { return fmt.Sprintf("%v %v #%v", info["method"], info["url"], info["attempt"]) }
\treturn []ClientOption{
\t\tWithOnRequest(func(info map[string]any) {
\t\t\tspan := tracer.StartSpan(fmt.Sprint(info["method"]), 3)
\t\t\tspan.SetAttribute("http.request.method", info["method"])
\t\t\tspan.SetAttribute("url.full", info["url"])
\t\t\tif parsed, err := url.Parse(fmt.Sprint(info["url"])); err == nil && parsed.Hostname() != "" {
\t\t\t\tspan.SetAttribute("server.address", parsed.Hostname())
\t\t\t}
\t\t\tif attempt, ok := info["attempt"].(int); ok && attempt > 0 {
\t\t\t\tspan.SetAttribute("http.request.resend_count", attempt)
\t\t\t}
\t\t\tspans[keyOf(info)] = span
\t\t}),
\t\tWithOnResponse(func(info map[string]any) {
\t\t\tspan, ok := spans[keyOf(info)]
\t\t\tif !ok {
\t\t\t\treturn
\t\t\t}
\t\t\tdelete(spans, keyOf(info))
\t\t\tspan.SetAttribute("http.response.status_code", info["status"])
\t\t\tif status, ok := info["status"].(int); ok && status >= 400 {
\t\t\t\tspan.SetStatus(2)
\t\t\t}
\t\t\tspan.End()
\t\t}),
\t\tWithOnError(func(info map[string]any) {
\t\t\tspan, ok := spans[keyOf(info)]
\t\t\tif !ok {
\t\t\t\treturn
\t\t\t}
\t\t\tdelete(spans, keyOf(info))
\t\t\tspan.SetAttribute("error.type", "error")
\t\t\tspan.SetStatus(2)
\t\t\tspan.End()
\t\t}),
\t}
}
${webhookOption}${basicOption}

func (client *Client) applyDefaultHeaders(request *http.Request, attempt int) {
\trequest.Header.Set("Accept", "application/json")
\tif !client.omitStainlessHeaders {
\t\trequest.Header.Set("X-Stainless-Lang", "go")
\t\trequest.Header.Set("X-Stainless-Package-Version", client.packageVersion)
\t\trequest.Header.Set("X-Stainless-Runtime", "go")
\t\trequest.Header.Set("X-Stainless-Timeout", fmt.Sprint(client.httpClient.Timeout.Seconds()))
\t\trequest.Header.Set("X-Stainless-Retry-Count", fmt.Sprint(attempt))
\t}
}

// accessToken implements the OAuth2 client-credentials flow with caching and refresh.
func (client *Client) accessToken(ctx context.Context, force bool) (string, error) {
\tif client.clientID == "" || client.clientSecret == "" {
\t\treturn "", nil
\t}
\tif !force && client.cachedToken != "" && time.Now().Before(client.tokenExpiry) {
\t\treturn client.cachedToken, nil
\t}
\ttokenURL := client.oauth2TokenURL
\tif !strings.HasPrefix(tokenURL, "http") {
\t\ttokenURL = client.baseURL + tokenURL
\t}
\tform := url.Values{}
\tform.Set("grant_type", "client_credentials")
\tif len(client.oauth2Scopes) > 0 {
\t\tform.Set("scope", strings.Join(client.oauth2Scopes, " "))
\t}
\tif client.oauth2AuthStyle != "basic" {
\t\tform.Set("client_id", client.clientID)
\t\tform.Set("client_secret", client.clientSecret)
\t}
\trequest, err := http.NewRequestWithContext(ctx, "POST", tokenURL, strings.NewReader(form.Encode()))
\tif err != nil {
\t\treturn "", err
\t}
\trequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
\trequest.Header.Set("Accept", "application/json")
\tif client.oauth2AuthStyle == "basic" {
\t\trequest.SetBasicAuth(client.clientID, client.clientSecret)
\t}
\tresponse, err := client.httpClient.Do(request)
\tif err != nil {
\t\treturn "", err
\t}
\tbody, _ := io.ReadAll(response.Body)
\tresponse.Body.Close()
\tif response.StatusCode < 200 || response.StatusCode >= 300 {
\t\treturn "", &APIError{StatusCode: response.StatusCode, Body: body}
\t}
\tvar payload struct {
\t\tAccessToken string \`json:"access_token"\`
\t\tExpiresIn   int64  \`json:"expires_in"\`
\t}
\tif err := json.Unmarshal(body, &payload); err != nil {
\t\treturn "", err
\t}
\texpires := payload.ExpiresIn
\tif expires == 0 {
\t\texpires = 3600
\t}
\tclient.cachedToken = payload.AccessToken
\tclient.tokenExpiry = time.Now().Add(time.Duration(expires-30) * time.Second)
\treturn client.cachedToken, nil
}

func (client *Client) authorize(ctx context.Context, request *http.Request) error {
\tif client.clientID != "" && client.clientSecret != "" {
\t\ttoken, err := client.accessToken(ctx, false)
\t\tif err != nil {
\t\t\treturn err
\t\t}
\t\tif token != "" {
\t\t\trequest.Header.Set("Authorization", "Bearer "+token)
\t\t}
\t\treturn nil
\t}
\tif client.apiKey != "" {
\t\trequest.Header.Set("Authorization", "Bearer "+client.apiKey)
\t\treturn nil
\t}${basic ? `
\tif client.basicUser != "" && client.basicPass != "" {
\t\trequest.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(client.basicUser+":"+client.basicPass)))
\t}` : ""}
\treturn nil
}

func (client *Client) do(ctx context.Context, method string, path string, query url.Values, body any, out any) error {
\treturn client.doEncoded(ctx, method, path, query, body, out, "json")
}

func (client *Client) doEncoded(ctx context.Context, method string, path string, query url.Values, body any, out any, encoding string) error {
\tvar payload []byte
\tcontentType := "application/json"
\tif body != nil {
\t\tif encoding == "form" {
\t\t\tpayload = []byte(encodeForm(body))
\t\t\tcontentType = "application/x-www-form-urlencoded"
\t\t} else if encoding == "text" {
\t\t\tpayload = []byte(fmt.Sprint(body))
\t\t\tcontentType = "text/plain"
\t\t} else {
\t\t\tencoded, err := json.Marshal(body)
\t\t\tif err != nil {
\t\t\t\treturn err
\t\t\t}
\t\t\tpayload = encoded
\t\t}
\t}

\trequestURL := client.baseURL + path
\tif len(query) > 0 {
\t\trequestURL += "?" + query.Encode()
\t}

\trefreshed := false
\tfor attempt := 0; attempt <= client.maxRetries; attempt++ {
\t\tvar reader io.Reader
\t\tif payload != nil {
\t\t\treader = bytes.NewReader(payload)
\t\t}

\t\trequest, err := http.NewRequestWithContext(ctx, strings.ToUpper(method), requestURL, reader)
\t\tif err != nil {
\t\t\treturn err
\t\t}
\t\tclient.applyDefaultHeaders(request, attempt)
\t\tif err := client.authorize(ctx, request); err != nil {
\t\t\treturn err
\t\t}
\t\tif body != nil {
\t\t\trequest.Header.Set("Content-Type", contentType)
\t\t}
\t\tif client.idempotencyHeader != "" && strings.ToLower(method) != "get" && request.Header.Get(client.idempotencyHeader) == "" {
\t\t\trequest.Header.Set(client.idempotencyHeader, "stainless-retry-"+randomID())
\t\t}

\t\tstarted := time.Now()
\t\tif client.onRequest != nil {
\t\t\tclient.onRequest(map[string]any{"method": strings.ToUpper(method), "url": requestURL, "attempt": attempt})
\t\t}
\t\tresponse, err := client.httpClient.Do(request)
\t\tif err != nil {
\t\t\tif client.onError != nil {
\t\t\t\tclient.onError(map[string]any{"method": strings.ToUpper(method), "url": requestURL, "attempt": attempt, "error": err})
\t\t\t}
\t\t\tif attempt < client.maxRetries {
\t\t\t\ttime.Sleep(retryDelay(attempt))
\t\t\t\tcontinue
\t\t\t}
\t\t\treturn err
\t\t}
\t\tif client.onResponse != nil {
\t\t\tclient.onResponse(map[string]any{"method": strings.ToUpper(method), "url": requestURL, "attempt": attempt, "status": response.StatusCode, "durationMs": float64(time.Since(started).Milliseconds())})
\t\t}

\t\tresponseBody, readErr := io.ReadAll(response.Body)
\t\tresponse.Body.Close()
\t\tif readErr != nil {
\t\t\treturn readErr
\t\t}
\t\tif response.StatusCode == 401 && client.clientID != "" && client.clientSecret != "" && !refreshed {
\t\t\trefreshed = true
\t\t\tif _, err := client.accessToken(ctx, true); err != nil {
\t\t\t\treturn err
\t\t\t}
\t\t\tcontinue
\t\t}
\t\tif response.StatusCode < 200 || response.StatusCode >= 300 {
\t\t\tif attempt < client.maxRetries && client.shouldRetry(response) {
\t\t\t\ttime.Sleep(retryDelay(attempt, response))
\t\t\t\tcontinue
\t\t\t}
\t\t\treturn &APIError{StatusCode: response.StatusCode, Body: responseBody}
\t\t}
\t\tif raw, ok := out.(*[]byte); ok {
\t\t\t*raw = responseBody
\t\t\treturn nil
\t\t}
\t\tif out == nil || len(responseBody) == 0 {
\t\t\treturn nil
\t\t}
\t\tif err := json.Unmarshal(responseBody, out); err != nil {
\t\t\treturn fmt.Errorf("decode response: %w", err)
\t\t}
\t\treturn nil
\t}
\treturn fmt.Errorf("request retry loop exited unexpectedly")
}

func (client *Client) doMultipart(ctx context.Context, method string, path string, query url.Values, fields map[string]any, out any) error {
\tvar buffer bytes.Buffer
\twriter := multipart.NewWriter(&buffer)
\tfor key, value := range fields {
\t\tif value == nil {
\t\t\tcontinue
\t\t}
\t\tswitch typed := value.(type) {
\t\tcase []byte:
\t\t\tpart, err := writer.CreateFormFile(key, key)
\t\t\tif err != nil {
\t\t\t\treturn err
\t\t\t}
\t\t\tif _, err := part.Write(typed); err != nil {
\t\t\t\treturn err
\t\t\t}
\t\tcase *string:
\t\t\tif typed != nil {
\t\t\t\tif err := writer.WriteField(key, *typed); err != nil {
\t\t\t\t\treturn err
\t\t\t\t}
\t\t\t}
\t\tcase string:
\t\t\tif err := writer.WriteField(key, typed); err != nil {
\t\t\t\treturn err
\t\t\t}
\t\tdefault:
\t\t\tencoded, err := json.Marshal(typed)
\t\t\tif err != nil {
\t\t\t\treturn err
\t\t\t}
\t\t\tif err := writer.WriteField(key, string(encoded)); err != nil {
\t\t\t\treturn err
\t\t\t}
\t\t}
\t}
\tif err := writer.Close(); err != nil {
\t\treturn err
\t}

\trequestURL := client.baseURL + path
\tif len(query) > 0 {
\t\trequestURL += "?" + query.Encode()
\t}
\trequest, err := http.NewRequestWithContext(ctx, strings.ToUpper(method), requestURL, &buffer)
\tif err != nil {
\t\treturn err
\t}
\tclient.applyDefaultHeaders(request, 0)
\tif err := client.authorize(ctx, request); err != nil {
\t\treturn err
\t}
\trequest.Header.Set("Content-Type", writer.FormDataContentType())
\tresponse, err := client.httpClient.Do(request)
\tif err != nil {
\t\treturn err
\t}
\tresponseBody, readErr := io.ReadAll(response.Body)
\tresponse.Body.Close()
\tif readErr != nil {
\t\treturn readErr
\t}
\tif response.StatusCode < 200 || response.StatusCode >= 300 {
\t\treturn &APIError{StatusCode: response.StatusCode, Body: responseBody}
\t}
\tif out == nil || len(responseBody) == 0 {
\t\treturn nil
\t}
\treturn json.Unmarshal(responseBody, out)
}

func (client *Client) doStream(ctx context.Context, method string, path string, query url.Values, body any) (*http.Response, error) {
\tvar reader io.Reader
\tif body != nil {
\t\tencoded, err := json.Marshal(body)
\t\tif err != nil {
\t\t\treturn nil, err
\t\t}
\t\treader = bytes.NewReader(encoded)
\t}
\trequestURL := client.baseURL + path
\tif len(query) > 0 {
\t\trequestURL += "?" + query.Encode()
\t}
\trequest, err := http.NewRequestWithContext(ctx, strings.ToUpper(method), requestURL, reader)
\tif err != nil {
\t\treturn nil, err
\t}
\tclient.applyDefaultHeaders(request, 0)
\tif err := client.authorize(ctx, request); err != nil {
\t\treturn nil, err
\t}
\trequest.Header.Set("Accept", "text/event-stream")
\tif body != nil {
\t\trequest.Header.Set("Content-Type", "application/json")
\t}
\tresponse, err := client.httpClient.Do(request)
\tif err != nil {
\t\treturn nil, err
\t}
\tif response.StatusCode < 200 || response.StatusCode >= 300 {
\t\tresponseBody, _ := io.ReadAll(response.Body)
\t\tresponse.Body.Close()
\t\treturn nil, &APIError{StatusCode: response.StatusCode, Body: responseBody}
\t}
\treturn response, nil
}

type APIError struct {
\tStatusCode int
\tBody       []byte
}

func (err *APIError) Error() string {
\treturn fmt.Sprintf("API request failed with status %d", err.StatusCode)
}

// Stream is a typed iterator over a server-sent-event or JSONL response body.
type Stream[T any] struct {
\tscanner      *bufio.Scanner
\tbody         io.ReadCloser
\tsse          bool
\tdoneSentinel string
\tcurrent      T
\terr          error
\tfinished     bool
}

func newStream[T any](body io.ReadCloser, sse bool, doneSentinel string) *Stream[T] {
\treturn &Stream[T]{scanner: bufio.NewScanner(body), body: body, sse: sse, doneSentinel: doneSentinel}
}

func (stream *Stream[T]) Next() bool {
\tif stream.err != nil || stream.finished {
\t\treturn false
\t}
\tif stream.sse {
\t\tvar dataLines []string
\t\tfor stream.scanner.Scan() {
\t\t\tline := stream.scanner.Text()
\t\t\tif line == "" {
\t\t\t\tif len(dataLines) == 0 {
\t\t\t\t\tcontinue
\t\t\t\t}
\t\t\t\tdata := strings.Join(dataLines, "\\n")
\t\t\t\tdataLines = nil
\t\t\t\tif stream.doneSentinel != "" && data == stream.doneSentinel {
\t\t\t\t\tstream.finished = true
\t\t\t\t\treturn false
\t\t\t\t}
\t\t\t\tvar event T
\t\t\t\tif err := json.Unmarshal([]byte(data), &event); err != nil {
\t\t\t\t\tstream.err = err
\t\t\t\t\treturn false
\t\t\t\t}
\t\t\t\tstream.current = event
\t\t\t\treturn true
\t\t\t}
\t\t\tif strings.HasPrefix(line, ":") {
\t\t\t\tcontinue
\t\t\t}
\t\t\tif strings.HasPrefix(line, "data:") {
\t\t\t\tdataLines = append(dataLines, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
\t\t\t}
\t\t}
\t\tif len(dataLines) > 0 {
\t\t\tdata := strings.Join(dataLines, "\\n")
\t\t\tif !(stream.doneSentinel != "" && data == stream.doneSentinel) {
\t\t\t\tvar event T
\t\t\t\tif err := json.Unmarshal([]byte(data), &event); err == nil {
\t\t\t\t\tstream.current = event
\t\t\t\t\tstream.finished = true
\t\t\t\t\treturn true
\t\t\t\t}
\t\t\t}
\t\t}
\t\tstream.err = stream.scanner.Err()
\t\tstream.finished = true
\t\treturn false
\t}
\tfor stream.scanner.Scan() {
\t\tline := strings.TrimSpace(stream.scanner.Text())
\t\tif line == "" {
\t\t\tcontinue
\t\t}
\t\tif stream.doneSentinel != "" && line == stream.doneSentinel {
\t\t\tstream.finished = true
\t\t\treturn false
\t\t}
\t\tvar event T
\t\tif err := json.Unmarshal([]byte(line), &event); err != nil {
\t\t\tstream.err = err
\t\t\treturn false
\t\t}
\t\tstream.current = event
\t\treturn true
\t}
\tstream.err = stream.scanner.Err()
\tstream.finished = true
\treturn false
}

func (stream *Stream[T]) Current() T {
\treturn stream.current
}

func (stream *Stream[T]) Err() error {
\treturn stream.err
}

func (stream *Stream[T]) Close() error {
\treturn stream.body.Close()
}

// OnEvent drains the stream, invoking onEvent for each item, then returns any terminal
// error (nil on clean end). Event-handler alternative to the Next()/Current() loop.
func (stream *Stream[T]) OnEvent(onEvent func(T)) error {
\tdefer stream.Close()
\tfor stream.Next() {
\t\tonEvent(stream.Current())
\t}
\treturn stream.Err()
}

func (client *Client) shouldRetry(response *http.Response) bool {
\tshouldRetry := strings.ToLower(response.Header.Get("X-Should-Retry"))
\tif shouldRetry == "true" {
\t\treturn true
\t}
\tif shouldRetry == "false" {
\t\treturn false
\t}
\treturn client.retryStatuses[response.StatusCode] || response.StatusCode >= 500
}

func retryDelay(attempt int, response ...*http.Response) time.Duration {
\tif len(response) > 0 && response[0] != nil {
\t\tif value := response[0].Header.Get("Retry-After-Ms"); value != "" {
\t\t\tvar milliseconds int64
\t\t\tif _, err := fmt.Sscan(value, &milliseconds); err == nil && milliseconds >= 0 && milliseconds < 60000 {
\t\t\t\treturn time.Duration(milliseconds) * time.Millisecond
\t\t\t}
\t\t}
\t\tif value := response[0].Header.Get("Retry-After"); value != "" {
\t\t\tvar seconds int64
\t\t\tif _, err := fmt.Sscan(value, &seconds); err == nil && seconds >= 0 && seconds < 60 {
\t\t\t\treturn time.Duration(seconds) * time.Second
\t\t\t}
\t\t}
\t}
\tbase := min(time.Duration(500*(1<<attempt))*time.Millisecond, 8*time.Second)
\tjitter := 0.75 + rand.Float64()*0.5
\treturn time.Duration(float64(base) * jitter)
}

func randomID() string {
\tbytes := make([]byte, 16)
\tif _, err := cryptorand.Read(bytes); err != nil {
\t\treturn fmt.Sprint(time.Now().UnixNano())
\t}
\treturn hex.EncodeToString(bytes)
}

// encodeForm renders a typed body as application/x-www-form-urlencoded with bracket
// notation for nested objects/arrays (json round-trip keeps it generic over any struct).
func encodeForm(body any) string {
\tencoded, err := json.Marshal(body)
\tif err != nil {
\t\treturn ""
\t}
\tvar generic any
\tif err := json.Unmarshal(encoded, &generic); err != nil {
\t\treturn ""
\t}
\tvalues := url.Values{}
\tvar add func(key string, value any)
\tadd = func(key string, value any) {
\t\tswitch typed := value.(type) {
\t\tcase nil:
\t\t\treturn
\t\tcase map[string]any:
\t\t\tfor k, v := range typed {
\t\t\t\tif key == "" {
\t\t\t\t\tadd(k, v)
\t\t\t\t} else {
\t\t\t\t\tadd(key+"["+k+"]", v)
\t\t\t\t}
\t\t\t}
\t\tcase []any:
\t\t\tfor i, v := range typed {
\t\t\t\tadd(fmt.Sprintf("%s[%d]", key, i), v)
\t\t\t}
\t\tdefault:
\t\t\tvalues.Add(key, fmt.Sprint(typed))
\t\t}
\t}
\tadd("", generic)
\treturn values.Encode()
}
`;
}

function renderGoWebhooks(ir: ApiIR, packageName: string): string {
  const webhook = ir.webhooks;
  if (!webhook) return "";
  const payloadType = webhook.payload_type_id ? typeById(ir, webhook.payload_type_id)?.name : undefined;
  const returnType = payloadType ? `(*${payloadType}, error)` : "(map[string]any, error)";
  const decode = payloadType
    ? `\tvar event ${payloadType}
\tif err := json.Unmarshal(payload, &event); err != nil {
\t\treturn nil, err
\t}
\treturn &event, nil`
    : `\tvar event map[string]any
\tif err := json.Unmarshal(payload, &event); err != nil {
\t\treturn nil, err
\t}
\treturn event, nil`;

  return `package ${packageName}

import (
\t"crypto/hmac"
\t"crypto/sha256"
\t"encoding/hex"
\t"encoding/json"
\t"fmt"
\t"net/http"
\t"strconv"
\t"strings"
\t"time"
)

type WebhookClient struct {
\tsecret          string
\tsignatureHeader string
\ttimestampHeader string
\ttolerance       time.Duration
}

func NewWebhookClient(secret string) *WebhookClient {
\treturn &WebhookClient{
\t\tsecret:          secret,
\t\tsignatureHeader: ${quote(webhook.signature_header)},
\t\ttimestampHeader: ${quote(webhook.timestamp_header)},
\t\ttolerance:       ${webhook.tolerance_seconds} * time.Second,
\t}
}

type WebhookVerificationError struct {
\tReason string
}

func (err *WebhookVerificationError) Error() string {
\treturn "webhook verification failed: " + err.Reason
}

func (client *WebhookClient) Unwrap(payload []byte, headers http.Header) ${returnType} {
\tif err := client.VerifySignature(payload, headers); err != nil {
\t\treturn nil, err
\t}
${decode}
}

func (client *WebhookClient) VerifySignature(payload []byte, headers http.Header) error {
\tif client.secret == "" {
\t\treturn &WebhookVerificationError{Reason: "missing webhook signing secret"}
\t}

\tsignatureHeader := headers.Get(client.signatureHeader)
\tif signatureHeader == "" {
\t\treturn &WebhookVerificationError{Reason: "missing webhook signature header"}
\t}
\tparsedHeader := parseWebhookSignatureHeader(signatureHeader)

\ttimestamp := headers.Get(client.timestampHeader)
\tif timestamp == "" {
\t\ttimestamp = parsedHeader["t"]
\t}
\tif timestamp == "" {
\t\treturn &WebhookVerificationError{Reason: "missing webhook timestamp"}
\t}
\tif err := assertFreshWebhookTimestamp(timestamp, client.tolerance); err != nil {
\t\treturn err
\t}

\tsignature := firstNonEmpty(parsedHeader["v1"], parsedHeader["sha256"], parsedHeader["signature"], parsedHeader["raw"])
\tif signature == "" {
\t\treturn &WebhookVerificationError{Reason: "missing webhook signature value"}
\t}
\treceived, err := hex.DecodeString(signature)
\tif err != nil {
\t\treturn &WebhookVerificationError{Reason: "invalid webhook signature encoding"}
\t}

\tmac := hmac.New(sha256.New, []byte(client.secret))
\tmac.Write([]byte(timestamp))
\tmac.Write([]byte("."))
\tmac.Write(payload)
\tif !hmac.Equal(mac.Sum(nil), received) {
\t\treturn &WebhookVerificationError{Reason: "webhook signature mismatch"}
\t}
\treturn nil
}

func parseWebhookSignatureHeader(value string) map[string]string {
\tresult := map[string]string{}
\tfor _, part := range strings.Split(value, ",") {
\t\ttrimmed := strings.TrimSpace(part)
\t\tif trimmed == "" {
\t\t\tcontinue
\t\t}
\t\tkey, signatureValue, ok := strings.Cut(trimmed, "=")
\t\tif !ok {
\t\t\tresult["raw"] = trimmed
\t\t\tcontinue
\t\t}
\t\tresult[strings.ToLower(strings.TrimSpace(key))] = strings.TrimSpace(signatureValue)
\t}
\treturn result
}

func assertFreshWebhookTimestamp(value string, tolerance time.Duration) error {
\tunixSeconds, err := strconv.ParseInt(value, 10, 64)
\tif err != nil {
\t\treturn &WebhookVerificationError{Reason: "invalid webhook timestamp"}
\t}
\tage := time.Since(time.Unix(unixSeconds, 0))
\tif age < 0 {
\t\tage = -age
\t}
\tif age > tolerance {
\t\treturn &WebhookVerificationError{Reason: fmt.Sprintf("webhook timestamp is outside the %s tolerance window", tolerance)}
\t}
\treturn nil
}

func firstNonEmpty(values ...string) string {
\tfor _, value := range values {
\t\tif value != "" {
\t\t\treturn value
\t\t}
\t}
\treturn ""
}
`;
}

function renderGoWebhookTest(ir: ApiIR, packageName: string): string {
  const webhook = ir.webhooks;
  if (!webhook) return "";
  return `package ${packageName}

import (
\t"crypto/hmac"
\t"crypto/sha256"
\t"encoding/hex"
\t"net/http"
\t"strconv"
\t"testing"
\t"time"
)

func TestWebhookUnwrap(t *testing.T) {
\tsecret := "whsec_test_secret"
\ttimestamp := strconv.FormatInt(time.Now().Unix(), 10)
\tpayload := []byte(\`{"id":"evt_test","type":"customer.created","created":123,"data":{"customer_id":"cus_test"}}\`)

\tmac := hmac.New(sha256.New, []byte(secret))
\tmac.Write([]byte(timestamp))
\tmac.Write([]byte("."))
\tmac.Write(payload)
\tsignature := hex.EncodeToString(mac.Sum(nil))

\tclient := NewClient(WithWebhookSecret(secret))
\tevent, err := client.Webhooks.Unwrap(payload, http.Header{
\t\t${quote(webhook.timestamp_header)}: []string{timestamp},
\t\t${quote(webhook.signature_header)}: []string{"v1=" + signature},
\t})
\tif err != nil {
\t\tt.Fatalf("unwrap returned error: %v", err)
\t}
\tif event.Id != "evt_test" {
\t\tt.Fatalf("unexpected event id: %s", event.Id)
\t}
\tif _, err := client.Webhooks.Unwrap(payload, http.Header{
\t\t${quote(webhook.timestamp_header)}: []string{timestamp},
\t\t${quote(webhook.signature_header)}: []string{"v1=bad"},
\t}); err == nil {
\t\tt.Fatal("expected invalid signature to fail")
\t}
}
`;
}

function renderGoModels(ir: ApiIR, packageName: string): string {
  const needsJSON = ir.types.some((type) => type.kind === "object" && type.extra_fields === "preserve");
  const imports = needsJSON ? '\nimport "encoding/json"\n' : "";
  // All Go package-level identifiers (types + enum consts) share one namespace. Seed the
  // used-set with every type name so enum consts can't collide with a struct/alias type
  // (e.g. enum `SourceType` value `ach_credit_transfer` vs type `SourceTypeAchCreditTransfer`).
  const used = new Set(ir.types.map((type) => type.name));
  const models = ir.types.map((type) => renderGoType(ir, type, used)).join("\n\n");
  return `package ${packageName}
${imports}
${models}
`;
}

function renderGoType(ir: ApiIR, type: TypeIR, used: Set<string>): string {
  if (type.kind === "object") return renderGoObject(ir, type);
  if (type.kind === "enum") {
    const constants = type.values
      .map((value) => {
        const base = `${type.name}${pascalCase(String(value))}`;
        let constantName = base;
        let suffix = 2;
        while (used.has(constantName)) constantName = `${base}${suffix++}`;
        used.add(constantName);
        return `${constantName} ${type.name} = ${quote(String(value))}`;
      })
      .join("\n\t");
    return `type ${type.name} string

const (
\t${constants}
)`;
  }
  if (type.kind === "union") {
    return `type ${type.name} map[string]any`;
  }
  return `type ${type.name} = ${goType(ir, type.target, false)}`;
}

function renderGoObject(ir: ApiIR, type: ObjectTypeIR): string {
  const fields = type.fields.map((field) => renderGoField(ir, field)).join("\n");
  const extra = type.extra_fields === "preserve" ? "\n\tExtraFields map[string]json.RawMessage `json:\"-\"`" : "";
  return `type ${type.name} struct {
${fields}${extra}
}`;
}

function renderGoField(ir: ApiIR, field: FieldIR): string {
  const name = pascalCase(field.name);
  const optional = !field.required || field.nullable || Boolean(field.type.nullable);
  const type = goType(ir, field.type, optional);
  const omitempty = optional ? ",omitempty" : "";
  return `\t${name} ${type} \`json:"${field.wire_name}${omitempty}"\``;
}

function renderGoResource(ir: ApiIR, packageName: string, resource: ResourceIR): string {
  const operations = targetOperationsForResource(ir, resource, "go");
  const children = childResources(ir, resource, "go");
  const params = operations.map((operation) => renderGoParams(ir, resource, operation)).filter(Boolean).join("\n\n");
  const childFields = children.map((child) => `\t${pascalCase(child.name)} *${child.class_name}Service`).join("\n");
  const childInit = children.map((child) => `\tservice.${pascalCase(child.name)} = new${child.class_name}Service(client)`).join("\n");
  const methods = operations
    .flatMap((operation) => [renderGoMethod(ir, resource, operation), renderGoPager(ir, resource, operation)].filter(Boolean))
    .join("\n\n");
  const needsFmt = operations.some((operation) => operation.params.some((param) => param.location === "path" || param.location === "query"));
  const imports = ["\t\"context\"", ...(needsFmt ? ["\t\"fmt\""] : []), "\t\"net/url\""].join("\n");
  return `package ${packageName}

import (
${imports}
)

type ${resource.class_name}Service struct {
\tclient *Client
${childFields}
}

func new${resource.class_name}Service(client *Client) *${resource.class_name}Service {
\tservice := &${resource.class_name}Service{client: client}
${childInit}
\treturn service
}

${params}

${methods}
`;
}

function renderGoParams(ir: ApiIR, resource: ResourceIR, operation: OperationIR): string {
  if (operation.websocket) return "";
  const name = operationTypeName(resource, operation, "Params");
  const fields: string[] = [];
  for (const param of operation.params) {
    const optional = !param.required || param.nullable || Boolean(param.type.nullable) || param.location === "query";
    fields.push(`\t${pascalCase(param.name)} ${goType(ir, param.type, optional)} \`${param.location}:"${param.wire_name}"\``);
  }
  if (operation.request) {
    fields.push(`\tBody ${goType(ir, operation.request.type, false)}`);
  }
  if (fields.length === 0) return "";
  return `type ${name} struct {
${fields.join("\n")}
}`;
}

function renderGoMethod(ir: ApiIR, resource: ResourceIR, operation: OperationIR): string {
  if (operation.websocket) return "";
  const dep = operation.deprecated ? `// Deprecated:${typeof operation.deprecated === "string" ? ` ${operation.deprecated}` : ""}\n` : "";
  if (operation.streaming) {
    const methods: string[] = [];
    if (!operation.streaming.always) methods.push(renderGoRequestMethod(ir, resource, operation, "non-stream"));
    methods.push(renderGoStreamingMethod(ir, resource, operation));
    return dep + methods.join("\n\n");
  }
  return dep + renderGoRequestMethod(ir, resource, operation, "plain");
}

function renderGoRequestMethod(ir: ApiIR, resource: ResourceIR, operation: OperationIR, mode: "plain" | "non-stream"): string {
  const paramsName = operationTypeName(resource, operation, "Params");
  const hasParams = operation.params.length > 0 || Boolean(operation.request);
  const responseType = operation.response ? goType(ir, operation.response, false) : "";
  const returnType = responseType ? `(*${trimPointer(responseType)}, error)` : "error";
  const paramsArg = hasParams ? `, params ${paramsName}` : "";
  const path = renderGoPath(operation);
  const queryLines = operation.params
    .filter((param) => param.location === "query")
    .map((param) => renderGoQueryParam(ir, param))
    .join("\n");

  const discriminator = mode === "non-stream" ? operation.streaming?.param_discriminator : undefined;
  const discriminatorLines = discriminator && operation.request
    ? `\tdiscriminatorValue := false\n\tparams.Body.${pascalCase(discriminator)} = &discriminatorValue\n`
    : "";

  if (operation.request?.multipart) {
    const fields = goMultipartFields(ir, operation);
    const decode = responseType
      ? `\tvar out ${trimPointer(responseType)}
\tif err := service.client.doMultipart(ctx, ${quote(operation.http_method)}, path, query, fields, &out); err != nil {
\t\treturn nil, err
\t}
\treturn &out, nil`
      : `\treturn service.client.doMultipart(ctx, ${quote(operation.http_method)}, path, query, fields, nil)`;
    return `func (service *${resource.class_name}Service) ${pascalCase(operation.name)}(ctx context.Context${paramsArg}) ${returnType} {
\tpath := ${path}
\tquery := url.Values{}
${queryLines ? `${queryLines}\n` : ""}\tfields := map[string]any{
${fields}
\t}
${decode}
}`;
  }

  const body = operation.request ? "params.Body" : "nil";
  if (operation.binary_response) {
    return `func (service *${resource.class_name}Service) ${pascalCase(operation.name)}(ctx context.Context${paramsArg}) ([]byte, error) {
\tpath := ${path}
\tquery := url.Values{}
${queryLines ? `${queryLines}\n` : ""}${discriminatorLines}\tvar out []byte
\tif err := service.client.do(ctx, ${quote(operation.http_method)}, path, query, ${body}, &out); err != nil {
\t\treturn nil, err
\t}
\treturn out, nil
}`;
  }
  const encoding = operation.request?.form_urlencoded ? "form" : operation.request?.text_plain ? "text" : undefined;
  const doExpr = (target: string) =>
    encoding
      ? `service.client.doEncoded(ctx, ${quote(operation.http_method)}, path, query, ${body}, ${target}, ${quote(encoding)})`
      : `service.client.do(ctx, ${quote(operation.http_method)}, path, query, ${body}, ${target})`;
  const decode = responseType
    ? `\tvar out ${trimPointer(responseType)}
\tif err := ${doExpr("&out")}; err != nil {
\t\treturn nil, err
\t}
\treturn &out, nil`
    : `\treturn ${doExpr("nil")}`;
  return `func (service *${resource.class_name}Service) ${pascalCase(operation.name)}(ctx context.Context${paramsArg}) ${returnType} {
\tpath := ${path}
\tquery := url.Values{}
${queryLines ? `${queryLines}\n` : ""}${discriminatorLines}${decode}
}`;
}

function renderGoStreamingMethod(ir: ApiIR, resource: ResourceIR, operation: OperationIR): string {
  const streaming = operation.streaming;
  if (!streaming) return "";
  const paramsName = operationTypeName(resource, operation, "Params");
  const hasParams = operation.params.length > 0 || Boolean(operation.request);
  const eventName = streamEventType(ir, operation)?.name ?? "any";
  const methodName = streaming.always ? pascalCase(operation.name) : `${pascalCase(operation.name)}Streaming`;
  const paramsArg = hasParams ? `, params ${paramsName}` : "";
  const path = renderGoPath(operation);
  const queryLines = operation.params
    .filter((param) => param.location === "query")
    .map((param) => renderGoQueryParam(ir, param))
    .join("\n");
  const discriminator = streaming.param_discriminator;
  const discriminatorLines = discriminator && operation.request
    ? `\tdiscriminatorValue := true\n\tparams.Body.${pascalCase(discriminator)} = &discriminatorValue\n`
    : "";
  const body = operation.request ? "params.Body" : "nil";
  const sse = streaming.protocol === "sse" ? "true" : "false";
  const done = quote(streaming.done_sentinel ?? "");
  return `func (service *${resource.class_name}Service) ${methodName}(ctx context.Context${paramsArg}) (*Stream[${eventName}], error) {
\tpath := ${path}
\tquery := url.Values{}
${queryLines ? `${queryLines}\n` : ""}${discriminatorLines}\tresponse, err := service.client.doStream(ctx, ${quote(operation.http_method)}, path, query, ${body})
\tif err != nil {
\t\treturn nil, err
\t}
\treturn newStream[${eventName}](response.Body, ${sse}, ${done}), nil
}`;
}

function goMultipartFields(ir: ApiIR, operation: OperationIR): string {
  const request = operation.request;
  if (!request || request.type.kind !== "ref") return "";
  const type = typeById(ir, request.type.id);
  if (!type || type.kind !== "object") return "";
  return type.fields
    .map((field) => `\t\t${quote(field.wire_name)}: params.Body.${pascalCase(field.name)},`)
    .join("\n");
}

function renderGoPager(ir: ApiIR, resource: ResourceIR, operation: OperationIR): string {
  const shape = paginationShape(ir, operation);
  if (!shape) return "";
  const pagerName = `${resource.class_name}${pascalCase(operation.name)}Pager`;
  const paramsName = operationTypeName(resource, operation, "Params");
  const itemType = goType(ir, shape.itemType, false);
  const itemsField = pascalCase(shape.itemsField.name);
  const advance = goPagerAdvance(shape);
  return `func (service *${resource.class_name}Service) ${pascalCase(operation.name)}AutoPaging(ctx context.Context, params ${paramsName}) *${pagerName} {
\treturn &${pagerName}{service: service, ctx: ctx, params: params, index: -1}
}

type ${pagerName} struct {
\tservice *${resource.class_name}Service
\tctx     context.Context
\tparams  ${paramsName}
\titems   []${itemType}
\tindex   int
\tdone    bool
\tcurrent ${itemType}
\terr     error
}

func (pager *${pagerName}) Next() bool {
\tif pager.err != nil {
\t\treturn false
\t}
\tfor {
\t\tpager.index++
\t\tif pager.index < len(pager.items) {
\t\t\tpager.current = pager.items[pager.index]
\t\t\treturn true
\t\t}
\t\tif pager.done {
\t\t\treturn false
\t\t}
\t\tpage, err := pager.service.${pascalCase(operation.name)}(pager.ctx, pager.params)
\t\tif err != nil {
\t\t\tpager.err = err
\t\t\treturn false
\t\t}
\t\tpager.items = page.${itemsField}
\t\tpager.index = -1
${advance}
\t}
}

func (pager *${pagerName}) Current() ${itemType} {
\treturn pager.current
}

func (pager *${pagerName}) Err() error {
\treturn pager.err
}${renderGoBackwardPager(resource, operation, shape, pagerName, paramsName, itemType, itemsField)}`;
}

// Bidirectional cursor pagination: a backward pager struct walking the prev cursor.
function renderGoBackwardPager(
  resource: ResourceIR,
  operation: OperationIR,
  shape: NonNullable<ReturnType<typeof paginationShape>>,
  pagerName: string,
  paramsName: string,
  itemType: string,
  itemsField: string,
): string {
  if (shape.kind !== "cursor" || !shape.prevCursorField || !shape.requestPrevCursorParam) return "";
  const back = `${pagerName}Backward`;
  const field = pascalCase(shape.prevCursorField.name);
  const param = pascalCase(shape.requestPrevCursorParam);
  return `

func (service *${resource.class_name}Service) ${pascalCase(operation.name)}AutoPagingBackward(ctx context.Context, params ${paramsName}) *${back} {
\treturn &${back}{service: service, ctx: ctx, params: params, index: -1}
}

type ${back} struct {
\tservice *${resource.class_name}Service
\tctx     context.Context
\tparams  ${paramsName}
\titems   []${itemType}
\tindex   int
\tdone    bool
\tcurrent ${itemType}
\terr     error
}

func (pager *${back}) Next() bool {
\tif pager.err != nil {
\t\treturn false
\t}
\tfor {
\t\tpager.index++
\t\tif pager.index < len(pager.items) {
\t\t\tpager.current = pager.items[pager.index]
\t\t\treturn true
\t\t}
\t\tif pager.done {
\t\t\treturn false
\t\t}
\t\tpage, err := pager.service.${pascalCase(operation.name)}(pager.ctx, pager.params)
\t\tif err != nil {
\t\t\tpager.err = err
\t\t\treturn false
\t\t}
\t\tpager.items = page.${itemsField}
\t\tpager.index = -1
\t\tif page.${field} == nil || *page.${field} == "" {
\t\t\tpager.done = true
\t\t} else {
\t\t\tpager.params.${param} = page.${field}
\t\t}
\t}
}

func (pager *${back}) Current() ${itemType} {
\treturn pager.current
}

func (pager *${back}) Err() error {
\treturn pager.err
}`;
}

function goPagerAdvance(shape: NonNullable<ReturnType<typeof paginationShape>>): string {
  switch (shape.kind) {
    case "cursor": {
      if (!shape.nextCursorField || !shape.requestCursorParam) return "\t\tpager.done = true";
      const field = pascalCase(shape.nextCursorField.name);
      const param = pascalCase(shape.requestCursorParam);
      return `\t\tif page.${field} == nil || *page.${field} == "" {
\t\t\tpager.done = true
\t\t} else {
\t\t\tpager.params.${param} = page.${field}
\t\t}`;
    }
    case "cursor_id": {
      if (!shape.cursorIdParam || !shape.cursorItemIdField) return "\t\tpager.done = true";
      const param = pascalCase(shape.cursorIdParam);
      const idField = pascalCase(shape.cursorItemIdField.name);
      return `\t\tif len(pager.items) == 0 {
\t\t\tpager.done = true
\t\t} else {
\t\t\tnextID := pager.items[len(pager.items)-1].${idField}
\t\t\tif nextID == "" {
\t\t\t\tpager.done = true
\t\t\t} else {
\t\t\t\tpager.params.${param} = &nextID
\t\t\t}
\t\t}`;
    }
    case "offset": {
      if (!shape.offsetParam) return "\t\tpager.done = true";
      const param = pascalCase(shape.offsetParam);
      const totalGuard = shape.totalCountField
        ? `\n\t\t\tif page.${pascalCase(shape.totalCountField.name)} != 0 && next >= page.${pascalCase(shape.totalCountField.name)} {\n\t\t\t\tpager.done = true\n\t\t\t}`
        : "";
      return `\t\tif len(pager.items) == 0 {
\t\t\tpager.done = true
\t\t} else {
\t\t\tvar current int64
\t\t\tif pager.params.${param} != nil {
\t\t\t\tcurrent = *pager.params.${param}
\t\t\t}
\t\t\tnext := current + int64(len(pager.items))
\t\t\tpager.params.${param} = &next${totalGuard}
\t\t}`;
    }
    case "page_number": {
      if (!shape.pageParam) return "\t\tpager.done = true";
      const param = pascalCase(shape.pageParam);
      const currentExpr = shape.currentPageField
        ? `page.${pascalCase(shape.currentPageField.name)}`
        : `func() int64 { if pager.params.${param} != nil { return *pager.params.${param} }; return 1 }()`;
      const totalGuard = shape.totalPagesField
        ? `\n\t\t\tif page.${pascalCase(shape.totalPagesField.name)} != 0 && current >= page.${pascalCase(shape.totalPagesField.name)} {\n\t\t\t\tpager.done = true\n\t\t\t}`
        : "";
      return `\t\tif len(pager.items) == 0 {
\t\t\tpager.done = true
\t\t} else {
\t\t\tcurrent := ${currentExpr}
\t\t\tnext := current + 1
\t\t\tpager.params.${param} = &next${totalGuard}
\t\t}`;
    }
    default:
      return "\t\tpager.done = true";
  }
}

function renderGoPath(operation: OperationIR): string {
  if (!operation.params.some((param) => param.location === "path")) return quote(operation.path);
  return `"` + pathTemplateForGo(operation.path) + `"`;
}

function renderGoQueryParam(ir: ApiIR, param: ParamIR): string {
  const name = pascalCase(param.name);
  const accessor = `params.${name}`;
  const fieldType = goType(ir, param.type, !param.required || param.nullable);
  // Slices serialize as repeated query keys (form/explode style, incl. `name[]`); they are
  // already nil-able so they are never pointers and must not be dereferenced.
  if (fieldType.startsWith("[]") && fieldType !== "[]byte") {
    return `\tfor _, v := range ${accessor} {
\t\tquery.Add(${quote(param.wire_name)}, fmt.Sprint(v))
\t}`;
  }
  if (fieldType.startsWith("map[")) {
    return `\tfor k, v := range ${accessor} {
\t\tquery.Set(${quote(param.wire_name)}+"["+k+"]", fmt.Sprint(v))
\t}`;
  }
  if (fieldType.startsWith("*")) {
    return `\tif ${accessor} != nil {
\t\tquery.Set(${quote(param.wire_name)}, fmt.Sprint(*${accessor}))
\t}`;
  }
  if (!param.required || param.nullable) {
    return `\tif ${accessor} != nil {
\t\tquery.Set(${quote(param.wire_name)}, fmt.Sprint(${accessor}))
\t}`;
  }
  return `\tquery.Set(${quote(param.wire_name)}, fmt.Sprint(${accessor}))`;
}

function renderGoReadme(ir: ApiIR, modulePath: string): string {
  return `# ${ir.api.name} Go SDK

\`\`\`go
import "${modulePath}"

client := ${goPackageName(modulePath)}.NewClient()
_ = client
\`\`\`

---
<sub>Generated by [Inox](https://github.com/CREVIOS/inox) — one spec, every SDK.</sub>
`;
}

function goType(ir: ApiIR, ref: TypeRefIR, optional: boolean): string {
  let value: string;
  if (ref.kind === "ref") value = typeById(ir, ref.id)?.name ?? "any";
  else if (ref.kind === "array") value = `[]${goType(ir, ref.items, false)}`;
  else if (ref.kind === "map") value = `map[string]${goType(ir, ref.values, false)}`;
  else if (ref.kind === "file") value = "[]byte";
  else if (ref.name === "integer") value = "int64";
  else if (ref.name === "number") value = "float64";
  else if (ref.name === "boolean") value = "bool";
  else if (ref.name === "string") value = "string";
  else value = "any";

  if (optional && !value.startsWith("[]") && !value.startsWith("map[") && value !== "any") {
    return `*${value}`;
  }
  return value;
}

function trimPointer(type: string): string {
  return type.startsWith("*") ? type.slice(1) : type;
}

function goPackageName(modulePath: string): string {
  const lastSegment = modulePath.split("/").at(-1) ?? "sdk";
  return snakeCase(lastSegment.replace(/-go$/, "")).replace(/[^a-zA-Z0-9_]/g, "_");
}
