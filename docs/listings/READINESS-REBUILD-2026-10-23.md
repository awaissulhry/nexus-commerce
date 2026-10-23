# Listing readiness — rebuild plan (23 October 2026)

## Summary

- **Status (23 Oct, night):** BUILT on branch `feat/listing-readiness-rebuild` (layout A, the Owner's yes). Checked
  locally on a private copy of the local dev data (see section 6). Merge waits for "Merge #N".
- **Page:** `/products/listing-readiness` (the same address, so every old link keeps working).
- **Goal:** the page answers one question — *what is ready, what needs work, and where do I fix it?* It looks and
  works like the live Products page: product photos, families that fold open, the same toolbar, live updates.
- **Old work:** branch `feature/listings-readiness` (113 local commits, 22 Sep – 1 Oct) is **not reused**. `main` was
  rewritten on 29 Sep, so the branch has no shared history with `main`. Its design was very heavy (certificates,
  locks, epochs) and it never shipped. The branch stays untouched as history.
- **No schema change. No migration. No write to any marketplace.** The page only reads.

## 1. What is wrong today (read on the live site, 23 Oct)

- A flat table: 11,307 rows ("coordinates") for 415 products. One row per product × market × language.
- No photos. No families. GALE-JACKET shows once per size, per colour, per market, per language.
- The state reads "Blocked · 38%" and "100 issues to review". The issue list is long and hard to read.
- Every issue says `kind: 'missing'`, also when the real cause is a missing translation, an unset theme or a
  collision (the API drops the stored kind).
- No live updates. The page does not change when a fix is saved. You must reload.
- Page size is fixed at 25. No search box. The layout is narrow and does not match Products.
- "Back to products" goes to the old address `/products/next` (it only works through a redirect).

## 2. The new page (layout A — recommended)

The numbers in this sketch are examples, not real counts.

```
Listing readiness                                         [Translate…] [Back to products]
23 products · 1,240 listings · checked 2 min ago

[ All 1,240 ] [ Blocked 310 ] [ Warnings 420 ] [ Ready 380 ] [ Not checked 130 ]     ← click = filter

Filters  Channel ▾  Market ▾  Store ▾  Language ▾  Product family ▾                    [Hide]

23 products  [Search SKU or name…]        Compact Cozy Spacious  Customise  Views  ● Up to date
┌──┬──────────────────────────────┬──────────────────────────────────────┬──────────────────────┬───────────┬────────┐
│▸ │ [photo] GALE-JACKET          │ Shared ● Amazon IT ● Amazon DE ●     │ Add a size chart     │ 2 min ago │ [Fix]  │
│  │ GAL-…  20 variations         │ Amazon FR ● eBay IT ● Shopify ●      │ Amazon DE · 20 var.  │           │        │
├──┼──────────────────────────────┼──────────────────────────────────────┼──────────────────────┼───────────┼────────┤
│▾ │ [photo] XAVIA AIREON …       │ …                                    │ …                    │ Checking… │ [Fix]  │
│  │   [photo] AIREON-BLK-M       │ Shared ● Amazon IT ● …               │ …                    │           │ [Fix]  │
│  │   … (at most 10 variants)    │                                      │                      │           │        │
│  │   Showing 10 of 40 variations                                              [View all 40]                  │
└──┴──────────────────────────────┴──────────────────────────────────────┴──────────────────────┴───────────┴────────┘
                                                                      ‹ 1 2 › Rows per page: 50 / 100 / 200
```

- **One row per product family**, exactly like Products. A single product has no fold-open arrow.
- **Markets column:** one coloured chip per destination (Shared, Amazon IT, Amazon DE, eBay IT, Shopify, …). The chip
  colour is the worst state on that market (red Blocked, amber Warnings, grey Not set up / Not computed, green Ready).
  The chip shows the number of problems. With a Channel or Market filter, only those chips show.
- **Next step column:** the most urgent problem in plain words, the market and how many variants it touches.
- **Checked column:** the oldest check time in the family. "Checking…" while Nexus rebuilds it.
- **Fold open:** the same 10-variation preview and footer as Products ("Showing 10 of 40 variations", "View all 40").
  When the parent has its own listing (Amazon parent SKU), it is the first row inside the family.
- **Fix:** click a chip or **Fix** → a centred window (DS `Modal`) "GALE-JACKET · Amazon DE":
  problems grouped Blocked → Warnings → Not set up; each problem has its plain message, the variants it touches and a
  link that opens the **exact field** in the product studio. One tab per language when the market has more than one.
- **Order:** worst first (Blocked → Warnings → Not checked → Ready), then name. Stable.
- **Counts:** the tiles count *listings* (one product on one market; its languages fold into one verdict, the worst
  wins). The toolbar names both units: "23 products · 1,240 listings". All = Blocked + Warnings + Ready + Not checked.
- **Labels:** the DS's own readiness labels and tones (`readinessMeta(state, 'scope')`) — no new words.
- **Phone:** the same grid with the Products page's phone rules; chips wrap to more lines.
- **Old links keep working:** `?productIds=`, `?listingIds=`, `?job=`, `?skus=`, `?familyId=`, `?channel=`,
  `?marketplace=`, `?language=`, `?state=`, `?accountId=`. A selector shows as a chip ("12 chosen products ✕").
- **Translate filtered products…** stays (same scope, same API).
- "Back to products" goes to `/products`.

### Layout B (the old 26 September rule, OD6) — not recommended

One row per family **per market**. GALE-JACKET shows about 15 times (Shared, Amazon IT, DE, FR, ES, BE, NL, PL, SE,
eBay IT, Shopify, …), each with its photo. Long and repetitive; this is what makes today's page hard to read.

## 3. Live updates (real time)

- Today a readiness rebuild publishes **no event**. The page cannot know.
- New event `readiness.updated` (`{ rootProductId }`), declared in `packages/events/catalog.ts` (hard rule 8),
  published once per family rebuild, after the commit.
- It goes out on the existing stream `GET /api/listings/events` that Products already uses.
- The page refreshes **only the changed family** (wait 1 s to group bursts). It also re-reads every 30 s and on tab
  focus, like Products. The pill says "Up to date" / "Updating…" / "Not updating".
- Families with `pendingSince` show "Checking…" and refresh when their event arrives.

## 4. Build — 3 parallel parts, then one check

The lead writes the shared types first (`packages/shared/listing-readiness.ts`), so the parts can run at the same time.

| Part | What | Files (new or changed) |
|---|---|---|
| **1. Read API** | `GET /api/catalog-transfer/readiness/families` (filters, search, page size 50/100/200, worst-first order, tile counts, photo from `ProductReadCache.imageUrl`). `GET …/families/:rootId/members` (10 preview + total). `GET …/detail` (problems per market and language, true issue kind). Reuses `listingReadinessWhere()` so filters match Translate. | `apps/api/src/services/pim/listing-readiness-families.service.ts` (new) + test; `apps/api/src/routes/catalog-transfer.routes.ts`; `packages/shared/listing-readiness.ts`; fix the dropped `kind` in `listing-readiness.service.ts` |
| **2. Live event** | Declare `readiness.updated`; publish it after each family rebuild; let the stream carry it; map it in the web invalidation channel. | `packages/events/catalog.ts`; `apps/api/src/services/pim/readiness-index.service.ts`; `apps/api/src/routes/listings-syndication.routes.ts` (stream filter only, if needed); `apps/web/src/lib/sync/*` + tests |
| **3. Page** | Rebuild the page on `NexusGrid` (server rows, tree, `IdentityCell`, `ExpandButton`, `SkuTag`, `MetricStrip`, `FilterBar`, `GridToolbar`, `GridDensityToggle`, `PreferencesModal`, `GridViewsMenu`, `GridPager`, `Pill`). New market-chip cell and the Fix window. Move the family footer frame into the DS so Products and Listings share it (Products looks the same). | `apps/web/src/app/products/listing-readiness/*`; `apps/web/src/design-system/grid/…` (footer + chip cell, mirrored to `apps/factory/src/design-system`, `CHANGELOG.md`); `apps/web/src/app/products/next/FamilyFooter.tsx` (uses the DS frame); `en.json` + `it.json` |

**Not in scope:** the `/listings` pages, the Products page behaviour, Publish, any marketplace call, the old branch.

## 5. Checks (LOCAL FIRST — LIGHT), then PR

| Check | Command |
|---|---|
| Types | `npm run typecheck -w @nexus/api`, `-w @nexus/web`, `-w @nexus/shared`, `-w @nexus/events` |
| API tests | `cd apps/api && npx vitest run src/services/pim/listing-readiness` (+ the event test) |
| Web tests | `cd apps/web && npx vitest run src/app/products/listing-readiness src/lib/sync` |
| DS guards | `node scripts/check-raw-primitives-ratchet.mjs --check`, `node scripts/ds-conformance-guard.mjs --check`, `node scripts/check-ds-fork-drift.mjs` |
| Browser (big screen change) | local API + local database, `NEXT_PUBLIC_API_URL` set; light + dark, phone + desktop, keyboard only; Products page unchanged |

Then one PR from a worktree branch. **The merge waits for "Merge #N" from the Owner.**

## 6. What was built (23 October 2026)

Four parallel parts, then one integration pass by the lead.

- **Read API** — `listing-readiness-families.service.ts`: families, members (`limit` + `offset`), detail. Two passes: light
  columns for every filtered row (tiles, order, paging), problem counts in SQL for the requested page only. The old
  endpoint now says the true issue kind (it said `missing` for everything).
- **Live event** — `readiness.updated` (`{ rootProductId }`) declared in `packages/events/catalog.ts`, published after
  commit at the end of every family rebuild and when families are marked pending. It rides the existing
  `GET /api/listings/events` stream. The Products page does not refetch on it.
- **Page** — `ListingReadinessClient.tsx` on `NexusGrid` (server rows, tree), the Products page's frame and parts.
- **Fix window** — `FixDialog.tsx`, a DS `Modal`. **Shared footer** — `FamilyFooterFrame` moved into the DS (web +
  factory mirror); Products' footer renders through it with the same markup.

Changes made during the browser check, beyond the plan's sketch:

- **Markets are grouped by store.** One line per store ("Amazon", "eBay · motovento") with short market chips
  ("DE · 72"); Shared and market-less stores (Shopify, Etsy…) share the first line. The plan's one-chip-per-market
  cloud was about 25 chips per row on real data — hard to read. The Fix window's market switcher uses the same lines.
- **The family footer counts variations only** ("Showing 10 of 20 variations"). The parent's own listing shows first
  and does not cost a variation (the preview asks for 11 rows).
- **Phone:** AG Grid hides a flex column for good when the pinned columns fill the grid. Markets therefore has a fixed
  width below a 640px grid, and a saved layout is read without its `flex` (`marketsWidth.ts`).
- **Header words:** "4,459 listings on 12 markets · checked just now"; the toolbar counts rows ("42 products").
- The Fix window says "21 listings, all blocked" / "21 listings: 18 blocked · 3 ready".

Proven in the browser (private stack, loopback only, no outbound network): light and dark, desktop and 390px phone,
keyboard (Enter into a cell, Tab between chips, Enter opens Fix, Escape closes and returns focus), tiles, search,
fold-open + footer, Fix window + "Open field" (lands on the exact studio field), and live refresh: a readiness rebuild
of 42 families refreshed the open page by itself through the event stream, with the tab in the background.

Known and left as they are:
- Some stored problem messages read oddly ("de content is missing; showing it fallback.") — that is the producer's text.
- A dev-only AG warning (#3) when the density changes: `NexusGrid` resets row heights and Markets is `autoHeight`.
- `ds-conformance-guard.mjs --check` fails on `origin/main` itself (section `design`, tailwindType 127 → 128), not on
  this work.
