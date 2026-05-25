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

| API | OpenAPI | Operations | Types | TS files | tsc errors |
|---|---|---:|---:|---:|---:|
| Stripe | 3.0.0 | 587 | 11,275 | 11,356 | **0** |
| OpenAI | 3.1.0 | 242 | 3,119 | 3,160 | **0** |
| DigitalOcean | 3.0.0 | 632 | — | 55 | **0** |
| Plaid | 3.0.0 | 330 | 2,317 | 2,323 | **0** |
| Box | 3.0.2 | 296 | 1,456 | 1,534 | **0** |
| Asana | 3.0.0 | 247 | 1,202 | 1,255 | **0** |
| Discord | 3.1.0 | 233 | 1,111 | 1,132 | **0** |
| Ory | 3.0.3 | 59 | 235 | 244 | **0** |
| Twilio | 3.0.1 | 58 | 83 | 110 | **0** |
| Adyen | 3.1.0 | 28 | 465 | 477 | **0** |
| SendGrid | 3.1.0 | 3 | 7 | 14 | **0** |
| GitHub | 3.0.3 | 1,186 | 6,817 | 6,869 | 68 (in progress) |

**11 of 12 compile with zero TypeScript errors.** GitHub (the largest public spec at
1,186 operations) has a handful of remaining edge cases, tracked openly.

Specs are fetched fresh from each vendor's public repo and are git-ignored
(`benchmarks/specs/`, `benchmarks/out/`).
