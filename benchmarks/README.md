# Benchmarks — reproducible proof

Don't take "it compiles" on faith. Run it:

```bash
sh benchmarks/build.sh        # fetches 12 public specs, generates + typechecks each
cat benchmarks/RESULTS.md
```

Each spec gets a **minimal config** (project name + spec path + one target — no
per-endpoint setup). Inox auto-derives resources, methods, schemas, pagination, and
auth, generates the TypeScript SDK, and we run `tsc --noEmit` against it.

## Latest results

**All 12 public specs compile with zero TypeScript errors** — including GitHub's, the
largest public spec at 1,186 operations.

| API | OpenAPI | Operations | Types | TS files | tsc errors |
|---|---|---:|---:|---:|---:|
| GitHub | 3.0.3 | 1,186 | 6,817 | 6,870 | **0** |
| DigitalOcean | 3.0.0 | 632 | — | 56 | **0** |
| Stripe | 3.0.0 | 587 | 11,275 | 11,357 | **0** |
| Plaid | 3.0.0 | 330 | 2,317 | 2,324 | **0** |
| Box | 3.0.2 | 296 | 1,456 | 1,535 | **0** |
| Asana | 3.0.0 | 247 | 1,202 | 1,256 | **0** |
| OpenAI | 3.1.0 | 242 | 3,119 | 3,161 | **0** |
| Discord | 3.1.0 | 233 | 1,111 | 1,133 | **0** |
| Ory | 3.0.3 | 59 | 235 | 245 | **0** |
| Twilio | 3.0.1 | 58 | 83 | 111 | **0** |
| Adyen | 3.1.0 | 28 | 465 | 478 | **0** |
| SendGrid | 3.1.0 | 3 | 7 | 15 | **0** |

Specs are fetched fresh from each vendor's public repo and are git-ignored
(`benchmarks/specs/`, `benchmarks/out/`).
