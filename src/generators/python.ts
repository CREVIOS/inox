import type { ApiIR, FieldIR, GenerationResult, ObjectTypeIR, OperationIR, ResourceIR, TypeIR, TypeRefIR } from "../types.js";
import { indent, pascalCase, quote, snakeCase } from "../utils.js";
import { renderPyConformanceTest } from "../conformance.js";
import { renderReleaseWorkflow } from "../release.js";
import {
  bearerHeaderPrefix,
  childResources,
  createTargetWriter,
  emittedResources,
  paginationShape,
  resourceFileSlug,
  streamEventType,
  targetOperationsForResource,
  topLevelResources,
  typeById,
} from "./common.js";

export async function generatePython(ir: ApiIR, rootOutDir: string): Promise<GenerationResult> {
  const writer = createTargetWriter("python", rootOutDir);
  const packageName = snakeCase(ir.targets.python?.package_name ?? ir.api.package_prefix.replace(/-api$/, ""));

  await writer.write(
    "pyproject.toml",
    `[project]
name = "${packageName}"
version = "${ir.api.version ?? "0.1.0"}"
description = "${ir.api.name} Python SDK"
requires-python = ">=3.11"
dependencies = []

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
`,
  );

  await writer.write(`src/${packageName}/__init__.py`, renderPythonInit(ir));
  await writer.write(`src/${packageName}/_client.py`, renderPythonClient(ir));
  await writer.write(`src/${packageName}/_exceptions.py`, renderPythonExceptions());
  await writer.write(`src/${packageName}/_streaming.py`, renderPythonStreaming());
  await writer.write(`src/${packageName}/_otel.py`, renderPythonOtel());
  await writer.write(`src/${packageName}/types/__init__.py`, renderPythonTypesInit(ir));
  await writer.write(`src/${packageName}/resources/__init__.py`, renderPythonResourcesInit(ir));
  await writer.write("tests/test_smoke.py", renderPythonSmokeTest(packageName));
  await writer.write("tests/test_endpoints.py", renderPyConformanceTest(ir, packageName));
  if (ir.webhooks) {
    await writer.write(`src/${packageName}/_webhooks.py`, renderPythonWebhooks(ir));
    await writer.write("tests/test_webhooks.py", renderPythonWebhookTest(ir, packageName));
  }

  for (const type of ir.types) {
    await writer.write(`src/${packageName}/types/${pyTypeModule(type)}.py`, renderPythonType(ir, type));
  }

  for (const resource of emittedResources(ir, "python")) {
    await writer.write(`src/${packageName}/resources/${pyModule(resourceFileSlug(resource))}.py`, renderPythonResource(ir, resource));
  }

  await writer.write(".github/workflows/release.yml", renderReleaseWorkflow("python", ir));
  await writer.write("README.md", renderPythonReadme(ir, packageName));
  return writer.result();
}

function renderPythonInit(ir: ApiIR): string {
  const webhookImports = ir.webhooks ? `from ._webhooks import WebhookClient, WebhookVerificationError\n` : "";
  const webhookExports = ir.webhooks ? `, "WebhookClient", "WebhookVerificationError"` : "";
  return `from ._client import ${ir.client.name}, Async${ir.client.name}
from ._exceptions import (
    ApiError,
    BadRequestError,
    AuthenticationError,
    PermissionDeniedError,
    NotFoundError,
    ConflictError,
    UnprocessableEntityError,
    RateLimitError,
    InternalServerError,
)
from ._streaming import Stream, AsyncStream
from ._otel import create_otel_hooks
${webhookImports}

__all__ = ["${ir.client.name}", "Async${ir.client.name}", "ApiError", "BadRequestError", "AuthenticationError", "PermissionDeniedError", "NotFoundError", "ConflictError", "UnprocessableEntityError", "RateLimitError", "InternalServerError", "Stream", "AsyncStream", "create_otel_hooks"${webhookExports}]
`;
}

function renderPythonClient(ir: ApiIR): string {
  const webhookImport = ir.webhooks ? "from ._webhooks import WebhookClient\n" : "";
  const webhookParameter = ir.webhooks ? "        webhook_secret: str | None = None," : "";
  const webhookAssignment = ir.webhooks ? "        self.webhooks = WebhookClient(secret=webhook_secret)\n" : "";
  const oauth = ir.client.oauth2;
  const basic = ir.client.auth?.basic;
  const authPrefix = bearerHeaderPrefix(ir);
  const basicUserEnv = basic?.username_env ?? `${ir.client.env_prefix}_USERNAME`;
  const basicPassEnv = basic?.password_env ?? `${ir.client.env_prefix}_PASSWORD`;
  const basicParam = basic ? "\n        username: str | None = None,\n        password: str | None = None," : "";
  const basicInit = basic
    ? `        import base64 as _b64
        _bu = username or os.getenv("${basicUserEnv}")
        _bp = password or os.getenv("${basicPassEnv}")
        self._basic_auth = ("Basic " + _b64.b64encode(f"{_bu}:{_bp}".encode()).decode()) if _bu and _bp else None
`
    : "        self._basic_auth = None\n";
  const oauthParam = oauth ? "\n        client_id: str | None = None,\n        client_secret: str | None = None," : "";
  const oauthInit = oauth
    ? `        self.client_id = client_id or os.getenv("${oauth.client_id_env}")
        self.client_secret = client_secret or os.getenv("${oauth.client_secret_env}")
        self.oauth2_token_url = ${quote(oauth.token_url)}
        self.oauth2_scopes = ${JSON.stringify(oauth.scopes)}
        self.oauth2_auth_style = ${quote(oauth.auth_style)}
        self.oauth2_authorization_url = ${oauth.authorization_url ? quote(oauth.authorization_url) : "None"}
        self.oauth2_device_url = ${oauth.device_authorization_url ? quote(oauth.device_authorization_url) : "None"}
        self._cached_token: str | None = None
        self._token_expiry = 0.0
`
    : `        self.client_id = None
        self.client_secret = None
`;
  const oauthFlowMethods = oauth
    ? `${oauth.authorization_url ? `
    def authorization_url(self, redirect_uri: str, state: str | None = None, scopes: list[str] | None = None) -> str:
        base = self.oauth2_authorization_url if self.oauth2_authorization_url.startswith("http") else self.base_url + self.oauth2_authorization_url
        params = {"response_type": "code", "redirect_uri": redirect_uri}
        if self.client_id:
            params["client_id"] = self.client_id
        chosen = scopes if scopes is not None else self.oauth2_scopes
        if chosen:
            params["scope"] = " ".join(chosen)
        if state:
            params["state"] = state
        sep = "&" if "?" in base else "?"
        return base + sep + urllib.parse.urlencode(params)

    def exchange_code(self, code: str, redirect_uri: str) -> str:
        return self._oauth_token_request({"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri})
` : ""}${oauth.device_authorization_url ? `
    def request_device_code(self) -> dict:
        url = self.oauth2_device_url if self.oauth2_device_url.startswith("http") else self.base_url + self.oauth2_device_url
        params = {}
        if self.client_id:
            params["client_id"] = self.client_id
        if self.oauth2_scopes:
            params["scope"] = " ".join(self.oauth2_scopes)
        req = urllib.request.Request(url, data=urllib.parse.urlencode(params).encode("utf-8"), method="POST", headers={"content-type": "application/x-www-form-urlencoded", "accept": "application/json"})
        with urllib.request.urlopen(req, timeout=self.timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    def poll_device_token(self, device_code: str, interval: float = 5) -> str:
        while True:
            try:
                return self._oauth_token_request({"grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": device_code})
            except ApiError as err:
                code = err.body.get("error") if isinstance(err.body, dict) else None
                if code in ("authorization_pending", "slow_down"):
                    time.sleep(interval)
                    continue
                raise
` : ""}${oauth.authorization_url || oauth.device_authorization_url ? `
    def _oauth_token_request(self, extra: dict) -> str:
        token_url = self.oauth2_token_url if self.oauth2_token_url.startswith("http") else self.base_url + self.oauth2_token_url
        params = dict(extra)
        if self.client_id:
            params["client_id"] = self.client_id
        if self.client_secret:
            params["client_secret"] = self.client_secret
        req = urllib.request.Request(token_url, data=urllib.parse.urlencode(params).encode("utf-8"), method="POST", headers={"content-type": "application/x-www-form-urlencoded", "accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as http_err:
            raw = http_err.read().decode("utf-8")
            try:
                parsed = json.loads(raw)
            except ValueError:
                parsed = raw
            raise create_api_error(http_err.code, parsed, http_err.headers.get("x-request-id"), http_err.headers) from None
        self._cached_token = payload["access_token"]
        self._token_expiry = time.time() + (payload.get("expires_in", 3600) - 30)
        return payload["access_token"]
` : ""}`
    : "";
  const oauthMethods = oauth
    ? `
    def _get_token(self, force: bool = False) -> str | None:
        if not (self.client_id and self.client_secret):
            return None
        if not force and self._cached_token and time.time() < self._token_expiry:
            return self._cached_token
        token_url = self.oauth2_token_url if self.oauth2_token_url.startswith("http") else self.base_url + self.oauth2_token_url
        params = {"grant_type": "client_credentials"}
        token_headers = {"content-type": "application/x-www-form-urlencoded", "accept": "application/json"}
        if self.oauth2_scopes:
            params["scope"] = " ".join(self.oauth2_scopes)
        if self.oauth2_auth_style == "basic":
            import base64
            token_headers["authorization"] = "Basic " + base64.b64encode(f"{self.client_id}:{self.client_secret}".encode()).decode()
        else:
            params["client_id"] = self.client_id
            params["client_secret"] = self.client_secret
        token_request = urllib.request.Request(token_url, data=urllib.parse.urlencode(params).encode("utf-8"), method="POST", headers=token_headers)
        with urllib.request.urlopen(token_request, timeout=self.timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
        self._cached_token = payload["access_token"]
        self._token_expiry = time.time() + (payload.get("expires_in", 3600) - 30)
        return self._cached_token

    def _resolve_bearer(self) -> str | None:
        if self.client_id and self.client_secret:
            return self._get_token()
        return self.api_key
`
    : `
    def _resolve_bearer(self) -> str | None:
        return self.api_key
`;
  const syncResources = topLevelResources(ir, "python");
  const resourceAssignments = syncResources
    .map((resource) => {
      const module = pyModule(resourceFileSlug(resource));
      return `        from .resources.${module} import ${resource.class_name}Resource
        self.${resource.name} = ${resource.class_name}Resource(self)
`;
    })
    .join("");
  const asyncAssignments = syncResources
    .map((resource) => {
      const module = pyModule(resourceFileSlug(resource));
      return `        from .resources.${module} import Async${resource.class_name}Resource
        self.${resource.name} = Async${resource.class_name}Resource(self)
`;
    })
    .join("");

  return `from __future__ import annotations

import asyncio
import json
import os
import platform
import random
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Iterator

from ._exceptions import ApiError, create_api_error, RawResponse
from ._streaming import Stream, AsyncStream
${webhookImport}

_MULTIPART_OMIT = object()


class _BaseClient:
    _ENVIRONMENTS: dict[str, str] = ${JSON.stringify(ir.client.environments)}

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        environment: str | None = None,
        timeout: float = ${ir.client.timeout_ms / 1000},
        max_retries: int = ${ir.client.retry_policy.max_retries},
        omit_stainless_headers: bool = ${ir.client.omit_stainless_headers ? "True" : "False"},${oauthParam}${basicParam}
        on_request: Callable[[dict[str, Any]], None] | None = None,
        on_response: Callable[[dict[str, Any]], None] | None = None,
        on_error: Callable[[dict[str, Any]], None] | None = None,
${webhookParameter}
    ) -> None:
        self.api_key = api_key or os.getenv("${ir.client.env_prefix}_API_KEY")
        resolved_url = base_url or (self._ENVIRONMENTS.get(environment) if environment else None) or ${quote(ir.client.base_url)}
        self.base_url = resolved_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.retry_statuses = {${ir.client.retry_policy.retry_statuses.join(", ")}}
        self.omit_stainless_headers = omit_stainless_headers
        self.idempotency_header = ${ir.client.idempotency_header ? quote(ir.client.idempotency_header) : "None"}
        self.package_version = ${quote(ir.api.version ?? "0.1.0")}
        self._on_request = on_request
        self._on_response = on_response
        self._on_error = on_error
${oauthInit}${basicInit}${webhookAssignment}

    def _headers(self, *, extra: dict[str, str] | None = None, bearer: str | None = None) -> dict[str, str]:
        headers = {"accept": "application/json", **(extra or {})}
        if not self.omit_stainless_headers:
            headers.update({
                "x-stainless-lang": "python",
                "x-stainless-package-version": self.package_version,
                "x-stainless-runtime": platform.python_implementation(),
                "x-stainless-runtime-version": sys.version.split()[0],
                "x-stainless-timeout": str(self.timeout),
            })
        if bearer:
            headers["authorization"] = f"${authPrefix}{bearer}"
        elif self._basic_auth:
            headers["authorization"] = self._basic_auth
        return headers
${oauthMethods}${oauthFlowMethods}

    def request(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, Any] | None = None,
        body: Any = None,
        headers: dict[str, str] | None = None,
        multipart: bool = False,
        form_urlencoded: bool = False,
        text_plain: bool = False,
        idempotency_key: str | None = None,
        timeout: float | None = None,
        max_retries: int | None = None,
        binary: bool = False,
        with_meta: bool = False,
    ) -> Any:
        effective_timeout = timeout if timeout is not None else self.timeout
        effective_retries = max_retries if max_retries is not None else self.max_retries
        url = f"{self.base_url}{path}"
        if query:
            clean_query = [(key, value) for key, value in query.items() if value is not None]
            if clean_query:
                url = f"{url}?{urllib.parse.urlencode(clean_query, doseq=True)}"

        data = None
        bearer = self._resolve_bearer()
        request_headers = self._headers(extra=headers, bearer=bearer)
        if multipart and isinstance(body, dict):
            content_type, data = _encode_multipart(body)
            request_headers["content-type"] = content_type
        elif form_urlencoded and isinstance(body, dict):
            request_headers["content-type"] = "application/x-www-form-urlencoded"
            data = _encode_form(body).encode("utf-8")
        elif text_plain and body is not None:
            request_headers["content-type"] = "text/plain"
            data = (body if isinstance(body, str) else str(body)).encode("utf-8")
        elif body is not None:
            request_headers["content-type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        if self.idempotency_header and method.lower() != "get" and self.idempotency_header not in request_headers:
            request_headers[self.idempotency_header] = idempotency_key or f"stainless-retry-{random.getrandbits(128):032x}"

        refreshed = False
        for attempt in range(effective_retries + 1):
            if not self.omit_stainless_headers:
                request_headers["x-stainless-retry-count"] = str(attempt)
            request = urllib.request.Request(url, data=data, method=method.upper(), headers=request_headers)
            started = time.time()
            info = {"method": method.upper(), "url": url, "attempt": attempt}
            if self._on_request:
                self._on_request(info)
            try:
                with urllib.request.urlopen(request, timeout=effective_timeout) as response:
                    if binary:
                        payload = response.read()
                        if self._on_response:
                            self._on_response({**info, "status": response.status, "duration_ms": (time.time() - started) * 1000})
                        return payload
                    raw = response.read().decode("utf-8")
                    if self._on_response:
                        self._on_response({**info, "status": response.status, "duration_ms": (time.time() - started) * 1000})
                    parsed_ok = json.loads(raw) if raw else None
                    if with_meta:
                        return RawResponse(parsed_ok, response.status, dict(response.headers), response.headers.get("x-request-id"))
                    return parsed_ok
            except urllib.error.HTTPError as exc:
                if self._on_response:
                    self._on_response({**info, "status": exc.code, "duration_ms": (time.time() - started) * 1000})
                raw = exc.read().decode("utf-8")
                try:
                    parsed: Any = json.loads(raw) if raw else None
                except json.JSONDecodeError:
                    parsed = raw
                if exc.code == 401 and self.client_id and self.client_secret and not refreshed:
                    refreshed = True
                    request_headers["authorization"] = f"${authPrefix}{self._get_token(force=True)}"
                    continue
                if attempt < effective_retries and _should_retry(exc, self.retry_statuses):
                    time.sleep(_computed_backoff_seconds(attempt, exc.headers.get("retry-after"), exc.headers.get("retry-after-ms")))
                    continue
                raise create_api_error(exc.code, parsed, exc.headers.get("x-request-id"), exc.headers) from exc
            except urllib.error.URLError as exc:
                if self._on_error:
                    self._on_error({**info, "error": exc})
                if attempt >= effective_retries:
                    raise
                time.sleep(_backoff_seconds(attempt))
        raise RuntimeError("request retry loop exited unexpectedly")

    def request_absolute(self, absolute_url: str, *, headers: dict[str, str] | None = None) -> Any:
        if absolute_url.startswith(self.base_url):
            path = absolute_url[len(self.base_url):]
        else:
            parsed = urllib.parse.urlparse(absolute_url)
            path = parsed.path + (f"?{parsed.query}" if parsed.query else "")
        return self.request("get", path, headers=headers)

    def stream(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, Any] | None = None,
        body: Any = None,
        headers: dict[str, str] | None = None,
        sse: bool = True,
        done_sentinel: str | None = None,
    ) -> Iterator[Any]:
        url = f"{self.base_url}{path}"
        if query:
            clean_query = [(key, value) for key, value in query.items() if value is not None]
            if clean_query:
                url = f"{url}?{urllib.parse.urlencode(clean_query, doseq=True)}"
        request_headers = self._headers(extra={"accept": "text/event-stream", **(headers or {})}, bearer=self._resolve_bearer())
        data = None
        if body is not None:
            request_headers["content-type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(url, data=data, method=method.upper(), headers=request_headers)
        try:
            response = urllib.request.urlopen(request, timeout=self.timeout)
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8")
            try:
                parsed: Any = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                parsed = raw
            raise create_api_error(exc.code, parsed, exc.headers.get("x-request-id"), exc.headers) from exc
        return _iter_stream(response, sse, done_sentinel)

    async def async_request(self, method: str, path: str, **kwargs: Any) -> Any:
        return await asyncio.to_thread(lambda: self.request(method, path, **kwargs))

    async def async_request_stream(self, method: str, path: str, **kwargs: Any) -> Iterator[Any]:
        return await asyncio.to_thread(lambda: self.stream(method, path, **kwargs))


class ${ir.client.name}(_BaseClient):
    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
${resourceAssignments || "        pass\n"}

    def __enter__(self) -> "${ir.client.name}":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


class Async${ir.client.name}(_BaseClient):
    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
${asyncAssignments || "        pass\n"}


def _backoff_seconds(attempt: int) -> float:
    return _computed_backoff_seconds(attempt, None, None)


def _computed_backoff_seconds(attempt: int, retry_after: str | None, retry_after_ms: str | None) -> float:
    if retry_after_ms:
        try:
            milliseconds = float(retry_after_ms)
            if 0 <= milliseconds < 60_000:
                return milliseconds / 1000
        except ValueError:
            pass
    if retry_after:
        try:
            seconds = float(retry_after)
            if 0 <= seconds < 60:
                return seconds
        except ValueError:
            pass
    return min(8.0, 0.5 * (2 ** attempt)) * random.uniform(0.75, 1.25)


def _should_retry(exc: urllib.error.HTTPError, retry_statuses: set[int]) -> bool:
    should_retry = exc.headers.get("x-should-retry")
    if should_retry == "true":
        return True
    if should_retry == "false":
        return False
    return exc.code in retry_statuses or exc.code >= 500


def _iter_stream(response: Any, sse: bool, done_sentinel: str | None) -> Iterator[Any]:
    if sse:
        data_lines: list[str] = []
        for raw in response:
            line = raw.decode("utf-8").rstrip("\\n").rstrip("\\r")
            if line == "":
                if data_lines:
                    data = "\\n".join(data_lines)
                    data_lines = []
                    if done_sentinel is not None and data == done_sentinel:
                        return
                    yield json.loads(data)
                continue
            if line.startswith(":"):
                continue
            if line.startswith("data:"):
                data_lines.append(line[5:].lstrip(" "))
        if data_lines:
            data = "\\n".join(data_lines)
            if not (done_sentinel is not None and data == done_sentinel):
                yield json.loads(data)
    else:
        for raw in response:
            line = raw.decode("utf-8").strip()
            if not line:
                continue
            if done_sentinel is not None and line == done_sentinel:
                return
            yield json.loads(line)


def _encode_form(body: dict[str, Any]) -> str:
    # application/x-www-form-urlencoded with bracket notation for nested objects/arrays.
    parts: list[tuple[str, str]] = []

    def add(key: str, value: Any) -> None:
        if value is None:
            return
        if isinstance(value, (list, tuple)):
            for i, item in enumerate(value):
                add(f"{key}[{i}]", item)
        elif isinstance(value, dict):
            for k, v in value.items():
                add(f"{key}[{k}]", v)
        else:
            parts.append((key, str(value)))

    for key, value in body.items():
        add(key, value)
    return urllib.parse.urlencode(parts)


def _encode_multipart(fields: dict[str, Any]) -> tuple[str, bytes]:
    boundary = "----sdkgen" + secrets.token_hex(16)
    body = b""
    for key, value in fields.items():
        if value is None:
            continue
        body += b"--" + boundary.encode() + b"\\r\\n"
        if isinstance(value, tuple) and len(value) == 2:
            filename, content = value
            body += f'Content-Disposition: form-data; name="{key}"; filename="{filename}"\\r\\n'.encode()
            body += b"Content-Type: application/octet-stream\\r\\n\\r\\n"
            body += (content if isinstance(content, (bytes, bytearray)) else str(content).encode()) + b"\\r\\n"
        elif isinstance(value, (bytes, bytearray)):
            body += f'Content-Disposition: form-data; name="{key}"; filename="{key}"\\r\\n'.encode()
            body += b"Content-Type: application/octet-stream\\r\\n\\r\\n"
            body += bytes(value) + b"\\r\\n"
        else:
            body += f'Content-Disposition: form-data; name="{key}"\\r\\n\\r\\n'.encode()
            body += str(value).encode() + b"\\r\\n"
    body += b"--" + boundary.encode() + b"--\\r\\n"
    return f"multipart/form-data; boundary={boundary}", body
`;
}

function renderPythonStreaming(): string {
  return `from __future__ import annotations

import asyncio
from typing import AsyncIterator, Callable, Generic, Iterator, TypeVar

T = TypeVar("T")


class Stream(Generic[T]):
    """Thin iterable wrapper over a server-sent-event or JSONL response."""

    def __init__(self, iterator: Iterator[T]) -> None:
        self._iterator = iterator

    def __iter__(self) -> Iterator[T]:
        return self._iterator

    def __next__(self) -> T:
        return next(self._iterator)

    def subscribe(
        self,
        on_event: "Callable[[T], None]",
        *,
        on_end: "Callable[[], None] | None" = None,
        on_error: "Callable[[Exception], None] | None" = None,
    ) -> None:
        """Event-handler API: drain the stream, calling on_event per item. Use this OR iteration."""
        try:
            for event in self._iterator:
                on_event(event)
            if on_end is not None:
                on_end()
        except Exception as error:  # noqa: BLE001
            if on_error is not None:
                on_error(error)
            else:
                raise


class AsyncStream(Generic[T]):
    def __init__(self, iterator: Iterator[T]) -> None:
        self._iterator = iterator

    def __aiter__(self) -> "AsyncStream[T]":
        return self

    async def __anext__(self) -> T:
        sentinel = object()
        value = await asyncio.to_thread(next, self._iterator, sentinel)
        if value is sentinel:
            raise StopAsyncIteration
        return value
`;
}

function renderPythonOtel(): string {
  return `"""Optional OpenTelemetry instrumentation (zero dependency).

Pass any tracer exposing start_span(name, kind=...) -> span where the span has
set_attribute(key, value), set_status(code) and end(). Emits one CLIENT span per HTTP
attempt with stable HTTP semantic-convention attributes. Wire via:

    client = Client(**create_otel_hooks(tracer))
"""
from __future__ import annotations

from typing import Any, Callable
from urllib.parse import urlparse

_SPAN_KIND_CLIENT = 3  # SpanKind.CLIENT
_STATUS_ERROR = 2  # StatusCode.ERROR


def create_otel_hooks(tracer: Any) -> dict[str, Callable[[dict[str, Any]], None]]:
    spans: dict[str, Any] = {}

    def key(info: dict[str, Any]) -> str:
        return f"{info['method']} {info['url']} #{info.get('attempt', 0)}"

    def on_request(info: dict[str, Any]) -> None:
        parsed = urlparse(info["url"])
        span = tracer.start_span(info["method"], kind=_SPAN_KIND_CLIENT)
        span.set_attribute("http.request.method", info["method"])
        span.set_attribute("url.full", info["url"])
        if parsed.hostname:
            span.set_attribute("server.address", parsed.hostname)
        if parsed.port:
            span.set_attribute("server.port", parsed.port)
        if info.get("attempt"):
            span.set_attribute("http.request.resend_count", info["attempt"])
        spans[key(info)] = span

    def on_response(info: dict[str, Any]) -> None:
        span = spans.pop(key(info), None)
        if span is None:
            return
        span.set_attribute("http.response.status_code", info["status"])
        if info["status"] >= 400:
            span.set_status(_STATUS_ERROR)
        span.end()

    def on_error(info: dict[str, Any]) -> None:
        span = spans.pop(key(info), None)
        if span is None:
            return
        span.set_attribute("error.type", type(info["error"]).__name__)
        span.set_status(_STATUS_ERROR)
        span.end()

    return {"on_request": on_request, "on_response": on_response, "on_error": on_error}
`;
}

function renderPythonExceptions(): string {
  return `from __future__ import annotations

from typing import Any


class ApiError(Exception):
    def __init__(self, status_code: int, body: Any, request_id: str | None = None, headers: Any = None) -> None:
        message = f"API request failed with status {status_code}"
        if request_id:
            message += f" (request id: {request_id})"
        super().__init__(message)
        self.status_code = status_code
        self.body = body
        self.request_id = request_id
        self.headers = headers


class BadRequestError(ApiError):
    pass


class AuthenticationError(ApiError):
    pass


class PermissionDeniedError(ApiError):
    pass


class NotFoundError(ApiError):
    pass


class ConflictError(ApiError):
    pass


class UnprocessableEntityError(ApiError):
    pass


class RateLimitError(ApiError):
    pass


class InternalServerError(ApiError):
    pass


_ERROR_BY_STATUS = {
    400: BadRequestError,
    401: AuthenticationError,
    403: PermissionDeniedError,
    404: NotFoundError,
    409: ConflictError,
    422: UnprocessableEntityError,
    429: RateLimitError,
}


def create_api_error(status_code: int, body: Any, request_id: str | None = None, headers: Any = None) -> ApiError:
    cls = _ERROR_BY_STATUS.get(status_code)
    if cls is None and status_code >= 500:
        cls = InternalServerError
    return (cls or ApiError)(status_code, body, request_id, headers)


class RawResponse:
    """Parsed data plus the raw HTTP status, headers, and request id (from with_raw_response)."""

    def __init__(self, data: Any, status_code: int, headers: Any, request_id: str | None = None) -> None:
        self.data = data
        self.status_code = status_code
        self.headers = headers
        self.request_id = request_id
`;
}

function renderPythonWebhooks(ir: ApiIR): string {
  const webhook = ir.webhooks;
  if (!webhook) return "";
  const payloadType = webhook.payload_type_id ? typeById(ir, webhook.payload_type_id)?.name : undefined;
  const payloadImport = payloadType ? `from .types.${snakeCase(payloadType)} import ${payloadType}\n` : "";
  const returnType = payloadType ?? "Any";
  return `from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from typing import Any, Mapping, Sequence
${payloadImport}

class WebhookVerificationError(Exception):
    pass


class WebhookClient:
    def __init__(self, *, secret: str | None = None, tolerance_seconds: int = ${webhook.tolerance_seconds}) -> None:
        self.secret = secret or os.getenv("${webhook.signing_secret_env}")
        self.tolerance_seconds = tolerance_seconds

    def unwrap(self, payload: str | bytes, headers: Mapping[str, str | Sequence[str]]) -> ${returnType}:
        self.verify_signature(payload, headers)
        return json.loads(_payload_text(payload))

    def verify_signature(self, payload: str | bytes, headers: Mapping[str, str | Sequence[str]]) -> bool:
        if not self.secret:
            raise WebhookVerificationError("Missing webhook signing secret")

        signature_header = _header_value(headers, "${webhook.signature_header}")
        if not signature_header:
            raise WebhookVerificationError("Missing webhook signature header")

        parsed_header = _parse_signature_header(signature_header)
        timestamp = _header_value(headers, "${webhook.timestamp_header}") or parsed_header.get("t")
        if not timestamp:
            raise WebhookVerificationError("Missing webhook timestamp")
        _assert_fresh_timestamp(timestamp, self.tolerance_seconds)

        signature = parsed_header.get("v1") or parsed_header.get("sha256") or parsed_header.get("signature") or parsed_header.get("raw")
        if not signature:
            raise WebhookVerificationError("Missing webhook signature value")

        signed_payload = timestamp.encode("utf-8") + b"." + _payload_bytes(payload)
        expected = hmac.new(self.secret.encode("utf-8"), signed_payload, hashlib.sha256).digest()
        try:
            received = bytes.fromhex(signature)
        except ValueError as exc:
            raise WebhookVerificationError("Invalid webhook signature encoding") from exc
        if not hmac.compare_digest(expected, received):
            raise WebhookVerificationError("Webhook signature mismatch")
        return True


def _header_value(headers: Mapping[str, str | Sequence[str]], name: str) -> str | None:
    wanted = name.lower()
    for key, value in headers.items():
        if key.lower() != wanted:
            continue
        if isinstance(value, str):
            return value
        for item in value:
            return item
    return None


def _parse_signature_header(value: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for part in value.split(","):
        trimmed = part.strip()
        if not trimmed:
            continue
        if "=" not in trimmed:
            result["raw"] = trimmed
            continue
        key, signature_value = trimmed.split("=", 1)
        result[key.strip().lower()] = signature_value.strip()
    return result


def _assert_fresh_timestamp(value: str, tolerance_seconds: int) -> None:
    try:
        timestamp = int(value)
    except ValueError as exc:
        raise WebhookVerificationError("Invalid webhook timestamp") from exc
    if abs(time.time() - timestamp) > tolerance_seconds:
        raise WebhookVerificationError("Webhook timestamp is outside the tolerance window")


def _payload_bytes(payload: str | bytes) -> bytes:
    return payload.encode("utf-8") if isinstance(payload, str) else payload


def _payload_text(payload: str | bytes) -> str:
    return payload if isinstance(payload, str) else payload.decode("utf-8")
`;
}

function renderPythonSmokeTest(packageName: string): string {
  return `import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

import ${packageName}  # noqa: E402


class SmokeTest(unittest.TestCase):
    def test_imports_package(self) -> None:
        self.assertTrue(hasattr(${packageName}, "__all__"))


if __name__ == "__main__":
    unittest.main()
`;
}

function renderPythonWebhookTest(ir: ApiIR, packageName: string): string {
  const webhook = ir.webhooks;
  if (!webhook) return "";
  return `import hashlib
import hmac
import json
import pathlib
import sys
import time
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from ${packageName} import ${ir.client.name}, WebhookVerificationError  # noqa: E402


class WebhookTest(unittest.TestCase):
    def test_unwrap_signed_payload(self) -> None:
        secret = "whsec_test_secret"
        timestamp = str(int(time.time()))
        payload = json.dumps({
            "id": "evt_test",
            "type": "customer.created",
            "created": int(timestamp),
            "data": {"customer_id": "cus_test"},
        }, separators=(",", ":"))
        signature = hmac.new(secret.encode(), f"{timestamp}.{payload}".encode(), hashlib.sha256).hexdigest()
        client = ${ir.client.name}(webhook_secret=secret)

        event = client.webhooks.unwrap(payload, {
            "${webhook.timestamp_header}": timestamp,
            "${webhook.signature_header}": f"v1={signature}",
        })

        self.assertEqual(event["id"], "evt_test")
        with self.assertRaises(WebhookVerificationError):
            client.webhooks.unwrap(payload, {
                "${webhook.timestamp_header}": timestamp,
                "${webhook.signature_header}": "v1=bad",
            })


if __name__ == "__main__":
    unittest.main()
`;
}

function renderPythonTypesInit(ir: ApiIR): string {
  const imports = ir.types.map((type) => `from .${pyTypeModule(type)} import ${type.name}`);
  const all = ir.types.map((type) => quote(type.name)).join(", ");
  return `${imports.join("\n")}

__all__ = [${all}]
`;
}

function renderPythonResourcesInit(ir: ApiIR): string {
  const resources = emittedResources(ir, "python");
  const imports = resources.map((resource) => {
    const module = pyModule(resourceFileSlug(resource));
    return `from .${module} import ${resource.class_name}Resource, Async${resource.class_name}Resource`;
  });
  const all = resources.flatMap((resource) => [`${resource.class_name}Resource`, `Async${resource.class_name}Resource`]).map(quote).join(", ");
  return `${imports.join("\n")}

__all__ = [${all}]
`;
}

function renderPythonType(ir: ApiIR, type: TypeIR): string {
  if (type.kind === "object") return renderPythonObject(ir, type);
  if (type.kind === "enum") {
    const literals = type.values.map((value) => JSON.stringify(value)).join(", ");
    return `from __future__ import annotations

from typing import Literal, TypeAlias

${type.name}: TypeAlias = Literal[${literals}] | ${type.value_type === "integer" ? "int" : "str"}
`;
  }
  if (type.kind === "union") {
    return `from __future__ import annotations

from typing import Any, TypeAlias

${type.name}: TypeAlias = ${type.variants.map((variant) => pythonType(ir, variant)).join(" | ") || "Any"} | dict[str, Any]
`;
  }
  return `from __future__ import annotations

from typing import TypeAlias

${type.name}: TypeAlias = ${pythonType(ir, type.target)}
`;
}

function renderPythonObject(ir: ApiIR, type: ObjectTypeIR): string {
  const imports = importsForPythonType(ir, type).filter((name) => name !== type.name);
  const importLines = imports.map((name) => `from .${pyModule(snakeCase(name))} import ${name}`);
  const typingImports = ["NotRequired", "TypedDict"];
  if (type.fields.some((field) => pythonRefUsesAny(ir, field.type))) typingImports.unshift("Any");
  const header = `from __future__ import annotations

from typing import ${typingImports.join(", ")}
${importLines.join("\n")}

`;
  // TypedDict keys are the spec wire names: responses are returned as raw dicts keyed by
  // wire name and request bodies are sent verbatim, so the typed surface must match the wire.
  // A wire name that is a Python keyword or not a valid identifier (e.g. Stripe's `in`)
  // can't use class syntax; emit the functional TypedDict form, which takes string keys.
  if (type.fields.some((field) => !isSafePyIdentifier(field.wire_name))) {
    const entries = type.fields
      .map((field) => `    ${JSON.stringify(field.wire_name)}: ${pythonFieldType(ir, field)},`)
      .join("\n");
    return `${header}
${type.name} = TypedDict(
    ${JSON.stringify(type.name)},
    {
${entries}
    },
    total=False,
)
`;
  }
  const fields = type.fields.map((field) => renderPythonField(ir, field)).join("\n");
  return `${header}
class ${type.name}(TypedDict, total=False):
${fields ? indent(fields, 4) : "    pass"}
`;
}

const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue",
  "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
  "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

function isSafePyIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !PY_KEYWORDS.has(name);
}

/** A valid Python identifier for a parameter/variable: snake_case, keyword- and digit-safe. */
function pyIdent(name: string): string {
  let ident = snakeCase(name);
  if (ident === "" || /^[0-9]/.test(ident)) ident = `_${ident}`;
  if (PY_KEYWORDS.has(ident)) ident = `${ident}_`;
  return ident;
}

/** A valid Python module name: not a keyword (GitHub's `Import`) and not digit-leading (DO's 1-clicks). */
function pyModule(slug: string): string {
  let name = slug;
  if (/^[0-9]/.test(name)) name = `_${name}`;
  if (PY_KEYWORDS.has(name)) name = `${name}_`;
  return name;
}

/** Module file stem for a generated type, keyword/digit safe. */
function pyTypeModule(type: { name: string }): string {
  return pyModule(snakeCase(type.name));
}

function pythonFieldType(ir: ApiIR, field: FieldIR): string {
  const inner = `${pythonType(ir, field.type)}${field.nullable || field.type.nullable ? " | None" : ""}`;
  return field.required ? inner : `NotRequired[${inner}]`;
}

function renderPythonField(ir: ApiIR, field: FieldIR): string {
  // Wire name, not camelCase: the runtime dict is keyed by the spec name (see renderPythonObject).
  return `${field.wire_name}: ${pythonFieldType(ir, field)}`;
}

function renderPythonResource(ir: ApiIR, resource: ResourceIR): string {
  const imports = new Set<string>();
  const operations = targetOperationsForResource(ir, resource, "python");
  const children = childResources(ir, resource, "python");
  for (const operation of operations) {
    collectOperationPythonImports(ir, operation, imports);
  }
  const importLines = [...imports].map((name) => `from ..types.${pyModule(snakeCase(name))} import ${name}`);
  const streamImport = operations.some((operation) => operation.streaming)
    ? "from .._streaming import Stream, AsyncStream\n"
    : "";
  const childImports = children
    .map((child) => `from .${pyModule(resourceFileSlug(child))} import ${child.class_name}Resource, Async${child.class_name}Resource`)
    .join("\n");
  const methods = operations
    .flatMap((operation) => renderPythonOperation(ir, operation, false))
    .filter(Boolean)
    .join("\n\n");
  const asyncMethods = operations
    .flatMap((operation) => renderPythonOperation(ir, operation, true))
    .filter(Boolean)
    .join("\n\n");
  const childInit = children.map((child) => `        self.${child.name} = ${child.class_name}Resource(client)`).join("\n");
  const asyncChildInit = children.map((child) => `        self.${child.name} = Async${child.class_name}Resource(client)`).join("\n");

  // with_raw_response: plain (non-streaming) methods returning RawResponse(data, status, headers, request_id).
  const rawOps = operations.filter((operation) => !operation.websocket && !operation.streaming);
  const rawMethods = rawOps.map((operation) => renderPythonMethod(ir, operation, false, "plain", true)).join("\n\n");
  const rawAsyncMethods = rawOps.map((operation) => renderPythonMethod(ir, operation, true, "plain", true)).join("\n\n");
  const rawProp = `
    @property
    def with_raw_response(self) -> "_Raw${resource.class_name}Resource":
        return _Raw${resource.class_name}Resource(self._client)
`;
  const rawAsyncProp = `
    @property
    def with_raw_response(self) -> "_AsyncRaw${resource.class_name}Resource":
        return _AsyncRaw${resource.class_name}Resource(self._client)
`;

  return `from __future__ import annotations

from typing import Any, AsyncIterator, Iterator
from .._exceptions import RawResponse
${importLines.join("\n")}
${streamImport}${childImports}${childImports ? "\n" : ""}

class ${resource.class_name}Resource:
    def __init__(self, client: Any) -> None:
        self._client = client
${childInit}
${rawOps.length ? rawProp : ""}
${methods ? indent(methods, 4) : "    pass"}


class _Raw${resource.class_name}Resource:
    def __init__(self, client: Any) -> None:
        self._client = client

${rawMethods ? indent(rawMethods, 4) : "    pass"}


class Async${resource.class_name}Resource:
    def __init__(self, client: Any) -> None:
        self._client = client
${asyncChildInit}
${rawOps.length ? rawAsyncProp : ""}
${asyncMethods ? indent(asyncMethods, 4) : "    pass"}


class _AsyncRaw${resource.class_name}Resource:
    def __init__(self, client: Any) -> None:
        self._client = client

${rawAsyncMethods ? indent(rawAsyncMethods, 4) : "    pass"}
`;
}

function renderPythonOperation(ir: ApiIR, operation: OperationIR, asyncMethod: boolean): string[] {
  if (operation.websocket) return [];
  const methods: string[] = [];
  if (operation.streaming) {
    if (!operation.streaming.always) methods.push(renderPythonMethod(ir, operation, asyncMethod, "non-stream"));
    methods.push(renderPythonStreamingMethod(ir, operation, asyncMethod));
  } else {
    methods.push(renderPythonMethod(ir, operation, asyncMethod, "plain"));
  }
  const pager = renderPythonPaginationMethod(ir, operation, asyncMethod);
  if (pager) methods.push(pager);
  if (operation.deprecated) {
    const reason = typeof operation.deprecated === "string" ? `: ${operation.deprecated}` : "";
    return methods.map((method, index) => (index === 0 ? `# @deprecated${reason}\n${method}` : method));
  }
  return methods;
}

interface PyParamPlan {
  pathParams: { name: string }[];
  queryParams: { name: string; wire: string }[];
  signature: string[];
  pathExpr: string;
}

function pyParamPlan(ir: ApiIR, operation: OperationIR): PyParamPlan {
  const pathParams = operation.params.filter((param) => param.location === "path");
  const queryParams = operation.params.filter((param) => param.location === "query");
  const signature: string[] = ["self"];
  for (const param of pathParams) {
    signature.push(`${pyIdent(param.name)}: ${pythonType(ir, param.type)}`);
  }
  if (operation.request) {
    signature.push(`body: ${pythonType(ir, operation.request.type)}`);
  }
  for (const param of queryParams) {
    signature.push(`${pyIdent(param.name)}: ${pythonType(ir, param.type)} | None = None`);
  }
  signature.push("headers: dict[str, str] | None = None");
  signature.push("idempotency_key: str | None = None");
  // Path f-string interpolates path params by their idiomatic (keyword/digit-safe) names.
  const pathExpr = pathParams.length
    ? `f"${operation.path.replace(/\{([^}]+)\}/g, (_m, n: string) => `{${pyIdent(n)}}`)}"`
    : quote(operation.path);
  return {
    pathParams: pathParams.map((param) => ({ name: pyIdent(param.name) })),
    queryParams: queryParams.map((param) => ({ name: pyIdent(param.name), wire: param.wire_name })),
    signature,
    pathExpr,
  };
}

function pyQueryDict(plan: PyParamPlan): string {
  return plan.queryParams.length
    ? `{
${plan.queryParams.map((param) => `            ${quote(param.wire)}: ${param.name},`).join("\n")}
        }`
    : "None";
}

function renderPythonMethod(ir: ApiIR, operation: OperationIR, asyncMethod: boolean, mode: "plain" | "non-stream", raw = false): string {
  const plan = pyParamPlan(ir, operation);
  const response = operation.response ? pythonType(ir, operation.response) : "Any";
  const methodPrefix = asyncMethod ? "async def" : "def";
  const requestCall = asyncMethod ? "self._client.async_request" : "self._client.request";
  const returnPrefix = asyncMethod ? "return await" : "return";
  const discriminator = mode === "non-stream" ? operation.streaming?.param_discriminator : undefined;
  const bodyExpr = operation.request
    ? discriminator
      ? `{**body, ${quote(discriminator)}: False}`
      : "body"
    : "None";
  const multipart = operation.request?.multipart
    ? ", multipart=True"
    : operation.request?.form_urlencoded
      ? ", form_urlencoded=True"
      : operation.request?.text_plain
        ? ", text_plain=True"
        : "";
  const binary = operation.binary_response ? ", binary=True" : "";
  const returnType = raw ? "RawResponse" : operation.binary_response ? "bytes" : response;
  const meta = raw ? ", with_meta=True" : "";
  return `${methodPrefix} ${snakeCase(operation.name)}(${plan.signature.join(", ")}) -> ${returnType}:
    ${returnPrefix} ${requestCall}(${quote(operation.http_method)}, ${plan.pathExpr}, query=${pyQueryDict(plan)}, body=${bodyExpr}, headers=headers, idempotency_key=idempotency_key${multipart}${binary}${meta})`;
}

function renderPythonStreamingMethod(ir: ApiIR, operation: OperationIR, asyncMethod: boolean): string {
  const streaming = operation.streaming;
  if (!streaming) return "";
  const plan = pyParamPlan(ir, operation).signature.filter((part) => part !== "idempotency_key: str | None = None");
  const eventName = streamEventType(ir, operation)?.name ?? "Any";
  const methodName = streaming.always ? snakeCase(operation.name) : `${snakeCase(operation.name)}_streaming`;
  const discriminator = streaming.param_discriminator;
  const bodyExpr = operation.request
    ? discriminator
      ? `{**body, ${quote(discriminator)}: True}`
      : "body"
    : "None";
  const sse = streaming.protocol === "sse" ? "True" : "False";
  const done = streaming.done_sentinel ? `, done_sentinel=${quote(streaming.done_sentinel)}` : "";
  const queryPlan = pyParamPlan(ir, operation);
  if (asyncMethod) {
    return `async def ${methodName}(${plan.join(", ")}) -> AsyncStream[${eventName}]:
    iterator = await self._client.async_request_stream(${quote(operation.http_method)}, ${queryPlan.pathExpr}, query=${pyQueryDict(queryPlan)}, body=${bodyExpr}, headers=headers, sse=${sse}${done})
    return AsyncStream(iterator)`;
  }
  return `def ${methodName}(${plan.join(", ")}) -> Stream[${eventName}]:
    iterator = self._client.stream(${quote(operation.http_method)}, ${queryPlan.pathExpr}, query=${pyQueryDict(queryPlan)}, body=${bodyExpr}, headers=headers, sse=${sse}${done})
    return Stream(iterator)`;
}

function renderPythonPaginationMethod(ir: ApiIR, operation: OperationIR, asyncMethod: boolean): string {
  const shape = paginationShape(ir, operation);
  if (!shape) return "";
  const plan = pyParamPlan(ir, operation);
  const methodPrefix = asyncMethod ? "async def" : "def";
  const iteratorType = asyncMethod ? "AsyncIterator" : "Iterator";
  const itemType = pythonType(ir, shape.itemType);
  const itemsField = quote(shape.itemsField.wire_name);
  const awaitKw = asyncMethod ? "await " : "";
  // Build call to the list method using path positionals + query kwargs + headers.
  const signature = plan.signature.filter(
    (part) => part !== "idempotency_key: str | None = None" && !part.startsWith("body:"),
  );
  const callArgs = [
    ...plan.pathParams.map((param) => param.name),
    ...plan.queryParams.map((param) => `${param.name}=${param.name}`),
    "headers=headers",
  ].join(", ");
  const listCall = `${awaitKw}self.${snakeCase(operation.name)}(${callArgs})`;
  const advance = pythonPagerAdvance(shape, itemsField);

  const forward = `${methodPrefix} ${snakeCase(operation.name)}_auto_paging(${signature.join(", ")}) -> ${iteratorType}[${itemType}]:
${indent(pythonPagerInit(shape), 4)}
    while True:
        page = ${listCall}
        items = page.get(${itemsField}, [])
        for item in items:
            yield item
${indent(advance, 8)}`;

  // Bidirectional cursor pagination: backward auto-pager driven by the prev cursor.
  if (shape.kind === "cursor" && shape.prevCursorField && shape.requestPrevCursorParam) {
    const backAdvance = `${snakeCase(shape.requestPrevCursorParam)} = page.get(${quote(shape.prevCursorField.wire_name)})
if not ${snakeCase(shape.requestPrevCursorParam)}:
    break`;
    const backward = `${methodPrefix} ${snakeCase(operation.name)}_auto_paging_backward(${signature.join(", ")}) -> ${iteratorType}[${itemType}]:
    while True:
        page = ${listCall}
        items = page.get(${itemsField}, [])
        for item in items:
            yield item
${indent(backAdvance, 8)}`;
    return `${forward}\n\n${backward}`;
  }
  return forward;
}

function pythonPagerInit(shape: NonNullable<ReturnType<typeof paginationShape>>): string {
  switch (shape.kind) {
    case "offset":
      return shape.offsetParam ? `${snakeCase(shape.offsetParam)} = ${snakeCase(shape.offsetParam)} or 0` : "";
    case "page_number":
      return shape.pageParam ? `${snakeCase(shape.pageParam)} = ${snakeCase(shape.pageParam)} or 1` : "";
    default:
      return "";
  }
}

function pythonPagerAdvance(shape: NonNullable<ReturnType<typeof paginationShape>>, itemsField: string): string {
  switch (shape.kind) {
    case "cursor": {
      if (!shape.nextCursorField || !shape.requestCursorParam) return "break";
      return `${snakeCase(shape.requestCursorParam)} = page.get(${quote(shape.nextCursorField.wire_name)})
if not ${snakeCase(shape.requestCursorParam)}:
    break`;
    }
    case "cursor_id": {
      if (!shape.cursorIdParam || !shape.cursorItemIdField) return "break";
      return `if not items:
    break
${snakeCase(shape.cursorIdParam)} = items[-1].get(${quote(shape.cursorItemIdField.wire_name)})
if not ${snakeCase(shape.cursorIdParam)}:
    break`;
    }
    case "offset": {
      if (!shape.offsetParam) return "break";
      const total = shape.totalCountField
        ? `\ntotal = page.get(${quote(shape.totalCountField.wire_name)})\nif total is not None and ${snakeCase(shape.offsetParam)} + len(items) >= total:\n    break`
        : "";
      return `if not items:
    break${total}
${snakeCase(shape.offsetParam)} = ${snakeCase(shape.offsetParam)} + len(items)`;
    }
    case "page_number": {
      if (!shape.pageParam) return "break";
      const current = shape.currentPageField
        ? `page.get(${quote(shape.currentPageField.wire_name)}) or ${snakeCase(shape.pageParam)}`
        : snakeCase(shape.pageParam);
      const total = shape.totalPagesField
        ? `\ntotal_pages = page.get(${quote(shape.totalPagesField.wire_name)})\nif total_pages is not None and current >= total_pages:\n    break`
        : "";
      return `if not items:
    break
current = ${current}${total}
${snakeCase(shape.pageParam)} = current + 1`;
    }
    case "cursor_url": {
      if (!shape.nextUrlField) return "break";
      return `next_url = page.get(${quote(shape.nextUrlField.wire_name)})
if not next_url:
    break
page = self._client.request_absolute(next_url, headers=headers)
for item in page.get(${itemsField}, []):
    yield item
while True:
    next_url = page.get(${quote(shape.nextUrlField.wire_name)})
    if not next_url:
        break
    page = self._client.request_absolute(next_url, headers=headers)
    for item in page.get(${itemsField}, []):
        yield item
break`;
    }
    default:
      return "break";
  }
}

function renderPythonReadme(ir: ApiIR, packageName: string): string {
  return `# ${ir.api.name} Python SDK

\`\`\`python
from ${packageName} import ${ir.client.name}

client = ${ir.client.name}()
\`\`\`

---
<sub>Generated by [Inox](https://github.com/CREVIOS/inox) — one spec, every SDK.</sub>
`;
}

function pythonType(ir: ApiIR, ref: TypeRefIR): string {
  if (ref.kind === "ref") return typeById(ir, ref.id)?.name ?? "Any";
  if (ref.kind === "array") return `list[${pythonType(ir, ref.items)}]`;
  if (ref.kind === "map") return `dict[str, ${pythonType(ir, ref.values)}]`;
  if (ref.kind === "file") return "bytes | tuple[str, bytes]";
  if (ref.name === "integer") return "int";
  if (ref.name === "number") return "float";
  if (ref.name === "boolean") return "bool";
  if (ref.name === "string") return "str";
  return "Any";
}

function pythonRefUsesAny(ir: ApiIR, ref: TypeRefIR): boolean {
  if (ref.kind === "primitive") return ref.name === "unknown";
  if (ref.kind === "array") return pythonRefUsesAny(ir, ref.items);
  if (ref.kind === "map") return pythonRefUsesAny(ir, ref.values);
  if (ref.kind === "ref") return !typeById(ir, ref.id);
  return false;
}

function importsForPythonType(ir: ApiIR, type: ObjectTypeIR): string[] {
  const imports = new Set<string>();
  for (const field of type.fields) collectPythonImports(ir, field.type, imports);
  return [...imports];
}

function collectOperationPythonImports(ir: ApiIR, operation: OperationIR, imports: Set<string>): void {
  for (const param of operation.params) collectPythonImports(ir, param.type, imports);
  if (operation.request) collectPythonImports(ir, operation.request.type, imports);
  if (operation.response) collectPythonImports(ir, operation.response, imports);
  const shape = paginationShape(ir, operation);
  if (shape) collectPythonImports(ir, shape.itemType, imports);
  const eventType = streamEventType(ir, operation);
  if (eventType) imports.add(eventType.name);
}

function collectPythonImports(ir: ApiIR, ref: TypeRefIR, imports: Set<string>): void {
  if (ref.kind === "ref") {
    const type = typeById(ir, ref.id);
    if (type) imports.add(type.name);
  } else if (ref.kind === "array") {
    collectPythonImports(ir, ref.items, imports);
  } else if (ref.kind === "map") {
    collectPythonImports(ir, ref.values, imports);
  }
}
