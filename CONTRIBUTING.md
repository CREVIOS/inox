# Contributing to Inox

Thanks for helping make Inox better. It's a clean-room, zero-dependency OpenAPI SDK
generator — contributions should keep it that way.

## Develop

```bash
npm install
npm run build          # compile the generator to dist/
npm run inox -- --help # run the CLI from source (tsx)
```

## Before you open a PR

```bash
npm run check          # tsc, zero errors
npm test               # end-to-end: generate + verify TS/Python/Go/Java/Ruby/C#
```

Both must pass. CI runs the same across all six language toolchains on every PR.

## Ground rules

- **Zero runtime dependencies** in generated SDKs. Don't introduce one without discussion.
- **Verified output.** New features must keep `npm test` green (the generated SDKs compile
  and pass endpoint conformance against the spec-derived mock).
- **Real specs.** If you fix a generator bug, prefer adding the triggering shape to a spec
  in `benchmarks/` so it stays fixed (`sh benchmarks/build.sh`).
- Match the surrounding code style; keep changes focused.

## Reporting bugs

Open an issue with the OpenAPI spec snippet (or a link), your `sdkgen.yml`, the target
language, and the error. Minimal repros get fixed fastest.

## License

By contributing you agree your contributions are licensed under the [MIT License](LICENSE).
