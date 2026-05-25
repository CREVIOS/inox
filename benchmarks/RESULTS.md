# Inox benchmark results

Public spec -> minimal config -> generated TypeScript SDK -> `tsc --noEmit`.
Regenerate with `sh benchmarks/build.sh`.

| API | OpenAPI | Operations | Types | TS files | tsc errors |
|---|---|---:|---:|---:|---:|
| openai | 3.1.0 | 242 | 3119 | 3161 | 0 |
| stripe | 3.0.0 | 587 | 11275 | 11357 | 0 |
| digitalocean | 3.0.0 | 632 | 0 | 56 | 0 |
| box | 3.0.2 | 296 | 1456 | 1535 | 0 |
| asana | 3.0.0 | 247 | 1202 | 1256 | 0 |
| twilio | 3.0.1 | 58 | 83 | 111 | 0 |
| plaid | 3.0.0 | 330 | 2317 | 2324 | 0 |
| discord | 3.1.0 | 233 | 1111 | 1133 | 0 |
| adyen | 3.1.0 | 28 | 465 | 478 | 0 |
| sendgrid | 3.1.0 | 3 | 7 | 15 | 0 |
| ory | 3.0.3 | 59 | 235 | 245 | 0 |
| github | 3.0.3 | 1186 | 6817 | 6870 | 0 |
