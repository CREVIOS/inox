# SDK Gallery

Pre-generated, ready-to-use SDKs for popular public APIs — proof Inox works on real
specs, and a discoverable home for "`<API>` `<language>` SDK".

Each gallery SDK is generated from the vendor's own public OpenAPI spec with a minimal
config and published as its own repository so it's installable and indexable.

## Publish a gallery SDK

```bash
# generate the full SDK set for an API and push it to its own repo
sh gallery/publish.sh openai https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml
```

`publish.sh <name> <spec-url> [github-owner]` will:
1. fetch the spec, write a minimal `sdkgen.yml`,
2. `inox generate` all six languages + `inox products` (docs, MCP, CLI),
3. `inox verify`,
4. create `github.com/<owner>/inox-<name>-sdks` and push.

## Verify the claims

The full compile matrix lives in [`../benchmarks`](../benchmarks) — run
`sh benchmarks/build.sh` to reproduce it yourself.

## Catalog (target APIs)

| API | Spec source |
|---|---|
| OpenAI | github.com/openai/openai-openapi |
| Stripe | github.com/stripe/openapi |
| DigitalOcean | github.com/digitalocean/openapi |
| Plaid | github.com/plaid/plaid-openapi |
| Box · Asana · Discord · Twilio · Adyen · Ory · SendGrid | vendor public specs |
