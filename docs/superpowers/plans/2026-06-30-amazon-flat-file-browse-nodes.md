# Amazon Flat-File Browse Nodes & Category Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface Amazon browse nodes as a first-class, per-group, auto-fresh **Category** concept in `/products/amazon-flat-file`, replacing the toolbar product-type controls with per-group category assignment (product type + browse node).

**Architecture:** The Amazon product-type-definition (PTD) schema Nexus already fetches carries `recommended_browse_nodes` with `enum` (node ids) + `enumNames` (paths). We extract those into the manifest column's existing `options` + `optionLabels`, so the existing `EnumDropdown` cell renders a search-as-you-type browse-node picker for free. We then add a derived **Category** column (product type + browse node) and a "Set category" action that bulk-applies to selected rows and drives the existing union-manifest machinery so the right field columns appear per subgroup. A dedicated `/browse-nodes` endpoint + nightly schema refresh keep the valid node set fresh per (marketplace, product type).

**Tech Stack:** TypeScript, Fastify (apps/api), Next.js/React (apps/web), Prisma, Amazon SP-API Product Type Definitions API, Vitest (backend unit), Playwright (frontend e2e against the live deploy), node-cron.

## Global Constraints

- **Surface:** `/products/amazon-flat-file` only. No changes to the eBay flat-file editor, its routes, or the product cockpit (reuse cockpit browse-node infra; do not modify it).
- **Surgical:** no changes to unrelated working columns or the Product cell. The flat-file "untouchable" rule is lifted **for this approved work only**.
- **Design system:** build any new UI from `apps/web/src/design-system` primitives where one fits; match the existing flat-file component idiom (the `EnumDropdown`/`ProductTypeDropdown` patterns).
- **DSP discard/save/publish:** respect the editor's existing dirty-registry / save / sync flow (`handleSave` → `syncToPlatform`); do not introduce silent auto-save.
- **Ship live (enabled by default):** no dark flag. Per-type validation + diff-then-apply are the safety.
- **Required fields are driven by product type, not the browse node.** Browse node is placement metadata. Store/validate as two separate fields; assign together via one "Category" gesture.
- **Browse-node ids are per-marketplace.** Token is `recommended_browse_nodes[marketplace_id=<MP>]#N.value`. An IT id is invalid on DE/UK.
- **Node cap:** UI supports 1–2 nodes (`#1`, `#2`); default 1. (Schema ceiling is 232; not exposed.)
- **EU/IT-first.** US `item_type_keyword` placement path is out of scope.
- **Commit + push after each verified task.** Other Claude sessions commit to `main` in parallel: use `git commit --only <paths>`, and on push rejection `git pull --rebase` then push. Never `--no-verify` past a failing pre-push build.
- **Verify on the live deploy, not Docker.** Frontend Playwright specs run against `https://nexus-commerce-three.vercel.app` after the push is green.

**Reference spec:** `docs/superpowers/specs/2026-06-30-amazon-flat-file-browse-nodes-design.md`

---

## File Structure

**Backend (apps/api):**
- Create `src/services/amazon/browse-nodes.ts` — pure `extractBrowseNodes(schema, marketplaceId)` + types. One responsibility: turn a PTD schema into `{id, path}[]`.
- Create `src/services/amazon/browse-nodes.vitest.test.ts` — unit tests for the extractor.
- Modify `src/services/amazon/flat-file.service.ts` — in `expandSchemaField`, attach `options`+`optionLabels` to the `recommended_browse_nodes` column using the extractor.
- Modify `src/routes/amazon-flat-file.routes.ts` — add `GET /amazon/flat-file/browse-nodes`; extend `sync-rows` write-back (Task 1.3) to persist `platformAttributes.browseNodeId`.
- Create `src/routes/amazon-flat-file.browse-nodes.vitest.test.ts` — route + write-back tests.
- Modify `src/jobs/schema-refresh.job.ts` (existing `startSchemaRefreshCron`) — ensure in-use (marketplace, productType) pairs are refreshed nightly.

**Frontend (apps/web):**
- Modify `src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx` — derived Category column + cell; "Set category" action + modal; drive `sheetTypes` from assigned categories; remove the Bar-3 product-type controls; freshness indicator; per-market re-resolution; warnings.
- Create `src/app/products/amazon-flat-file/category-model.ts` — pure helpers (`categoryOf`, `assignCategory`, `productTypesInUse`, `unresolvedNodeRows`) so logic is unit-testable with Vitest.
- Create `src/app/products/amazon-flat-file/category-model.vitest.test.ts` — unit tests for those helpers.
- Create `apps/web/tests/amazon-flat-file-browse-nodes.spec.ts` — Playwright regression guard (runs against the live deploy).

---

## Phase 0 — Browse-node source of truth (backend)

### Task 0.1: `extractBrowseNodes` pure function

**Files:**
- Create: `apps/api/src/services/amazon/browse-nodes.ts`
- Test: `apps/api/src/services/amazon/browse-nodes.vitest.test.ts`

**Interfaces:**
- Produces: `export interface BrowseNode { id: string; path: string }` and `export function extractBrowseNodes(schema: Record<string, unknown>, marketplaceId: string): BrowseNode[]`. Returns `[]` when the schema has no `recommended_browse_nodes` enum. The extractor walks `properties.recommended_browse_nodes` → array `items` → the first descendant property carrying parallel `enum` + `enumNames`, filtering to `marketplaceId` if a sibling `marketplace_id` const/enum scopes the block.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/services/amazon/browse-nodes.vitest.test.ts
import { describe, it, expect } from 'vitest'
import { extractBrowseNodes } from './browse-nodes.js'

// Representative slice of an Amazon PTD schema for IT motorcycle apparel.
// Mirrors the live shape: recommended_browse_nodes → array → items.properties.value
// carries enum (node ids) + enumNames (localized browse paths).
const IT_COAT_SCHEMA = {
  properties: {
    recommended_browse_nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          value: {
            type: 'string',
            maxLength: 15,
            enum: ['2420941031', '2420945031'],
            enumNames: [
              'Auto e Moto > Moto, accessori e componenti > Abbigliamento protettivo > Giacche',
              'Auto e Moto > Moto, accessori e componenti > Abbigliamento protettivo > Tute',
            ],
          },
        },
      },
    },
  },
} as Record<string, unknown>

describe('extractBrowseNodes', () => {
  it('pairs enum ids with enumNames paths', () => {
    const nodes = extractBrowseNodes(IT_COAT_SCHEMA, 'APJ6JRA9NG5V4')
    expect(nodes).toEqual([
      { id: '2420941031', path: 'Auto e Moto > Moto, accessori e componenti > Abbigliamento protettivo > Giacche' },
      { id: '2420945031', path: 'Auto e Moto > Moto, accessori e componenti > Abbigliamento protettivo > Tute' },
    ])
  })

  it('returns [] when the attribute/enum is absent (e.g. US item_type_keyword path)', () => {
    expect(extractBrowseNodes({ properties: {} }, 'ATVPDKIKX0DER')).toEqual([])
    expect(extractBrowseNodes({}, 'ATVPDKIKX0DER')).toEqual([])
  })

  it('falls back to id-as-path when enumNames is missing or length-mismatched', () => {
    const s = { properties: { recommended_browse_nodes: { items: { properties: { value: { enum: ['111', '222'] } } } } } } as Record<string, unknown>
    expect(extractBrowseNodes(s, 'APJ6JRA9NG5V4')).toEqual([
      { id: '111', path: '111' },
      { id: '222', path: '222' },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npm run test -- services/amazon/browse-nodes.vitest.test.ts`
Expected: FAIL — `extractBrowseNodes` not found / module missing.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/services/amazon/browse-nodes.ts
export interface BrowseNode {
  id: string
  path: string
}

/** Deep-find the first node carrying a string `enum` (and optional parallel
 *  `enumNames`) under a schema subtree. Amazon nests the node-id enum under
 *  recommended_browse_nodes → items → properties.value (sometimes inside an
 *  allOf/anyOf scoped by marketplace_id). We walk defensively. */
function findEnumNode(
  node: unknown,
  marketplaceId: string,
): { enum: string[]; enumNames?: string[] } | null {
  if (!node || typeof node !== 'object') return null
  const obj = node as Record<string, unknown>

  // A marketplace-scoped block: skip blocks that pin a different marketplace.
  const mp = obj.marketplace_id ?? (obj.properties as any)?.marketplace_id
  const mpConst =
    (mp as any)?.const ??
    (Array.isArray((mp as any)?.enum) ? (mp as any).enum[0] : undefined)
  if (typeof mpConst === 'string' && mpConst !== marketplaceId) return null

  if (Array.isArray(obj.enum) && obj.enum.every((v) => typeof v === 'string')) {
    return {
      enum: obj.enum as string[],
      enumNames: Array.isArray(obj.enumNames) ? (obj.enumNames as string[]) : undefined,
    }
  }

  for (const key of ['items', 'properties', 'value', 'allOf', 'anyOf', 'oneOf']) {
    const child = obj[key]
    if (Array.isArray(child)) {
      for (const c of child) {
        const found = findEnumNode(c, marketplaceId)
        if (found) return found
      }
    } else if (child) {
      const found = findEnumNode(child, marketplaceId)
      if (found) return found
    }
  }
  return null
}

export function extractBrowseNodes(
  schema: Record<string, unknown>,
  marketplaceId: string,
): BrowseNode[] {
  const props = (schema?.properties ?? {}) as Record<string, unknown>
  const rbn = props.recommended_browse_nodes
  if (!rbn) return []
  const found = findEnumNode(rbn, marketplaceId)
  if (!found) return []
  const names = found.enumNames
  const usable = !!names && names.length === found.enum.length
  return found.enum.map((id, i) => ({ id, path: usable ? names![i] : id }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npm run test -- services/amazon/browse-nodes.vitest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git commit --only apps/api/src/services/amazon/browse-nodes.ts apps/api/src/services/amazon/browse-nodes.vitest.test.ts \
  -m "feat(flat-file): extractBrowseNodes — PTD enum/enumNames → {id,path} (BN.0.1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 0.2: Attach browse nodes to the manifest column (`options` + `optionLabels`)

**Files:**
- Modify: `apps/api/src/services/amazon/flat-file.service.ts` (`expandSchemaField` ~546–732; it already builds the `recommended_browse_nodes#N` columns from the schema)
- Test: `apps/api/src/services/amazon/flat-file.browse-nodes.vitest.test.ts` (create)

**Interfaces:**
- Consumes: `extractBrowseNodes` (Task 0.1), `amazonMarketplaceId` (from `src/services/categories/marketplace-ids.ts`).
- Produces: every `recommended_browse_nodes[...]#N.value` column in the manifest has `kind: 'enum'`, `selectionOnly: false`, `options: string[]` (node ids), `optionLabels: Record<string,string>` (id → path). The existing `EnumDropdown` then renders the picker.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/services/amazon/flat-file.browse-nodes.vitest.test.ts
import { describe, it, expect } from 'vitest'
import { decorateBrowseNodeColumn } from './flat-file.service.js'

describe('decorateBrowseNodeColumn', () => {
  const nodes = [
    { id: '2420941031', path: '… > Giacche' },
    { id: '2420943031', path: '… > Pantaloni' },
  ]
  it('turns a browse-node column into an enum with id→path labels', () => {
    const col = {
      id: 'recommended_browse_nodes_1',
      fieldRef: 'recommended_browse_nodes[marketplace_id=APJ6JRA9NG5V4]#1.value',
      kind: 'text' as const,
      options: undefined,
      optionLabels: undefined,
    }
    const out = decorateBrowseNodeColumn(col as any, nodes)
    expect(out.kind).toBe('enum')
    expect(out.selectionOnly).toBe(false)
    expect(out.options).toEqual(['2420941031', '2420943031'])
    expect(out.optionLabels).toEqual({ '2420941031': '… > Giacche', '2420943031': '… > Pantaloni' })
  })
  it('leaves non-browse-node columns untouched', () => {
    const col = { id: 'color', fieldRef: 'color#1.value', kind: 'text' as const }
    expect(decorateBrowseNodeColumn(col as any, nodes)).toBe(col)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npm run test -- services/amazon/flat-file.browse-nodes.vitest.test.ts`
Expected: FAIL — `decorateBrowseNodeColumn` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `apps/api/src/services/amazon/flat-file.service.ts` (near `expandSchemaField`):

```typescript
import { extractBrowseNodes, type BrowseNode } from './browse-nodes.js'

/** BN.0.2 — if `col` is a recommended_browse_nodes value column, make it an
 *  enum carrying node ids (options) + localized paths (optionLabels) so the
 *  grid renders the existing search-as-you-type EnumDropdown. Free-text still
 *  allowed (selectionOnly=false) since a market may surface a node not in enum. */
export function decorateBrowseNodeColumn(col: FlatFileColumn, nodes: BrowseNode[]): FlatFileColumn {
  if (!/^recommended_browse_nodes\b/.test(col.fieldRef) || nodes.length === 0) return col
  const options = nodes.map((n) => n.id)
  const optionLabels: Record<string, string> = {}
  for (const n of nodes) optionLabels[n.id] = n.path
  return { ...col, kind: 'enum', selectionOnly: false, options, optionLabels }
}
```

Then in `generateManifest`, after the groups are built and before returning, decorate the browse-node columns. Compute nodes once:

```typescript
// inside generateManifest, after `def`/`properties` are resolved and `mp` known:
const browseNodes = extractBrowseNodes(def, amazonMarketplaceId(mp))
// …after building `groups`:
for (const g of groups) {
  g.columns = g.columns.map((c) => decorateBrowseNodeColumn(c, browseNodes))
}
```

(Use the existing `amazonMarketplaceId` import already present in the schema-sync path; add the import to this file if missing.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npm run test -- services/amazon/flat-file.browse-nodes.vitest.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd apps/api && npx tsc --noEmit && cd ..
git commit --only apps/api/src/services/amazon/flat-file.service.ts apps/api/src/services/amazon/flat-file.browse-nodes.vitest.test.ts \
  -m "feat(flat-file): decorate recommended_browse_nodes column as id→path enum (BN.0.2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 0.3: `GET /amazon/flat-file/browse-nodes` endpoint (with predictor fallback)

**Files:**
- Modify: `apps/api/src/routes/amazon-flat-file.routes.ts` (add route near `/product-types` ~94–142; reuse the `/template` pattern ~149–192)
- Test: `apps/api/src/routes/amazon-flat-file.browse-nodes.vitest.test.ts` (create)

**Interfaces:**
- Consumes: `flatFileService` (already in scope in the route file), `extractBrowseNodes`, the schema service `getSchema({channel:'AMAZON', marketplace, productType}, {force})` (returns `{ schemaDefinition, fetchedAt }`), `amazonMarketplaceId`. Fallback: `predictBrowseNode` is per-product, so the route's fallback is the existing `/api/categories` predictor shape — but for a product-type-level list with no product context we simply return `source:'none'` when the enum is absent (the picker then allows free-text id entry).
- Produces: `GET /amazon/flat-file/browse-nodes?marketplace=&productType=&force=` →
  `{ marketplace: string; productType: string; nodes: { id: string; path: string; label: string }[]; source: 'schema' | 'none'; fetchedAt: string }`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/routes/amazon-flat-file.browse-nodes.vitest.test.ts
import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { registerAmazonFlatFileRoutes } from './amazon-flat-file.routes.js'

function buildApp(schemaDefinition: Record<string, unknown>) {
  const app = Fastify()
  // Stub the schema service the route depends on.
  const schemas = { getSchema: vi.fn().mockResolvedValue({ schemaDefinition, fetchedAt: '2026-06-30T00:00:00Z' }) }
  registerAmazonFlatFileRoutes(app, { schemas } as any)
  return app
}

describe('GET /amazon/flat-file/browse-nodes', () => {
  it('returns nodes from the PTD enum', async () => {
    const app = buildApp({
      properties: {
        recommended_browse_nodes: { items: { properties: { value: {
          enum: ['2420941031'], enumNames: ['… > Giacche'],
        } } } },
      },
    })
    const res = await app.inject({ method: 'GET', url: '/amazon/flat-file/browse-nodes?marketplace=IT&productType=COAT' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.source).toBe('schema')
    expect(body.nodes).toEqual([{ id: '2420941031', path: '… > Giacche', label: '… > Giacche' }])
  })

  it('400 when productType missing', async () => {
    const app = buildApp({ properties: {} })
    const res = await app.inject({ method: 'GET', url: '/amazon/flat-file/browse-nodes?marketplace=IT' })
    expect(res.statusCode).toBe(400)
  })

  it('source=none when the enum is absent', async () => {
    const app = buildApp({ properties: {} })
    const res = await app.inject({ method: 'GET', url: '/amazon/flat-file/browse-nodes?marketplace=IT&productType=WIDGET' })
    expect(res.json().source).toBe('none')
    expect(res.json().nodes).toEqual([])
  })
})
```

> Note: if `registerAmazonFlatFileRoutes` does not currently accept an injectable `{ schemas }` dependency, adapt the test to the file's existing wiring (it imports a singleton schema service). In that case `vi.mock('../services/categories/schema-sync.service.js', …)` to stub `getSchema`. Inspect the top of `amazon-flat-file.routes.ts` first and mirror its actual import style — keep the test hermetic (no live SP-API).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npm run test -- routes/amazon-flat-file.browse-nodes.vitest.test.ts`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Write minimal implementation**

Add to `apps/api/src/routes/amazon-flat-file.routes.ts` (mirror the `/template` handler; reuse a `TtlCache` keyed `${marketplace}:${productType}`):

```typescript
import { extractBrowseNodes } from '../services/amazon/browse-nodes.js'
import { amazonMarketplaceId } from '../services/categories/marketplace-ids.js'

const browseNodeCache = new TtlCache<unknown>({ ttlMs: 30 * 60_000, maxEntries: 200 })

fastify.get<{ Querystring: { marketplace?: string; productType?: string; force?: string } }>(
  '/amazon/flat-file/browse-nodes',
  async (request, reply) => {
    const marketplace = (request.query.marketplace ?? 'IT').toUpperCase()
    const productType = (request.query.productType ?? '').toUpperCase()
    const force = request.query.force === '1'
    if (!productType) return reply.code(400).send({ error: 'productType is required' })

    const cacheKey = `${marketplace}:${productType}`
    if (!force) {
      const cached = browseNodeCache.get(cacheKey)
      if (cached !== undefined) return reply.send(cached)
    }
    try {
      const schema = await schemaService.getSchema(
        { channel: 'AMAZON', marketplace, productType },
        { force },
      )
      const def = (schema.schemaDefinition ?? {}) as Record<string, unknown>
      const nodes = extractBrowseNodes(def, amazonMarketplaceId(marketplace))
      const payload = {
        marketplace,
        productType,
        nodes: nodes.map((n) => ({ id: n.id, path: n.path, label: n.path })),
        source: nodes.length ? 'schema' : 'none',
        fetchedAt: schema.fetchedAt ?? new Date().toISOString(),
      }
      if (!force) browseNodeCache.set(cacheKey, payload)
      return reply.send(payload)
    } catch (err: any) {
      request.log.error(err, 'flat-file/browse-nodes failed')
      return reply.code(500).send({ error: err?.message ?? 'Failed to load browse nodes' })
    }
  },
)
```

(Wire `schemaService` from the same import the route file already uses for schemas; if the file currently reaches schemas only via `flatFileService`, add a direct import of the schema-sync singleton, matching `categories.routes.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npm run test -- routes/amazon-flat-file.browse-nodes.vitest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Integration smoke (manual, against cached schema)**

Run the API locally or hit the deployed API:
`curl '<API_BASE>/api/amazon/flat-file/browse-nodes?marketplace=IT&productType=COAT'`
Expected: `source:"schema"` and a node whose `path` ends in `Giacche`. If `source:"none"`, the IT COAT schema lacks the enum → that's the documented fallback; note it and proceed.

- [ ] **Step 6: Commit**

```bash
git commit --only apps/api/src/routes/amazon-flat-file.routes.ts apps/api/src/routes/amazon-flat-file.browse-nodes.vitest.test.ts \
  -m "feat(flat-file): GET /amazon/flat-file/browse-nodes (PTD enum + cache) (BN.0.3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 0.4: Nightly freshness — ensure in-use (market, type) schemas refresh

**Files:**
- Modify: `apps/api/src/jobs/schema-refresh.job.ts` (the existing `startSchemaRefreshCron` wired at `apps/api/src/index.ts:834`)
- Test: `apps/api/src/jobs/schema-refresh.vitest.test.ts` (create or extend)

**Interfaces:**
- Consumes: the existing schema service `refreshSchema({channel, marketplace, productType})`, `prisma.categorySchema` (distinct in-use product types), `prisma.channelListing` (markets in use).
- Produces: an exported `collectInUseSchemaTargets(prisma): Promise<{ marketplace: string; productType: string }[]>` the cron iterates. This guarantees the browse-node enums for every (market, type) the seller actually edits stay ≤24h fresh.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/jobs/schema-refresh.vitest.test.ts
import { describe, it, expect, vi } from 'vitest'
import { collectInUseSchemaTargets } from './schema-refresh.job.js'

describe('collectInUseSchemaTargets', () => {
  it('returns distinct (marketplace, productType) pairs from cached schemas', async () => {
    const prisma = {
      categorySchema: {
        findMany: vi.fn().mockResolvedValue([
          { marketplace: 'IT', productType: 'COAT' },
          { marketplace: 'IT', productType: 'PANTS' },
          { marketplace: 'IT', productType: 'COAT' },
        ]),
      },
    } as any
    const out = await collectInUseSchemaTargets(prisma)
    expect(out).toEqual([
      { marketplace: 'IT', productType: 'COAT' },
      { marketplace: 'IT', productType: 'PANTS' },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npm run test -- jobs/schema-refresh.vitest.test.ts`
Expected: FAIL — `collectInUseSchemaTargets` not exported.

- [ ] **Step 3: Write minimal implementation**

In `apps/api/src/jobs/schema-refresh.job.ts`, export the collector and call it from the cron body (refresh each target with a small concurrency cap). If `schema-refresh.job.ts` does not exist under that exact name, locate the file defining `startSchemaRefreshCron` (referenced at `index.ts:834`) and add this there:

```typescript
export async function collectInUseSchemaTargets(
  prisma: PrismaClient,
): Promise<{ marketplace: string; productType: string }[]> {
  const rows = await prisma.categorySchema.findMany({
    where: { channel: 'AMAZON', isActive: true },
    select: { marketplace: true, productType: true },
    orderBy: [{ marketplace: 'asc' }, { productType: 'asc' }],
  })
  const seen = new Set<string>()
  const out: { marketplace: string; productType: string }[] = []
  for (const r of rows) {
    const mp = r.marketplace ?? 'IT'
    const key = `${mp}:${r.productType}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ marketplace: mp, productType: r.productType })
  }
  return out
}
```

Then ensure the scheduled callback iterates `collectInUseSchemaTargets(prisma)` and calls `refreshSchema` for each (sequential or small batches; wrap in `recordCronRun('schema-refresh', …)` if not already). Do **not** change the existing cron schedule expression.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npm run test -- jobs/schema-refresh.vitest.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit + push (Phase 0 ships)**

```bash
cd apps/api && npx tsc --noEmit && cd ..
git commit --only apps/api/src/jobs/schema-refresh.job.ts apps/api/src/jobs/schema-refresh.vitest.test.ts \
  -m "feat(flat-file): nightly refresh of in-use PTD schemas keeps browse nodes fresh (BN.0.4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git pull --rebase && git push
```

**Phase 0 acceptance:** `/amazon/flat-file/browse-nodes?marketplace=IT&productType=COAT` returns the Giacche node (or documented `source:none` fallback); the manifest's browse-node column is an `enum` with id→path labels; in-use schemas refresh nightly.

---

## Phase 1 — Browse node as a first-class, picker-driven column (frontend)

> Frontend tests in this repo are Playwright specs run against the live deploy (no auth on the editor), matching the FF-EN series. Pure logic is extracted into `category-model.ts` and unit-tested with Vitest; UI behavior is guarded by a Playwright spec after the push is green.

### Task 1.1: Confirm + label the browse-node column in the grid

**Files:**
- Modify: `apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx` (the column-label/normalize path that maps the backend manifest column → frontend `Column`)
- Test: `apps/web/tests/amazon-flat-file-browse-nodes.spec.ts` (create)

**Interfaces:**
- Consumes: the manifest column from Task 0.2 (`kind:'enum'`, `options`, `optionLabels`).
- Produces: the browse-node column renders the existing `EnumDropdown` (search-as-you-type over the path), shows the **path** while storing the **id**, and displays a friendly header label "Browse node" instead of the raw `recommended_browse_nodes…` token.

- [ ] **Step 1: Write the failing test (Playwright, runs post-deploy)**

```typescript
// apps/web/tests/amazon-flat-file-browse-nodes.spec.ts
import { test, expect } from '@playwright/test'

// A family with a browse-node-bearing product type (COAT/PANTS). Override via env if reseeded.
const MARKET = process.env.PLAYWRIGHT_MARKET ?? 'IT'
const PRODUCT_TYPE = process.env.PLAYWRIGHT_PRODUCT_TYPE ?? 'COAT'

test.describe('amazon flat-file — browse nodes (BN)', () => {
  test('a Browse node column renders and its picker searches paths', async ({ page }) => {
    await page.goto(`/products/amazon-flat-file?marketplace=${MARKET}&productType=${PRODUCT_TYPE}`, {
      waitUntil: 'domcontentloaded', timeout: 60_000,
    })
    await page.waitForTimeout(8000)
    const body = (await page.locator('body').innerText()).toLowerCase()
    expect(body).not.toContain('application error')
    // The friendly header label exists.
    await expect(page.getByText('Browse node', { exact: false }).first()).toBeVisible()
  })
})
```

- [ ] **Step 2: Run to verify it fails (or is red pre-deploy)**

Run: `PLAYWRIGHT_BASE_URL=https://nexus-commerce-three.vercel.app npx playwright test amazon-flat-file-browse-nodes --workspace=@nexus/web`
Expected: FAIL — no "Browse node" header yet (current build shows the raw token / no labeled column).

- [ ] **Step 3: Implement the friendly label + ensure enum rendering**

In `AmazonFlatFileClient.tsx`, where backend columns are mapped to the frontend `Column` (search for where `labelEn`/`labelLocal` are assigned per column, or where columns are normalized after fetch), add a label override for browse-node columns. Keep it surgical — a single mapping helper:

```typescript
// near the manifest-normalization code
function prettyColumnLabel(col: Column): Column {
  if (/^recommended_browse_nodes\b/.test(col.fieldRef)) {
    const n = col.fieldRef.match(/#(\d+)\.value/)?.[1]
    return { ...col, labelEn: n && n !== '1' ? `Browse node ${n}` : 'Browse node', labelLocal: n && n !== '1' ? `Browse node ${n}` : 'Browse node' }
  }
  return col
}
```

Apply `prettyColumnLabel` wherever the manifest groups' columns are first turned into the grid's `Column[]` (map over `group.columns`). The cell itself already renders `EnumDropdown` because Task 0.2 set `kind:'enum'` + `options` — no cell change needed.

- [ ] **Step 4: Push, then run the Playwright spec green**

```bash
git commit --only apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx apps/web/tests/amazon-flat-file-browse-nodes.spec.ts \
  -m "feat(flat-file): Browse node column label + enum picker (BN.1.1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git pull --rebase && git push
```
Wait for the Vercel deploy, then:
Run: `PLAYWRIGHT_BASE_URL=https://nexus-commerce-three.vercel.app npx playwright test amazon-flat-file-browse-nodes --workspace=@nexus/web`
Expected: PASS.

---

### Task 1.2: `category-model.ts` helpers (pure, unit-tested)

**Files:**
- Create: `apps/web/src/app/products/amazon-flat-file/category-model.ts`
- Test: `apps/web/src/app/products/amazon-flat-file/category-model.vitest.test.ts`

**Interfaces:**
- Produces:
  - `export interface RowCategory { productType: string; nodeId: string | null; nodePath: string | null }`
  - `export function browseNodeFieldRef(marketplaceId: string, n?: number): string` → `recommended_browse_nodes[marketplace_id=<MP>]#<n>.value`
  - `export function categoryOf(row: Record<string, unknown>, marketplaceId: string, labels: Record<string,string>): RowCategory`
  - `export function productTypesInUse(rows: Array<Record<string, unknown>>): string[]` (distinct, non-empty `product_type`, order of first appearance)
  - `export function assignCategory(row: Record<string, unknown>, c: { productType: string; nodeId: string | null }, marketplaceId: string): Record<string, unknown>` (returns a new row with `product_type` + the `#1` browse-node field set)

- [ ] **Step 1: Write the failing test**

```typescript
// category-model.vitest.test.ts
import { describe, it, expect } from 'vitest'
import { browseNodeFieldRef, categoryOf, productTypesInUse, assignCategory } from './category-model.js'

const MP = 'APJ6JRA9NG5V4'

describe('category-model', () => {
  it('builds the per-market field ref', () => {
    expect(browseNodeFieldRef(MP)).toBe('recommended_browse_nodes[marketplace_id=APJ6JRA9NG5V4]#1.value')
    expect(browseNodeFieldRef(MP, 2)).toBe('recommended_browse_nodes[marketplace_id=APJ6JRA9NG5V4]#2.value')
  })

  it('reads a row category (type + node id + path label)', () => {
    const row = { product_type: 'COAT', [browseNodeFieldRef(MP)]: '2420941031' }
    const c = categoryOf(row, MP, { '2420941031': '… > Giacche' })
    expect(c).toEqual({ productType: 'COAT', nodeId: '2420941031', nodePath: '… > Giacche' })
  })

  it('lists distinct product types in first-seen order', () => {
    const rows = [{ product_type: 'COAT' }, { product_type: 'PANTS' }, { product_type: 'COAT' }, { product_type: '' }]
    expect(productTypesInUse(rows)).toEqual(['COAT', 'PANTS'])
  })

  it('assigns category onto a row immutably', () => {
    const row = { item_sku: 'X', product_type: 'COAT' }
    const out = assignCategory(row, { productType: 'PANTS', nodeId: '2420943031' }, MP)
    expect(out.product_type).toBe('PANTS')
    expect(out[browseNodeFieldRef(MP)]).toBe('2420943031')
    expect(row.product_type).toBe('COAT') // original untouched
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/app/products/amazon-flat-file/category-model.vitest.test.ts`
Expected: FAIL — module missing. (If `apps/web` has no Vitest configured, add `vitest` per the api package's config; check `apps/web/package.json` first and mirror `apps/api`'s test script. If web truly has no unit runner, place this file + test under `apps/api`'s reach is wrong — instead add a minimal `vitest.config.ts` to `apps/web`. Prefer reusing an existing web unit test if one exists.)

- [ ] **Step 3: Implement**

```typescript
// category-model.ts
export interface RowCategory { productType: string; nodeId: string | null; nodePath: string | null }

export function browseNodeFieldRef(marketplaceId: string, n = 1): string {
  return `recommended_browse_nodes[marketplace_id=${marketplaceId}]#${n}.value`
}

export function categoryOf(
  row: Record<string, unknown>,
  marketplaceId: string,
  labels: Record<string, string>,
): RowCategory {
  const productType = String(row.product_type ?? '')
  const nodeRaw = row[browseNodeFieldRef(marketplaceId)]
  const nodeId = nodeRaw == null || nodeRaw === '' ? null : String(nodeRaw)
  return { productType, nodeId, nodePath: nodeId ? labels[nodeId] ?? null : null }
}

export function productTypesInUse(rows: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rows) {
    const t = String(r.product_type ?? '').toUpperCase()
    if (t && !seen.has(t)) { seen.add(t); out.push(t) }
  }
  return out
}

export function assignCategory(
  row: Record<string, unknown>,
  c: { productType: string; nodeId: string | null },
  marketplaceId: string,
): Record<string, unknown> {
  return {
    ...row,
    product_type: c.productType.toUpperCase(),
    [browseNodeFieldRef(marketplaceId)]: c.nodeId ?? '',
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/app/products/amazon-flat-file/category-model.vitest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git commit --only apps/web/src/app/products/amazon-flat-file/category-model.ts apps/web/src/app/products/amazon-flat-file/category-model.vitest.test.ts \
  -m "feat(flat-file): category-model pure helpers (BN.1.2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1.3: Write-back browse node id → `platformAttributes.browseNodeId`

**Files:**
- Modify: `apps/api/src/routes/amazon-flat-file.routes.ts` (the `POST /amazon/flat-file/sync-rows` handler that serializes rows)
- Test: extend `apps/api/src/routes/amazon-flat-file.browse-nodes.vitest.test.ts`

**Interfaces:**
- Consumes: each synced row's `recommended_browse_nodes[...]#1.value`.
- Produces: on sync, the chosen node id is persisted to the row's `ChannelListing.platformAttributes.browseNodeId` for that marketplace (reusing the cockpit field), in addition to flowing into the feed. A pure helper `export function browseNodeIdFromRow(row, marketplaceId): string | null` is added to `browse-nodes.ts` and unit-tested.

- [ ] **Step 1: Write the failing test**

```typescript
// add to apps/api/src/services/amazon/browse-nodes.vitest.test.ts
import { browseNodeIdFromRow } from './browse-nodes.js'
describe('browseNodeIdFromRow', () => {
  it('reads the #1 node id for the marketplace', () => {
    const row = { 'recommended_browse_nodes[marketplace_id=APJ6JRA9NG5V4]#1.value': '2420941031' }
    expect(browseNodeIdFromRow(row, 'APJ6JRA9NG5V4')).toBe('2420941031')
  })
  it('null when absent/empty', () => {
    expect(browseNodeIdFromRow({}, 'APJ6JRA9NG5V4')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npm run test -- services/amazon/browse-nodes.vitest.test.ts`
Expected: FAIL — `browseNodeIdFromRow` not exported.

- [ ] **Step 3: Implement helper + wire into sync-rows**

Add to `browse-nodes.ts`:

```typescript
export function browseNodeIdFromRow(row: Record<string, unknown>, marketplaceId: string): string | null {
  const v = row[`recommended_browse_nodes[marketplace_id=${marketplaceId}]#1.value`]
  return v == null || v === '' ? null : String(v)
}
```

In the `sync-rows` handler, where each row is persisted to its `ChannelListing`, merge the node id into `platformAttributes` (preserve existing keys):

```typescript
import { browseNodeIdFromRow } from '../services/amazon/browse-nodes.js'
import { amazonMarketplaceId } from '../services/categories/marketplace-ids.js'
// per row, when updating/creating the ChannelListing:
const nodeId = browseNodeIdFromRow(row, amazonMarketplaceId(marketplace))
// merge into the platformAttributes JSON you already write:
const platformAttributes = { ...(existing.platformAttributes as object ?? {}), ...(nodeId ? { browseNodeId: nodeId } : {}) }
```

(Adapt to the handler's actual upsert shape — locate where `platformAttributes` is currently written for sync-rows and extend that object; do not overwrite sibling keys like `bulletPoints`.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npm run test -- services/amazon/browse-nodes.vitest.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit + push (Phase 1 ships)**

```bash
cd apps/api && npx tsc --noEmit && cd ..
git commit --only apps/api/src/services/amazon/browse-nodes.ts apps/api/src/services/amazon/browse-nodes.vitest.test.ts apps/api/src/routes/amazon-flat-file.routes.ts \
  -m "feat(flat-file): persist browse node id to platformAttributes.browseNodeId on sync (BN.1.3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git pull --rebase && git push
```

**Phase 1 acceptance:** the grid shows a labeled "Browse node" column with a path-searchable picker; picking a node on a jacket row and saving persists `browseNodeId` on the listing; `category-model` helpers are green.

---

## Phase 2 — Category concept + per-group assignment (UX core)

### Task 2.1: Pinned, derived "Category" column

**Files:**
- Modify: `apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx` (inject a synthetic column into `allColumns`; render its cell; include it in `frozenColCount`/`stickyLeftByColIdx`)
- Test: extend `apps/web/tests/amazon-flat-file-browse-nodes.spec.ts`

**Interfaces:**
- Consumes: `categoryOf` (Task 1.2), the active `marketplaceId`, the manifest's browse-node `optionLabels` (id→path).
- Produces: a non-editable, pinned **Category** column (id `__category`) rendering a chip `<path-leaf> · <PRODUCT_TYPE>` per real row (blank for parent rows). It is a display column — edits happen via "Set category" (Task 2.2) and the Browse-node/Product-type cells.

- [ ] **Step 1: Write the failing test**

```typescript
// add to amazon-flat-file-browse-nodes.spec.ts
test('a pinned Category column shows type · node chips', async ({ page }) => {
  await page.goto(`/products/amazon-flat-file?marketplace=${MARKET}&productType=${PRODUCT_TYPE}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await expect(page.getByRole('columnheader', { name: /category/i }).first()).toBeVisible()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `PLAYWRIGHT_BASE_URL=https://nexus-commerce-three.vercel.app npx playwright test amazon-flat-file-browse-nodes --workspace=@nexus/web`
Expected: FAIL — no Category column header.

- [ ] **Step 3: Implement**

Add a synthetic column to the front of the derived `allColumns` (just after the identity columns). Build it in a `useMemo` that depends on the effective manifest:

```typescript
const CATEGORY_COL: Column = {
  id: '__category', fieldRef: '__category', labelEn: 'Category', labelLocal: 'Category',
  required: false, kind: 'text', width: 200,
}
// where allColumns is derived, prepend it:
const allColumns = useMemo<Column[]>(() => [CATEGORY_COL, ...visibleGroups.flatMap((g) => g.columns)], [visibleGroups])
```

In the cell renderer (`SpreadsheetCell`), short-circuit `col.id === '__category'` to a read-only chip built from `categoryOf(row, marketplaceId, browseNodeLabels)` (compute `browseNodeLabels` once from the manifest's browse-node column `optionLabels`). Render the leaf of the path (`path.split('>').pop()?.trim()`) + ` · ` + `productType`; render nothing for parent rows (`parentage_level === 'parent'`). Reuse the existing family color dot if present.

Ensure the Category column is frozen: it is index 0 of `allColumns`, and `frozenColCount` defaults to 1, so `stickyLeftByColIdx` already pins it. Bump the default `ff-frozen-cols` floor to include identity + category if needed (keep ≥1).

- [ ] **Step 4: Push, deploy, run spec green**

```bash
git commit --only apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx apps/web/tests/amazon-flat-file-browse-nodes.spec.ts \
  -m "feat(flat-file): pinned derived Category column (BN.2.1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git pull --rebase && git push
```
After deploy: `PLAYWRIGHT_BASE_URL=https://nexus-commerce-three.vercel.app npx playwright test amazon-flat-file-browse-nodes --workspace=@nexus/web` → PASS.

---

### Task 2.2: "Set category" action + modal (bulk-apply to selection)

**Files:**
- Modify: `apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx` (toolbar action; new `SetCategoryModal` component in the same file or a sibling)
- Create: `apps/web/src/app/products/amazon-flat-file/SetCategoryModal.tsx`
- Test: extend `apps/web/tests/amazon-flat-file-browse-nodes.spec.ts`

**Interfaces:**
- Consumes: `selectedRows: Set<string>` + `setRows` (from the editor), `assignCategory` (Task 1.2), the `/amazon/flat-file/product-types` endpoint (existing) for the type list, and `/amazon/flat-file/browse-nodes?marketplace=&productType=` (Task 0.3) for the node list.
- Produces: a toolbar button "Set category" (enabled when `selectedRows.size > 0`) opening `SetCategoryModal`. The modal: pick product type (reuse the `ProductTypeDropdown` pattern) → fetch its browse nodes → pick a node (reuse `EnumDropdown`) → Apply runs `assignCategory` over every selected row and updates `rows`.

- [ ] **Step 1: Write the failing test**

```typescript
// add to amazon-flat-file-browse-nodes.spec.ts
test('Set category applies a type + node to the selected rows', async ({ page }) => {
  await page.goto(`/products/amazon-flat-file?marketplace=${MARKET}&productType=${PRODUCT_TYPE}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(8000)
  // select all
  const selectAll = page.locator('thead input[type="checkbox"]').first()
  await selectAll.check()
  const btn = page.getByRole('button', { name: /set category/i })
  await expect(btn).toBeVisible()
  await btn.click()
  await expect(page.getByText(/browse node/i).first()).toBeVisible()
})
```

- [ ] **Step 2: Run to verify it fails**

Run the spec → FAIL (no "Set category" button).

- [ ] **Step 3: Implement the modal**

Create `SetCategoryModal.tsx` using design-system primitives (`Button`, dialog) + the existing `EnumDropdown` for the node picker. Props:

```typescript
interface SetCategoryModalProps {
  open: boolean
  marketplace: string
  marketplaceId: string
  productTypeOptions: { value: string; source: string }[]
  onApply: (c: { productType: string; nodeId: string | null }) => void
  onClose: () => void
}
```

Behavior: on product-type change, `fetch('/api/amazon/flat-file/browse-nodes?marketplace=' + marketplace + '&productType=' + pt)` → set node options (`nodes.map(n => n.id)`) + labels (`id→path`); render `EnumDropdown` with those. "Apply" calls `onApply({ productType, nodeId })`.

In `AmazonFlatFileClient.tsx`, add the toolbar button + wire `onApply`:

```typescript
const applyCategory = useCallback((c: { productType: string; nodeId: string | null }) => {
  setRows((prev) => prev.map((r) =>
    selectedRows.has(r._rowId as string) && !r._ghost
      ? { ...assignCategory(r, c, marketplaceId), _dirty: true }
      : r))
  setSheetTypes((s) => [...new Set([...s, c.productType.toUpperCase()])]) // drives union columns (Task 2.3)
  setShowSetCategory(false)
}, [selectedRows, marketplaceId])
```

- [ ] **Step 4: Push, deploy, run spec green**

```bash
git commit --only apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx apps/web/src/app/products/amazon-flat-file/SetCategoryModal.tsx apps/web/tests/amazon-flat-file-browse-nodes.spec.ts \
  -m "feat(flat-file): Set category action + modal (bulk type+node) (BN.2.2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git pull --rebase && git push
```
After deploy: run the spec → PASS.

---

### Task 2.3: Drive union columns from assigned categories

**Files:**
- Modify: `apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx` (the `useEffect` at ~588 that resets `sheetTypes` to `[productType]` on type/market change, and the union fetch ~595)
- Test: extend `category-model.vitest.test.ts` (the `productTypesInUse` driver) + the Playwright spec

**Interfaces:**
- Consumes: `productTypesInUse(rows)` (Task 1.2).
- Produces: `sheetTypes` reflects the union of product types actually present in the rows (so assigning PANTS to a subgroup makes pant columns appear), instead of being reset purely from the single toolbar `productType`. Single-type sheets are unaffected (one type → no union).

- [ ] **Step 1: Write the failing test (driver behavior)**

```typescript
// add to category-model.vitest.test.ts
it('productTypesInUse drives union membership including assigned subgroups', () => {
  const rows = [
    { product_type: 'COAT', parentage_level: 'child' },
    { product_type: 'PANTS', parentage_level: 'child' },
  ]
  expect(productTypesInUse(rows)).toEqual(['COAT', 'PANTS'])
})
```

- [ ] **Step 2: Run to verify it fails or passes**

Run: `cd apps/web && npx vitest run src/app/products/amazon-flat-file/category-model.vitest.test.ts`
Expected: PASS for the helper (it already exists); this locks the contract. If it passes immediately, proceed — the real change is the wiring below, guarded by the Playwright spec.

- [ ] **Step 3: Implement the wiring**

Replace the reset effect so `sheetTypes` derives from the rows' product types (union of toolbar type + assigned types), while still resetting on a market switch:

```typescript
useEffect(() => {
  const inUse = productTypesInUse(rows)
  const next = [...new Set([productType.toUpperCase(), ...inUse])].filter(Boolean)
  setSheetTypes(next.length ? next : [productType])
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [productType, marketplace, rows])
```

Keep the existing union-template fetch effect (it already runs when `sheetTypes.length > 1`). Verify single-type sheets (one product type across all rows) keep `sheetTypes.length === 1` → no regression.

- [ ] **Step 4: Push, deploy, regression spec green**

Add to the Playwright spec a check that after assigning two types, a pant-only column header appears (pick a real PANTS-only field, e.g. an inseam/`bottoms_size_class` label). Then:

```bash
git commit --only apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx apps/web/src/app/products/amazon-flat-file/category-model.vitest.test.ts apps/web/tests/amazon-flat-file-browse-nodes.spec.ts \
  -m "feat(flat-file): union columns follow assigned categories (BN.2.3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git pull --rebase && git push
```
After deploy: run the spec → PASS.

**Phase 2 acceptance:** in one AIREON family, assigning COAT to jacket rows and PANTS to pant rows shows correct per-type columns, the Category column reads `Giacche · COAT` / `Pantaloni · PANTS`, and per-type validation holds.

---

## Phase 3 — Toolbar replacement

### Task 3.1: Remove Bar-3 product-type controls; add "Categories in this sheet" summary

**Files:**
- Modify: `apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx` (Bar 3 JSX ~4038–4149)
- Test: extend `apps/web/tests/amazon-flat-file-browse-nodes.spec.ts`

**Interfaces:**
- Consumes: `productTypesInUse(rows)`, `setFilterType` (existing union column filter), `selectedRows` (for "Set category").
- Produces: Bar 3 no longer renders `ProductTypeDropdown` or the "+ Add category" `<select>`. It renders: the Market switcher (unchanged), a **"Categories in this sheet"** chip row (one chip per distinct product type → click toggles `filterType` to show only that category's columns), the **Set category** button, and the existing **Refresh schema** button. Search stays.

- [ ] **Step 1: Write the failing test**

```typescript
// add to amazon-flat-file-browse-nodes.spec.ts
test('toolbar shows Categories summary, not the old product-type dropdown', async ({ page }) => {
  await page.goto(`/products/amazon-flat-file?marketplace=${MARKET}&productType=${PRODUCT_TYPE}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await expect(page.getByText(/categories in this sheet/i).first()).toBeVisible()
  await expect(page.getByText('+ Add category')).toHaveCount(0)
})
```

- [ ] **Step 2: Run to verify it fails**

Run the spec → FAIL (old controls still present).

- [ ] **Step 3: Implement**

In Bar 3, delete the block from `<span>Product Type</span>` through the `productTypes.length > 1 && (…)` multi-category region (the `ProductTypeDropdown`, the `+ Add category` `<select>`, and the inline chips). Replace with:

```tsx
<div className="flex items-center gap-2">
  <span className="text-xs text-slate-400 font-medium">Categories in this sheet</span>
  <div className="flex items-center gap-1 flex-wrap">
    {productTypesInUse(rows).length === 0 ? (
      <span className="text-[11px] text-slate-400 italic">none yet — select rows and Set category</span>
    ) : productTypesInUse(rows).map((t) => (
      <button key={t} type="button"
        onClick={() => setFilterType((f) => (f === t ? null : t))}
        className={cn('px-1.5 py-0.5 rounded text-[11px] font-semibold border transition-colors',
          filterType === t ? 'bg-indigo-100 text-indigo-700 border-indigo-300 dark:bg-indigo-900/40 dark:text-indigo-300'
          : 'border-slate-200 text-slate-500 hover:border-indigo-400')}>
        {t}
      </button>
    ))}
  </div>
  <Button size="sm" variant="secondary" disabled={selectedRows.size === 0} onClick={() => setShowSetCategory(true)}>
    Set category{selectedRows.size > 0 ? ` (${selectedRows.size})` : ''}
  </Button>
  {productType && (
    <Button size="sm" variant="ghost" onClick={() => void loadData(marketplace, productType, true)} loading={loading}
      title="Refresh schema from Amazon — updates columns/groups, keeps row edits">
      <RefreshCw className="w-3 h-3 mr-1" />Refresh schema
    </Button>
  )}
</div>
```

Remove the now-unused `ProductTypeDropdown` import/usage only if nothing else references it (keep the component definition if the Set-category modal reuses it). Keep `navigateTo` for market switching.

- [ ] **Step 4: Push, deploy, run spec green**

```bash
git commit --only apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx apps/web/tests/amazon-flat-file-browse-nodes.spec.ts \
  -m "feat(flat-file): replace toolbar product-type controls with Categories summary + Set category (BN.3.1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git pull --rebase && git push
```
After deploy: run the spec → PASS.

**Phase 3 acceptance:** old `ProductTypeDropdown` + "+ Add category" gone; assignment is via Category column + Set category; clicking a category chip filters columns; market switch + Refresh schema intact.

---

## Phase 4 — Freshness, per-market resolution, validation polish

### Task 4.1: "Synced from Amazon · last refreshed · Refresh" indicator on the node picker

**Files:**
- Modify: `apps/web/src/app/products/amazon-flat-file/SetCategoryModal.tsx`
- Test: extend the Playwright spec

**Interfaces:**
- Consumes: the `/browse-nodes` response `{ source, fetchedAt }` (Task 0.3).
- Produces: the modal shows `Synced from Amazon · <relative fetchedAt>` and a Refresh button that re-fetches with `&force=1`; when `source === 'none'`, it shows "No Amazon node list for this type — enter a node id manually" and allows free-text id entry.

- [ ] **Step 1: Write the failing test**

```typescript
test('node picker shows a freshness line', async ({ page }) => {
  await page.goto(`/products/amazon-flat-file?marketplace=${MARKET}&productType=${PRODUCT_TYPE}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(8000)
  await page.locator('thead input[type="checkbox"]').first().check()
  await page.getByRole('button', { name: /set category/i }).click()
  await expect(page.getByText(/synced from amazon|enter a node id manually/i).first()).toBeVisible()
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** the freshness line in `SetCategoryModal` from the fetch response (`source`, `fetchedAt`), with a Refresh button issuing `&force=1`.

- [ ] **Step 4: Commit + push + spec green**

```bash
git commit --only apps/web/src/app/products/amazon-flat-file/SetCategoryModal.tsx apps/web/tests/amazon-flat-file-browse-nodes.spec.ts \
  -m "feat(flat-file): node-picker freshness + manual-id fallback (BN.4.1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git pull --rebase && git push
```

---

### Task 4.2: Per-market node re-resolution on market switch

**Files:**
- Modify: `apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx`
- Create: helper `unresolvedNodeRows` in `category-model.ts` + unit test

**Interfaces:**
- Produces: `export function unresolvedNodeRows(rows, fromMarketplaceId, toMarketplaceId): string[]` → `_rowId`s whose `#1` node is set under the old market token but empty under the new market token. On market switch, the editor flags these rows (amber Category chip "node not set for <market>") and offers a one-click "Auto-fill via prediction" calling the existing predictor.

- [ ] **Step 1: Write the failing test**

```typescript
// category-model.vitest.test.ts
import { unresolvedNodeRows } from './category-model.js'
it('flags rows whose node is unset for the new market', () => {
  const IT = 'APJ6JRA9NG5V4', DE = 'A1PA6795UKMFR9'
  const rows = [
    { _rowId: 'r1', [`recommended_browse_nodes[marketplace_id=${IT}]#1.value`]: '2420941031' },
    { _rowId: 'r2', [`recommended_browse_nodes[marketplace_id=${IT}]#1.value`]: '2420941031', [`recommended_browse_nodes[marketplace_id=${DE}]#1.value`]: '999' },
  ]
  expect(unresolvedNodeRows(rows, IT, DE)).toEqual(['r1'])
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `unresolvedNodeRows` (compare old vs new market tokens) and wire a market-switch check that sets an amber state on flagged rows; "Auto-fill via prediction" calls the existing predictor endpoint per flagged SKU.

- [ ] **Step 4: Run unit → PASS; commit + push + deploy.**

```bash
git commit --only apps/web/src/app/products/amazon-flat-file/category-model.ts apps/web/src/app/products/amazon-flat-file/category-model.vitest.test.ts apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx \
  -m "feat(flat-file): per-market node re-resolution + predictor auto-fill (BN.4.2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git pull --rebase && git push
```

---

### Task 4.3: Mixed-family + missing-node warnings

**Files:**
- Modify: `apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx` (preflight/validation surface)
- Create: helpers `mixedTypeFamilies`, `euRowsMissingNode` in `category-model.ts` + unit tests

**Interfaces:**
- Produces:
  - `export function mixedTypeFamilies(rows): string[]` → parent SKUs whose children span >1 product type (warn: "Amazon may reject mixed-type families").
  - `export function euRowsMissingNode(rows, marketplaceId): string[]` → `_rowId`s with no `#1` node (warn: "no browse node — Amazon will use the category root").
  - Both surface as non-blocking warnings in the existing preflight banner (do not block submit).

- [ ] **Step 1: Write the failing test**

```typescript
import { mixedTypeFamilies, euRowsMissingNode } from './category-model.js'
it('detects mixed-type families', () => {
  const rows = [
    { item_sku: 'AIREON', parentage_level: 'parent' },
    { parent_sku: 'AIREON', parentage_level: 'child', product_type: 'COAT' },
    { parent_sku: 'AIREON', parentage_level: 'child', product_type: 'PANTS' },
  ]
  expect(mixedTypeFamilies(rows)).toEqual(['AIREON'])
})
it('flags EU rows with no node', () => {
  const MP = 'APJ6JRA9NG5V4'
  const rows = [{ _rowId: 'r1', parentage_level: 'child' }]
  expect(euRowsMissingNode(rows, MP)).toEqual(['r1'])
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** both helpers + render their results as warnings in the existing preflight/validation banner (reuse the current warning UI; non-blocking).

- [ ] **Step 4: Run unit → PASS; commit + push + deploy + final spec.**

```bash
git commit --only apps/web/src/app/products/amazon-flat-file/category-model.ts apps/web/src/app/products/amazon-flat-file/category-model.vitest.test.ts apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx apps/web/tests/amazon-flat-file-browse-nodes.spec.ts \
  -m "feat(flat-file): mixed-family + missing-node warnings (BN.4.3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git pull --rebase && git push
```

**Phase 4 acceptance:** IT→DE switch flags rows needing a DE node + offers auto-fill; a mixed-type family shows a non-blocking warning; an EU row without a node warns about the root-node fallback; manual Refresh updates the node list.

---

## Self-Review (completed against the spec)

- **Spec §4.2 (browse-node source):** Tasks 0.1–0.3. ✅
- **Spec §4.2 (freshness/nightly):** Task 0.4. ✅
- **Spec §4.1 (write-back to platformAttributes):** Task 1.3. ✅
- **Spec §4.3 (Category column):** Task 2.1. ✅
- **Spec §4.3 (Set category per-group):** Task 2.2. ✅
- **Spec §4.3 (dynamic columns via union):** Task 2.3. ✅
- **Spec §4.3 (toolbar replacement):** Task 3.1. ✅
- **Spec §4.4 (freshness indicator):** Task 4.1. ✅
- **Spec §4.4 (per-market re-resolution):** Task 4.2. ✅
- **Spec §4.4 (mixed-family + missing-node warnings):** Task 4.3. ✅
- **Type consistency:** `BrowseNode{id,path}`, `RowCategory{productType,nodeId,nodePath}`, `browseNodeFieldRef`, `assignCategory`, `productTypesInUse`, `unresolvedNodeRows`, `mixedTypeFamilies`, `euRowsMissingNode` used consistently across tasks. ✅
- **Open risk noted in spec §7:** PTD enum may be absent for some EU types → Task 0.3 `source:'none'` + Task 4.1 manual-id fallback cover it. ✅

> Execution note: several frontend tasks land deep in a ~6k-line component. Each task's "Implement" step names the exact anchor (Bar-3 JSX 4038–4149; `EnumDropdown` 6262–6378; union wiring 566–610; sticky cols 2007–2015; selection in `useFlatFileCore` 279). Read the current code at that anchor before editing — line numbers may have drifted as sibling sessions commit.
