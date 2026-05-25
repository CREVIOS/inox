#!/bin/sh
# Reproducible proof: fetch real public OpenAPI specs, generate the TypeScript SDK with a
# minimal config (no per-endpoint setup), typecheck it, and record op/type/file counts +
# tsc error count. Run from the repo root:  sh benchmarks/build.sh
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
SPECDIR="benchmarks/specs"
OUT="benchmarks/out"
RESULTS="benchmarks/RESULTS.md"
mkdir -p "$SPECDIR" "$OUT"

{
  echo "# Inox benchmark results"
  echo
  echo "Public spec -> minimal config -> generated TypeScript SDK -> \`tsc --noEmit\`."
  echo "Regenerate with \`sh benchmarks/build.sh\`."
  echo
  echo "| API | OpenAPI | Operations | Types | TS files | tsc errors |"
  echo "|---|---|---:|---:|---:|---:|"
} > "$RESULTS"

run() {
  name="$1"; url="$2"
  case "$url" in *.yaml|*.yml) ex="yaml";; *) ex="json";; esac
  spec="$SPECDIR/$name.$ex"; cfg="$SPECDIR/$name.sdkgen.yml"
  printf '[%s] ' "$name"
  if [ ! -s "$spec" ]; then
    printf 'fetching... '
    curl -fsSL "$url" -o "$spec" 2>/dev/null || { echo "FETCH FAIL"; echo "| $name | — | — | — | — | fetch fail |" >> "$RESULTS"; return; }
  fi
  cat > "$cfg" <<EOF
sdkgen: 1
project:
  name: $name
spec:
  path: ./$name.$ex
targets:
  typescript:
    package_name: "@inox-bench/$name"
EOF
  rm -rf "$OUT/$name"
  if ! npx tsx src/cli.ts generate -c "$cfg" --target typescript --no-overlay --out "$OUT/$name" >/dev/null 2>&1; then
    echo "GENERATE FAIL"; echo "| $name | — | — | — | — | generate fail |" >> "$RESULTS"; return
  fi
  ov=$(python3 -c "import json;print(json.load(open('.sdkgen/ir.json'))['source']['openapi_version'])" 2>/dev/null || echo "?")
  ops=$(python3 -c "import json;print(len(json.load(open('.sdkgen/ir.json'))['operations']))" 2>/dev/null || echo "?")
  tys=$(python3 -c "import json;print(len(json.load(open('.sdkgen/ir.json'))['types']))" 2>/dev/null || echo "?")
  files=$(find "$OUT/$name/typescript" -name "*.ts" 2>/dev/null | wc -l | tr -d ' ')
  errs=$(cd "$OUT/$name/typescript" && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS")
  echo "ops=$ops types=$tys files=$files tsc_errors=$errs"
  echo "| $name | $ov | $ops | $tys | $files | $errs |" >> "$RESULTS"
}

run openai       https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml
run stripe       https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
run digitalocean https://raw.githubusercontent.com/digitalocean/openapi/main/specification/DigitalOcean-public.v2.yaml
run box          https://raw.githubusercontent.com/box/box-openapi/main/openapi.json
run asana        https://raw.githubusercontent.com/Asana/openapi/master/defs/asana_oas.yaml
run twilio       https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_messaging_v1.json
run plaid        https://raw.githubusercontent.com/plaid/plaid-openapi/master/2020-09-14.yml
run discord      https://raw.githubusercontent.com/discord/discord-api-spec/main/specs/openapi.json
run adyen        https://raw.githubusercontent.com/Adyen/adyen-openapi/main/json/CheckoutService-v71.json
run sendgrid     https://raw.githubusercontent.com/twilio/sendgrid-oai/main/spec/json/tsg_mail_v3.json
run ory          https://raw.githubusercontent.com/ory/kratos/master/spec/api.json
run github       https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json

echo "Done. See $RESULTS"
