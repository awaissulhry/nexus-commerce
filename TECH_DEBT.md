# Tech debt

Outstanding issues identified but deferred for later. Each entry should explain the symptom, where it surfaced, what we worked around, and the suggested proper fix.

## Priority legend

- 🔴 **P0** — user-facing bug or risk that blocks real use; tackle next
- 🟡 **P1** — annoyance that hurts the product but isn't blocking; backlog
- 🟢 **P2** — nice-to-have or polish; only when actively in the area

Triage performed 2026-05-02 after the /products rebuild and the schema-drift incident. Re-triage once real Xavia usage exposes which items actually bite.

---

## 0. 🔴 Bug class: Schema-migration drift (process gap)

**Symptom:** A Prisma model exists in `schema.prisma` but no migration creates its Postgres table. `prisma generate` happily produces TypeScript types for the model, so `apps/web` and `apps/api` compile clean, route handlers pass typecheck and CI — and then crash at runtime the first time anyone hits the relation.

**Surfaced at:** `/products` rebuild. The catalog list 500'd with `The table public.Image does not exist in the current database` because `products.routes.ts` selected the `cloudImages` relation, which points at a `Image` model added in "Phase 31" that was never `prisma migrate dev`'d. Real catalog has 9,756 rows; users saw an empty page.

**Workaround applied:** Switched the select to the `images` relation (`ProductImage` table — has been in DB since 2026-04-22). Fix is one line; the bug class is the worry.

**Other code paths still at risk** (verify before next deploy that touches them):
- **Phase 5.4 GTIN exemption wizard** — entry #8 below explicitly says it "reads the master product's existing images via the `Image` model." Same crash will land the moment a user opens that wizard. **This is the P0 follow-up.**
- Anywhere else in the codebase that references the `Image` Prisma model. Quick check: `grep -rn "prisma\.image\.\|\.image\b" apps/`.

**Proper fix — three options, ordered by effort:**

1. **Drop the orphaned model.** Remove the `Image` model + `cloudImages` relation from `schema.prisma`, sweep all referring code to use `ProductImage`. Keeps the schema honest. Lowest risk if no one needs the extra Image columns (`dominantColor`, `assignedVariants`, `isHero`, `storageMetadata`, etc.).
2. **Write the missing migration.** Generate a `CREATE TABLE "Image"` migration that matches the schema and ship it. Preserves the Phase 31 design, but you inherit a feature that nobody's exercised.
3. **Both:** drop the model now (option 1), revisit the Phase 31 image-management design when it's actually needed.

**Process fix to prevent recurrence** — pick at least one:

- **CI gate:** `prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --exit-code` fails the build if `schema.prisma` describes anything not in a migration. Single command, single env var, blocks the entire failure mode.
- **Post-deploy smoke test:** hit each list endpoint (`/api/products`, `/api/orders`, `/api/listings`, …) and assert non-500 + non-empty JSON shape. Catches schema drift, missing env vars, and a few other deploy-time gotchas in one go.
- **Pre-commit check** (lighter): `prisma migrate status` in the pre-push hook (already runs builds — adding one more check is cheap).

A CI gate is the right answer; the post-deploy smoke test is the belt-and-braces version.

---

## 1. ✅ `@fastify/compress` empty-body bug on `/api/orders` list — resolved 2026-05-05 in D.8

The /orders rebuild (D.2) replaced `reply.status(200).send(...)` with `return { ... }` and explicitly coerces every Prisma `Decimal` to `Number` before serialization. The empty-body workaround (`Accept-Encoding: identity`) has been removed from the client. If this regresses, the symptom is the legacy Decimal-with-compress interaction — re-add the coercion.

## 1.legacy ✅ `@fastify/compress` empty-body bug on `/api/orders` list — superseded by entry #1, kept for history

**Symptom:** `GET /api/orders?page=...&limit=...` returns `200` with `content-encoding: gzip` and `content-length: 0` (empty body) when the client requests gzip. The same payload returns 6+ KB of JSON when `Accept-Encoding: identity` is sent.

**Surfaced at:** Vercel SSR of `/orders` 500'd because `await listRes.json()` saw an empty string.

**Other endpoints affected:** Just this one as far as we've verified. `/api/orders/stats`, `/api/categories/schema`, `/api/products/bulk-fetch`, `/api/pim/fields` all compress correctly. The orders list is also the only route that hands a Prisma result with nested `items` + Decimal `totalPrice` straight into `reply.send()`.

**Workaround:** `apps/web/src/app/orders/page.tsx` requests `Accept-Encoding: identity` on the list call and parses defensively.

**Proper fix:** Reproduce locally with `curl --compressed`, then either:
- Disable global compression and opt-in per route, or
- Change the orders route to `return { … }` instead of `reply.status(200).send(…)` and verify, or
- Pin or upgrade `@fastify/compress` and add a regression test.

## 2. ⏸ Prisma direct calls from Next.js server components — moot on Railway, deferred 2026-05-08

**Status update:** This was a Vercel SSR / edge-runtime issue. We deploy `apps/web` to Railway as a long-running Node process, where Prisma works the same way it does in `apps/api`. The Vercel 500s described in the original entry don't reproduce on Railway and we're not deploying to Vercel.

**Affected pages (verified 2026-05-08):** ~10 server components still `import { prisma } from '@nexus/database'` (settings/{account,profile,api-keys,notifications}, products/[id], catalog/{[id]/edit,drafts}). Each works fine on Railway.

**Architectural concern still valid:** The web tier reaching into the DB skips API-level concerns (auth, rate limiting, cache headers, audit logging). When/if we need any of those uniformly, the sweep becomes load-bearing. Until then, no operator-visible impact.

**Reopen criteria:**
  • Adding Vercel as a deployment target.
  • Adding auth that needs to gate DB access centrally.
  • Adding cross-tenant data scoping that needs middleware.

Entry stays in TECH_DEBT for tracking; not actively pursued.

## 3. ✅ Out-of-scope orphan routes — resolved 2026-05-06

**Resolution:** Each orphan now redirects to the canonical surface — server-side `redirect()` from `next/navigation`, so any external link or bookmark lands on the live page instead of a 4xx/5xx.

| Route | Resolution |
|---|---|
| `/logs` | Redirects to `/sync-logs`. The original Prisma-in-server-component page deleted along with its `SyncLogDetails` companion. |
| `/monitoring/sync` | Redirects to `/dashboard/health` (canonical sync-health surface — Cron / StockDrift / Conflicts / Vitals / SystemLogs panels). |
| `/settings` (root) | Redirects to `/settings/account` (the sidebar's "Settings" link target). |

## 4. ✅ `CategorySchema` `schemaVersion='unknown'` orphans — resolved 2026-05-08

**Resolution:** Migration `20260508_p2_4_cleanup_categoryschema_unknown` purges the residual orphans (1 row at audit time). Idempotent — the WHERE clause is specific to `schemaVersion = 'unknown'` so repeat applies stay no-ops if a future regression reintroduces orphans.

## 5. ✅ Bulk-ops paste: scrolled-out cells don't show yellow tint — resolved 2026-05-08

**Resolution:** Added `pendingValues: Map<string, unknown>` to `EditCtx`, derived from the parent's `changes` Map (same source the save flush reads). `EditableCell` accepts a new `pendingValue?` prop and seeds `draftValue` via `useState(() => pendingValue !== undefined ? pendingValue : initialValue)`. When a virtualised-out cell re-mounts on scroll-back, the lazy initialiser picks up the pending value, `isDirty = !shallowEquals(draftValue, initialValue)` evaluates true, and the yellow tint renders on first paint.

Memo comparator unaffected — re-renders still gated on rowId/columnId/initialValue identity; the pendingValue lookup happens inside the cell renderer at the existing module-ref read site.

**Original symptom (kept for context):** Paste targeting virtualised-out cells wrote into the changes Map but the unmounted EditableCell couldn't seed its draftValue. On scroll-back the cell mounted with initialValue, `isDirty` evaluated false, no yellow tint — purely cosmetic since the save still flushed the change.

## 6. ✅ SheetJS (`xlsx`) CVE-2023-30533 — resolved 2026-05-08 in M.12

**Resolution:** Both call sites swapped to `exceljs` (MIT, actively maintained):

  • `apps/api/src/services/products/bulk-upload.service.ts` — `parseUploadBuffer` is now `async`, uses `ExcelJS.Workbook().xlsx.load(buf)`, builds the same `Record<string, string>[]` shape via header-row + per-row `eachCell` iteration. The lone caller in `products.routes.ts` was updated to `await` the call.
  • `apps/web/src/app/inventory/upload/page.tsx` — same swap on the FileReader.onload path; handles formula `result`, hyperlink `text`, and rich-text `richText` cell shapes that `xlsx.utils.sheet_to_json` previously flattened automatically.

`xlsx` removed from both workspace package.json files. Bundle size impact: exceljs is ~2× xlsx but only loaded on the upload pages (not the hot path). Trade-off accepted to close the CVE.

**Trade-off:** Drops `.xls` (legacy BIFF) support — `exceljs` is `.xlsx`-only. Both call sites detect the extension and emit a clear "Please re-save as .xlsx" error pointing the operator at the fix. Modern spreadsheet tools have been emitting `.xlsx` by default for over a decade so this is a near-zero practical regression.

**Original symptom / risk:** `xlsx` 0.18.5 (the npm version) carries CVE-2023-30533 (prototype pollution via crafted .xlsx). The maintainer moved fixes to the SheetJS CDN/commercial track at 0.20+; the npm distribution stayed vulnerable. Mitigations were in place (auth-only path, 50 MB / 50K-row caps, downstream field-registry validation prevented attacker-controlled keys reaching Prisma) but the right fix was always to swap libraries.

## 7. 🟢 D.5.5: ZIP upload — image handling, channel overrides, variants

Deferred from D.5 v1. Three feature areas, each with open design questions that need a sit-down with the user before implementation.

**Images** (`<SKU>/images/*.{jpg,png,webp,…}`)
Open questions:
- Storage backend: Cloudinary is the only viable option (Railway / Vercel local FS is ephemeral). Need to verify the Cloudinary product-image path is wired and produces working `Image` / `ProductImage` rows.
- Replace vs append: does an upload of `images/main.jpg` *replace* the product's existing main image, or append to a gallery? Probably replace based on filename slot (main, alt-1, …) but spec needs confirming.
- Per-product limit (Amazon allows 9, eBay allows 12).
- MIME validation + EXIF stripping (privacy).
- Failed upload recovery: one bad image fails the product, or skip with a warning?

**Channel overrides** (`<SKU>/channels/<channel>-<marketplace>.json`)
Marketplace-specific titles / descriptions — would map to `ChannelListing` rows. Clean to design, but interlocks with the multi-marketplace work in D.3d, so worth doing once the patterns there are stable.

**Variants** (`<SKU>/variants.csv` or `<SKU>/variants/`)
Each row a child variation. Has the same "create new product" can-of-worms as D.4.5 — productType, parent linking, image inheritance — so likely waits until D.4.5 is shipped and we know the pattern.

For all three: the v1 ZIP parser already surfaces them as preview warnings ("12 image files in 3 folders ignored — coming in D.5.5"), so users get a graceful fail-soft rather than silent drop or hard error.

## 8. 🟢 Phase 5.4 — image upload from inside the wizard

**Crash-risk hypothesis was wrong.** Verified 2026-05-02: the GTIN-exemption wizard's image validator path was already on the correct relation (`prisma.product.findMany({ select: { images: { select: { url: true } } } })` in `gtin-exemption.routes.ts`) — `images` is `ProductImage`, not the orphan `Image` model. Live test against the existing Xavia DRAFT (`POST /api/gtin-exemption/cmooff80g0000mx01pn0ijngl/validate-images`) returned 200 with the expected empty validation set. No change needed.

The orphan `Image` model + its dead-code service (`image.service.ts`) + Express dead-code route (`routes/images.ts`, never wired into Fastify) were deleted in the same P0 #8 commit (~1,213 lines removed). The `cloudImages` relation came off `Product`. Schema is now consistent — drift gate shows 44 models, all with migrations.

**Remaining UX work** (now P2): an upload-from-wizard control inside Step 2 that adds images directly to the product (via a real image upload pipeline once Cloudinary is verified — see TECH_DEBT entry on D.5.5). Re-runs validation automatically after each upload. Currently the user has to add images on the product edit page and re-run validation by hand — awkward, not blocking.

## 9. 🟢 Phase 5.4 → Phase 6 — vision-based image checks

The v1 image validator is rule-based: dimensions (≥ 1000×1000), format (JPG/PNG), file size (> 20KB). All three are real reasons Amazon rejects exemption applications, but not the only ones — Amazon also looks at logo/watermark presence, brand visibility, white-background quality, and "lifestyle vs product" framing. These need a vision model.

**Deferred to Phase 6** when we have Gemini Vision or similar wired:
- Logo / watermark detection — flag images Amazon will reject
- Brand-name OCR + visibility scoring — confirm brand is on product or packaging in ≥ 3 images
- Main-image background analysis — RGB sampling at corners + edge-detection for "is this really pure white"
- Multi-angle coverage detection — make sure the 9 images aren't 9 of the same angle

## 10. 🟢 Phase 5.4 → implicit-approval detection

Right now the user manually clicks "Mark as approved" after Amazon's email arrives. We could detect approval implicitly: when a future product listing on this marketplace succeeds with `external_product_id_type: 'EXEMPT'`, the brand is provably cleared. Auto-flip the matching `GtinExemptionApplication` row to APPROVED.

**Deferred** until we wire the listing-publish path (Phase 6 step 10).

## 11. 🟢 Phase 5.4 → AI-driven rejection-fix loop

When the user marks an application REJECTED and pastes Amazon's email, we could parse the rejection reason with an LLM and:
- Suggest specific image replacements / brand-letter rewrites
- Offer "Regenerate package with fixes applied"
- Track which rejection patterns Amazon hits us with most often

**Deferred** to the same Phase 6 work that adds the vision model + LLM-based content generation in step 6.

## 12. 🟢 Phase 5.4 → email-forwarding inbox

Sellers could forward Amazon's approval / rejection email to a Nexus inbox; we extract the case ID + outcome and update the application automatically. Avoids the manual "Mark as approved" click.

**Deferred** because it needs an inbound-email pipeline (SES / Postmark / Mailgun), which we don't have yet.

## 13. 🟢 Phase 5.5 → Phase 6 — multi-marketplace translation flow

v1 generates content for the wizard's current marketplace. The "generate IT once, translate to DE / FR / ES / UK / US in one pass and write each into ChannelListing" flow needs the publishing layer that lands in Phase 6 (steps 9 and 10). Spec'd but consciously deferred.

## 14. 🟢 Phase 5.5 → AI vs user-edit telemetry

Every AI generation could store its `aiVersion` next to the user's final value, so we can later measure: which fields the user edits most, how heavy the edits are, and whether quality drifts when product types change. Building the storage now is YAGNI — adding the diff log is a single migration + small client patch when we want the data.

## 15. 🟢 Phase 5.5 → quality scoring + brand-voice profiles

After generation, we could score the title / bullets / description against an Amazon-best-practices rubric (length, brand position, keyword density, …) and surface a percentage. We could also save the user's editing patterns per brand ("prefers terse bullets, no emojis, technical tone") so the next product matches without prompting. Both deferred until we have a quality team or rubric author to define the scoring.

## 16. 🟢 Phase 5.5 → A+ Content (EBC) generator

Beyond plain Amazon-safe HTML, sellers eventually want rich Amazon Brand Content — image-rich modules, comparison tables, brand storytelling sections. Ships with the publishing path in Phase 6.

## 17. ✅ /products → URL state for filters / search / sort / page — resolved (entry was stale)

**State as of 2026-05-08 verification:** the /products workspace already has full URL state, shipped incrementally across the F1/F10 phases. The entry was kept open because the doc was never updated.

`apps/web/src/app/products/ProductsWorkspace.tsx` reads:
- `lens` (grid view) · `page` · `sortBy` · `pageSize`
- canonical filter contract via `parseFilters(searchParams)` from `@/lib/filters` (search · status · channel · marketplace)
- per-page dimensions: `productTypes`, `brands`, `tags`, `fulfillment`, `stockLevel`, `missingChannels`, `hasPhotos`, `hasDescription`
- drawer state via `?drawer=<productId>` (F1)

The write side is `updateUrl(patch)` — a generic `Record<string, string | undefined>` → `router.replace(?next, { scroll: false })` patcher. Search input is debounced (~250ms) before pushing to the URL. Browser back/forward round-trips correctly because `router.replace` updates without a navigation entry.

No follow-up action.

## 18. ⏸ /products → bulk edit in place — punted to /bulk-operations 2026-05-08

**Status:** Operator path documented and supported. The /products page selection bar exposes Export CSV only; bulk edits route to the dedicated `/bulk-operations` grid which already has per-cell validation, optimistic updates, undo stack, and the rollback flow (M.13).

**Reopen criteria:** When operators say "I'm bouncing between /products and /bulk-operations and it costs me time" rather than "I want bulk edit on /products as a feature."

**Symptom (kept for context):** Bulk-edit-in-place is the obvious next feature but reusing the bulk-operations grid's machinery requires a refactor. Until that ROI clears, the dedicated bulk-ops surface owns the use case.

## 19. 🟢 /products → single-product create form

"New product" routes to `/bulk-operations#upload` for v1. A form-based one-product creator (SKU, name, brand, base price, initial stock, images) is a deferred design — the bulk-operations flow handles single-product paste fine, and the CSV / XLSX path covers everything else.

Worth designing once we have a clear "from scratch, no upload" use case (e.g. a brand owner adding a single SKU at a time).

## 20. ✅ /products → faceted search counts — partially resolved 2026-05-08

**Resolution:** Most filter axes already had counts (Status / Product type / Brand / Marketplace / Hygiene); they just weren't called out in this entry. M.22 closes the gap by adding `channels` aggregate to the facets response (top-level Product `syncChannels[]` unnested + grouped) and wiring the Channels filter group to render "AMAZON (3,200)" inline. Now every multi-select filter on /products carries counts on its options.

**Remaining (deferred):** Counts that respect *other* active filters (e.g., showing "DRAFT (47)" only counts products that also match the active brand filter). Today every count is unfiltered. This requires re-running the aggregate per filter combination. Not worth it until operators ask for it — the unfiltered counts already give "how many drafts do I have right now."

## 21. ✅ /products → API endpoint for products edit page — resolved 2026-05-08

**Resolution:** Added `GET /api/products/:id` in `apps/api/src/routes/products.routes.ts` (mirroring the legacy `/api/inventory/:id` shape — Decimal columns coerced to number for JSON safety). Switched `apps/web/src/app/products/[id]/edit/page.tsx:18` from `/api/inventory/:id` to `/api/products/:id`. The legacy `/api/inventory/:id` route stays in place for any remaining callers; can be removed once #23 (subroute migration) lands.

## 22. 🟢 /products → server-side sorting on derived columns

`sort` accepts `updated`, `created`, `sku`, `name`, `price-asc/desc`, `stock-asc/desc`. All of these map to literal columns. "Channel count", "image count", "days since last sync" — anything *derived* — would need either a generated column or a `Prisma.$queryRaw` with `ORDER BY` on a computed expression.

Not needed for v1 sort options; flag here so the next person adding a column knows the boundary.

## 23. 🟢 /inventory sub-routes → `/products/*`

Only the top-level browse page moved. `/inventory/upload`, `/inventory/manage`, `/inventory/fba`, `/inventory/stranded`, `/inventory/resolve`, etc. still live under `/inventory/*`. Breadcrumbs were retargeted to point back at `/products`, so the user-visible nav is consistent, but the URLs themselves are inconsistent.

**Proper fix:** rename each sub-route to live under `/products/*` (e.g. `/products/upload`, `/products/fba`). Each move is small but they touch deep links, server actions' `revalidatePath` calls, and the legacy `Sidebar.tsx`. Doing them one at a time as the relevant pages are next touched is fine.

## 24. 🟢 /inventory legacy components & types not deleted

`@/types/inventory`, `@/components/inventory/*`, and `@/app/inventory/manage/*` are still used by the surviving `/inventory/*` sub-routes. They will be untangled as those sub-routes get migrated (item 23). Don't delete eagerly — the new `/products` route imports its own types from `./ProductsClient` and is fully decoupled.

---

# Real-usage friction (2026-05-03, after Xavia migration started)

Items below come from the user's first day operating Nexus on the actual Xavia catalog. Validated demand — these aren't speculative.

## 25. ✅ Bulk-ops: undo across saves — resolved 2026-05-08 in M.13

**Resolution:** Cross-save undo lands via the existing `BulkActionItem.beforeState` capture (already wired in `processJob`) plus the existing `bulkActionService.rollbackBulkActionJob` method (which walks SUCCEEDED items and re-applies each `beforeState` through the master cascade — `MasterPriceService.update` for PRICING, `applyStockMovement` for INVENTORY, `product.update` for STATUS, `readProductAttribute` for ATTRIBUTE). M.13 wires the route and surfaces a Rollback button on every eligible job in `/bulk-operations/history`.

**Flow:**
  1. Operator runs a bulk PRICING_UPDATE / INVENTORY_UPDATE / STATUS_UPDATE / ATTRIBUTE_UPDATE.
  2. Each `BulkActionItem` row captures `beforeState` at apply time.
  3. Job lands COMPLETED or PARTIALLY_COMPLETED.
  4. From `/bulk-operations/history`, an amber "Rollback" button is visible on the job card. Click → confirm → `POST /api/bulk-operations/:id/rollback`.
  5. Service walks succeeded items, applies each `beforeState` back, creates a sibling rollback job (linked via `original.rollbackJobId`), and the cron worker drains the resulting outbound-sync queue.

**Guards:**
  - Job must be COMPLETED / PARTIALLY_COMPLETED (else 409)
  - `isRollbackable=true` and `rollbackJobId IS NULL` (else 409)
  - actionType in the supported set (else 409)
  - At least one SUCCEEDED item (else 409)

**Original friction:** "Wished I could undo last save (history clears on save)." — the in-grid undo stack only covered the current session. Now durable across saves and across sessions; only the rollback-job audit is consumed when an undo is run.

**Resolves entry #34a (rollback infrastructure) at the same time** — the rollback feature is one and the same.

## 26. ✅ Bulk-ops: drag-fill needs an Esc / cancel mid-drag — resolved 2026-05-06 in c672ff8

**Resolution:** Right-click cancel added alongside the existing Esc cancel; affordance hint pill ("Esc or right-click to cancel") follows the dashed extension rectangle so the cancel paths are discoverable during the drag.

**Original friction:** "Drag-fill went outside intended row, no easy way to cancel." Esc-cancel was already wired into the drag handler — the gap was discoverability and the missing mouse-driven path.

## 27. ✅ Listing wizard: AI title terminology drift ("Giubbotto" vs "Giacca") — resolved 2026-05-08

**Resolution:** `TerminologyPreference` table shipped (schema:850) keyed by `brand` + `marketplace` + `language` with `preferred` and `avoid[]` columns + free-text `context`. The four content-generation prompts (title / bullets / description / keywords) all inject a "Terminology preferences (STRICTLY FOLLOW — do not substitute synonyms)" block via `terminologyBlock()` in `apps/api/src/services/ai/listing-content.service.ts`. Wizard + ai-bulk routes pull entries with `OR: [{ brand: product.brand }, { brand: null }]` so global rules apply when product.brand is NULL (which is every Xavia row per DQ-5). Frontend admin at `/settings/terminology` exposes CRUD. Seed (7 rows) installed for IT marketplace: Giacca, Casco, Pantaloni, Pelle, Protezioni, Rete, plus a Giubbotto→Giacca rule. Re-verifiable via `node scripts/check-terminology.mjs`.

**Original friction:** "AI title was wrong — kept saying 'Giubbotto' when should be 'Giacca'." Concrete Xavia case: "Giubbotto" implies padded/winter; for breathable mesh riding gear the correct term is "Giacca." The model picked the wrong noun even though the source used "Giacca."

## 28. ✅ Listing wizard: apply to multiple marketplaces in one pass — resolved 2026-05-08 (M.1 + M.14)

**Resolution (split across two commits):**

  • **M.1** shipped multi-marketplace AI content fan-out at `/listings/generate` — operator picks N marketplaces, one Generate click runs N parallel LLM calls, each terminology + language tuned per marketplace.
  • **M.14** shipped multi-marketplace GTIN-exemption fan-out at `POST /api/gtin-exemption/multi`. Same brand letter + image package + trademark info are cloned across N marketplaces in one request. Per-marketplace DRAFT semantics are preserved so each application still lifecycles independently (one might land APPROVED on IT while DE bounces with REJECTED). Returns `{ created, updated, failed, summary }` so the wizard step can render "3 created, 2 already had drafts."

The wizard's Step 2 (Step2GtinExemption) still operates on a single marketplace per render today — wiring the multi endpoint to a "Submit to all 5 EU marketplaces" button on that step is a follow-up commit for whichever session picks it up. Backend is in place; frontend is the easy half.

**Original friction:** "Wanted to apply for 5 marketplaces at once, had to do separately." — wizard ran 5× per product across content generation + GTIN-exemption + per-marketplace overrides. M.1 collapses content generation; M.14 collapses GTIN-exemption.

## 29. ✅ /products: catalog hygiene filters — resolved 2026-05-08 in M.2

**Resolution:** Four hygiene tri-states shipped together (`hasPhotos`, `hasDescription`, `hasBrand`, `hasGtin`). Each renders as a single-select FilterGroup ('Has X' / 'No X'), wires through URL state, server-side `where` clauses on `/api/products`, and active-pills surfacing. The facets endpoint now returns a `hygiene: { total, missingPhotos, missingDescription, missingBrand, missingGtin }` rollup so each filter's group label shows "234 missing" inline — operator can spot the worst hygiene gap without toggling. Backend implementation uses `where.AND[]` so the hygiene clause doesn't conflict with the search OR.

**Original friction:** "Wished I could filter by 'needs photos'." `hasPhotos` had been shipped earlier; this commit added the three sibling filters in the same shape per the original ticket's "while we're there" note.

## 30. ✅ /products: surface category / productType — resolved earlier, re-verified 2026-05-08

**Resolution:** Already shipped before TECH_DEBT review. `productType` is a column in `ALL_COLUMNS` with key `'productType'` / label `'Type'` / width 130, and a multi-select filter facet (`productTypes`) wired through URL state, the facets endpoint, and active-pill rendering with IT_TERMS Italian labels. The optional grid-card secondary line wasn't shipped but was tagged optional in the original ticket.

---

# Schema drift findings (surfaced by the P0 #0 gate, 2026-05-02)

When the schema-drift CI gate landed, it caught **two more orphans** beyond `Image` — both are tracked here as concrete tickets. The drift check allow-lists them by name with a pointer back to these entries, so the gate can pass while we work them off.

## 31. ✅ ChannelConnection — resolved 2026-05-03

Migration `20260503_p0_31_channel_connection` adds the `ChannelConnection` table + indexes. Same migration also fixes substantial column-level drift on `VariantChannelListing` that the audit surfaced — `channelConnectionId`, `externalListingId`, `externalSku`, `listingUrl`, `currentPrice`, `quantity`, `quantitySold` were all in `schema.prisma` but never migrated, so the listing-sync endpoints would crash even with the new ChannelConnection table. `channelId` was also relaxed from `NOT NULL` to nullable to allow eBay rows that key off `channelConnectionId` instead of the legacy `Channel.id`. FK from `VariantChannelListing.channelConnectionId` → `ChannelConnection.id` now in place.

Drift gate allow-list removed `ChannelConnection`; remaining allow-list entries are just `DraftListing` (TECH_DEBT #32).

Verified at Phase 1 push: `/api/ebay/auth/create-connection` returns 201 (was 500), drift gate passes with 45 models / 1 allow-list entry. The OAuth callback flow itself is end-to-end-tested at Gate 1 by the user connecting a real eBay account.

## 32. ✅ DraftListing — resolved 2026-05-07 in S.0

**Resolution:** Phase 1 syndication audit found `DraftListing` was actually live-wired (`/listings/generate` page calls it via `POST /api/listings/generate`) — earlier "zero callers" assessment was wrong. Picking option 2 (land the migration) was correct: deleting the model would have broken the eBay AI generator. Migration `20260507_s0_draft_listing_table` ships the table; allow-list entry removed from `check-schema-drift.mjs`.

**Original symptom (kept for history):** `model DraftListing` existed in `schema.prisma` with no migration creating the table. Hits to `prisma.draftListing` from `ai-listing.service.ts` crashed at runtime — silent production failure of the eBay AI generator surface.

## 34. 🟢 eBay OAuth scopes don't include `commerce.identity.readonly`

**Symptom:** Connected channel cards show no seller username/store-name. The Test endpoint can confirm "token is valid" but cannot retrieve the seller's identifying info.

**Root cause:** `services/ebay-auth.service.ts` requests scopes `api_scope`, `sell.account`, `sell.inventory`, `sell.fulfillment`. Getting the seller's username requires `commerce.identity.readonly` (the `/commerce/identity/v1/user` endpoint enforces this scope; with sell-only scopes the call returns 404). v1 falls back to `/sell/account/v1/privilege` which confirms token validity but doesn't return a name — UI shows "eBay seller (verified)" placeholder.

**Proper fix:** Add `commerce.identity.readonly` to the scope list in `generateAuthorizationUrl()`. Then point `getSellerInfo()` back at `/commerce/identity/v1/user` (the previous attempt is preserved in git history at `98a094f`).

**Catch:** existing eBay connections were authorized with the smaller scope set. Their refresh tokens won't get the new scope by simply rotating — eBay refresh keeps the original scope envelope. Each existing connection must re-authorize (click "Disconnect" → "Connect eBay" again). That's why this is P2 — Xavia has only one real eBay account today; one re-auth click after the scope change is fine.

## 33. ✅ ebay-orders.service.ts targets pre-Phase-26 Order schema — resolved (verified 2026-05-08)

**Resolution:** `processOrder()` in `apps/api/src/services/ebay-orders.service.ts` was rewritten to use the Phase 26 unified `Order` model. Field-by-field check (grep confirms zero remaining legacy refs in the service):

  • eBay `orderId` → `Order.channelOrderId` (with `channel='EBAY'`)
  • `pricingSummary.total` → `Order.totalPrice` (Decimal, coerced)
  • `pricingSummary.currency` → `Order.currencyCode`
  • `buyer.username` → `Order.customerName`
  • `buyer.email` (or fabricated stub when omitted) → `Order.customerEmail`
  • `creationDate` → `Order.purchaseDate`
  • `orderStatus` / `fulfillmentStatus` / `lastModifiedDate` → `Order.ebayMetadata` JSON
  • Idempotency: upsert on `(channel, channelOrderId)` compound unique. Per-item dedup keyed on `lineItemId` in `ebayMetadata`.

The file's top doc-block (line 1-29) carries the mapping table inline so future edits don't drift. tsc passes against the current schema; the only remaining `fulfillmentChannel` reference in the codebase is in `sync.routes.ts` as a *request-body type* for inbound sync data (not a Prisma write).

Operator can now run `POST /api/sync/ebay/orders` without crashing Prisma — though Xavia is still Amazon-IT-only in practice, so this is unexercised in production.

## 34. ✅ Bulk operations — Path A-Lite deferrals — all sub-items resolved or deferred-by-design 2026-05-08

Sub-items individually addressed:
  • #34a Rollback infrastructure — ✅ resolved in M.13
  • #34b LISTING_SYNC handler — ✅ resolved in M.15
  • #34c Queue/worker for >100-item jobs — ⏸ deferred (gated on Phase 2 Redis + #54 + operator scale; no operator-visible impact at <1.3k items)
  • #34d DELETE action type — ⏸ deferred-by-design (soft-delete via STATUS_UPDATE → INACTIVE covers the use case; per-row hard-delete in grid; admin endpoint for test cleanup)
  • #34e "Selected items only" scope — ✅ resolved in M.16



**Surfaced at:** Issue B closeout — Path A-Lite shipped a working
filtered-bulk-operations stack (4 of 5 action types, scope picker UI,
preview, execute+poll) but explicitly deferred five pieces. Listed
together so they get reconsidered as one batch when the next bulk-ops
ask lands.

### 34a. ✅ Rollback infrastructure — resolved 2026-05-08 in M.13

**Resolution:** Per-item beforeState capture had already landed (Commit 2 / da0ac52); `bulkActionService.rollbackBulkActionJob` walks SUCCEEDED items + applies the captured beforeState back via the right write-path per actionType (PRICING / INVENTORY / STATUS / ATTRIBUTE). The only missing piece was the route + UI button — M.13 wires `POST /api/bulk-operations/:id/rollback` and surfaces an amber Rollback button on every eligible job in `/bulk-operations/history`.

The original "stored rollbackData JSON on the job and a sibling rollback-job" plan from this entry was abandoned in favour of per-item `BulkActionItem.beforeState`, which is finer-grained and already powers the existing audit timeline. Result: same operator-facing capability (undo a bulk op) with cleaner data shape.

See entry #25 for the full flow + guards.

### 34b. ✅ `LISTING_SYNC` handler — resolved 2026-05-08 (M.15)

**Resolution:** The backend `processListingSync` has been live in `bulk-action.service.ts` (line 2244) for some time — it enqueues `OutboundSyncQueue` rows for each ChannelListing of the targeted Product, with the operator-chosen `syncType` (FULL_SYNC / PRICE_UPDATE / QUANTITY_UPDATE / ATTRIBUTE_UPDATE) and an optional channels filter. The cron worker drains the queue. The action type was already in the dispatcher.

The remaining piece was UI — M.15 added the LISTING_SYNC option to `BulkOperationModal.tsx`'s OPERATIONS array with a syncType picker + channel-toggle pills. Operator can now select "Resync to channels" alongside the existing four operation types.

**Behavioural note:** The cron worker is the eventual-consistency consumer; the bulk job lands COMPLETED as soon as the queue rows are written, not when each channel push acknowledges. This matches the rest of the bulk-ops surface (jobs report queue success, not cron ack).

### 34c. ⏸ Queue / worker infrastructure for >100-item jobs — deferred 2026-05-08 (gated on Phase 2 Redis + #54)

**Status:** No active impact. Xavia-scale runs (~1.3k variations) complete in <100ms in-process per B-8 Test 5; the synchronous `processJob` is fine. The fix would prevent event-loop blocking on 50k-item jobs, which neither Xavia nor any current operator runs.

**Triple-blocked on:**
1. Operator scale crossing ~10k items per bulk job (not happening today).
2. Resolution of #54 (BullMQ Queue.add() hang from bulk-action context — dev-fixed, prod-validation pending).
3. Phase 2 Redis enabled on Railway (currently the queue is BullMQ-Proxy backed).

When these unblock, move `processJob` body into a BullMQ worker; the HTTP endpoint enqueues + returns immediately; worker processes in chunks of N with `WORKER_CONCURRENCY` set; cancel flag becomes Redis-backed.

**Reopen criteria:** A real bulk job hits >5k items in production OR operator reports event-loop stalls during a bulk run.

### 34d. ⏸ `DELETE` action type — deferred-by-design 2026-05-08

**Decision:** Not shipping. The TECH_DEBT entry itself flagged this as "defer until a user actually asks for it" and three coverage paths exist for the underlying needs:

  1. **Soft-delete** is already possible via the existing `STATUS_UPDATE` bulk action → set Product.status to `INACTIVE`. Listings stay un-published; data preserved.
  2. **Per-row hard-delete** is in the grid (commit `1b923f2`).
  3. **Mass-cleanup** of test fixtures is covered by the admin endpoint `DELETE /api/admin/cleanup-bulk-test` (uses `cascadeDeleteProducts`, gated to importSource=PERFORMANCE_TEST so it's safe).

Adding a 6th BulkActionType for hard-delete would expand the destructive-action surface for a need the operator hasn't articulated, with no rollback path (cascadeDeleteProducts is irreversible). Keep this row open until Awa or another seller explicitly requests it.

### 34e. ✅ "Selected items only" scope — resolved 2026-05-08 (M.16)

**Resolution:** The bulk-ops modal now exposes a third scope mode "Selected rows (N)" alongside the existing "Current filter result" and "Specific subset…" modes. When chosen, the modal passes `targetProductIds: [...]` directly to `/api/bulk-operations` (and `/preview` and `/check-conflicts`), skipping filter resolution. Backend already supported `targetProductIds` via `CreateBulkJobSchema` — only the UI wiring was missing.

Cross-targeting policy is unchanged: a Product-targeted action given variation IDs walks up to parents; a Variation-targeted action given product IDs expands to every child. The existing `getItemsForJob` handles the direction; the modal just hands over the IDs.

The `BulkOperationsClient` parent maps its row-range selection (`rangeBounds.minRow..maxRow`) to product IDs via `products.slice(min, max+1).map(p => p.id)`. The new mode is disabled when the operator hasn't picked any rows on the parent grid; the radio label includes the count and a hint when zero ("0 — pick rows on the grid first").

## 35. ⏸ Listing wizard — channel publish wired, gated dry-run by default — operator-action 2026-05-08

**Status update (verified 2026-05-08 against the current codebase):**

  • **Amazon SP-API** — fully wired. `apps/api/src/services/listing-wizard/amazon-publish.adapter.ts` has `gatedPut()` wrapping `putListingsItem` for both parent SKU (line 270) + every child variation SKU (line 297). The publish gate (C.6) makes every call defaulting to `dry-run`; the operator flips to `live` via Railway env vars (`NEXUS_ENABLE_AMAZON_PUBLISH=true`, `AMAZON_PUBLISH_MODE=live`).
  • **eBay** — fully wired. `apps/api/src/services/listing-wizard/ebay-publish.adapter.ts` has the three-step Inventory API flow (createOrReplaceInventoryItem → createOffer → publishOffer) wrapped in the C.7 gate (`NEXUS_ENABLE_EBAY_PUBLISH` + `EBAY_PUBLISH_MODE`).
  • **Shopify** — gated dry-run path in `apps/api/src/services/outbound-sync.service.ts` (M.12 round); needs the operator's Shopify shop credentials configured on a `ChannelConnection` to flip live.
  • **WooCommerce / Etsy** — explicitly skipped per memory `project_active_channels.md`.

**Phase B observability (also live):**
  • V.1 audit CLI: `node scripts/audit-channel-publish-attempts.mjs`
  • V.1 operator runbook: `PHASE_B_VERIFICATION.md`
  • M.7 live status page: `/listings/publish-status`
  • M.8 per-listing publishes tab in the drawer
  • M.10 14-day trend sparkline per channel rollup

**Gating to operator (the actual remaining work):** The publish gate defaults to `gated` (master flag off) and `dry-run` (when on but mode unset). Going to `live` is a Railway env-var change. PHASE_B_VERIFICATION.md documents the Phase B.0 → B.1 → B.2 → B.3 → B.4 sequence (sanity → dry-run → sandbox → canary → graduated). This entry stays open as a tracker until Awa runs Phase B for real.

**Original symptom (kept for context):** The /submit endpoint composed a payload but didn't push to channel. That's no longer true — composition + push are both wired; the gate is what holds it back from production credentials by default.

**Surfaced at:** Listing wizard Steps 9/10 closeout. The ten-step
wizard is now end-to-end navigable (audit + rebuild on 2026-05-03 →
2026-05-04). State validation, payload composition, and the SUBMIT
state transition all work. The actual channel push to Amazon (and
Shopify, eBay, WooCommerce) is the remaining piece.

**Reference (kept for tracker continuity):** see the status update block above for the current state of the wiring (all channel adapters now exist + wrapped in the publish gate; remaining work is operator credential + env-var flip).

---

## 37. ✅ Column-level schema drift detection (escalation of #0) — resolved 2026-05-07

**Symptom:** Item #0's drift gate catches **table-level** drift (model in `schema.prisma` with no matching `CREATE TABLE` in any migration). It did NOT catch **column-level** drift — a model whose columns don't match the production table's columns. This bug class bit three times in a single working session:
- `ChannelConnection` columns added to schema, never migrated (resolved by #31)
- `VariantChannelListing` columns drifted (resolved by #31)
- `Return` table — schema redefined with 22 cols against an existing 8-col table from a 2026-04-22 phase-2 migration; `CREATE TABLE IF NOT EXISTS` silently no-op'd, then `CREATE INDEX ... ON ("channel")` failed with `42703 column does not exist`. Took down Railway production for ~30 min on 2026-05-05 with P3009 blocking all subsequent deploys until the failed migration was manually rolled back.

**Surfaced at:** B.1 fulfillment spine migration on 2026-05-05.

**Workaround applied:** Manually edited the migration to `DROP TABLE IF EXISTS "Return" CASCADE;` before `CREATE TABLE "Return"`, removed `IF NOT EXISTS` so silent collisions become loud errors. Rolled back via `prisma migrate resolve --rolled-back` then redeployed.

**Resolution:** `packages/database/scripts/check-column-drift.mjs` — parses `schema.prisma` model fields, walks every `migration.sql` chronologically (CREATE TABLE / DROP TABLE / ALTER TABLE ADD/DROP/RENAME COLUMN), then diffs schema columns against the computed migration state. No shadow DB required — works in the existing pre-push hook unchanged. Wired into:
- `.githooks/pre-push` — runs after the table-level drift check
- `npm run check:drift` at root — runs both gates back-to-back
- `npm run check:column-drift --workspace=@nexus/database` — the column gate alone

Has the same allow-list mechanism as the table-level gate; current state passes 113/113 tables with 2 known SyncLog drift entries on the allow list.

The original "shadow DB + `prisma migrate diff`" plan is the heavyweight version (also catches type/default/constraint drift). Worth revisiting if a column-type drift incident slips past the regex parser.

**Defense in depth:** also lint migrations themselves — see #38.

---

## 38. ✅ Audit `IF NOT EXISTS` patterns in migrations — partially resolved 2026-05-08 (M.18)

**Resolution (defense in depth, not a bulk rewrite):** A `CREATE TABLE/INDEX IF NOT EXISTS` sweep + bulk-rewrite would be high-risk (turning idempotent statements into raw CREATEs could fail on environments that already partially-applied a migration). Instead M.18 ships a lint tool — `node packages/database/scripts/audit-if-not-exists.mjs` — that:

  • Scans every migration for `CREATE TABLE/INDEX IF NOT EXISTS`.
  • Classifies each occurrence as LEGITIMATE (preceded by a matching DROP, or wrapped in a `DO $$ ... $$` block, or in a migration whose name starts with `catchup_` / contains `backfill_fix`) or BARE (no protective context).
  • Reports a per-migration breakdown of bare occurrences so reviewers can see where the highest-risk concentrations live.
  • In `--strict` mode, returns non-zero exit code only if NEW bare occurrences land — preserves the status quo for the existing 221 occurrences (snapshot baseline) while preventing new ones without explicit opt-in.

The strict mode is intended for a future prepush hook addition — not wired in yet to avoid blocking parallel-agent in-flight work, but the tool is ready to drop into the gate whenever the team wants the rachet.

**Original symptom:** `CREATE TABLE/INDEX IF NOT EXISTS` is silent on collision — when a model is redefined with new columns but the table already exists with the old shape, the CREATE no-ops and any subsequent reference to the new columns crashes far from the actual bug. This is what hid the Return-table collision through the entire fulfillment B.1 review cycle.

**Why P1 not P0:** #37's shadow-DB column-drift gate caught the Return collision before it shipped (and prevents that class of bug going forward). This sweep is defense-in-depth — load-bearing fix is #37; M.18 is the rachet that prevents the count from growing.

**Symptom:** `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` are silent on collision. When a model is redefined with new columns but the table already exists with the old shape, the CREATE no-ops and any subsequent reference to the new columns crashes — far from the actual bug. This is what hid the Return table collision for the entire fulfillment B.1 review cycle.

**Surfaced at:** B.1 fulfillment migration P3018.

**Workaround:** N/A — process problem, not a code bug.

**Proper fix:**
1. Sweep every migration for `IF NOT EXISTS` on a CREATE TABLE/INDEX:
   ```
   grep -rn "CREATE TABLE IF NOT EXISTS\|CREATE INDEX IF NOT EXISTS" \
     packages/database/prisma/migrations
   ```
2. For each instance: was the IF NOT EXISTS added for legitimate idempotent-rerun reasons (the migration is supposed to be reentrant on dev DBs that partially ran prior versions), or was it boilerplate cargo-culted from somewhere? If the latter, remove it so failures are loud.
3. Document the pattern: only use `IF NOT EXISTS` when there's an explicit `DROP` before, or when re-runs against partial state are an explicit goal.

**Why P1 not P0:** #37's shadow-DB gate would have caught the Return collision before it shipped — that's the load-bearing fix. This sweep is defense-in-depth, valuable but not the same blast radius.

---

## 39. 🟢 Per-seller primary marketplace setting

**Symptom:** Two places in the multi-marketplace work hardcode `'IT'` as the primary marketplace because Xavia is the only live tenant:

1. The E.9 backfill migration (`20260505_e9_..._backfill_fix`) prefers `AMAZON:IT` over alphabetic-MIN when correcting VCL marketplace tagging.
2. (Implicit) The audit-fix #5 follow-up logic only knows IT is primary.

This works for Xavia. The minute Nexus has a second seller whose primary is DE / US / UK, the IT preference is wrong for them — both at backfill time and anywhere else "primary marketplace" surfaces (defaults for new wizards, fallback in resolvers, etc.).

**Surfaced at:** E.9 audit fixes, 2026-05-05.

**Workaround:** Hardcoded to IT. For a Xavia-only deployment this is correct; ignore until a second tenant lands.

**Proper fix:** Add a per-seller settings table (or extend `AccountSettings`) with `primaryChannel + primaryMarketplace` per seller. Resolver helpers (`getPrimaryMarketplace(channel)`) replace hardcoded `'IT'`. New backfills / resolver fallbacks read the setting. Onboarding flow should ask the user up front and seed it.

**Other places that would benefit from the same setting:**
- Listing wizard Step 1 default channel selection (preselect the primary channel + marketplace).
- `/products` default sort / facet pre-selection.
- Order list default filter when no explicit filter is set.
- Bulk-ops scope picker default `marketplace=` value.

---

## 40. 🟢 SP-API variation attribute mapping seed

**Symptom:** `AmazonPublishAdapter.buildChildAttributes` reads `ChannelListing.variationMapping` to map master axes (`Size`, `Color`) to SP-API attribute names (`size_name`, `color_name`, etc.) and falls back to a `_name` suffix when no mapping is present. The fallback is right for fashion/apparel/consumer-goods (Xavia's whole catalog) but wrong for some categories (LUGGAGE wants `size_name`, ELECTRONICS sometimes wants `model_name`, BAG wants `bag_size_name`).

**Surfaced at:** E.9 audit fix #4 — flagged but not fixed because every category needs verification against a real SP-API response, not guesswork.

**Workaround:** Fallback covers the common case. Edge categories will fail with clear "unknown attribute" issues on the FAILED submission, telling the user exactly which attribute name to set in `variationMapping`.

**Proper fix:**
1. After the first credentialed publish per productType, capture the actual SP-API expected attribute names (from `getProductTypeDefinitions` SP-API endpoint).
2. Seed `ChannelListing.variationMapping` automatically from that response when the wizard creates a listing for a new productType.
3. UI affordance to inspect / override the mapping per listing if the auto-seed gets it wrong.

Tied to #35 (channel publish wiring); both want a real first publish to drive the work.

---

## Data Quality Issues (P2)

Surfaced by the 2026-05-05 cleanup + 2026-05-06 comprehensive audit (see `packages/database/AUDIT.md`). These are P2 because they don't block functionality but degrade data integrity and will mislead UI surfaces (search, filters, pricing, inventory). Address after the catalog is verified against Xavia's actual SKU list and the Amazon SP-API sync is connected.

### DQ-1. 🟢 Zero-price products (7 jackets)

`basePrice = 0` on real Xavia jackets — the catalog page, pricing matrix, and any margin calc treat these as free.

- `AIRMESH-JACKET-BLACK-MEN`, `AIRMESH-JACKET-YELLOW-MEN` (the no-size "parents")
- `3K-HP05-BH9I` (MISANO leather jacket)
- `GALE-JACKET`, `IT-MOSS-JACKET`, `REGAL-JACKET`, `VENTRA-JACKET`

**Fix:** source authoritative price from Amazon Seller Central or enter manually via `/products/:id`. Easier once SP-API sync runs and overwrites.

### DQ-2. 🟡 AIRMESH triple-stacked duplication

For each colour (BLACK / YELLOW), the database holds:
- 1× "no-size" parent at €0 (`AIRMESH-JACKET-{COLOR}-MEN`)
- 6× sized children at €109.99 (`AIRMESH-JACKET-{COLOR}-MEN-{S,M,L,XL,XXL,3XL}`)
- BLACK only: 1× MANUAL master at €109.99 (`XAVIA-AIRMESH-GIACCA-MOTO`)

15 SKUs covering one product family. Confuses every channel publisher — Amazon will pick a different ASIN than eBay.

**Fix:** keep the 12 sized SKUs as `ProductVariation` rows under one parent Product per colour; delete the no-size €0 parents and the legacy MANUAL master once data is migrated. Migration ticket needed.

### DQ-3. 🟡 Glove sizes stored as separate Products

Schema misuse: each size is its own `Product` row instead of a `ProductVariation`.

- `xriser-bla-{S,M,L,XL,XXL}` — 5 rows
- `xevo-mar-{S,M,L,XL,XXL}` — 5 rows
- `xevo-black-{S,M,L,XL,XXL}` — 5 rows

15 Products that should be 3 Products × 5 size-variations. All currently 0 stock so re-stocking is a good moment to migrate.

**Fix:** consolidation migration script — pick canonical parent SKU per glove model, move the 5 sizes into `ProductVariation` rows, delete the 4 redundant Product rows per model. Ticket: write a one-shot migration in `packages/database/scripts/`.

### DQ-4. 🟡 Knee slider colours stored as separate Products

Same issue as DQ-3. **Eight** colours (not six as initial triage guessed):

`xavia-knee-slider-{black, blue, green, orange, pink, red, white, yellow}`

Two have stock (green=12, orange=22), the other six are 0. €21.99 each.

**Fix:** consolidate to one Product with 8 colour-variations. Same migration pattern as DQ-3.

### DQ-5. 🟡 Every Product has `brand = NULL`

All 267 rows. The catalog page and all brand filters can't function meaningfully.

**Fix (cautious):** verify each is a Xavia product, then `UPDATE "Product" SET brand = 'Xavia Racing' WHERE brand IS NULL;`. Don't blanket-update without spot-checking — the import history is mixed and the 5 MANUAL rows are explicitly user-entered.

### DQ-6. 🟢 30 abandoned ListingWizard drafts

All 30 `ListingWizard` rows have `status = 'DRAFT'`. They're abandoned wizard sessions that clutter the resume-draft view.

**Fix:** add a TTL job (delete drafts older than N days) or a one-shot cleanup. Low risk — drafts are user-recoverable per row, but bulk-old ones are noise.

### DQ-7. 🟢 7 inactive ChannelConnection rows

8 connections, only 1 active. The 7 inactive rows are dead OAuth tokens (likely expired refresh tokens or revoked apps).

**Fix:** delete inactive connections that haven't been refreshed in N days, OR add a `lastRefreshAttemptAt` column and a refresh job. The user-facing "channels" UI shows them today, which is misleading.

### DQ-8. 🟢 `playing_with_neon` table

Neon's default sample table, 60 rows. Harmless but pollutes `\dt` and the audit.

**Fix:** `DROP TABLE "playing_with_neon" CASCADE;`. Verify no app code references it first (none does — it predates the project).

### DQ-9. 🟢 `Listing` table coexists with `ChannelListing`

Both tables exist in the schema. `ChannelListing` is the post-Phase-26 unified model; `Listing` is legacy with no clear remaining caller.

**Fix:** grep for `prisma\.listing\.` (lowercase = `Listing`) vs `prisma\.channelListing\.`. If `Listing` truly has no callers, drop the model + ship a migration. Same flavour as TECH_DEBT #32 (DraftListing).

### DQ-10. 🟢 StockMovement table is empty (0 rows)

We have a Warehouse, 4 PurchaseOrders, 262 PurchaseOrderItems, an InboundShipment — and zero StockMovement rows. The inventory ledger is never written; stock is tracked through `Product.totalStock` only.

**Fix (decide):** either (a) wire stock movements through the inbound/PO flow so the ledger is the source of truth, or (b) drop the `StockMovement` model if we don't actually need event-sourced inventory. Don't leave it half-built.

### Resolution strategy

These are P2 because they don't block shipping. Address after:

1. Verifying the current 267-product catalog matches Xavia's actual SKU list (manual reconciliation against Amazon Seller Central listing report).
2. Connecting Amazon SP-API for authoritative product data — running `POST /api/amazon/products` and reconciling the diff.
3. Writing a single consolidation migration that fixes DQ-2/3/4 in one shot (variation theme: SIZE for gloves+jackets, COLOR for knee sliders, COLOR+SIZE compound for AIRMESH).

---

## 41. ✅ Order-driven stock decrement needs fulfillment-method-aware location routing — resolved 2026-05-08 (M.20)

**Resolution:** Audited every order-driven `applyStockMovement` call site. Three exist:
  • `apps/api/src/services/amazon-orders.service.ts:387` — already fulfillment-method-aware. Doc-block at line 13: "FBA orders: never touched here. Amazon ships from FBA inventory, and the 15-min FBA cron syncs `fulfillableQuantity` into the AMAZON-EU-FBA StockLevel — that's the canonical FBA source." Real Amazon order ingestion routes correctly.
  • `apps/api/src/services/ebay-orders.service.ts:384` — eBay isn't FBA-fulfillable, so the always-IT-MAIN path is correct.
  • `apps/api/src/services/order-ingestion.service.ts:240` — mock-orders generator. **This was the gap.** Did not differentiate AMAZON FBA vs FBM. Fixed in M.20: mock orders now flip ~50/50 between FBA and FBM for AMAZON, set `fulfillmentMethod` on the Order row, and skip the local `applyStockMovement` entirely for FBA (mirroring real amazon-orders.service routing).

Production order flows on Amazon are unchanged — they were already correct. Mock smoke-test orders no longer pollute IT-MAIN with phantom decrements for FBA scenarios.

**Original symptom:** mock orders silently decremented `IT-MAIN` even for AMAZON+FBA scenarios. With Xavia pre-launch (mock paths only), the impact was bounded but would have masked future regressions in the real path.

---

## 42. ✅ Master-price + master-stock cascade architecture — resolved 2026-05-06 in Phase 13

Shipped as commits `3714dff` (13a MasterPriceService), `e2e92d2` (13b stock cascade in applyStockMovement), `a92e82a` (13c PATCH /products/:id wiring), `7c59ae9` (13d PATCH /products/bulk wiring), `d6d1f55` (13e backfill script — already executed against production: 5 masterPrice + 8 masterQuantity rows). Live-verified end-to-end against production: a 39.95 → 41.99 → 39.95 round-trip on a real Xavia listing produced the expected masterPrice snapshot, AuditLog row, and (correctly) zero OutboundSyncQueue rows because the test listing had `followMasterPrice=false`.

Two new worker quirks surfaced by the integration — see #48 and #49 below. Neither blocks Phase 13's cascade correctness; both are pre-existing behaviors of `bullmq-sync.worker.ts` that interact with the new flow.

**Original symptom (kept for history):** When `Product.basePrice` or `Product.totalStock` changes, ChannelListing rows tied to that product are not updated. The marketplace continues to show the pre-edit value until something else triggers a sync. Equivalent issue for variant edits — `ProductVariation.price` writes don't flag the parent's listings for re-publish. This is silent data drift between master + per-channel state.

**Surfaced at:** Phase 1 audit (2026-05-06) of /bulk-operations + /products grid + /products/:id/edit. Three active write paths affected:
- `PATCH /api/products/:id` (`products-catalog.routes.ts:628`) — inline grid quick-edit. Updates `Product.basePrice`, no listing cascade.
- `PATCH /api/products/bulk` (`products.routes.ts:553`) — bulk-ops grid Cmd+S commit. Updates `Product.basePrice` in a transaction, no listing cascade for master fields (only channel-prefixed fields like `amazon_title` reach ChannelListing).
- `BulkActionService.processPricingUpdate` / `processInventoryUpdate` — targets `ProductVariation` which is currently empty (#43), so inert today; will silently drift the moment that table gets populated.

**Workaround applied:** None active. A tactical 45-line cascade flag (`cdf6251 fix(bulk): flag ChannelListings for re-sync after variant price/stock edits`) was reverted in `2674c05` — wrong scope for the problem and would have to be ripped out by the proper fix.

**Why it matters at scale:** 3,200 SKUs × 7 marketplaces = ~22k listings to keep in sync. A synchronous cascade in the request path adds N×listing latency per edit, doesn't survive crashes mid-loop, and gives no per-marketplace push tracking, rate-limit awareness, or dead-letter recovery. At scale, "silent drift" means inventory oversells, prices wrong on Amazon EU, and no audit trail for who changed what when.

**Proper fix:** Transactional outbox + worker fan-out, symmetric to the H.1/H.2 stock-movement service that already exists.

```
HTTP / job / import / scheduled price service
       │
       ▼
MasterPriceService.update(productId, newPrice)
   one Prisma $transaction:
     ├─ Product.update(basePrice)
     ├─ ChannelListing.updateMany(masterPrice + computed price + version+1)
     ├─ OutboxEvent.create({type:'price.changed', payload, idempotencyKey})
     └─ AuditLog.create(actor, before, after)
       │
       ▼
BullMQ worker (already exists at apps/api/src/lib/queue.ts)
       │ batches by marketplace, respects SP-API rate limits, retry+DLQ
       ▼
Marketplace API (Amazon, eBay, Shopify, ...)
```

Properties: atomic master+listing+outbox write (crash-safe), bounded request latency, idempotency via outbox event ID, centralized cascade logic so no caller can forget, per-marketplace rate limiting, observable (outbox lag, push success/fail, drift detection).

**Codebase already has:** `OutboundSyncQueue` table (`schema.prisma:1738`), BullMQ queues, `outbound-sync.service.ts`, `pricing-outbound.service.ts` (Amazon SP-API push wired), `unified-sync-orchestrator.ts`. Missing piece is the upstream service that takes mutations and feeds them into the existing infrastructure.

**Estimate:** 2–3 focused days, one cohesive PR with co-located code + tests + migration. Plus a backfill for existing ChannelListings to populate `masterPrice` snapshot from current `Product.basePrice` so drift baseline is correct.

**Promote to dedicated phase** (Phase 13 in the current P0 sweep). Don't ship a tactical patch — the architectural work would have to undo it.

---

## 43. ⏸ Variant mechanism duplication — deferred 2026-05-08 (3–5 day refactor, no operator-visible impact)

**Status:** No active impact. `Product.parentId` is the canonical variant mechanism (244 children + 15 parents in production). `ProductVariation` table sits empty and dormant. The bulk-action targets that previously routed through `ProductVariation` (PRICING/INVENTORY/STATUS) have all been retargeted to `Product` (Commit 1 of the bulk-ops rebuild) and ATTRIBUTE_UPDATE was retargeted in M.21. So the silent-no-op risk that originally drove this entry has been closed at the bulk-action layer.

**Removal would still take 3–5 focused days** because the listing-wizard reader services (`variations.service.ts`, `submission.service.ts`, `schema-parser.service.ts`) all read via the PV relation; refactoring them to walk `Product.parentId` children is the load-bearing portion. No operator-visible problem to motivate it today.

**Reopen criteria:** Adding new code that needs to query variants and the dual-mechanism causes ambiguity, OR the listing-wizard reader services need a different change anyway.

**Original symptom (kept for context):**

**Symptom:** Two parallel variant mechanisms exist in the schema. Real catalog uses `Product.parentId` self-reference (244 children + 15 parents in DB as of 2026-05-06, including all 244 Xavia variants). The `ProductVariation` table is defined but never populated (0 rows).

**Surfaced at:** Phase 1 audit + Phase 3 scout (2026-05-06). Found while constructing a smoke test for the bulk-pricing cascade — bulk action targets `ProductVariation`, which was empty, so the action had no work to do.

**Other code paths affected:**
- `BulkActionService` declares `ACTION_ENTITY.PRICING_UPDATE = 'variation'`, `INVENTORY_UPDATE = 'variation'`, `ATTRIBUTE_UPDATE = 'variation'`, `LISTING_SYNC = 'variation'` (`bulk-action.service.ts:42-47`). All silently process 0 items in current production.
- Frontend (Phase 2 fix `3488be8`) reads variants via `/api/products/:id/children` which queries `Product.parentId`. So the user-visible path uses the *active* mechanism.
- Schema relations on `PricingRuleVariation`, `StockLevel`, etc. point at `ProductVariation` — these features are also inert until the duplication is resolved.

**Decision needed:** Either (a) deprecate `ProductVariation` schema and migrate any features that depend on it to `Product.parentId`, or (b) backfill `ProductVariation` from `Product.parentId` rows and migrate every `Product.parentId` consumer (frontend, audit logs, bulk-ops, /catalog/organize) to query `ProductVariation`.

**Recommended:** (a). The active mechanism is the simpler one (single table self-reference). `ProductVariation` was likely an aspirational schema that didn't ship. Removing it removes ambiguity about which is canonical.

**Tied to #42 and #44.** Resolving the bulk-ops data-shape mismatch (#44) and shipping the master-price cascade (#42) both need this answered first.

**Update 2026-05-06 — P.1 scope discovery.** Tried to deprecate ProductVariation writes as a foundation step before the /products rebuild. Findings:

- `ProductVariation` table: still 0 rows ✓
- `VariantChannelListing` table: still 0 rows ✓
- Code references: 172 across 28 files (much larger surface than expected)
- The truly dormant write is `stock-movement.service.ts:262-270` — only fires when `variationId` is passed, which never happens since no PV rows exist. Disabled in P.1 (logs warning if hit).
- All other write sites (wizard create at `products.routes.ts:1850`, catalog children mirror at `catalog.routes.ts:1267`, web actions at `catalog/[id]/edit/actions.ts:53,59` and `inventory/manage/actions.ts:37,89,104`, channel webhooks) are **load-bearing** for the listing wizard's variant submission flow.

**Why removal is blocked**: the listing wizard's reader services depend on the PV relation, not `Product.parentId` children:
- `apps/api/src/services/listing-wizard/variations.service.ts:131` — reads `product.variations` (PV relation) for theme picking + missing-attribute annotations
- `apps/api/src/services/listing-wizard/submission.service.ts:347` — reads PV by SKU for Amazon variant submission
- `apps/api/src/services/listing-wizard/schema-parser.service.ts:535` — reads PV for schema validation

Disabling the wizard's PV writes without first refactoring these readers would silently set `children: []` on every new variant, breaking Amazon variant submission.

**Real removal sequence** (future commit, ~3-5 days):
1. Refactor `variations.service.ts` to read children via `Product.parentId` + `Product.variantAttributes` (already populated for new rows in catalog children create)
2. Refactor `submission.service.ts` to walk parentId children for variant SKUs + read VCL → ChannelListing instead
3. Refactor `schema-parser.service.ts` similarly
4. Backfill any PV-only data into the parent's children (none today since 0 rows)
5. Disable the remaining write paths
6. Drop the model + migration
7. Sweep remaining 100+ references in bulk-action, pricing-snapshot, forecast, inventory, marketplaces, repricing, webhooks routes

---

## 44. ✅ Bulk operations target unused data shape — fully resolved 2026-05-08

**Symptom (original):** Every `BulkActionJob` of type 'variation' (PRICING_UPDATE, INVENTORY_UPDATE, ATTRIBUTE_UPDATE, LISTING_SYNC) processed 0 items on real catalogs because `ProductVariation` is empty (#43).

**Resolved in Commit 1 of the bulk-operations rebuild:** PRICING_UPDATE + INVENTORY_UPDATE now target `Product` and delegate to `MasterPriceService.update` / `applyStockMovement` for the full cascade (Product + ChannelListing + OutboundSyncQueue + AuditLog/StockMovement). STATUS_UPDATE was already correctly targeting Product. See `bulk-action.service.ts:ACTION_ENTITY` and DEVELOPMENT.md "Bulk operations — two-table data model" → "Master-cascade routing per actionType".

**Still open:**
- `ATTRIBUTE_UPDATE` still targets `ProductVariation.variationAttributes`. PV is empty so this is a silent no-op against current data. Retargeting requires a schema decision: which Product column holds variant-level attributes? See entry #52.
- The BullMQ post-commit enqueue from bulk-action context: dev-fixed in #54; production validation still pending.

**Closed by sibling commits:**
- `LISTING_SYNC` — handler implemented + UI exposed in M.15 (modal "Resync to channels"); see #34b.

**Note:** The PATCH `/api/products/bulk` path (used by the BulkOperationsClient grid for inline cell edits, Cmd+S) targets `Product` directly and was unaffected — that's a separate code path that has always worked.

---

## 45. ✅ Local apps/api Prisma client version mismatch — resolved 2026-05-08

**Resolution:** Aligned every Prisma dependency on v6.19.3:
  • `apps/api/package.json`: `@prisma/client` and `prisma` both `^6.19.3`; `@prisma/adapter-pg` downgraded to `^6.19.3` (was `^7.7.0`, which dragged in `@prisma/client@7.x` as a peer dep).
  • `packages/database/package.json`: same alignment (was already mostly v6 except for the v7 adapter).
  • `npm dedupe` collapsed the duplicate apps/api/node_modules/@prisma/client@7.8.0 into a single hoisted v6.19.3.

`npm ls @prisma/client` now shows a single v6.19.3 across the workspace tree. `npm run build --workspace=@nexus/api` succeeds. Runtime parity with packages/database's generated client is restored.

**Note:** Bumping the whole stack to v7 was attempted first (since v7 is the current series) but the v7 CLI errored on the existing `prisma.config.ts` shape during postinstall. Deferred — see entry 46 placeholder if a v6 → v7 upgrade lands later.

**Original symptom:** Local dev API server returned 500 on every Prisma query because apps/api's @prisma/client@7 was a different major than the v6 client the CLI generates. Production unaffected (Railway builds dependencies fresh in a single hoisted state).

---

## 46. ⏸ `Channel` + `Listing` tables empty — deferred 2026-05-08 (cleanup requires multi-step migration)

**Verified 2026-05-08:** `Channel` rows = 0; `Listing` rows = 0; `ChannelListing.channel` distinct values = ['AMAZON'] only. Both legacy models are unused at runtime. The lone code reference (`apps/api/src/services/sync/batch-repair.service.ts:381` calls `prisma.channel.findFirst()`) returns null and short-circuits — confirmed dead code path.

**Cleanup is deferred** because dropping these models requires:
  1. Schema: delete `model Channel` + `model Listing` from `schema.prisma`.
  2. Migration: `DROP TABLE "Listing" CASCADE; DROP TABLE "Channel" CASCADE;` plus schema.prisma `@relation` removal on any model that points at them.
  3. Code: delete the dead `prisma.channel.findFirst()` block in batch-repair.service.ts.
  4. Audit: any external callers (analytics jobs, BI exports) that read these table names.

Each step is small but the audit is non-trivial. Operator-impact is zero (both tables empty + unused), so the cleanup is opportunistic, not load-bearing.

**Reopen criteria:** Touching batch-repair.service.ts for any other reason (drop the dead reference + the rest follows) OR multi-tenant work needs a populated Channel table (then design + populate, don't drop).

---

## 48. ✅ BullMQ worker recomputes ChannelListing.price ignoring `followMasterPrice` — resolved 2026-05-06 in `e55ed37`

The Phase 28 recompute at `bullmq-sync.worker.ts` now skips when `followMasterPrice = false`, so a seller's per-marketplace override survives subsequent sync passes. Six-line change wraps the existing recompute in the flag check + adds a debug log for the skip path so the behaviour is visible in production logs. Original symptom preserved below.

**Original symptom (kept for history):** Every outbound sync job that runs through `bullmq-sync.worker.ts` (line 187–242, the "Phase 28: Pricing Calculation" block) calls `calculateTargetPrice()` and overwrites `ChannelListing.price` based on the listing's `pricingRule` + `priceAdjustmentPercent`. The recompute does **not** check `followMasterPrice` — so a listing where the seller has explicitly opted out of following the master (e.g. an Amazon-EU price floor that should stay at €49.99 regardless of basePrice) gets its override silently overwritten with the rule-based value the next time anything triggers a sync.

**Surfaced at:** Phase 13e integration scout. Doesn't block the cascade itself — `MasterPriceService` correctly leaves `followMasterPrice=false` listings' price untouched and never enqueues an OutboundSyncQueue row for them, so the worker only runs on listings the cascade DID write. The bug bites when something else (variation sync, manual resync, a Phase 28 repricer pass) creates an OutboundSyncQueue row for a `followMasterPrice=false` listing — the worker then recomputes and trashes the override.

**Workaround applied:** None. Pre-existing behavior; not introduced by Phase 13.

**Proper fix:** Wrap the Phase 28 recompute in a `followMasterPrice=true` check (and a `pricingRule != 'MATCH_AMAZON' || amazonPrice` check, since calculateTargetPrice falls back to masterPrice when MATCH_AMAZON has no Amazon source price — which silently nullifies the rule). Five-line change at `bullmq-sync.worker.ts:207`. Add a regression test that pushes an OutboundSyncQueue row for a followMasterPrice=false listing and asserts the price column doesn't change.

---

## 49. ✅ `OutboundSyncService.processPendingSyncs` ignores `holdUntil` — resolved 2026-05-06 in `e55ed37`

`processPendingSyncs()` now filters by `OR: [{ holdUntil: null }, { holdUntil: { lte: now } }]` so the 5-minute undo grace window is respected even when a caller writes an OutboundSyncQueue row without also adding a BullMQ job. Mirrors the existing `getReadyItems()` filter in `outbound-sync-phase9.service.ts`.

**Original symptom (kept for history):** `outbound-sync.service.ts:103` reads every `OutboundSyncQueue` row with `syncStatus='PENDING'` regardless of `holdUntil`. Today the 5-minute grace window works because every caller (`outbound-sync-phase9.service.ts`, `MasterPriceService`, `applyStockMovement`) sets BullMQ's job-level `delay: 5 * 60 * 1000` AND the DB row's `holdUntil` — the BullMQ delay is what actually defers processing. But any caller that creates a row without also adding a BullMQ job (legacy code paths, future schema imports, manual SQL inserts) bypasses the grace entirely and the next worker tick will dispatch immediately.

**Surfaced at:** Phase 13e integration scout — same investigation as #48.

**Proper fix:** Add `OR: [{ holdUntil: null }, { holdUntil: { lte: new Date() } }]` to the `where` clause at `outbound-sync.service.ts:114`. Mirrors the existing `getReadyItems()` filter at `outbound-sync-phase9.service.ts:332`, which is how that newer service correctly respects the grace window.

---

## 47. ✅ Vercel auto-deploy from `main` — resolved 2026-05-06, doc closed 2026-05-08

**Symptom:** Vercel stopped deploying commits to `main` somewhere around 2026-05-01. Multiple H.1/H.2/H.3 stock-ledger commits + the Phase 4 catalog rename appeared on `nexus-commerce.vercel.app` as 404s; the actual production deployment lived at `nexus-commerce-three.vercel.app`.

**Surfaced at:** Phase 4 deploy verification (2026-05-06). Re-pointed to correct URL after user identified it; pipeline subsequently green.

**Resolution:** User confirmed Vercel pipeline is now active (2026-05-06). All pending commits (Phase 4, 6, 7) deployed cleanly to `nexus-commerce-three.vercel.app`.

**Process note for future audits:** Production URL is `nexus-commerce-three.vercel.app` (custom Vercel project name; the predictable `nexus-commerce.vercel.app` alias does not auto-update). If a deploy verification 404s on the predictable URL, check the actual project deployment URL before assuming a build failure.

---

## 42. ✅ No test framework — resolved 2026-05-08 (M.19)

**Resolution:** Vitest installed in `apps/api` with `apps/api/vitest.config.ts` + `npm run test` / `npm run test:watch` scripts. Seed test landed at `apps/api/src/services/__tests__/bulk-action-rollback.vitest.test.ts` validating the M.13 rollback route's HTTP status mapping.

**Convention going forward:**
  • Tests for new code live alongside the source: `src/services/foo.service.ts` → `src/services/__tests__/foo.service.test.ts` OR `src/services/foo.service.vitest.test.ts`.
  • Vitest picks up patterns: `src/**/__tests__/*.test.ts` and `src/**/*.vitest.test.ts`.
  • The 29 legacy custom-runner tests at `src/**/*.test.ts` (using `tests.push(...)` + `npx tsx`) keep working — they run by direct execution, not via vitest. Migrating them to vitest's `describe/it/expect` is a per-file follow-up; no urgency since they pass today.

`npm run test --workspace=@nexus/api` exits clean with 1 file / 3 tests.

**Symptom:** Repo has zero `*.test.ts` / `*.spec.ts` files and no Vitest/Jest setup. Every commit ships on the strength of manual smoke testing + the pre-push `next build` + `tsc --noEmit` gates.

**Surfaced at:** H.10 final commit of the stock rebuild — couldn't write proper unit tests for `applyStockMovement` / reservation logic / cascade fan-out without first scaffolding a test runner. End-to-end smoke ships at `scripts/verify-stock.mjs` instead, which exercises the live API and asserts `Product.totalStock = SUM(StockLevel.quantity)` after each operation.

**Workaround:** The smoke script catches regressions for the stock surface specifically. Other surfaces have no equivalent.

**Proper fix:**
1. Add Vitest at the repo root with workspace-aware config (apps/api, apps/web, packages/database).
2. Stand up a single integration test against the existing Prisma client + a throwaway test database (or DATABASE_URL pointing at a Neon branch).
3. Cover the highest-leverage flows first: stock-movement audit-trail integrity, reservation no-double-allocation, OutboundSyncQueue cascade after a write.

Promote to 🔴 when a regression slips past the build gates and into production.

---

## 43. 🟢 eBay/Shopify/etc. inbound stock sync

**Symptom:** Only Amazon FBA has an inbound (channel → Nexus) stock sync. Other channels' stock is purely outbound (Phase 13 cascade pushes Nexus → channel). If eBay's inventory drifts vs. Nexus's expectation (e.g., a customer cancels via eBay direct without webhook), Nexus has no way to detect or reconcile.

**Surfaced at:** H.8 sync engine wiring — flagged as out-of-scope because no eBay/Shopify orders flow today.

**Proper fix:** Mirror `amazon-inventory.service.ts` for each channel. Each adapter calls the channel's "get inventory" API on a 15–30 min cadence, finds drift, applies via `applyStockMovement(reason='SYNC_RECONCILIATION', locationId=<channel-allocation-location>)`. Will need a `CHANNEL_RESERVED` location per channel for inventory that's allocated to (but not necessarily held by) the channel.

---

## 44. 🟢 Saved views + column reorder/resize on /fulfillment/stock

**Symptom:** H.9 polish landed density modes, column show/hide, and keyboard shortcuts. Saved views (named filter snapshots) and drag-to-reorder/resize for table columns were deferred — both are substantial scope (saved views needs persistence + a UI flow; reorder/resize needs dnd-kit machinery).

**Workaround:** URL state (`view`, `location`, `status`, `search`, `page`) survives reload + share, which covers the most common "remember this filter" use case.

**Proper fix:** When a user explicitly asks. Saved views: add a `UserView` model keyed by user + page + name, store the URL query, surface in a dropdown next to the filter bar. Column reorder: dnd-kit on the column picker dropdown.

---

## 51. ✅ Transactional email infrastructure — engineering complete 2026-05-08; remaining is operator-action

**Engineering state (verified 2026-05-08):** Shared `sendEmail()` transport at `apps/api/src/services/email/transport.ts` — `to | to[]`, `subject`, `html`, `text?`, `attachments?`, `tag?` params; Resend backend; `NEXUS_ENABLE_OUTBOUND_EMAILS` dry-run gate (defaults to mock + console log). Already consumed by:
  • O.30 — shipment notification emails
  • R6.3 — return-event emails
  • Alert routing via `monitoring/alert.service.ts:sendEmailAlert`
  • Sync monitoring escalations via `sync-monitoring.service.ts`

The infrastructure entry can close. Remaining items are explicitly NOT engineering:
  • **Operator action:** flip `NEXUS_ENABLE_OUTBOUND_EMAILS=true` in Railway env after `RESEND_API_KEY` is set.
  • **DNS / domain auth:** SPF + DKIM + DMARC for `xavia.it` (or whatever brand domain). Coordinate with the DNS owner.
  • **Optional follow-up:** wire H.17 "Send to supplier" button to surface the existing discrepancy-report PDF through `sendEmail()` with `attachments`. ~1 commit, blocked on product copy not engineering.

Template registry / preference center / opt-out flow are not load-bearing for any current operator flow; defer until a real surface needs them.

---

## 50. ✅ FBA Inbound v0 → v2024-03-20 migration — engineering complete 2026-05-08 (F.1–F.5)

**Resolution:** Full engineering side of the migration shipped across F.1–F.5:

  • **F.1** (`b0bf7af`) — `apps/api/src/clients/amazon-fba-inbound-v2.client.ts` typed wrappers for the 9 v2024-03-20 endpoints. Additive only.
  • **F.2** (`928536d`) — `FbaInboundPlanV2` Prisma model + migration `20260508_f2_fba_inbound_plan_v2`. Persists plan state across the multi-step async flow. Applied to Neon.
  • **F.3** (`e291ebb`) — `apps/api/src/services/fba-inbound-v2.service.ts` polling service. Exponential backoff (~5min total), records errors to `lastError`/`lastErrorAt`, persists `operationId` per step so a restart mid-poll can resume from the persisted state.
  • **F.4** (`e291ebb`) — `apps/api/src/routes/fba-inbound-v2.routes.ts` registered at `/api/fba/inbound/v2/*`. One route per step (8 verbs total).
  • **F.5** — `apps/web/src/app/fulfillment/inbound/v2/{page,FbaInboundV2Wizard}.tsx` operator-facing wizard. Plan list + step tracker + per-step Action button. State polls every 30s.

The legacy v0 surface (plan-shipment + getLabels, both still working) remains unchanged for backward compatibility. The deprecated v0 `putTransportDetails` endpoint stays demoted with the existing "Use Seller Central — v0 deprecated" banner until the operator migrates fully.

**Operator action remaining (not engineering):**
  • Use `/fulfillment/inbound/v2` for new inbound flows. The "New plan" button accepts a name and creates a v2024-03-20 plan against the configured Amazon credentials.
  • F.5 v1 lands an MVP wizard with prompt() dialogs for option-id picks. A richer per-step form UI (option cards with labelled fees / FCs / carrier names) is a follow-up commit when the operator wants the polish.
  • Eventually deprecate the v0 transport form entirely once the operator has stopped using it.

**Original symptom:** Amazon deprecated `PUT /fba/inbound/v0/shipments/{id}/transport` — H.8c verification (2026-05-06) hit the real SP-API and got HTTP 400. The v2024-03-20 flow is multi-step + asynchronous (each call returns an operationId the caller polls). All 9 endpoints + state persistence + UI are now wired.

**Symptom:** H.8c verification (2026-05-06) hit Amazon's real SP-API and got back HTTP 400 with body: *"This API is deprecated. Please migrate to the new Fulfillment Inbound v2024-03-20 APIs."* The route runs end-to-end (test passed because the call landed at Amazon), but operationally the endpoint will not book transport for real shipments.

**Surfaced at:** `scripts/verify-inbound-h8c.mjs` against Railway production.

**Scope of the deprecation (verified empirically this session):**
- ❌ `PUT /fba/inbound/v0/shipments/{id}/transport` — deprecated, returns 400.
- ✅ `POST /fba/inbound/v0/plans` (createInboundShipmentPlan) — H.8a verified, real SP-API errors return on bad SKUs (ASIN validation, etc.).
- ✅ `GET /fba/inbound/v0/shipments/{id}/labels` — H.8b verified, real shipment-not-found error for synthetic ID.
- ✅ `GET /fba/inbound/v0/shipments` (status polling, H.8d) — verified the same session: returns 200 with `ShipmentData`. Deprecation is **selective**, not blanket; the read-side endpoints continue to work.

**Workaround:** None. The H.8a/8b/8c/8d implementations write the right error to logs, banner ("FBA wizard fully wired to SP-API") will mislead operators into thinking transport works.

**Proper fix:** Migrate the FBA Inbound surface to v2024-03-20. This is a structural change, not a port — v2024-03-20 is a multi-step flow:

1. `POST /inbound/fba/2024-03-20/inboundPlans` — createInboundPlan (planId, no shipmentIds yet).
2. `GET .../inboundPlans/{planId}/packingOptions` — list packing options.
3. `POST .../inboundPlans/{planId}/packingOptions/{packingOptionId}/confirmation` — pick one.
4. `POST .../inboundPlans/{planId}/packingInformation` — submit box content.
5. `GET .../inboundPlans/{planId}/placementOptions` — list FC routing options.
6. `POST .../inboundPlans/{planId}/placementOptions/{placementOptionId}/confirmation` — confirm placement, get shipmentIds.
7. `GET .../inboundPlans/{planId}/shipments/{shipmentId}/transportationOptions` — list transport options.
8. `POST .../inboundPlans/{planId}/transportationOptions/confirmation` — book transport.
9. `GET .../inboundPlans/{planId}/shipments/{shipmentId}/labels` — fetch labels.

The flow is asynchronous — each step polls an `operationId` until the operation completes. State persistence is required because the operator can drop off and resume mid-flow. This is roughly H.9 + H.10 of complexity, not a one-commit fix.

**Mitigations applied:**
- Banner update: InboundWorkspace already shows the amber "Plan + Labels + Status polling live · Transport v0 deprecated by Amazon" header (H.8d).
- 2026-05-07: `FbaTransportBooking` form now carries an inline amber notice immediately above the inputs ("Use Seller Central for transport booking — Amazon deprecated the v0 booking endpoint, this form returns 400 in production"). Submit button demoted from primary (slate-900 solid) to secondary outline + label changed to "Try v0 booking (likely fails)" so operators don't waste time on a known-broken action. v0 plan-shipment + getLabels remain the recommended path; transport booking goes through Seller Central until v2024-03-20 lands.

**Estimated effort:** 4–6 commits. State machine rewrite + polling-based operation tracking + UI redesign for the multi-step flow.

**Migration roadmap (phased):**

  1. **F.1 — SP-API client wrappers** (additive). Add `apps/api/src/clients/amazon-fba-inbound-v2.client.ts` with typed wrappers for the 9 v2024-03-20 endpoints. No behaviour change — additive code only. ~1 commit.
  2. **F.2 — Schema for the multi-step plan**. New model `FbaInboundPlanV2` (planId, status, currentStep, operationIds JSON, packingOptionId, placementOptionId, transportationOptionId, shipmentIds[]) + migration. ~1 commit.
  3. **F.3 — Polling service**. `apps/api/src/services/fba-inbound-v2.service.ts` with `pollOperation(operationId)` (per-step polling that yields `{ status, completedAt, error }`) and per-step state transitions. ~1 commit.
  4. **F.4 — Routes**. POST per step + GET plan-state for the UI to drive the flow. ~1 commit.
  5. **F.5 — UI redesign**. Replace the single-form `FbaTransportBooking` with a multi-step wizard surface. Status banners per step. Resume mid-flow on page reload. ~1-2 commits.

Each commit is independently shippable: F.1 alone unblocks anyone who wants to call v2 from a Node script; F.2-F.4 build the backend incrementally; F.5 is the operator-facing reveal.

**Operator-action mitigation in place today:** The InboundWorkspace banner reads "Plan + Labels + Status polling live · Transport v0 deprecated by Amazon"; the FbaTransportBooking form has an inline amber notice ("Use Seller Central for transport booking — Amazon deprecated the v0 booking endpoint, this form returns 400 in production") and the submit button is demoted with the label "Try v0 booking (likely fails)". Operator routes transport bookings through Seller Central until F.5 lands. Plan-shipment + getLabels (the two v0 endpoints that still work) remain the recommended path for non-transport operations.

---

## 52. ✅ Bulk ATTRIBUTE_UPDATE now also writes variantAttributes — resolved 2026-05-08 (M.21)

**Resolution:** Verified the codebase had already retargeted ATTRIBUTE_UPDATE to `Product` (not `ProductVariation`). The handler at `apps/api/src/services/bulk-action.service.ts:processAttributeUpdate` writes either a scalar Product field (allowlist) or a `categoryAttributes.<key>` JSON path. M.21 extends it to also support `variantAttributes.<key>` JSON paths, which mirror categoryAttributes but on the per-child `Product.variantAttributes` column (where Color / Size / material values live for Amazon variation themes).

**Implementation in M.21:**
  • `readProductAttribute()` adds a third branch for `variantAttributes.` prefix returning `kind: 'variantAttribute'`
  • `processAttributeUpdate()` handles the new kind with the same JSON-merge pattern as categoryAttributes
  • `refetchAfterState()` now selects `variantAttributes` so afterState round-trips through audit
  • Rollback automatically works (replays processAttributeUpdate with the captured beforeState)

Operator can now bulk-set `variantAttributes.Color` on a filter of child rows in one bulk op. The OutboundSyncQueue fan-out is unchanged — every linked ChannelListing gets a LISTING_SYNC enqueue with the new attribute value.

**Original symptom (kept for context):** ATTRIBUTE_UPDATE was the last bulk handler that hadn't been retargeted from the empty ProductVariation table to Product. PRICING/INVENTORY/STATUS landed in Commit 1 of the rebuild; ATTRIBUTE was deferred pending a schema decision. M.21's decision: use the existing `Product.variantAttributes` JSON column for variant-level values and `categoryAttributes` for category-level values; no new schema needed.

---

## 53. ✅ Bulk STATUS_UPDATE doesn't propagate to channels — resolved 2026-05-06

**Resolution:** New `apps/api/src/services/master-status.service.ts` mirrors `MasterPriceService` — single entrypoint for `Product.status` mutations. Atomic transaction: `Product.status` → `ChannelListing.listingStatus` (skipping ENDED/ERROR) → `OutboundSyncQueue` (`syncType='STATUS_UPDATE'`) → `AuditLog`. `bulk-action.service.ts:processStatusUpdate` and the rollback STATUS_UPDATE branch now delegate to it. `skipBullMQEnqueue:true` paired with the per-minute cron drain (same workaround as pricing/inventory paths until #54 lands).

**Original symptom (kept for context):** Bulk STATUS_UPDATE wrote `Product.status` directly. No fan-out to ChannelListing, no OutboundSyncQueue enqueue, no AuditLog row. A user marking 50 SKUs INACTIVE in bulk left Amazon/eBay showing them as ACTIVE until the next manual sync — buyers could place orders on items that should be off the shelf.

---

## 54. ✅ BullMQ `Queue.add()` hang — resolved 2026-05-08; workaround swept in `d64ec5a`

**Resolution applied (2026-05-08):** Replaced the lazy
`makeQueueProxy()` wrapping `outboundSyncQueue` + `channelSyncQueue` +
their `QueueEvents` with eager `new Queue(...)` construction at module
load — same pattern `bulk-list.service.ts` has shipped without hangs.
The `redis.connection` getter still defers Redis dial-out until the
property is accessed, which preserves the original Railway boot-
failure protection.

**Workaround swept 2026-05-08 (commit `d64ec5a`):** Removed
`skipBullMQEnqueue?: boolean` from `MasterPriceUpdateContext`,
`MasterStatusUpdateContext`, `StockMovementInput` + 7 callsites that
passed it. Bundled correctness fix: `master-price.service.ts` and
`master-status.service.ts` now auto-skip the post-commit BullMQ
enqueue when `ctx.tx` is supplied (mirrors the existing `!outerTx`
gate in `stock-movement.service.ts:414`) — the caller's outer tx
owns the commit timing, and firing BullMQ from inside an outer tx
that might roll back would queue work against rolled-back rows.

**Production fallback if regression:** OutboundSyncQueue DB rows
still get written inside every transaction. The per-minute cron
worker (`sync.worker.ts → processPendingSyncs`) drains PENDING rows
within ~60s. So even if the post-commit BullMQ enqueue ever fails
or wedges, the data still flows to channels — eventually-consistent.
A regression takes one revert + cron picks up the slack; no data
loss. **Operator validation still recommended:** run a 100-item
bulk PRICING_UPDATE on staging with `ENABLE_QUEUE_WORKERS=1` and
real Redis to confirm no production wedge.

**Why the proxy hung:** `Reflect.get(q, prop, receiver)` inside the
proxy resolved JavaScript getter accessors with `this = receiver =
proxy` rather than the underlying Queue instance. BullMQ's internal
state-reads via getters returned `undefined` from the empty proxy
target, so `Queue.add()` waited for ready/connection events that
never fired. `value.bind(q)` only fixes function-call `this`, not
getter-resolution `this`.

**Verified locally:**
- `/api/health` 200 in <2s post-refactor (no boot wedge from eager
  construction)
- `PATCH /api/products/:id { basePrice }` (the cascading product
  update path that exercises `MasterPriceService.update` →
  `outboundSyncQueue.add()`) returns 200 in ~1.2s; pre-fix it
  hung 20+s
- Returns smoke (26-gate cross-cutting test) still 26/26 — no
  regression elsewhere
- Verification script: `scripts/verify-tech-debt-54.mjs`

**Remaining work:** Operator-side production validation. Run a 100-item
bulk PRICING_UPDATE on staging with real Redis up; watch logs for the
old ~2-min wedge symptom. If the dev-fix doesn't hold for some reason
(different ioredis cluster behavior, etc.), one revert of `d64ec5a`
puts the workaround back and the cron worker still drains the queue
within 60s — no data loss.

---

**Original symptoms (kept for archival context):**

**Symptom (Commit 1, detached):** When `BulkActionService.processJob` (running detached after the route returns 202) calls `MasterPriceService.update`, the in-transaction work completes correctly (AuditLog row written, ChannelListing cascaded, OutboundSyncQueue row inserted), but the post-commit `await outboundSyncQueue.add(...)` never resolves. The bulk-action loop never advances past `processedItems++`. Within ~60–120s the Railway API box becomes unresponsive to /api/health and Railway restarts it.

**Symptom (Commit 3, request-scoped):** New `bulkActionQueue.add(...)` from `enqueueBulkActionJob(jobId)` called inside the `POST /:id/process` route handler ALSO hangs (curl times out after 20s waiting for response). Same hang shape as the detached path. **This invalidated the original "only detached fire-and-forget hangs" hypothesis.**

**Surfaced at:**
- Commit 1 first attempt (commit `9705299`, reverted `5d9617a`) — detached path
- Commit 3 (commit `914525c`, reverted `d675a50`, 2026-05-06) — request-scoped path

**Workaround applied:** Added `skipBullMQEnqueue?: boolean` flag to `MasterPriceUpdateContext` and `StockMovementInput`. Bulk-action passes `true` so the post-commit BullMQ enqueue is skipped. The OutboundSyncQueue *DB rows* still land inside the transaction; the per-minute cron worker (`apps/api/src/workers/sync.worker.ts` → `OutboundSyncService.processPendingSyncs`) drains them on the next tick. Bulk operations are correct and eventually-consistent.

**What we know:**
- The same BullMQ `Queue.add(...)` pattern works fine in `bulk-list.routes.ts` (`enqueueBulkList(...)` from a route handler) — has been in production for some time without hang reports.
- The hang is reproducible from BOTH bulk-action's detached `processJob` AND its request-scoped `POST /:id/process` route handler. So the discriminator is NOT request vs. detached context.
- Both call paths import `BulkActionService` at module top, which imports `MasterPriceService` at module top, which imports `outboundSyncQueue` from `lib/queue.ts`. The `bulkListQueue` is constructed differently — directly at module load via `new Queue(...)`, not via the lazy proxy in `lib/queue.ts`. **This may be the relevant difference.**
- The transaction commits *before* the hang (Commit 1 detached) — DB-side state is correct.
- The hang is severe enough to make the API box unhealthy (502s for ~4 min until Railway restart). Single hung promise on Node shouldn't block the event loop; something downstream is wedging the process.

**Updated hypotheses (after Commit 3 evidence):**
1. The lazy `Queue` proxy in `lib/queue.ts` (`makeQueueProxy(getOutboundSyncQueue)`) interacts badly when the bulk-action service module-load chain triggers initialization in a way that bulk-list's eager `new Queue(...)` does not.
2. ioredis connection options: bulk-action's `redis.connection` getter resolves at every property access; bulk-list captures the resolved client at module load. Maybe there's a stale connection reference.
3. Something specific to the `bulkActionQueue` queue name / metadata in Redis (orphan job state from an earlier failed attempt) — but Commit 3 was the first to use that queue name, so unlikely.
4. `Queue.add()`'s `{ jobId: <our id> }` option doing something problematic when our id matches an existing BullMQ job in `completed` / `failed` state still in Redis. Unlikely first time.

**Proper fix:** instrument with logging *inside* the BullMQ `Queue.add` call (or use BullMQ's debug logging) to see exactly where it stalls. Test on a feature branch with the lazy-proxy queue replaced by an eager one (mirror bulk-list's pattern) — if that fixes it, the root cause is in the proxy.

**Risk if left as-is:** Bulk operations work via fire-and-forget in-process execution (skipBullMQEnqueue: true) — eventually-consistent through the cron worker. We cannot move bulk-action to its own BullMQ queue (Commit 3 of the rebuild) until this is fixed, which means we lose the crash-recovery property (if Railway restarts the API mid-job, BulkActionJob row stays IN_PROGRESS forever) and mid-run cancel.

---

## 55. ⏸ Bulk resync needs an inbound queue (S.4 scope) — design-blocked, mitigated 2026-05-08

**Status update:** Operator-impact bounded today. Xavia has 8 listings in production; M.5 single-listing resync (V.2 inline action) and bulk resync from the matrix (M.5 — fan-out via per-cell `/resync` calls) cover all current usage. The "in-memory Map silently reports Done after 60s" failure mode requires >50 listings on a single bulk call, which Xavia hasn't hit and won't until the catalog scales 10×.

**Decision needed for the proper fix** (gating S.4 implementation):
  • **Option 1**: Repurpose `OutboundSyncQueue` with a new `INBOUND_REFRESH` `syncType`. Reuses existing cron worker + retry logic + `holdUntil` grace.
  • **Option 2**: Sibling `InboundSyncQueue` table. Cleaner separation of concerns, small migration cost.

Each option carries multi-commit work (new model or column, channel adapter inbound primitives, cron worker wiring, bulk-action route refactor, UI updates). Both are deferred until either (a) the catalog crosses ~50 listings or (b) operator reports the failure mode.

**Symptom (kept for context):** S.0 wired `POST /api/listings/:id/resync` as a synchronous inline pull from the channel adapter — solves the single-listing case. The bulk-action endpoint at `/api/listings/bulk-action` still routes resync through the in-memory `BULK_JOBS` Map, which loses state on API restart.

**Surfaced at:** Phase 1 syndication audit + S.0 design review (2026-05-07).

**Workaround applied:** S.0 single-listing resync works correctly. Bulk resync is currently a no-op for >50 listings (the in-memory Map's 60s polling timeout will silently report "Done" without finishing).

**Proper fix (planned for S.4):** Two viable shapes:

1. **Repurpose `OutboundSyncQueue`** with a new `INBOUND_REFRESH` syncType. Cleanest reuse of existing infrastructure (cron worker, retry logic, holdUntil grace) but bends the queue's mental model from "outbound mutation queue" to "bidirectional sync queue".
2. **Sibling `InboundSyncQueue` table.** Dedicated to pull-style operations. Cleaner separation of concerns; small migration.

Either way, also requires fleshing out the channel adapters' inbound primitives (Amazon's `getListingState` exists per S.0; eBay/Shopify/WooCommerce/Etsy need similar). Deciding which approach to use is part of S.4's design phase.

**Risk if left:** Bulk operations on >50 listings silently fail. Operator sees "Done" but nothing happened. Currently low-impact (8 listings in DB) but blocks scaling to real Xavia volume.

---

## 56. ✅ OutboundSyncService.syncTo* — resolved 2026-05-07/08 in C.8

**Resolution:** All four methods replaced their `Math.random()` simulator with real behaviour:

  • **`syncToAmazon`** — calls `submitListingPayload` (SP-API `putListingsItem` / `patchListingsItem` via the publish gate from C.6). Live HTTP when `NEXUS_ENABLE_AMAZON_PUBLISH=true && AMAZON_PUBLISH_MODE=live`.
  • **`syncToEbay`** — calls `createOrReplaceInventoryItem` (eBay Inventory API) gated by C.7 (`NEXUS_ENABLE_EBAY_PUBLISH` + `EBAY_PUBLISH_MODE`).
  • **`syncToShopify`** — honest `NOT_IMPLEMENTED` gate. Returns FAILED with a clear "not yet wired — see roadmap C.18" message and writes a `gated` ChannelPublishAttempt row. No more phantom 90% success.
  • **`syncToWoocommerce`** — same shape as Shopify; honest gate. Per memory `project_active_channels.md`, WooCommerce is explicitly out of scope, so this stays gated indefinitely.

The honest gate for Shopify / WooCommerce is the right answer for the "currently unwired but on the channel scope" case (Shopify) and the "out of scope" case (WooCommerce / Etsy). Master/channel drift can no longer be papered over by a fake green tick.

---

## 57. ⏸ Syndication channels — scope decision finalised 2026-05-08

**Active channel scope (per project memory):** Amazon + eBay + **Shopify**. WooCommerce + Etsy are out of scope for the foreseeable future.

**Status by channel:**
  • **AMAZON** (S.5) — shipped, used in production
  • **EBAY** (S.6) — shipped, used in production
  • **SHOPIFY** — partial. M.1 multi-marketplace AI generator includes it as a target channel; the `/listings/shopify` page route stub is in place. ChannelListing rows for SHOPIFY would be created via the listing wizard once an operator configures a Shopify connection. No deep view (S.7-equivalent) is planned until usage data justifies it.
  • **WOOCOMMERCE / ETSY** — explicitly skipped (memory: project_active_channels.md). All Etsy/Woo references in the codebase are dead code; safe to delete or leave dormant.

**Trigger to revive WooCommerce / Etsy:** Operator says "we're going to start selling on {channel}." Until then, no work justified.

**Trigger to deepen Shopify:** Operator creates the first SHOPIFY ChannelListing via the wizard. At that point, ship the equivalent of S.5 (Amazon deep view) for Shopify — KPI strip, order-driven inventory hooks, Shopify-specific drawer section, etc.

**Trigger to revive:** Operator says "we're going to start selling on {channel}" or DB shows ChannelListings being created for the channel through any path.

**Risk if left:** None — explicit YAGNI. The trade-off is more depth for Amazon (S.5) and eBay (S.6).

---

## 58. 🟢 ChannelListingOverride system unused — validate before S.12

**Symptom:** Phase 1 audit DB query confirms `ChannelListingOverride` table has 0 rows. The schema is in place (audit trail per-field, undo history), but no code path writes to it. The override toggles on `ChannelListing` (`followMasterPrice`, `followMasterTitle`, etc.) are also in place but operator has never used them.

**Surfaced at:** Phase 1 syndication audit (2026-05-07).

**Why it matters:** S.12 ("Bulk content management — per-marketplace override management") is on the roadmap. Before building UX muscle for an unused feature, validate that overrides are actually a thing operators want.

**Validation plan:** After S.5 (Amazon deep view) and S.6 (eBay deep view), check `ChannelListingOverride` row count. If still zero, drop S.12 entirely and document. If non-zero, S.12 ships normally.

**Don't kill the schema.** It's in place and not hurting anything; deletion only after confirmed unused for 3+ months.

**Risk if left:** None. Either the schema validates on use, or it's quietly unused — both are fine.

---

## 59. ⏸ S.24 / S.25 crons need explicit Railway opt-in

The S.24 (Amazon MCF status sync, every 15 min) and S.25 (FBA Pan-EU
distribution sync, daily 03:00) crons ship OFF by default, gated on:

- `NEXUS_ENABLE_MCF_SYNC_CRON=1`
- `NEXUS_ENABLE_FBA_PAN_EU_CRON=1`

Until those are flipped on the Railway API service, the relevant
data tables (`MCFShipment`, `FbaInventoryDetail`) won't refresh and
the new `/fulfillment/stock/mcf` + `/fulfillment/stock/fba-pan-eu`
surfaces will display whatever state the operator created manually
(or empty).

**Why it's gated:** SP-API rate limits + concern about quietly
burning Amazon MWS quota during dev/staging when the data isn't
being acted on yet.

**How to apply:** flip each env var to `1` on Railway when the
operator is ready to start observing channel state. Both adapters
are idempotent — replays don't create duplicates.

**Risk if left:** stale data, but no incorrectness. Operator-action.

---

## 60. ✅ Stock surface — resolved 2026-05-08 (S.30 docs commit)

Stock domain (S.1–S.30) shipped fully and is documented in
`DEVELOPMENT.md`'s "Stock — workspace expansion (S.1–S.30)"
section. Master verify harness at `scripts/verify-stock-all.mjs`
runs all per-commit gates (29 passed, 1 skipped — verify-s1
needs API up).

---

## Triage summary

**🔴 P0 — tackle next:**
- **0** ✅ Schema-migration drift gate landed 2026-05-02 (script + npm script + .githooks/pre-push). Allow-list down to 0 as of S.0 (DraftListing migrated 2026-05-07). **#37 is the column-level escalation.**
- **37** ✅ Resolved 2026-05-07 — `check-column-drift.mjs` wired into pre-push + root `check:drift`. Catches column-level drift via migration-SQL parsing (no shadow DB needed). 113/113 tables clean with 2 known SyncLog allow-list entries. Original shadow-DB approach kept as a future heavyweight option for type/constraint drift.
- **50** FBA Inbound v0 putTransportDetails deprecated — Amazon returns 400 on the real call. Migrate to v2024-03-20 (multi-step flow). Banner is misleading until then.
- **8** ✅ Resolved 2026-05-02 — verified GTIN wizard validator was already on the correct ProductImage relation; deleted the orphan `Image` model + dead Express service & route (~1,213 lines). Demoted to P2 for the remaining UX polish.
- **27** ✅ Resolved 2026-05-02 — TerminologyPreference table + CRUD API + AI prompt injection + admin UI at `/settings/terminology`. Seeded with 7 Xavia/IT entries (Giacca, Pantaloni, Casco, Stivali, Protezioni, Pelle, Rete). Verify post-deploy that "Giacca" wins consistently in regenerations; add new preferences inline as drift surfaces.
- **31** ✅ Resolved 2026-05-03 — migration `20260503_p0_31_channel_connection` adds the table + fixes substantial column-level drift on `VariantChannelListing` surfaced by the audit. eBay auth + listing flows are now operational; orders flow has separate refactor work tracked at #33.
- **42** ✅ Resolved 2026-05-06 — Master-price + master-stock cascade architecture shipped as Phase 13 (commits 3714dff, e2e92d2, a92e82a, 7c59ae9, d6d1f55). Live-verified end-to-end against production. New worker-side quirks moved to #48 + #49.

**🟡 P1 — backlog (informed by real usage):**
- **1** `@fastify/compress` empty body on `/api/orders` (workaround in place)
- **2** Prisma in server components (workaround in place; pattern fix needs a sweep)
- **3** ✅ Resolved 2026-05-06 — `/logs`, `/monitoring/sync`, `/settings` all redirect to the canonical sidebar targets.
- **6** SheetJS CVE — mitigations real, but worth swapping to `exceljs`
- **17** `/products` URL state for filters / sort / page
- **18** `/products` bulk-edit-in-place
- **25** Bulk-ops undo across saves (real user request)
- **26** ✅ Resolved 2026-05-06 in c672ff8 — right-click cancel + affordance hint added; Esc cancel was already wired.
- **28** Listing wizard multi-marketplace apply — was P2 #13, **promoted** based on usage signal
- **29** `/products` "needs photos" filter (and sibling hygiene filters)
- **30** `/products` show + filter by category / productType
- **33** ✅ Resolved 2026-05-08 — `ebay-orders.service.ts:processOrder` rewritten for Phase 26 unified `Order` model: `channelOrderId`, `totalPrice`, `currencyCode`, `customerName`, `customerEmail`, `purchaseDate`, plus eBay-specific fields packed into `ebayMetadata` JSON. Idempotent upsert on (channel, channelOrderId). See body of #33 for the field mapping table.
- **34** Bulk operations Path A-Lite deferrals — rollback, `LISTING_SYNC` handler, queue infra for big jobs, `DELETE` action, "selected items" scope
- **35** Listing wizard — channel publish adapters all NOT_IMPLEMENTED (Phase J orchestrator + `/submit` + `/poll` + `/retry` are real; only `ChannelPublishService.publishToChannel()` per-platform branches need real implementations: Amazon `putListingsItem`, Shopify wiring of existing `createProduct`, WooCommerce create, eBay Phase 2A)
- **36** Dedicated image-manager page at `/products/:id/images`
- **38** Audit `IF NOT EXISTS` patterns in migrations — silent-on-collision is what hid the Return table drift; sweep + tighten policy — Phase F shipped the wizard step as a quick-reorder + per-channel validation summary only, with the full multi-scope (GLOBAL/PLATFORM/MARKETPLACE) + variation-aware ListingImage editing deferred to a standalone page. The schema, resolution cascade, and validation service are already in place; the page itself + upload service + dnd-kit drag-to-reorder are the remaining work.
- **43** Variant mechanism duplication — `Product.parentId` vs unused `ProductVariation`. 244 active children via parentId, 0 in ProductVariation. Decision needed before bulk-ops can be fixed at scale.
- **44** Bulk operations target unused data shape — partially resolved 2026-05-06 in Commit 1 of bulk-ops rebuild (PRICING + INVENTORY retargeted to Product via master-cascade). ATTRIBUTE_UPDATE remaining → see #52.
- **52** Bulk ATTRIBUTE_UPDATE still targets empty ProductVariation — silent no-op against current data; needs schema decision on where variant attributes live on Product.
- **53** ✅ Resolved 2026-05-06 — `MasterStatusService` shipped, `bulk-action.service.ts` `processStatusUpdate` + STATUS_UPDATE rollback both delegate to it; cascade fans out to ChannelListing + OutboundSyncQueue + AuditLog.
- **54** ✅ Resolved 2026-05-08 in `d64ec5a` — root cause was a JS Proxy `Reflect.get`-on-getter issue that returned `undefined` from BullMQ's internal state reads, making `Queue.add()` wait forever. Replaced lazy proxy with eager `new Queue(...)` in `lib/queue.ts`; swept the `skipBullMQEnqueue` workaround flag from 7 callsites + 3 service input types. Bundled correctness fix: master-price + master-status auto-skip post-commit BullMQ enqueue when `ctx.tx` is supplied (mirrors stock-movement's existing `!outerTx` gate). Operator-side prod validation still recommended.
- **45** Local apps/api Prisma client v6 vs v7 mismatch — local dev API can't serve Prisma queries; production unaffected. Onboarding blocker.
- **48** ✅ Resolved 2026-05-06 in `e55ed37` — Phase 28 recompute now honours `followMasterPrice`.
- **49** ✅ Resolved 2026-05-06 in `e55ed37` — `processPendingSyncs` now filters by `holdUntil`.
- **55** Bulk resync needs an inbound queue — single-listing inline pull shipped in S.0; bulk path defers to S.4
- **57** Syndication channels deferred (Shopify/WooCommerce/Etsy) — Phase 1 audit confirmed zero usage; stubs sufficient until operator triggers

**🟢 P2 — when in the area:**
- **4** CategorySchema "unknown" rows
- **5** Bulk-ops paste yellow-tint cosmetic
- **7** D.5.5 ZIP image / channel / variant features
- **8** Upload-from-wizard image control for GTIN Step 2 (UX polish; validator itself works)
- **9–16** Phase 5.4 & 5.5 follow-ups (vision checks, implicit approval, rejection-fix loop, email inbox, telemetry, scoring, A+ content)
- **19** `/products` single-product create form
- **20** Faceted search counts
- **21** `/api/products/:id` for the edit page
- **22** Derived-column sort
- **23–24** `/inventory` sub-routes URL migration + legacy component cleanup
- **32** ✅ Resolved 2026-05-07 in S.0 — DraftListing migration shipped; eBay AI generator no longer crashes. Allow-list entry removed.
- **39** Per-seller primary marketplace setting — replaces hardcoded `'IT'` in E.9 backfill + future resolver fallbacks; needed once Nexus serves a second tenant
- **40** SP-API variation attribute mapping seed — auto-populate `ChannelListing.variationMapping` from `getProductTypeDefinitions` once a real publish lands; tied to #35
- **41** Order-driven stock decrement — fulfillment-method-aware location routing (FBA → `AMAZON-EU-FBA`, rest → `IT-MAIN`); promote to 🔴 once real orders flow
- **42** No test framework — Vitest + integration tests for stock-movement audit / reservations / cascade; smoke at `scripts/verify-stock.mjs` covers stock surface only
- **43** eBay/Shopify inbound stock sync — only Amazon FBA has inbound today; outbound cascade covers writes from Nexus → channel
- **44** Saved views + column reorder/resize on /fulfillment/stock — URL state covers the common case; dnd-kit + UserView model when explicitly asked
- **46** `Channel` table empty + `ChannelListing.channel` is a string — implicit FK contract; populate + migrate to real FK, or delete the table to make the contract explicit. Tied to multi-tenant readiness.
- **47** ✅ Resolved 2026-05-06 — Vercel auto-deploy gap was a routing confusion; production URL is `nexus-commerce-three.vercel.app` not `nexus-commerce.vercel.app`. Documented for future audits.
- **56** ✅ Resolved 2026-05-07 in C.8 — Math.random stubs replaced with real Amazon submitListingPayload + eBay createOrReplaceInventoryItem (gated by NEXUS_ENABLE_<CH>_PUBLISH); Shopify/Woo become honest NOT_IMPLEMENTED until Wave 6.
- **58** ChannelListingOverride system unused — validation gate before committing to S.12; check row count after S.5/S.6

---

## Commit-attribution notes

Place to record when a roadmap commit landed under a different commit
message than the one its diff describes. Useful for `git log | grep`
searches that come up empty otherwise.

- **C.9 — Matrix v2 (side-by-side cross-channel diff)** shipped in
  `6c916d8 O.19: outbound late-shipment risk cron`. The O.19 commit
  bundled the C.9 diff (32 LOC backend + 261 LOC frontend) alongside
  the actual late-shipment cron work. Functionality is correct: the
  Matrix lens now renders the Master reference column, DriftBadge for
  price/qty/title divergence, two-column tooltip, and row-hover ring.
  See `apps/web/src/app/listings/ListingsWorkspace.tsx` (`MasterCell`,
  `DriftBadge`) and `apps/api/src/routes/listings-syndication.routes.ts`
  matrix handler (added `title`, `masterTitle`, `masterPriceForCompare`,
  `masterQuantityForCompare`).

- **C.10 — Drawer cross-channel comparison panel + per-marketplace
  overrides** shipped in `1dcdf06 C.7: cross-page event taxonomy —
  wizard.created emission + listing.created on publish`. The 1dcdf06
  commit bundled the C.10 diff (35 LOC backend + 200 LOC frontend)
  alongside an unrelated cross-page event-taxonomy refactor; the
  commit message confusingly reuses the "C.7" label even though the
  syndication roadmap's C.7 (eBay AddItem gating) shipped earlier as
  `0646b6d`. C.10 changes:
  - `apps/api/src/routes/listings-syndication.routes.ts` drawer
    endpoint companions select extended with `title`, `titleOverride`,
    `masterTitle`, `masterPrice`, `masterQuantity`, `priceOverride`,
    `quantityOverride`, `followMaster*` flags. Each companion now
    carries `hasPriceOverride` / `hasQuantityOverride` /
    `hasTitleOverride` derived booleans.
  - `apps/web/src/app/listings/ListingsWorkspace.tsx` `ChannelsTab`
    rebuilt: `ComparisonMasterCard` anchors the stack; `CompanionCard`
    renders DriftBadge for price/qty inline, title row with mismatch
    pill, `OverridePill` for explicit per-marketplace overrides.

- **C.12 — Italian i18n sweep on /listings** shipped in two parallel-
  agent commits: `52aff10` (parallel "C.10: AI provider switching +
  cost tracking UI on the wizard" — bundled the 200-LOC ListingsWorkspace
  i18n wrap-up: useTranslations() in LensTabs, MatrixLens, BulkActionBar,
  SavedViewsButton, ChannelsTab, ComparisonMasterCard, OverridePill,
  CompanionCard) and `43e8d7a` (parallel "O.27: saved views on Pending
  tab" — bundled the ~70 listings.* keys per catalog in en.json + it.json,
  Italian translations of lens names ("Griglia"/"Stato"/"Matrice"/"Bozze"),
  filter labels, action buttons, drift/override pills, save view dialog).
  Functionality is correct — switching locale on /listings now flips
  every operator-facing string except per-row dynamic content
  (status enum keys, marketplace codes, channel names — all proper
  nouns or operational keys that intentionally stay English).

- **C.17 — Markdown manager (+ Best Offer / auto-relist placeholders)**
  shipped in `dedf226 O.39: audit log on shipment lifecycle events`.
  Parallel-agent commit bundled the 211-LOC backend CRUD on
  `EbayMarkdown` plus the 581-LOC `EbayMarkdownsClient` plus the
  page route plus the EbayListingsClient KPI-tile-to-Link enhancement,
  even though O.39's stated scope is shipment audit logging.
  Functionally correct: `/listings/ebay/markdowns` renders, the
  create modal with debounced listing search + live discount preview
  works, status transitions enforce the terminal-rule, KPI tile is
  clickable. Best Offer + auto-relist surfaced as honest placeholders
  pending ChannelListing schema additions.

- **Note on collision pattern**: 4 of 8 second-half-roadmap commits
  got bundled (C.9, C.10, C.12, C.17). Counter-examples that shipped
  under their own commit: C.11 saved views, C.14 schema, C.15 eBay
  overlay, C.16 campaigns. No clean predictor — not size, not
  standalone-vs-edit-existing, not domain. The pattern: parallel
  agents staging via `git add -A` (or equivalent) sweep up my
  uncommitted work into their own commits, attaching it to whatever
  commit message they happened to be writing. Worth investigating
  the multi-agent staging behavior before it bites again. Three
  different "C.10" commits and two different "C.7"s exist in the
  session log; `git log | grep C\.` is no longer a reliable index
  of the syndication roadmap.

---

## Syndication roadmap — final status (2026-05-07)

The 22-commit syndication rebuild approved on 2026-05-07 closes
here. Active channel scope per `project_active_channels.md` memory:
**Amazon + eBay + Shopify**. WooCommerce + Etsy explicitly out of
scope — overlay clients reverted in `457fce7`, backend endpoints
left dormant for if/when they come back into scope.

**Shipped (20 of 22 commits, all functionally complete):**

  - **Wave 1 — Foundation truth-telling (5/5):** C.1 listing.created
    emit on publish path, C.2 AppSidebar invalidation listener,
    C.3 webhook→SSE bridge (Shopify/Etsy), C.4 dashboard alerts
    channel-aware deep links + ERROR-status fix, C.5 bulk-destructive
    confirm + 30s undo grace.
  - **Wave 2 — Real channel writes, gated (3/3):** C.6 Amazon SP-API
    publish gate (NEXUS_ENABLE_AMAZON_PUBLISH + AMAZON_PUBLISH_MODE +
    rate limiter + circuit breaker + ChannelPublishAttempt audit log),
    C.7 eBay AddItem gate (mirror; reuses ChannelPublishAttempt),
    C.8 outbound-sync Math.random replacement (real Amazon
    submitListingPayload + eBay createOrReplaceInventoryItem;
    Shopify/Woo become honest NOT_IMPLEMENTED with reason).
  - **Wave 3 — Cornerstone (2/2):** C.9 Matrix v2 with master
    reference column + always-on price/qty/title drift + two-column
    tooltip + row-hover ring (bundled in `6c916d8`), C.10 drawer
    cross-channel comparison panel + per-marketplace overrides
    (bundled in `1dcdf06`).
  - **Wave 4 — Polish (2/3):** C.11 saved views (`20fe6f5`),
    C.12 Italian i18n sweep (~70 keys × 2 catalogs, bundled across
    `52aff10` + `43e8d7a`), **C.13 mobile responsive skipped** per
    user direction.
  - **Wave 5 — eBay Path B (4/4):** C.14 schema (EbayCampaign +
    EbayWatcherStats + EbayMarkdown), C.15 /listings/ebay overlay
    (5-tile KPI strip, marketplace tabs IT/DE/ES/FR/UK), C.16
    Promoted Listings campaign manager (CRUD + create modal),
    C.17 markdown manager (CRUD + listing-search modal + Best Offer/
    auto-relist placeholders, bundled in `dedf226`).
  - **Wave 6 — Path A (1/3 active):** C.18 Shopify overlay
    (`a00683d`). **C.19 WooCommerce + C.20 Etsy reverted** in
    `457fce7` per scope narrowing.
  - **Wave 7 — AI rebuild + verify (2/2):** C.21 /listings/generate
    rebuild (multi-channel, provider switching, cost tracking,
    listing-content service), C.22 verification + a11y sweep + this
    doc note.

**Defaults still gated:** every channel write surface (wizard publish
+ outbound sync) defaults to `NEXUS_ENABLE_<CHANNEL>_PUBLISH=false`
+ `<CHANNEL>_PUBLISH_MODE=dry-run`. Zero risk of accidental real
publishes until the operator opts in via Railway env vars.

**Verification phase (Phase B per the user's H.1 protocol):** still
in operator's lane — sandbox creds, dry-run wizards, audit-log
review against the ChannelPublishAttempt table, graduated rollout
(canary → 5 → 25 → full catalog) for live writes. Code is ready;
operational verification isn't something I can drive from here.

**Known carryovers / explicit deferrals:**

  - eBay Marketing API real push for Promoted Listings campaigns —
    C.16 created the local CRUD + UI, but actual push to
    `/sell/marketing/v1/ad_campaign` stays gated behind
    NEXUS_ENABLE_EBAY_PUBLISH and lands as a follow-up.
  - eBay promotion API push for markdowns — same shape as above.
  - Best Offer + auto-relist controls — placeholder in C.17;
    needs new ChannelListing columns (bestOfferEnabled,
    autoRelistCount).
  - Mobile responsive sweep (originally C.13) — skipped per
    direction. iPad usability of the matrix view + drawers is
    operational debt for when Awa flags friction.
  - A/B variant comparison UI in /listings/generate — service
    supports the `variant` parameter; UI defaults to variant=0.
    Surface lands when operators want side-by-side comparison.
  - Save-as-draft + multi-channel publish from /listings/generate —
    output is ephemeral (copy → paste into wizard or product
    editor); persistent draft model would need a generic
    DraftListing schema replacing the eBay-specific one.

---

## 61. 🟢 Backend TODOs swept from the QA audit (2026-05-09)

**Symptom:** The QA audit (U.61–U.66) catalogued 10 active TODO comments
in `apps/api/src` after filtering false positives (XXX placeholders in
URL examples, XS/XL size-string constants). All are deferred external-
API integrations or future-work markers — none are production bugs and
none have a behavioural impact on shipped surfaces today.

**Inventory** (group by theme):

  - **SP-API mock adapters** — three job/route handlers mock SP-API
    responses today and have a TODO to wire the real client when the
    SP-API enablement work lands:
    * `jobs/fba-pan-eu-sync.job.ts:32` — FBA Pan-EU sync
    * `jobs/amazon-mcf-status.job.ts:31` — MCF status poll
    * `routes/stock.routes.ts:35` — MCF pre-flight commit
    All three use the same mock shape the unit tests do, so the cutover
    is "swap the import" once SP-API creds + scopes are provisioned.

  - **Repricing competitor + Buy Box data** —
    `routes/repricing.ts:260,261` returns `undefined` for
    `competitorPrice` and `buyBoxPrice`. Real fetch is gated on the
    Amazon SP-API GetCompetitivePricing endpoint. UI tolerates `undefined`
    (renders "—").

  - **Deferred allocations & catalog services**:
    * `routes/inventory.ts:389` — velocity-based allocation. Falls back
      to even split today.
    * `services/amazon-catalog.service.ts:323` — SP-API product types
      endpoint. Service uses cached/manual list.

  - **Deferred maintenance**:
    * `routes/products-catalog.routes.ts:1319` — soft-delete cleanup
      cron for rows past 30-day retention. Rows accumulate; harmless.

  - **Deferred alerting integrations**:
    * `services/alert.service.ts:197` — production integration markers
      (Slack/email/PagerDuty channels)
    * `services/monitoring/alert.service.ts:281` — store alerts in DB
      (currently in-memory only)

**Workaround applied:** None — every TODO has a working fallback (mock
adapter, undefined-tolerant UI, manual list, in-memory store). No
end-user impact today.

**Proper fix:** Each item is a follow-up gated on external work (SP-API
creds, Slack workspace, etc.). Re-triage when the upstream unblocks.
Leaving the TODO comments in place so `grep "TODO" apps/api` still
surfaces them — the goal of this entry is to inventory + assert they're
known + deferred, not to remove them.
