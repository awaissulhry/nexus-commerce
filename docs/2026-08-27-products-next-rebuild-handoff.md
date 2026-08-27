# `/products/next` rebuild — handoff for parallel sessions

**Written 2026-08-27 by session `nexus-commerce-30`.** Read this before touching anything under
`apps/web/src/app/products/next/` or `apps/web/src/design-system/`.

> 🔴 **Who owns what.** `nexus-commerce-30` is the products session. It is rebuilding
> `/products/next` and has **~32 files uncommitted in the shared working tree** (§2). If you are
> reading this and you are NOT `nexus-commerce-30`, those files are someone else's — check with
> `ListAgents` if you are unsure which session you are.
>
> An earlier draft of this document said "this session owns…", which every reader correctly read
> as *themselves*. A peer session read it, concluded it was the products session, and broadcast the
> ownership claim onward. Ownership is stated by NAME below for that reason.

This document exists so a second session can move fast without colliding with `nexus-commerce-30`.

---

## 1. The one thing that matters most

**Six sessions share ONE working tree and ONE `main`.** An uncommitted file is another session's
work in progress, not a stale artefact. The failure mode is real and has happened: a session ran
`git commit --only <file>` and captured another session's half-finished code, and Railway went red
because the pre-push hook builds the **working tree**, not the commit.

So:

- **Never `git checkout --` or revert a file you did not edit.**
- **`git commit -- <paths>` commits the WORKING-TREE version of those paths** — including any
  hunks another session has in flight in the same file. Only use it on files that are wholly yours.
- Before committing, run `git status --porcelain` and confirm every path in your commit is one you
  actually touched.
- `python`'s `str.replace(a, b)` replaces **all** occurrences, not the first. That silently edited
  an unrelated endpoint during this session; `tsc` caught it. Anchor edits on unique context.

---

## 2. 🔴 Files `nexus-commerce-30` owns — do not edit

Everything below is uncommitted and being actively worked **by `nexus-commerce-30`**. Reading is
fine. Editing collides. Message that session (`SendMessage` → `nexus-commerce-30`) if you need a
change inside one of them.

```
apps/web/src/app/products/next/**            (ProductsNextClient.tsx, TagDialog.tsx,
                                              styles.module.css, InventoryEditorModal.tsx,
                                              LocationQtyInput.tsx, ProductsSkeleton.tsx,
                                              inventoryEditor.logic.ts, products-next-shell.css)
apps/web/src/app/products/_types.ts          (ProductRow gained `sales`)
apps/web/src/app/_shared/grid-lens/Thumbnail.tsx

apps/web/src/design-system/components/DataGrid.tsx
apps/web/src/design-system/components/MetricStrip.tsx
apps/web/src/design-system/components/CoverageSummary.tsx      (new)
apps/web/src/design-system/primitives/Pill.tsx
apps/web/src/design-system/primitives/ColorSwatchPicker.tsx    (new)
apps/web/src/design-system/styles/{components,primitives}.css
                                             (NOT patterns.css — see below)
apps/web/src/design-system/{components,primitives}/index.ts
apps/factory/src/design-system/**            (mirrors of the above)
.claude/DS-GAPS.md
```

**`DataGrid.tsx` is the highest-collision file in the repo right now** — it gained four things
today (`prefsLocked`, `subRowSelectable`, `prefsSortFields`, `knownColumns` persistence) and
several other grids consume it.

### Adjacent, NOT owned — but changed today by `nexus-commerce-30`

`design-system/patterns/PreferencesModal.tsx` and the `.nds-prefs-*` block in `styles/patterns.css`
are **clean and free to take**, but they are not virgin. My changes to them were swept into
commit `e77497413` (a reporting session's commit, via `git commit -- <path>` taking working-tree
content), so they carry work you will not find under my name:

- `hasLeftPanel` — the dialog collapses to ONE column when every left-panel section is off.
- `size={hasLeftPanel ? 'xl' : 'md'}` — the width follows the layout. Without it the single-column
  case stretched one-word column names across 884px with ~748px of gap. Keep width tied to
  structure or that returns.
- `.nds-prefs.single` in `patterns.css` is the matching rule.

🔴 `PreferencesColumnSpec.locked` must stay honoured: a locked column must never become removable.
`/products/next` locks Product and Actions via `prefsLocked` (locked in the dialog WITHOUT being
pinned sticky, because sticky was explicitly not wanted). Make it removable and that page loses its
Product column.

Blast radius if you rework it — **this list was wrong in an earlier revision of this doc; the
numbers below are re-derived with `grep -a` and by resolving each import to its actual source.**

**There are TWO PreferencesModals.** Anything that says otherwise is guessing:

| | file | shape |
|---|---|---|
| DS | `design-system/patterns/PreferencesModal.tsx` | the real one, `--nds-*` |
| legacy fork | `app/_shared/grid-lens/PreferencesModal.tsx` | 416 lines, its own DOM, **0** `--nds-*` tokens, Tailwind throughout |

- **Direct DS consumers — 3**: `WorkspaceGrid.tsx`, `CampaignsGrid.tsx`, `SectionControls.tsx`.
- **Indirect — 25 files** pass `customizable` to `DataGrid`, which imports the DS modal at
  `DataGrid.tsx:8`. Mostly the ads console, plus `fleet/*`, `fulfillment/stock/*`,
  `pricing/volume-pricing`, and `/products/next` itself.
- **NOT affected — 6 files** that look like consumers and are not: `ProductsWorkspace`,
  `ListingsWorkspace`, `PricingMatrixClient`, `StockWorkspace`, `ReplenishmentWorkspace`,
  `PurchaseOrdersClient`. All six import the **legacy fork** via `@/app/_shared/grid-lens`.
  Changing the DS modal does nothing to them. (`ProductEditClient` is a third thing again — its
  own `TabPreferencesModal`.)

**Why the earlier list was wrong, and why yours will be too if you use plain `grep`:**
`WorkspaceGrid.tsx` contains a raw `U+0000` byte at line 470 (a `join()` separator written as a
literal control character instead of `'\u0000'`). `file(1)` therefore calls it `data`, and **grep
silently skips the whole file** — 0 hits where `grep -a` gives 4. Six files in `apps/web/src` are
invisible this way. Always audit with `grep -a`. See §6.7.

Credit: `nexus-commerce-53` caught the miss; verified independently here.

---

## 3. What is already on production

Three API commits are **deployed** (`/api/health` → `build`). The web app is **not** — all UI work
is local until the operator says otherwise.

| commit | what shipped |
|---|---|
| `e3bfe114d` | `GET /api/products` → `includeSales` + `salesDays`, `sales{units,revenueCents,days}` per row, `salesUnattributed` on the envelope |
| `0c6245f60` | `bulk-tag` → `includeChildren`, set-at-a-time writes; `PATCH /tags/:id` no longer wipes colour |
| `157c94056` | `bulk-status` / `bulk-soft-delete` / `bulk-duplicate` → `includeChildren`; duplicate now keeps `isParent`/`parentId` |

Verify with `curl -s $API/api/health | jq .build` — it is the short commit SHA.

---

## 4. Traps found the hard way (each cost real time)

**The two-relation trap.** `Product` has `children` (the real variation hierarchy, populated) and
`variations` (`ProductVariation[]`, empty). `products.routes.ts` filled `variantCount` from
`_count.variations`, so the grid's "N variations" label was gated on a field that is always 0 and
never rendered — while the expand chevron, reading `childCount`, worked fine. **A field existing is
not a field having data.** Check fill rates before building on any column.

**`ProductProfitDaily` is Amazon-only.** Its `marketplace` column holds `IT/DE/FR/ES` — Amazon
*countries*, not channels. Anything sourced from it and labelled "Sales" silently excludes eBay and
can never include a channel connected later. Order/`OrderItem` + `Order.channel`
(`AMAZON|EBAY|SHOPIFY|WOOCOMMERCE|ETSY|MANUAL`) is the channel-agnostic source.

**Sales attach to CHILDREN, never parents.** Every `ProductProfitDaily` and `OrderItem` row hangs
off a variation. Any per-product figure on a grid of parents must roll up, or it renders 0.00 on
every row.

**Bulk endpoints return HTTP 200 for PARTIAL failure.** `bulk-status` sends
`{ok:false, updated:3, errors:[...]}` with a 200. Checking `res.ok` alone shows a green success
toast over rows that never changed. Read the body.

**The ETag round-trip is dead cross-origin.** The API sets `ETag` but does not list it in
`Access-Control-Expose-Headers`, so `res.headers.get('etag')` is `null` in the browser and
`If-None-Match` is never sent. Every poll is a full 200. Two consequences: (a) data is genuinely
fresh; (b) **if anyone exposes that header or moves the API same-origin, staleness appears
immediately** — the ETag is `count · max(Product.updatedAt) · filter-hash`, so it does not notice a
new Order, and its `filterContext` omits `salesDays`, so one window's numbers would be served under
another window's label.

**`DataGrid` prefs could not persist a hidden column.** `visibleColumns` records only what is
visible, so a hidden column and a not-yet-shipped column were indistinguishable, and the
reconciliation re-appended every hidden column on load. Fixed by also persisting `knownColumns`.
Prefs written before that field fall back to the old behaviour.

**Amazon image URLs do not self-size.** A bare `m.media-amazon.com/images/I/<id>.jpg` serves the
full-resolution master — measured 2560×2560 into a 56×56 box. Size lives in the filename
(`<id>._SL112_.jpg`). Cloudinary was already handled; Amazon was not.

**The DOM can contain the PREVIOUS route.** `next.config.ts` sets
`experimental: { staleTimes: { dynamic: 180 } }`, so after a client-side navigation the App Router
keeps the previous dynamic route mounted under a `display:none` container at body level for three
minutes. Measured on `/products/next`: a hard load gives 1 `.nds-fpanel` / 2 `.nds-range` / 1
`.nds-grid`; navigate to `?parent=…` and back and it is **2 / 4 / 2**, the extras all 0×0 inside the
hidden container. It looks exactly like a double render and is not one. **Scope every DOM probe to
the visible instance** — filter on `getBoundingClientRect().height > 0` — or hard-reload first. Two
sessions have now lost time to this independently.

**A focus ring is unreadable while the document is unfocused.** Found by `nexus-commerce-c3`,
re-measured here. Focus an input, background the tab, and the control paints its RESTING state —
border `rgb(216,221,228)`, `box-shadow: none` — while `document.activeElement` is still that input.
A probe run in that state reports a working focus ring as broken. **Gate on `document.hasFocus()`:
if it is false, every focus-dependent measurement is void — click into the page first.**
🔴 c3 additionally reported that `matches(':focus-within')` stays `true` while unpainted, which
would make it a way to tell "focused but unpainted" from "not focused". That did NOT reproduce
here: both went false together, on the inner box and the outer wrapper. Do not rely on it. (A
clean control reading was not obtainable — running JS against a tab appears to focus it, so the
state moves under the probe; that is itself worth knowing.)

**Browser probes lie in specific ways.** A dev-server log can replay a browser's *old* errors on
reconnect (a stale `hasLeftPanel` error looked live). A poll loop that treats "couldn't parse" as
"changed" reports success falsely. `git push` can print `! [remote rejected]` and still land —
verify with `git ls-remote origin refs/heads/main`, never the exit code.

---

## 5. Conventions this rebuild follows

- **Design system first.** Anything new goes in `apps/web/src/design-system/`, `--nds-*` tokens
  only, and is mirrored to `apps/factory/` (the fork-drift guard blocks pushes otherwise —
  `cp` is right for `.tsx`, but **never** for the shared CSS files; they are stale in factory and a
  copy drags hundreds of unrelated lines across. Patch just your block).
- **Gaps get filed** in `.claude/DS-GAPS.md` with the measurement, not just the complaint.
- **Measure, don't assert.** Every contrast ratio, row height and pixel offset in the code comments
  was computed. One comment in `ColorSwatchPicker` was wrong on first write and says so.
- **Distinguish "not asked" from "measured zero".** `sales: null` (not requested) renders nothing;
  `revenueCents: 0` renders a muted dash with a tooltip saying no sales in the window.
- **Verify before claiming.** `tsc` on both apps plus the guard suite; anything user-visible gets
  checked in the browser, not inferred from the diff.

---

## 6. Work a parallel session can take safely

These do **not** touch the files `nexus-commerce-30` owns above, and are yours to take.

1. **`bulk-status` is slow — 7.3s for a 41-product no-op.** It calls `masterStatusService.update`
   once per id inside a transaction. `bulk-tag` was converted to `createMany`/`deleteMany`; this
   one needs the service reworked to batch its audit-log / listing-cascade / sync-queue writes.
   Owner: `apps/api/src/services/master-status.service.ts`. High value, self-contained.

2. **Tag management UI** — rename / recolour / delete. The API already supports all three
   (`PATCH`/`DELETE /tags/:id`, and `GET /tags` returns `productCount`). 🔴 The `Tag` model is
   shared by `ProductTag`, `OrderTag` and `AssetTag`, so deleting a tag removes it from orders and
   assets too — any delete flow must say so. Would live in a new file; coordinate before editing
   `TagDialog.tsx`.

3. **`variantCount` is dead API-wide.** `products.routes.ts` fills it from the empty relation, and
   `sortBy=variants` orders by `Product.variantCount`, a `@default(0)` column that is never written.
   Every consumer of that field is showing 0. Either fill it from `_count.children` or retire it.

4. **`OrderItem.productId` is NULL on real sales** — €949.95 over 90 days, and **all four eBay
   orders**. The grid surfaces this as a banner; the underlying linkage gap in order ingest is
   unfixed and belongs to whoever owns order sync.

5. **eBay and Shopify image sizing.** `Thumbnail` now sizes Cloudinary and Amazon. eBay encodes size
   in the filename (`s-l500.jpg`) and Shopify takes `?width=`. Neither was measured — **measure
   first**; writing a transform from documentation is how the old comment came to be wrong.

6. **`PreferencesModal` sort section.** `DataGrid customizable` hard-codes `sortFieldOptions={[]}`;
   a `prefsSortFields` pass-through already exists on `DataGrid` for this. Other grids may want it.

7. **Six source files are invisible to plain `grep`.** Each embeds a raw `U+0000`/`U+0001` control
   byte as a `join()` / key separator, written as a literal byte instead of the escape. `file(1)`
   calls them `data`, so `grep` skips them **without a word of warning** — every name-based audit
   run through the shell is unreliable until this is fixed.

   **Scope, measured — this does NOT affect the ratchets.** Every guard in `scripts/` reads via Node
   `readFileSync`, which is byte-agnostic; `file(1)`/`grep` binary detection never applies. Verified
   by instrumenting `readFileSync`: `ds-conformance-guard.mjs` reads both binary files that sit
   inside its scope. `WorkspaceGrid.tsx` is unscanned by the two `.tsx` guards for a separate and
   deliberate reason — `design-system/**` is exempt (`check-raw-primitives-ratchet.mjs:24`, "it IS
   the design system"; `ds-conformance-guard.mjs:28` roots at `apps/web/src/app`). **Fixing these
   bytes will not move any baseline.** The cost is confined to manual and agent-run `grep` — which
   is exactly where it landed.

   | file | byte | line |
   |---|---|---|
   | `design-system/patterns/workspace-grid/WorkspaceGrid.tsx` | `U+0000` | 470 |
   | `app/products/[id]/datasheet/variantAxes.ts` | `U+0000` | 44, 52 |
   | `app/marketing/ads-console/rank/rank-grid-model.ts` | `U+0001` | 36, 107 |
   | `app/marketing/ads/rules-automation/_rank/rank-grid-model.ts` | `U+0001` | 36, 107 |
   | `app/fulfillment/stock/import/ImportClient.tsx` | `U+0001` | 272 |
   | `app/products/ebay-flat-file/VariationValueOrderModal.tsx` | `U+0001` | 45 |

   **The fix is lossless and behaviour-identical**: replace the raw byte with `'\u0000'` /
   `'\u0001'`. Verified — `["a","b"].join("<raw NUL>") === ["a","b"].join("\u0000")` is `true`,
   and the file flips from `data`/0 grep hits to `ASCII text`/1 hit. The separators themselves are
   good design (a NUL genuinely cannot occur in an attribute value); only the *encoding* is the
   problem. **Not done here** — five of the six belong to other sessions' territory. Whoever picks
   this up should do all six at once, or the trap stays.

   **When you verify a mirror by extracting a block from two files, assert the extraction is
   non-empty before trusting the `diff`.** `nexus-commerce-c3` piped one through `head -n -1`, which
   BSD `head` rejects — both extractions came out EMPTY, `diff` found no difference, and the probe
   printed "IDENTICAL". A clean pass off two empty files. A miss and a match look the same when the
   instrument produced nothing.

   Find them again with:
   `find . -name '*.ts*' -exec sh -c 'file -b "$1" | grep -q data && echo "$1"' _ {} \;`

---

## 7. Environment

- Dev server: `cd apps/web && NEXT_DEV_ISOLATED=1 npm run dev` — **the flag is not optional.**
  Without it the pre-push hook's `rm -rf .next && next build` deletes the running server's output
  and every route 500s. Isolated builds go to `.next-dev`.
- The local web app talks to the **production** API. Bulk actions from `/products/next` are live
  writes.
- **Do not boot `apps/api` locally** to test an API change. `src/index.ts` starts **92 ungated
  crons** against the production database — including `startReviewMailerCron` (outbound email is
  live), `startPurgeSoftDeletedCron`, `startAutoPoCron` and channel writers like
  `startAmazonQtyReadbackCron`. Only 25 are behind `NEXUS_ENABLE_*` gates. Use a read-only probe
  script (`apps/api/scripts/_*.mts`, `import '../src/env.js'` then `import('../src/db.js')`) and
  delete it when done.

---

## 8. Known-open, deliberately

- `AIR-MESH-JACKET-MEN` is `INACTIVE` with all 6 variations differing — pre-existing drift. The
  cascade fix prevents new drift; it does not repair this. One click of **Inactive** reconciles it.
- `Pill tone="success"` renders **blue** (`--nds-pill-success-bg: #d2e6fc`) in both themes, by
  design across 32 call sites. `/products/next` no longer overrides it.
- `.h10-open` is referenced by `ads/ebay/products/EbayProductsRollup.tsx:160` and **defined
  nowhere** — that Open pill is unstyled. Different page, untouched.
