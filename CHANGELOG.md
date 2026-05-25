# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] — 2026-05-25

### Added
- Typed per-status error classes in generated SDKs (`BadRequestError`, `AuthenticationError`,
  `PermissionDeniedError`, `NotFoundError`, `ConflictError`, `UnprocessableEntityError`,
  `RateLimitError`, `InternalServerError`) so callers can `catch`/`instanceof` specific failures.
- `x-request-id` surfaced on errors for correlating with server logs.
- Configurable bearer auth header prefix.
- `inox --version`; npm auto-publish on `v*` tags; OSS hygiene (CONTRIBUTING, CoC, templates, dependabot).

### Fixed
- All 12 benchmarked public specs (incl. GitHub, 1,186 ops) now generate TypeScript SDKs
  that compile with zero errors.

## [0.1.0] — 2026-05-25

First public release.

### Added
- OpenAPI spec → idiomatic SDKs in **TypeScript, Python, Go, Java, Ruby, C#** with a
  zero-dependency runtime, verified on every build.
- Auto-derivation of resources, methods, schemas, pagination, and auth from the spec
  (no per-endpoint config required).
- Per-API **MCP server** (protocol 2025-06-18) with typed / dynamic / code tool modes,
  scope filtering, and stdio + streamable-HTTP transports.
- Auth (bearer / API key / OAuth2 client-credentials with refresh), retries with backoff,
  timeouts, idempotency, 5 pagination schemes, multipart, SSE/JSONL streaming, WebSockets,
  Standard-Webhooks verification, OpenTelemetry hooks, named environments.
- Platform: spec-derived mock + cross-language runtime conformance, custom-code overlay,
  SemVer release engineering, governance lint + breaking-change gate, CycloneDX SBOM,
  docs / CLI / Terraform / React hooks, offline Studio.
- `inox` CLI distributed via npm (`@crevious/inox`), a `curl | bash` installer, and Docker.
- Reproducible benchmark suite (`benchmarks/`) — 11 of 12 public specs compile with zero
  TypeScript errors.

[0.1.0]: https://github.com/CREVIOS/inox/releases/tag/v0.1.0
