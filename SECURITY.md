# Security Notes

This repository is an SDK generation platform prototype. The generated SDKs and platform
code should be treated as security-sensitive because they handle API credentials, request
payloads, package publication, and generated source artifacts.

Current implemented controls:

- Config/spec diagnostics warn on insecure default `http://` base URLs.
- Generated TypeScript, Python, Go, Ruby, Java, and C# runtimes read API keys from
  environment variables.
- Generated non-GET requests can include configured idempotency keys.
- Generated runtimes support retry limits and bounded backoff with jitter across every
  enabled SDK target.
- Generated runtimes support `X-Should-Retry`, `Retry-After`, and `Retry-After-Ms`.
- Generated runtimes emit `X-Stainless-*`-style observability headers and support omitting
  them where configured.
- Generated webhook helpers verify HMAC-SHA256 signatures with timestamp tolerance and
  constant-time comparison before JSON unwrap.
- `sdkgen mock` emits a local-only Node mock server bound to `127.0.0.1` by default for
  deterministic route self-tests.
- `sdkgen verify` compiles/checks every enabled generated SDK target and runs generated
  runtime tests where present.

Required before production use:

- Isolated worker sandboxing for untrusted specs and package manager execution.
- Secret isolation so registry credentials are available only during publish jobs.
- Signed release provenance and registry trusted publishing where possible.
- Runtime response validation and fuzz/property tests for generated serializers, path
  escaping, pagination, and retry behavior.
- Full multipart upload and streaming security review.
- Broader webhook compatibility tests for additional provider signature formats.
- Dependency scanning and SBOM generation for generated SDK packages.
