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

## 1.legacy 🟡 `@fastify/compress` empty-body bug on `/api/orders` list (kept for history)

**Symptom:** `GET /api/orders?page=...&limit=...` returns `200` with `content-encoding: gzip` and `content-length: 0` (empty body) when the client requests gzip. The same payload returns 6+ KB of JSON when `Accept-Encoding: identity` is sent.

**Surfaced at:** Vercel SSR of `/orders` 500'd because `await listRes.json()` saw an empty string.

**Other endpoints affected:** Just this one as far as we've verified. `/api/orders/stats`, `/api/categories/schema`, `/api/products/bulk-fetch`, `/api/pim/fields` all compress correctly. The orders list is also the only route that hands a Prisma result with nested `items` + Decimal `totalPrice` straight into `reply.send()`.

**Workaround:** `apps/web/src/app/orders/page.tsx` requests `Accept-Encoding: identity` on the list call and parses defensively.

**Proper fix:** Reproduce locally with `curl --compressed`, then either:
- Disable global compression and opt-in per route, or
- Change the orders route to `return { … }` instead of `reply.status(200).send(…)` and verify, or
- Pin or upgrade `@fastify/compress` and add a regression test.

## 2. 🟡 Prisma direct calls from Next.js server components 500 on Vercel

**Symptom:** `/settings/account` returned 500 from Vercel SSR. Page component calls `prisma.accountSettings.findFirst()` directly inside `async function AccountSettingsPage()`. Same shape as several other pages.

**Workaround:** `apps/web/src/app/settings/account/page.tsx` wraps the call in `try/catch` and renders an empty form on failure.

**Proper fix (pattern):** Web app should not import `@nexus/database` from server components. Move the query behind an API endpoint (`GET /api/settings/account`) and have the page `fetch(getBackendUrl() + '/api/settings/account')`. This is a project-wide pattern fix — sweep `apps/web/src/app` for `import { prisma } from '@nexus/database'` in `page.tsx` files and route them through the API.

## 3. ✅ Out-of-scope orphan routes — resolved 2026-05-06

**Resolution:** Each orphan now redirects to the canonical surface — server-side `redirect()` from `next/navigation`, so any external link or bookmark lands on the live page instead of a 4xx/5xx.

| Route | Resolution |
|---|---|
| `/logs` | Redirects to `/sync-logs`. The original Prisma-in-server-component page deleted along with its `SyncLogDetails` companion. |
| `/monitoring/sync` | Redirects to `/dashboard/health` (canonical sync-health surface — Cron / StockDrift / Conflicts / Vitals / SystemLogs panels). |
| `/settings` (root) | Redirects to `/settings/account` (the sidebar's "Settings" link target). |

## 4. 🟢 `CategorySchema` rows with `schemaVersion: "unknown"`

**Symptom:** First D.3f deployment used the wrong path (`meta.version`) when reading the SP-API envelope. Each fetched type wrote one row with `schemaVersion = "unknown"`. After the path fix, those rows are still in the DB; they sit at the bottom of the per-`(channel, marketplace, productType)` ordering and never get returned (the real-version row always wins on `fetchedAt desc`), but they take up a unique-constraint slot.

**Workaround:** None — just orphans. They expire 24h after creation and don't break anything.

**Proper fix:** Either let them age out and run a one-shot `DELETE FROM "CategorySchema" WHERE "schemaVersion" = 'unknown'` at any point, or accept and ignore. Worth a single cleanup migration if we touch this area again.

## 5. 🟢 Bulk-ops paste: scrolled-out cells don't show the yellow tint

**Symptom:** When a paste operation targets cells that are currently virtualised out of view (rowVirtualizer hasn't rendered them), only the changes Map gets the entry — the EditableCell's local `draftValue` doesn't get updated because the cell isn't mounted, so its `applyValue` handler isn't in the registry. When the user scrolls back to those cells, they re-mount with `initialValue` from the unsaved products array and `isDirty` evaluates false — no yellow tint, even though a save would still flush them.

**Surfaced at:** Step 4 (paste with preview).

**Workaround:** None for now. The user sees yellow on visible cells immediately and the save still applies all changes (visible + scrolled-out). The mismatch is purely cosmetic and disappears after a save.

**Proper fix:** Pass a `pendingValue` prop down to EditableCell when there's an entry in the changes Map for it. EditableCell's `useState(() => …)` initialiser seeds `draftValue` from `pendingValue ?? initialValue` so the yellow tint shows on first mount. Memo comparator already includes the relevant fields; one extra prop keyed on cellKey is enough.

## 6. 🟡 SheetJS (`xlsx`) CVE-2023-30533 + maintenance posture

**Symptom / risk:** `xlsx` is used in D.4 (bulk CSV/XLSX upload) to parse user-provided spreadsheets. CVE-2023-30533 is a prototype-pollution issue in older versions; the package's maintenance moved to a CDN/commercial track and the npm tarball is no longer the maintainer's preferred distribution.

**Surfaced at:** D.4 dependency install (`npm audit` flagged it).

**Workaround / current mitigations:**
- Parse-only path on authenticated user input (no `eval`, no dynamic property assignment).
- 50 MB / 50,000 row caps enforced by `@fastify/multipart` config + the upload service.
- The parse result is normalised through the same field-registry validation as the rest of the bulk API, so a malicious cell can't slip through to Prisma as an attacker-controlled key.

**Proper fix:** Replace with `exceljs` (MIT, actively maintained) when we have time to swap. `exceljs` has a slightly different API but supports CSV + XLSX with the same row-shape we need.

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

## 17. 🟡 /products → URL state for filters / search / sort / page

The new `/products` browse page keeps all filter / search / sort / page state in client React state. That means a filtered view can't be shared via link, browser back / forward doesn't round-trip filter changes, and opening "the same page in a new tab" loses the user's context.

**Proper fix:** mirror state to `searchParams` via `useSearchParams` + `router.replace` (or a Next App Router parallel-route URL state lib). Has to be designed carefully so the server-rendered first paint can also read the params and the client doesn't refetch immediately on hydration.

Deferred until at least one user asks for a shareable filtered view.

## 18. 🟡 /products → bulk edit in place

The selection bar exposes **Export CSV** only. Bulk-edit-in-place — select 50 rows, click "Set price", set value, save — is the obvious next feature but needs the same `PATCH /api/products/bulk` endpoint, per-cell validation, optimistic update path, and undo stack as the bulk-operations grid. Pulling that out cleanly into a reusable hook is the prerequisite work; until then v1 punts users to the existing bulk-operations grid.

## 19. 🟢 /products → single-product create form

"New product" routes to `/bulk-operations#upload` for v1. A form-based one-product creator (SKU, name, brand, base price, initial stock, images) is a deferred design — the bulk-operations flow handles single-product paste fine, and the CSV / XLSX path covers everything else.

Worth designing once we have a clear "from scratch, no upload" use case (e.g. a brand owner adding a single SKU at a time).

## 20. 🟢 /products → faceted search counts

Filter dropdowns currently list options without counts ("Active" / "Draft" / "Inactive", not "Active (1,247)"). Real faceting needs a second aggregate query per filter axis (or one query with `groupBy` over each), and care to make sure the counts respect the *other* active filters. Not worth it until users actually ask "how many drafts do I have right now."

## 21. 🟢 /products → API endpoint for products edit page

`/products/[id]/edit/page.tsx` still fetches `${backend}/api/inventory/${id}` — the old endpoint. The browse page moved to `/api/products`, but the per-product GET was left on the legacy route to avoid cascading the migration.

**Proper fix:** add `GET /api/products/:id` and switch the edit page over. Low-risk because the response shape is already well-known; just file moves and route registration.

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

## 25. 🟡 Bulk-ops: undo across saves

**Friction:** "Wished I could undo last save (history clears on save)."

The undo / redo stack lives entirely in the in-memory grid; once Save flushes to the DB the stack is reset. Real users save partway through a session and then realise they want to roll back the previous batch.

**Proper fix:** persist the last N (3? 10?) successful `BulkOperation` rows as undo points. The grid already writes a `BulkOperation` audit row per save with the full `validated` change list and pre-existing values would need to be captured at apply time. UI: a "Recently saved → Undo last save" entry above the existing in-session undo stack. Each undo emits an inverse `PATCH /api/products/bulk` with the captured pre-values.

Storage already exists — just need pre-value capture in the apply path and a small UI affordance.

## 26. ✅ Bulk-ops: drag-fill needs an Esc / cancel mid-drag — resolved 2026-05-06 in c672ff8

**Resolution:** Right-click cancel added alongside the existing Esc cancel; affordance hint pill ("Esc or right-click to cancel") follows the dashed extension rectangle so the cancel paths are discoverable during the drag.

**Original friction:** "Drag-fill went outside intended row, no easy way to cancel." Esc-cancel was already wired into the drag handler — the gap was discoverability and the missing mouse-driven path.

## 27. 🔴 Listing wizard: AI title terminology drift ("Giubbotto" vs "Giacca")

**Friction:** "AI title was wrong — kept saying 'Giubbotto' when should be 'Giacca'."

Concrete Xavia-Italian-motorcycle case: "Giubbotto" usually implies a padded/winter jacket; for breathable mesh riding gear the correct term is "Giacca." The model picked the wrong noun even though the source description used "Giacca."

This isn't a generic translation issue — it's a brand-glossary issue. The user can't trust AI titles right now without re-reading every single one.

**Proper fix (cheapest):** brand-level glossary table — `BrandTerminology { brandId, locale, preferTerm, avoidTerm, reason }` — fed into the Phase 5.5 prompt as a "must use / must avoid" section. Highest ROI feature for user trust. P0 because it actively undermines the AI feature shipped yesterday.

**Proper fix (better):** swap to a constrained-decoding step where the model rewrites the source description's existing nouns rather than picking new ones. Heavier; do glossary first.

## 28. 🟡 Listing wizard: apply to multiple marketplaces in one pass

**Friction:** "Wanted to apply for 5 marketplaces at once, had to do separately."

Already captured at high level in entry **13** (multi-marketplace translation flow). The friction log confirms it's real. Reframing the priority: P1 not P2, because the wizard ships now and users are running it 5× per product.

**Action:** when entry 13 lands, also apply to the GTIN-exemption submission — the same brand letter / image package is submittable to all five EU marketplaces in one pass.

## 29. 🟡 /products: "needs photos" filter

**Friction:** "Wished I could filter by 'needs photos'."

Catalog-hygiene filter — surface products with 0 images so the user can fix them in batches. Cheap to add: another filter pill in `ProductFilters.tsx`, server-side `where: { images: { none: {} } }` — single Prisma query.

**Proper fix:** add a "Has images" tri-state to the filter panel (`all` / `has-images` / `no-images`). One Prisma `where` clause, one filter chip, one stats counter. Probably an afternoon's work.

While we're there, add the same "needs description", "needs brand", "needs GTIN" hygiene filters — same shape.

## 30. 🟡 /products: surface category / productType

**Friction:** "Couldn't easily see which products are in which categories."

`Product.productType` exists in the schema (used by D.3e for category-specific attributes) but isn't shown on the products grid or table view, and isn't a filter facet.

**Proper fix:**
- Add a "Category" column to the table view (after Brand). Show `productType` if set, em-dash otherwise.
- Add `productType` as a filter facet in `ProductFilters.tsx` (multi-select against the distinct set of populated values — small enough to enumerate in one query at page load).
- Optional grid-card secondary line: show `productType` next to brand.

Same shape as the channels facet; mostly a typing exercise.

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

## 33. 🟡 ebay-orders.service.ts targets pre-Phase-26 Order schema

**Symptom:** Surfaced by the P0 #31 audit. `apps/api/src/services/ebay-orders.service.ts` writes orders using field names from a previous Order schema iteration (Phase < 26):

| In code | Actual schema |
|---|---|
| `salesChannel` | `channel` (`OrderChannel` enum) |
| `ebayOrderId` | `channelOrderId` |
| `purchaseDate` | `createdAt` |
| `lastUpdateDate` | `updatedAt` |
| `fulfillmentChannel` | (does not exist — moved to per-item or to `ebayMetadata`) |
| `buyerName` | `customerName` |
| `buyerEmail` | `customerEmail` |
| `buyerPhone` | (does not exist) |
| `totalAmount` | `totalPrice` (Decimal) |
| `currencyCode` | (does not exist on Order — needs to live in `ebayMetadata` or a new column) |

The field divergence happened during the Phase 26 unified-Order-Command refactor (schema.prisma comment at line 1182 confirms). The eBay orders service was not updated to match.

**Affected endpoint:** `POST /api/sync/ebay/orders` (registered at `app.register(ebayOrdersRoutes)`). Hitting this triggers an `Order.create` with all the wrong field names → Prisma will reject. The user-flow that triggers it is the `/settings/channels` "Sync orders" button, which they haven't pressed yet (Amazon-IT-only so far).

**Already fixed by P0 #31:** The lightweight stats endpoint `GET /api/sync/ebay/orders/stats/:connectionId` had the same `salesChannel`/`totalAmount` mismatch and got renamed inline (low scope, no schema dependency). Just rewriting `processOrder()` is the substantial part.

**Proper fix:** Rewrite `processOrder()` and the surrounding shape adapters in `ebay-orders.service.ts` to match Phase 26's `Order` model:
- Map eBay's `orderId` → `channelOrderId`, `channel: 'EBAY'`
- Map `pricingSummary.total` → `totalPrice` (Decimal — coerce from float)
- Move `currencyCode`, `purchaseDate`, `lastUpdateDate`, `fulfillmentStatus` into `ebayMetadata` JSON
- Map `buyer.username` → `customerName`, `buyer.email` → `customerEmail`
- Update OrderItem mapping similarly

Estimated 1–2h. Out of P0 #31 scope; do as soon as Xavia actually wants eBay orders synced (they don't yet).

## 34. 🟡 Bulk operations — Path A-Lite deferrals (rollback, LISTING_SYNC, queue infra, DELETE, "selected items" scope)

**Surfaced at:** Issue B closeout — Path A-Lite shipped a working
filtered-bulk-operations stack (4 of 5 action types, scope picker UI,
preview, execute+poll) but explicitly deferred five pieces. Listed
together so they get reconsidered as one batch when the next bulk-ops
ask lands.

### 34a. Rollback infrastructure

**Symptom:** `BulkActionJob.rollbackData` exists in the schema and
`bulk-action.service.ts` has a `rollback()` stub, but no per-item
before-state is captured during processing. The "Undo" path is
non-functional; `isRollbackable` is set to `true` for the four real
handlers but actually pressing Undo would do nothing useful.

**Workaround:** No rollback button in the UI. If a user runs the wrong
bulk op, they re-run it with the inverse value (proven viable in B-8
Test 5: a STATUS_UPDATE → DRAFT was reverted with a second STATUS_UPDATE
→ ACTIVE in seconds).

**Proper fix:** During `processJob`, before each `prisma.update`,
capture `{itemId, field, oldValue}` into an array; persist as
`rollbackData` JSON when the job completes. New endpoint `POST
/api/bulk-operations/:id/rollback` creates a sibling job with inverted
operations and links it via `rollbackJobId`. UI gets an "Undo this
operation" button on completed-job cards. Estimated 1 day.

### 34b. `LISTING_SYNC` handler

**Symptom:** The 5th action type is still a stub. Selecting it in the
modal would 500 at execute time (well — it would throw and the job
would land in `FAILED` state).

**Workaround:** Modal currently only exposes the 4 working action
types. `LISTING_SYNC` is filterable in the schema but not selectable
in the UI.

**Proper fix:** Implement `LISTING_SYNC` against the BullMQ outbound
queue (`outboundSyncQueue`). For each variation, enqueue a per-channel
sync job; mark the bulk job COMPLETED once all child jobs settle. This
is gated on Phase 2 (Redis enabled on Railway) — until then the queue
is Proxy-backed and `add()` would either succeed silently or fail at
runtime depending on env.

### 34c. Queue / worker infrastructure for >100-item jobs

**Symptom:** v1's `processJob` runs synchronously in-process, in a
single function call, updating the job row every 10 items. For
Xavia-scale (~1.3k variations, completes in <100ms in B-8 Test 5)
this is fine. For 50k-item jobs it would block the Node event loop
for minutes.

**Workaround:** "We're not at that scale yet."

**Proper fix:** Move `processJob` body into a BullMQ worker. The HTTP
endpoint enqueues, returns immediately; worker processes in chunks of
N with `WORKER_CONCURRENCY` set; cancel flag becomes a Redis-backed
check that the worker polls between chunks. Same gating as 34b —
needs Phase 2.

### 34d. `DELETE` action type

**Symptom:** Original Issue B spec listed bulk-delete as an operation;
Path A-Lite dropped it from scope. Not in the `BulkActionType` enum,
not in the modal.

**Workaround:** Users can multi-select rows in the grid and use the
existing per-row delete via the bulk-edit grid (the delete UX that
landed in commit `1b923f2`).

**Proper fix:** Add `DELETE` to `BulkActionType`, implement a handler
that uses `cascadeDeleteProducts` (the helper added in `9ba5aa4` for
the cleanup endpoints), wire to a fifth modal config. Defer until a
user actually asks for it; the per-row grid delete is fine for now.

### 34e. "Selected items only" scope

**Symptom:** The modal currently exposes "All matching filter" or
"Specific subset (filters)." The grid has row selection state, but
the modal can't take a selection — `targetVariationIds[]` and
`targetProductIds[]` are populated only via filter resolution.

**Workaround:** Users replicate their selection via filters (e.g.
filter by SKU prefix, then bulk apply to "All matching filter").

**Proper fix:** Pass `selectedRowIds` from the grid to the modal as a
prop; add a third scope mode "Selected rows (N)." Resolve the
question of what "select two parent products" means — operate on
those two parents (STATUS_UPDATE) or expand to every variation under
them (PRICING / INVENTORY / ATTRIBUTE)? The cross-targeting policy in
`getItemsForJob` already handles the expansion direction; what's
missing is the UI affordance and the scope-mode wiring.

## 35. 🟡 Listing wizard — channel publish not yet wired

**Surfaced at:** Listing wizard Steps 9/10 closeout. The ten-step
wizard is now end-to-end navigable (audit + rebuild on 2026-05-03 →
2026-05-04). State validation, payload composition, and the SUBMIT
state transition all work. The actual channel push to Amazon (and
Shopify, eBay, WooCommerce) is the remaining piece.

**What works today:**

- All 10 steps render real components (Steps 1, 2, 6 from earlier
  phases; 3, 4, 5, 7, 8, 9, 10 added in this round).
- `POST /api/listing-wizard/:id/submit` validates state, composes
  the Amazon listings payload (wraps each user-supplied attribute
  in the `[{ marketplace_id, value }]` convention, builds the
  `purchasable_offer`, attaches main + alt image URLs in
  `main_product_image_locator` / `other_product_image_locator`,
  records variation theme + child SKUs), transitions wizard.status
  to SUBMITTED, and returns the prepared payload so the user can
  inspect what *would* be sent.
- The endpoint response includes
  `channelPushed: false` and a human-readable
  `channelPushReason` so the UI can be honest about what's wired.

**What's missing:**

- **Amazon SP-API `putListingsItem` integration.** No
  `putListingsItem` wrapper exists in `apps/api/src/services/marketplaces/amazon.service.ts`
  (only `getListingsItem` for read). Building this means: take the
  composed payload, call SP-API with `productType`, `requirements:
  LISTING`, the wrapped attributes, plus the seller + marketplace
  IDs; capture the submission ID; poll `getListingsItem` /
  `getListingsItemIssues` until the listing is `BUYABLE` or surface
  the specific issues. ~6-10 hours, plus integration testing.
- **Shopify**: `ShopifyService.createProduct` already exists
  (`apps/api/src/services/marketplaces/shopify.service.ts:320`) —
  just needs an adapter that maps wizard state → its signature.
  ~1-2 hours.
- **WooCommerce**: no `createProduct` exists; only PUT for
  existing rows. Building create is straightforward (POST to
  `/products` with the same shape as the PUT). ~1-2 hours.
- **eBay**: adapter scaffolded in DD.4
  (`apps/api/src/services/listing-wizard/ebay-publish.adapter.ts`).
  Three-step Inventory-API flow wired
  (createOrReplaceInventoryItem → createOffer → publishOffer); error
  mapping per-step. **NOT END-TO-END TESTED.** Requires:
  (1) eBay developer credentials configured on a ChannelConnection
  (`channelType='EBAY'`, `isActive=true`, OAuth tokens),
  (2) `connectionMetadata.ebayPolicies.{fulfillmentPolicyId, paymentPolicyId, returnPolicyId, merchantLocationKey}` set on that connection,
  (3) sandbox or production seller account to test against.
  Once those are in place the existing /submit endpoint exercises it
  with no further wiring. Composition lives at
  `apps/api/src/services/listing-wizard/submission.service.ts` (EBAY branch).
- **Per-channel status polling** to surface "submitted → indexed →
  searchable" once the push lands. The `state.submission` slot is
  already wired in the schema for this.
- **Variation publishing** — when `state.variations.includedSkus`
  has children, each child needs its own `putListingsItem` call
  (Amazon publishes children as siblings of the parent under the
  variation theme). The composition layer surfaces them on
  `amazonPayload.childSkus`; the per-child payload still needs to
  be expanded.

**Workaround:** Users walk the wizard, hit Submit, see the prepared
payload, and copy it manually into Seller Central if they need to
list right now. Wizard state is preserved as SUBMITTED with the
prepared payload in `state.submission` so nothing is lost when the
integration eventually lands.

**Why this isn't in scope for the current round:** The channel-push
integrations are substantial backend work that benefit from a
dedicated phase with credentialed integration testing. They aren't
gated on the wizard UI, which is what this round delivered.

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

## 38. 🟡 Audit `IF NOT EXISTS` patterns in migrations

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

## 41. 🟡 Order-driven stock decrement needs fulfillment-method-aware location routing

**Symptom:** `inventory-sync.service.ts::syncGlobalStock` and `processSale` decrement `Product.totalStock` directly via the legacy path (no `locationId`). After H.2, `applyStockMovement` falls back to `IT-MAIN` when no location is given. That's correct for FBM/eBay/Shopify orders (we ship from Riccione) but wrong for Amazon FBA orders (Amazon decrements its own pool, the FBA cron picks it up — our `IT-MAIN` should not move).

**Surfaced at:** H.2 audit. The call graph is `webhooks/order` and `order-ingestion.service.ts:229 → processSale → syncGlobalStock`. The latter doesn't have channel/fulfillment-method context plumbed through.

**Workaround:** Xavia is pre-launch and `order-ingestion.service.ts` is currently only exercised by mock paths. The FBA cron's reconciliation sweep (every 15 min) corrects FBA stock; the only damage from a wrong-direction `IT-MAIN` decrement would be `IT-MAIN` going artificially low for an FBA-fulfilled SKU, which the operator would catch via the rebuilt `/fulfillment/stock` page.

**Proper fix:**
1. Plumb `channel` + `fulfillmentMethod` through `syncGlobalStock` and `processSale` (already in scope at the call site — `order-ingestion.service.ts:201` has `channel` in the same loop).
2. Resolve location: `AMAZON + FBA → AMAZON-EU-FBA`; everything else → `IT-MAIN`.
3. Pass `locationId` to `applyStockMovement`.
4. For FBA orders, optionally skip the local decrement entirely and rely on the cron — needs product-decision input.

Tied to: production order ingestion at scale (currently pre-launch). Bump to 🔴 once real orders flow.

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

## 43. 🟡 Variant mechanism duplication: `Product.parentId` vs unused `ProductVariation`

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

## 44. 🟡 Bulk operations target unused data shape — partially resolved 2026-05-06

**Symptom (original):** Every `BulkActionJob` of type 'variation' (PRICING_UPDATE, INVENTORY_UPDATE, ATTRIBUTE_UPDATE, LISTING_SYNC) processed 0 items on real catalogs because `ProductVariation` is empty (#43).

**Resolved in Commit 1 of the bulk-operations rebuild:** PRICING_UPDATE + INVENTORY_UPDATE now target `Product` and delegate to `MasterPriceService.update` / `applyStockMovement` for the full cascade (Product + ChannelListing + OutboundSyncQueue + AuditLog/StockMovement). STATUS_UPDATE was already correctly targeting Product. See `bulk-action.service.ts:ACTION_ENTITY` and DEVELOPMENT.md "Bulk operations — two-table data model" → "Master-cascade routing per actionType".

**Still open:**
- `ATTRIBUTE_UPDATE` still targets `ProductVariation.variationAttributes`. PV is empty so this is a silent no-op against current data. Retargeting requires a schema decision: which Product column holds variant-level attributes? See entry #52.
- `LISTING_SYNC` still throws "deferred to v2" — separate concern tracked in #34.
- The BullMQ post-commit enqueue from bulk-action context hangs indefinitely (root cause TBD — see #54). Worked around with `skipBullMQEnqueue: true`; cron worker drains PENDING rows within ~60s.

**Note:** The PATCH `/api/products/bulk` path (used by the BulkOperationsClient grid for inline cell edits, Cmd+S) targets `Product` directly and was unaffected — that's a separate code path that has always worked.

---

## 45. 🟡 Local apps/api Prisma client version mismatch (`@prisma/client` v6 vs v7)

**Symptom:** Local dev API server (`apps/api`) returns 500 on every Prisma query with `Invalid prisma.X invocation in ...` (truncated error). Same Prisma client works fine when invoked from a fresh Node script using `@nexus/database`.

**Surfaced at:** Phase 2 smoke test (2026-05-06). Couldn't verify variant endpoint locally; production unaffected (Railway builds dependencies fresh and aligns versions).

**Root cause:** Dependency split.
- `apps/api/package.json`: `"@prisma/client": "^7.7.0"` + `"@prisma/adapter-pg": "^7.7.0"`
- `packages/database/package.json`: `"prisma": "^6.19.3"` + `"@prisma/client": "^6.19.3"`

The CLI in `packages/database` (v6) generates a client compatible with `@prisma/client` v6, but `apps/api` loads `@prisma/client` v7 from its own `node_modules`. Same package, incompatible major versions.

**Workaround:** None for local dev. Verify against deployed Railway API instead, which builds dependencies fresh and ends up consistent.

**Proper fix:** Align versions. Either bump `packages/database` to `prisma@^7` (preferred — v7 is the current series) or pin `apps/api` to `^6.19.3`. Then `npm install` from repo root and `prisma generate` to confirm clean.

**Risk if left:** New developers can't run the API locally for any Prisma-touching path. Slows onboarding + makes integration testing impossible without a deployed environment.

---

## 46. 🟢 `Channel` table empty but `ChannelListing.channel` references it as a string

**Symptom:** `ChannelListing.channel` is a `String` column with values like `"AMAZON"`, `"EBAY"`. The `Channel` table exists in the schema but has 0 rows. There's no foreign-key constraint between them — the relationship is implicit via string equality.

**Surfaced at:** Phase 1 audit DB queries (2026-05-06).

**Why it matters:** Adding a new channel today requires editing UI hardcoded lists in N places (e.g., `bulk-operations/components/FilterDropdown.tsx:25` hardcodes `['AMAZON','EBAY','SHOPIFY','WOOCOMMERCE']`). With a populated `Channel` table + FK, channel options would be data-driven.

**Decision needed:** Either populate `Channel` and refactor `ChannelListing.channel` as an FK, or delete the unused `Channel` table to make the implicit-string contract explicit. The current half-state is the worst of both worlds.

**Tied to multi-tenant readiness** — when Nexus serves a second seller, channel availability may differ per tenant, which is much cleaner with an FK + per-tenant `Channel` rows than with hardcoded strings everywhere.

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

## 47. 🟢 Vercel auto-deploy from `main` was disconnected for ~5 days

**Symptom:** Vercel stopped deploying commits to `main` somewhere around 2026-05-01. Multiple H.1/H.2/H.3 stock-ledger commits + the Phase 4 catalog rename appeared on `nexus-commerce.vercel.app` as 404s; the actual production deployment lived at `nexus-commerce-three.vercel.app`.

**Surfaced at:** Phase 4 deploy verification (2026-05-06). Re-pointed to correct URL after user identified it; pipeline subsequently green.

**Resolution:** User confirmed Vercel pipeline is now active (2026-05-06). All pending commits (Phase 4, 6, 7) deployed cleanly to `nexus-commerce-three.vercel.app`.

**Process note for future audits:** Production URL is `nexus-commerce-three.vercel.app` (custom Vercel project name; the predictable `nexus-commerce.vercel.app` alias does not auto-update). If a deploy verification 404s on the predictable URL, check the actual project deployment URL before assuming a build failure.

---

## 42. 🟡 No test framework

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

## 51. 🟡 No transactional email infrastructure

**Symptom:** Multiple surfaces want to email PDFs / notifications to suppliers and operators, but Nexus has no email sending infrastructure. The `sendEmailAlert` function in `apps/api/src/services/monitoring/alert.service.ts` is a TODO. The H.17 inbound discrepancy report (2026-05-06) ships as a PDF download only — operator forwards to supplier via their own mail client.

**Surfaced at:** H.17 discrepancy report shipped 2026-05-06.

**Workaround:** Operator downloads PDF, attaches to mail client manually. Works but adds friction for the "ship the report on every receive close-out" use case.

**Proper fix:** Pick an email provider (Resend has a clean API + good deliverability for transactional; SendGrid for higher volume; SES if AWS-aligned). Wire one service: `apps/api/src/services/email.service.ts` with `sendTransactionalEmail({ to, subject, body, attachments })`. Then:
- Replace the H.17 download-only flow with a "Send to supplier" button that emails the PDF.
- Wire `sendEmailAlert` in alert.service.ts.
- Wire low-stock + sync-failure notifications via the same service.
- Domain auth (SPF + DKIM + DMARC for the brand domain) is required to land in supplier inboxes — coordinate with whoever owns DNS for `xaviaracing.com`.

**Estimated effort:** 1–2 commits. The email service itself is small; the surface area of "what should be emailed" is the time sink.

---

## 50. 🔴 FBA Inbound v0 putTransportDetails is deprecated

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

**Mitigation until then:** Update the InboundWorkspace banner from green ("fully wired") to amber ("v0 endpoints partially deprecated; transport booking flow needs v2024-03-20 migration"). Operators can still use plan-shipment + getLabels on v0 in the meantime; transport booking has to happen in Seller Central until v2024-03-20 lands.

**Estimated effort:** 4–6 commits. State machine rewrite + polling-based operation tracking + UI redesign for the multi-step flow.

---

## 52. 🟡 Bulk ATTRIBUTE_UPDATE still targets empty ProductVariation table

**Symptom:** `BulkActionJob` of type `ATTRIBUTE_UPDATE` shallow-merges into `ProductVariation.variationAttributes`. PV is empty in production, so jobs run silently with 0 items processed. Same shape as the old #44 PRICING/INVENTORY bug, scoped down to the one remaining handler.

**Surfaced at:** Phase 1 audit + Commit 1 of the bulk-operations rebuild (2026-05-06). PRICING + INVENTORY were retargeted to Product in Commit 1; ATTRIBUTE_UPDATE was deferred because there's no obvious target column on Product.

**Decision needed:** which Product column holds the equivalent of `variationAttributes`? Candidates:
- `Product.attributes` (if it exists — verify in schema)
- A new `Product.variantAttributes` JSON column added by migration
- Continue routing through PV but require callers to also create PV rows when they create Product children (large structural change to the catalog import flow)

**Proper fix:** Once decided, change `ACTION_ENTITY.ATTRIBUTE_UPDATE` from `'variation'` to `'product'`, retarget `processAttributeUpdate` to write the chosen Product column, and remove the deprecation comment in DEVELOPMENT.md.

**Risk if left:** Bulk attribute updates from `/bulk-operations` modal silently no-op. Users see "completed, 0 processed" with no error. Low blast-radius (no one has run this op in production per Phase 1 audit), but a real bug.

---

## 53. ✅ Bulk STATUS_UPDATE doesn't propagate to channels — resolved 2026-05-06

**Resolution:** New `apps/api/src/services/master-status.service.ts` mirrors `MasterPriceService` — single entrypoint for `Product.status` mutations. Atomic transaction: `Product.status` → `ChannelListing.listingStatus` (skipping ENDED/ERROR) → `OutboundSyncQueue` (`syncType='STATUS_UPDATE'`) → `AuditLog`. `bulk-action.service.ts:processStatusUpdate` and the rollback STATUS_UPDATE branch now delegate to it. `skipBullMQEnqueue:true` paired with the per-minute cron drain (same workaround as pricing/inventory paths until #54 lands).

**Original symptom (kept for context):** Bulk STATUS_UPDATE wrote `Product.status` directly. No fan-out to ChannelListing, no OutboundSyncQueue enqueue, no AuditLog row. A user marking 50 SKUs INACTIVE in bulk left Amazon/eBay showing them as ACTIVE until the next manual sync — buyers could place orders on items that should be off the shelf.

---

## 54. 🔴 BullMQ `Queue.add()` hangs from bulk-action context (both detached AND request-scoped)

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

## 55. 🟡 Bulk resync needs an inbound queue (S.4 scope)

**Symptom:** S.0 wired `POST /api/listings/:id/resync` as a synchronous inline pull from the channel adapter — solves the single-listing case ("operator clicks Resync in the drawer"). The bulk-action endpoint at `/api/listings/bulk-action` still routes resync through the in-memory `BULK_JOBS` Map, which loses state on API restart. Bulk resync (>1 listing) is on shaky ground until we have a real inbound queue.

**Surfaced at:** Phase 1 syndication audit + S.0 design review (2026-05-07).

**Workaround applied:** S.0 single-listing resync works correctly. Bulk resync is currently a no-op for >50 listings (the in-memory Map's 60s polling timeout will silently report "Done" without finishing).

**Proper fix (planned for S.4):** Two viable shapes:

1. **Repurpose `OutboundSyncQueue`** with a new `INBOUND_REFRESH` syncType. Cleanest reuse of existing infrastructure (cron worker, retry logic, holdUntil grace) but bends the queue's mental model from "outbound mutation queue" to "bidirectional sync queue".
2. **Sibling `InboundSyncQueue` table.** Dedicated to pull-style operations. Cleaner separation of concerns; small migration.

Either way, also requires fleshing out the channel adapters' inbound primitives (Amazon's `getListingState` exists per S.0; eBay/Shopify/WooCommerce/Etsy need similar). Deciding which approach to use is part of S.4's design phase.

**Risk if left:** Bulk operations on >50 listings silently fail. Operator sees "Done" but nothing happened. Currently low-impact (8 listings in DB) but blocks scaling to real Xavia volume.

---

## 56. 🟢 OutboundSyncService.syncTo* methods are simulated stubs

**Symptom:** `apps/api/src/services/outbound-sync.service.ts:286,328,366,406` — the `syncToAmazon`, `syncToEbay`, `syncToShopify`, `syncToWoocommerce` methods are placeholder demos using `Math.random() > 0.1` to simulate a 90% success rate. They construct payloads but never call the actual marketplace APIs.

**Surfaced at:** Phase 1 syndication audit (2026-05-07) — discovered while planning C-3.

**Why it matters:** Any code path that enqueues an `OutboundSyncQueue` row (price change, quantity change) gets simulated success/failure rather than real propagation. The `Math.random()` is enough to pass smoke tests but doesn't actually push data to channels.

**Proper fix:** Wire each method to its real adapter:
- `syncToAmazon` → `amazonService.updateVariantPrice` / SP-API patchListingsItem
- `syncToEbay` → `ebayService.updatePrice` / `updateInventory`
- `syncToShopify` → `shopifyService.updateProduct`
- `syncToWoocommerce` → `woocommerceService.updateProduct`

Tie this to S.4 channel adapter realization. Don't ship as a standalone fix — it's coupled to inbound queue design (#55) and rate-limit persistence (currently in-memory, won't survive horizontal scaling).

**Risk if left:** None today (8 listings, never synced). Becomes 🔴 the moment a real Xavia listing goes live and operator expects price/stock changes to actually propagate.

---

## 57. 🟡 Syndication channels deferred (Shopify / WooCommerce / Etsy)

**Symptom:** Phase 1 audit confirmed zero ChannelListings exist for Shopify, WooCommerce, or Etsy as of 2026-05-07. The `/listings/{shopify,woocommerce,etsy}` page routes are 13-line stubs around `ListingsWorkspace` with `lockChannel` set. The workspace has no channel-specific UI for any of these.

**Surfaced at:** Phase 1 syndication audit + S.0 roadmap calibration (2026-05-07).

**Decision (with operator):** Defer S.7 (Shopify deep view), S.8 (WooCommerce deep view), S.9 (Etsy deep view). Don't build for hypothetical demand; revive when Awa indicates intent to publish on these channels. Each represents 3–4 weeks of dedicated work.

**What stays (minimal viable):**
- The stub pages keep working (workspace shell renders, just no channel-specific tools).
- ChannelListing schema supports all five channels — no data model change needed when revived.
- Outbound sync queue routes already include all five channels (modulo #56's stub status).

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
- **33** Rewrite `ebay-orders.service.ts` against Phase 26 unified Order schema (orders sync flow currently broken)
- **34** Bulk operations Path A-Lite deferrals — rollback, `LISTING_SYNC` handler, queue infra for big jobs, `DELETE` action, "selected items" scope
- **35** Listing wizard — channel publish adapters all NOT_IMPLEMENTED (Phase J orchestrator + `/submit` + `/poll` + `/retry` are real; only `ChannelPublishService.publishToChannel()` per-platform branches need real implementations: Amazon `putListingsItem`, Shopify wiring of existing `createProduct`, WooCommerce create, eBay Phase 2A)
- **36** Dedicated image-manager page at `/products/:id/images`
- **38** Audit `IF NOT EXISTS` patterns in migrations — silent-on-collision is what hid the Return table drift; sweep + tighten policy — Phase F shipped the wizard step as a quick-reorder + per-channel validation summary only, with the full multi-scope (GLOBAL/PLATFORM/MARKETPLACE) + variation-aware ListingImage editing deferred to a standalone page. The schema, resolution cascade, and validation service are already in place; the page itself + upload service + dnd-kit drag-to-reorder are the remaining work.
- **43** Variant mechanism duplication — `Product.parentId` vs unused `ProductVariation`. 244 active children via parentId, 0 in ProductVariation. Decision needed before bulk-ops can be fixed at scale.
- **44** Bulk operations target unused data shape — partially resolved 2026-05-06 in Commit 1 of bulk-ops rebuild (PRICING + INVENTORY retargeted to Product via master-cascade). ATTRIBUTE_UPDATE remaining → see #52.
- **52** Bulk ATTRIBUTE_UPDATE still targets empty ProductVariation — silent no-op against current data; needs schema decision on where variant attributes live on Product.
- **53** ✅ Resolved 2026-05-06 — `MasterStatusService` shipped, `bulk-action.service.ts` `processStatusUpdate` + STATUS_UPDATE rollback both delegate to it; cascade fans out to ChannelListing + OutboundSyncQueue + AuditLog.
- **54** 🔴 BullMQ post-commit enqueue hangs from bulk-action's detached `processJob` context — workaround `skipBullMQEnqueue: true` in place; cron worker drains PENDING within 60s. Root cause investigation pending.
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
