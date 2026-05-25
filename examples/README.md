# Examples

A complete, runnable walkthrough of how Inox turns one spec into typed SDKs.

## `petstore/` — from spec to working client

Two input files:

- [`petstore/openapi.yaml`](petstore/openapi.yaml) — a tiny API: list pets (cursor
  pagination), create a pet, retrieve a pet, bearer auth.
- [`petstore/sdkgen.yml`](petstore/sdkgen.yml) — the Inox config: which targets to emit,
  auth, and the pagination scheme wired to `pets.list`.

### 1. Generate

```bash
cd examples/petstore
npx @crevious/inox generate --out sdk        # writes sdk/typescript, sdk/python, sdk/go
```

You get, per language, an idiomatic client with **zero runtime dependencies**:

```
sdk/
├── typescript/   # @example/petstore  (tsc-clean, 18 files)
├── python/
├── go/
└── mock/         # spec-derived mock server for tests
```

### 2. What the generated TypeScript looks like

Types come straight from the schema:

```ts
// sdk/typescript/src/types/pet.ts
export interface Pet {
  id: string;
  name: string;
  species: PetSpecies;   // "dog" | "cat" | "bird" | (string & {})
  tag?: string;
}
```

The client is nested by resource, with auth, retries, and pagination built in:

```ts
import Petstore from "@example/petstore";

const client = new Petstore({ apiKey: process.env.PETSTORE_API_KEY });

// create — typed request body
const pet = await client.pets.create({ body: { name: "Rex", species: "dog" } });

// retrieve — path param
const fetched = await client.pets.retrieve(pet.id);

// list — one page
const page = await client.pets.list({ limit: 20 });

// list — auto-pagination across all pages (follows next_cursor for you)
for await (const p of client.pets.listAutoPaging()) {
  console.log(p.name);
}
```

Typed errors let you catch specific failures:

```ts
import { NotFoundError, RateLimitError } from "@example/petstore";

try {
  await client.pets.retrieve("missing");
} catch (err) {
  if (err instanceof NotFoundError) console.log("no such pet", err.requestId);
  if (err instanceof RateLimitError) console.log("slow down");
}
```

### 3. Verify it compiles + conforms

```bash
npx @crevious/inox verify --out sdk    # compiles every target + runs endpoint
                                       # conformance against the spec-derived mock
```

### 4. Agent tools (MCP) from the same spec

```bash
npx @crevious/inox products --out sdk          # writes sdk/mcp
cd sdk/mcp && npm install && npm run build
node dist/server.js                            # a zero-dep MCP server for Petstore
```

That's the whole loop: **one spec → typed clients in every language + an MCP server**,
all verified.
