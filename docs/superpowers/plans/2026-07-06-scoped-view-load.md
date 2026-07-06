# Scoped-View Load (per channel/market files) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each flat-file editor show only the SKUs **listed on its channel (+ market)** — turning the shared whole-catalog view into per-channel/market "files" — with a persistent "All products" toggle so the full catalog is always one click away.

**Architecture:** A shared pure helper `buildListingScopeWhere` produces a family-coherent Prisma `where` fragment (a product qualifies if it, its parent, or a child has a listing on the channel [+ marketplace]). Both load paths accept a `scope` param (`listed` default / `all`). The eBay editor scopes at channel level (it is multi-market by design); the Amazon editor scopes at channel + marketplace (it already loads per-market). Each client gets a toggle (localStorage-persisted, default `listed`) and a "N hidden — show all" indicator.

**Tech Stack:** Fastify (apps/api, Node ESM), Prisma, Next.js/React (apps/web), Vitest.

## Global Constraints

- ESM: every relative import in `apps/api` ends in `.js`.
- Untouchable-file exception: edits to `apps/web/src/app/products/{amazon,ebay}-flat-file/` + the eBay/Amazon flat-file routes are permitted for THIS plan only (spec `docs/superpowers/specs/2026-07-06-channel-market-scoped-flat-files-design.md` is the approval), additive and surgical.
- Design-system primitives only for the toggle UI; no hand-rolled controls.
- Do NOT change save/PATCH, delete, or the FF2 engine. Do NOT touch `Product`/stock.
- Drill-in loads (a specific `familyId`/`productId`) IGNORE scope — you are viewing one family.
- Default scope = `listed`; the toggle is persistent and the scoped state shows a hidden-count indicator (never silently hide with no cue).
- Commit + push after each task. Verify: `cd apps/api && npx vitest run <file>` + `npx tsc -p apps/api/tsconfig.json --noEmit`; web `npx tsc -p apps/web/tsconfig.json --noEmit`.

---

## File Structure

**Created (apps/api):**
- `src/services/flat-file/listing-scope.ts` — `buildListingScopeWhere` + `ListingScope` type.
- `src/services/flat-file/listing-scope.vitest.test.ts` — unit tests.

**Modified (apps/api):**
- `src/routes/ebay-flat-file.routes.ts` — GET `/rows` accepts `scope`; applies the helper when no `familyId`.
- `src/services/amazon/flat-file.service.ts` — `getExistingRows` accepts `scope`; applies the helper in the no-`productId` branch.
- `src/routes/amazon-flat-file.routes.ts` — GET `/rows` reads `scope` and passes it through.

**Modified (apps/web — untouchable exception, surgical):**
- `src/app/products/ebay-flat-file/EbayFlatFileClient.tsx` — scope toggle + thread `scope` into `onReload` qs + hidden-count indicator.
- `src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx` — same.

**Docs / tracking:** `.superpowers/sdd/scoped-view-progress.md`.

---

## Task 1: Shared `buildListingScopeWhere` helper

**Files:**
- Create: `apps/api/src/services/flat-file/listing-scope.ts`
- Test: `apps/api/src/services/flat-file/listing-scope.vitest.test.ts`

**Interfaces:**
- Produces: `type ListingScope = 'listed' | 'all'`; `buildListingScopeWhere({ channel, marketplace?, scope }): Record<string, unknown>` — returns `{}` for `'all'`, else a family-coherent `{ OR: [...] }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { buildListingScopeWhere } from './listing-scope.js'

describe('buildListingScopeWhere', () => {
  it("scope 'all' → empty where (no filtering)", () => {
    expect(buildListingScopeWhere({ channel: 'EBAY', scope: 'all' })).toEqual({})
  })

  it("scope 'listed', no marketplace → channel-level family-coherent OR", () => {
    const w = buildListingScopeWhere({ channel: 'EBAY', scope: 'listed' })
    expect(w).toEqual({
      OR: [
        { channelListings: { some: { channel: 'EBAY' } } },
        { parent: { channelListings: { some: { channel: 'EBAY' } } } },
        { children: { some: { channelListings: { some: { channel: 'EBAY' } } } } },
      ],
    })
  })

  it("scope 'listed' + marketplace → channel+market-scoped listing filter", () => {
    const w = buildListingScopeWhere({ channel: 'AMAZON', marketplace: 'IT', scope: 'listed' })
    expect(w).toEqual({
      OR: [
        { channelListings: { some: { channel: 'AMAZON', marketplace: 'IT' } } },
        { parent: { channelListings: { some: { channel: 'AMAZON', marketplace: 'IT' } } } },
        { children: { some: { channelListings: { some: { channel: 'AMAZON', marketplace: 'IT' } } } } },
      ],
    })
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/api && npx vitest run src/services/flat-file/listing-scope.vitest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/flat-file/listing-scope.ts
/**
 * Family-coherent "is listed on this channel (+ market)" Prisma where-fragment
 * for the scoped flat-file views. A product qualifies if IT, its PARENT, or a
 * CHILD has a matching ChannelListing — so variation families stay intact.
 * scope 'all' → {} (no filtering, i.e. the whole catalog).
 */
export type ListingScope = 'listed' | 'all'

export function buildListingScopeWhere(opts: {
  channel: string
  marketplace?: string
  scope: ListingScope
}): Record<string, unknown> {
  if (opts.scope === 'all') return {}
  const listingWhere = {
    channel: opts.channel,
    ...(opts.marketplace ? { marketplace: opts.marketplace } : {}),
  }
  const hasListing = { channelListings: { some: listingWhere } }
  return {
    OR: [
      hasListing,
      { parent: hasListing },
      { children: { some: hasListing } },
    ],
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/flat-file/listing-scope.vitest.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/flat-file/listing-scope.ts apps/api/src/services/flat-file/listing-scope.vitest.test.ts
git commit -m "feat(flat-file): buildListingScopeWhere — family-coherent per-channel/market scope filter"
```

---

## Task 2: eBay GET /rows honors `scope`

**Files:**
- Modify: `apps/api/src/routes/ebay-flat-file.routes.ts` (Querystring + WHERE, ~L75-90)

**Interfaces:**
- Consumes: `buildListingScopeWhere` (Task 1).
- Produces: `GET /api/ebay/flat-file/rows?scope=listed|all` — `listed` (default) filters to eBay-listed families; `familyId` still overrides (ignores scope).

- [ ] **Step 1: Add the import (`.js`)**

```ts
import { buildListingScopeWhere, type ListingScope } from '../services/flat-file/listing-scope.js'
```

- [ ] **Step 2: Extend the Querystring + WHERE**

Change the handler signature and the `where` so scope applies only when not drilling into a family:

```ts
  fastify.get<{
    Querystring: { familyId?: string; scope?: ListingScope }
  }>('/ebay/flat-file/rows', async (request, reply) => {
    const { familyId } = request.query;
    const scope: ListingScope = request.query.scope === 'all' ? 'all' : 'listed';

    try {
      const products = await prisma.product.findMany({
        where: {
          deletedAt: null,
          ...(familyId
            ? { OR: [{ id: familyId }, { parentId: familyId }] }
            : buildListingScopeWhere({ channel: 'EBAY', scope })),
        },
        include: {
          channelListings: { where: { channel: 'EBAY' } },
          // ...(rest of the existing include unchanged)
```

Leave the rest of the handler (include/images/shared-row post-pass) unchanged.

- [ ] **Step 3: Verify**

Run: `cd apps/api && npx tsc -p tsconfig.json --noEmit` → clean.
Manual after deploy: `GET /api/ebay/flat-file/rows?scope=all` returns the full set; `?scope=listed` (or omitted) returns only eBay-listed families.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/ebay-flat-file.routes.ts
git commit -m "feat(ebay): GET /rows honors scope=listed|all (default listed, familyId overrides)"
```

---

## Task 3: Amazon `getExistingRows` + route honor `scope`

**Files:**
- Modify: `apps/api/src/services/amazon/flat-file.service.ts` (`getExistingRows`, ~L1332)
- Modify: `apps/api/src/routes/amazon-flat-file.routes.ts` (GET `/rows` handler, ~L283)

**Interfaces:**
- Consumes: `buildListingScopeWhere` (Task 1).
- Produces: `getExistingRows(marketplace, productType?, productId?, scope: ListingScope = 'listed')`; route passes `scope` from the querystring.

- [ ] **Step 1: Service — import + signature + WHERE**

Add import (`.js`), extend the signature, and apply the helper in the no-`productId` branch (the `productId` drill-in branches are unchanged — they ignore scope):

```ts
import { buildListingScopeWhere, type ListingScope } from '../flat-file/listing-scope.js'

  async getExistingRows(
    marketplace: string,
    productType?: string,
    productId?: string,
    scope: ListingScope = 'listed',
  ): Promise<FlatFileRow[]> {
```

In the `else` (no `productId`) branch, change the `where`:

```ts
      const where: Record<string, any> = {
        deletedAt: null,
        ...buildListingScopeWhere({ channel: 'AMAZON', marketplace: mp, scope }),
      }
      if (productType) where.productType = productType.toUpperCase()
```

- [ ] **Step 2: Route — read + pass `scope`**

In the GET `/api/amazon/flat-file/rows` handler (~L283), add `scope` to the querystring type and pass it to `getExistingRows`:

```ts
  // add scope to the Querystring generic and read it:
  const scope: ListingScope = request.query.scope === 'all' ? 'all' : 'listed'
  // ...
  const rows = await flatFileService.getExistingRows(marketplace, productType, productId, scope)
```

Add the import at the top of the route file (`.js`): `import type { ListingScope } from '../services/flat-file/listing-scope.js'`.

- [ ] **Step 3: Verify**

Run: `cd apps/api && npx tsc -p tsconfig.json --noEmit` → clean.
Manual after deploy: `GET /api/amazon/flat-file/rows?marketplace=IT&scope=all` = full catalog; `scope=listed` = only products listed on Amazon-IT.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/amazon/flat-file.service.ts apps/api/src/routes/amazon-flat-file.routes.ts
git commit -m "feat(amazon): getExistingRows + /rows honor scope=listed|all (channel+market scoped)"
```

---

## Task 4: eBay client — scope toggle + hidden-count indicator

**Files:**
- Modify: `apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx` (`onReload` ~L865-885; toolbar)

**Interfaces:**
- Consumes: `GET /rows?scope=` (Task 2).
- Produces: a persisted `scope` state driving the reload + a UI toggle.

- [ ] **Step 1: Add persisted scope state**

Near the other editor state, add (localStorage-persisted, default `'listed'`):

```tsx
const [scope, setScope] = useState<'listed' | 'all'>(() => {
  if (typeof window === 'undefined') return 'listed'
  return (window.localStorage.getItem('ebay-ff-scope') as 'listed' | 'all') || 'listed'
})
const scopeRef = useRef(scope)
useEffect(() => { scopeRef.current = scope; try { window.localStorage.setItem('ebay-ff-scope', scope) } catch {} }, [scope])
```

- [ ] **Step 2: Thread `scope` into the GET reloads**

In `onReload` (and the other GET at ~L704), add the param:

```tsx
    const qs = new URLSearchParams()
    if (familyId) qs.set('familyId', familyId)
    qs.set('scope', scopeRef.current)
    const res = await fetch(`${BACKEND}/api/ebay/flat-file/rows?${qs}`)
```

Add `scope` to `onReload`'s dependency array. When the toggle changes `scope`, trigger the existing reload path (call `onReload()` / the same refresh the toolbar Reload button uses).

- [ ] **Step 3: Add the DS toggle + hidden indicator to the toolbar**

Using the design-system control already used elsewhere in this file (a `SegmentedControl`/`Toggle`/`Button` pair — match the existing pattern), add a two-option control: **This file** (`listed`) / **All products** (`all`), wired to `setScope` + reload. When `scope === 'listed'`, show a small muted line near the toolbar: `Showing SKUs listed on eBay. <button>Show all products</button>` (the button sets `scope` to `'all'`). Do not hand-roll; reuse the file's DS imports.

- [ ] **Step 4: Verify**

Run: `cd apps/web && npx tsc -p tsconfig.json --noEmit` → clean.
Manual after deploy: default view shows only eBay-listed families; toggling **All products** shows the full catalog; the choice persists across reloads.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/products/ebay-flat-file/EbayFlatFileClient.tsx
git commit -m "feat(ebay-flat-file): This file / All products scope toggle (default scoped, persisted)"
```

---

## Task 5: Amazon client — scope toggle + hidden-count indicator

**Files:**
- Modify: `apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx` (the rows fetch + toolbar)

**Interfaces:**
- Consumes: `GET /rows?...&scope=` (Task 3).
- Produces: persisted `scope` state driving the load + a UI toggle (mirrors Task 4).

- [ ] **Step 1: Add persisted scope state** (localStorage key `amazon-ff-scope`, default `'listed'`) — same shape as Task 4 Step 1.

- [ ] **Step 2: Thread `scope` into the rows fetch.** Find where the client fetches `/api/amazon/flat-file/rows` (the `loadData`/reload path) and append `&scope=${scopeRef.current}` to the URL. Re-run that load when the toggle changes.

- [ ] **Step 3: Add the DS toggle + hidden indicator** to the Amazon toolbar — **This file** (`listed`) / **All products** (`all`), copy "Showing SKUs listed on Amazon {marketplace}." with a "Show all products" action, mirroring Task 4 Step 3 and matching this file's existing DS toolbar controls.

- [ ] **Step 4: Verify**

Run: `cd apps/web && npx tsc -p tsconfig.json --noEmit` → clean.
Manual after deploy: default shows only Amazon-{market}-listed products; toggle reveals the full catalog; persists.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx
git commit -m "feat(amazon-flat-file): This file / All products scope toggle (default scoped, persisted)"
```

---

## Task 6: Docs + ledger

**Files:**
- Create: `.superpowers/sdd/scoped-view-progress.md`
- Modify: `docs/superpowers/specs/2026-07-06-channel-market-scoped-flat-files-design.md` (note C3 delivered)

- [ ] **Step 1:** Append to spec §8: "Plan 2 (scoped-view load, C3) delivered — both editors default to their channel(+market) listed SKUs with an All-products toggle. See `docs/superpowers/plans/2026-07-06-scoped-view-load.md`. Remaining: Action column (Deactivate/End/Delete verbs) + `ReviseFixedPriceItem`."
- [ ] **Step 2:** Write the ledger with a line per completed task.
- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-06-channel-market-scoped-flat-files-design.md
git commit -m "docs(flat-file): mark Plan 2 (scoped-view load, C3) delivered"
```

---

## Self-review notes (coverage vs spec)

- **C3 (whole-catalog view)** → Tasks 1-5 (family-coherent scope filter + toggle).
- **Non-disruptive:** default scoped BUT always a persistent "All products" toggle + a visible "showing listed only" cue (never silent hiding).
- **eBay channel-level vs Amazon channel+market:** deliberate — the eBay editor is multi-market by construction; per-market eBay scoping is a future refinement (noted, not silently dropped).
- **Drill-in unaffected:** `familyId`/`productId` loads ignore scope.
- **Deferred:** Action column verbs + `ReviseFixedPriceItem` = later plans.
- **Rollback:** additive; `scope=all` reproduces prior behavior; revert commits to restore default.
