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

## 1. 🟡 `@fastify/compress` empty-body bug on `/api/orders` list

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

## 3. 🟡 Out-of-scope orphan routes (not in sidebar)

Found during the sidebar audit but not linked from `AppSidebar.tsx`. They show up in `pathname.startsWith()` matchers and external links elsewhere — leaving them broken creates confusion later.

| Route | Status | Note |
|---|---|---|
| `/logs` | 500 | Old activity log page; sidebar uses `/sync-logs` now. Either delete or fix and 301 → `/sync-logs`. |
| `/monitoring/sync` | 404 | Mentioned in user spec as a planned home for Sync Health; sidebar still links to `/dashboard/health`. Decide which is canonical, redirect the other. |
| `/settings` (root) | 404 | No index page under `/settings/`. Add a `page.tsx` that redirects to `/settings/channels` or to a real settings landing. |

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

## 26. 🟡 Bulk-ops: drag-fill needs an Esc / cancel mid-drag

**Friction:** "Drag-fill went outside intended row, no easy way to cancel."

Once the user starts the fill, it auto-commits when the mouse releases. There's no way to bail mid-drag if they realise they're filling the wrong direction or too many rows.

**Proper fix:** during drag, listen for `Escape` (and probably right-click) to abort the in-progress fill before commit. Visual: dim or strike through the highlighted target range while the abort key is held, so users learn the affordance. The drag handler already has a clean lifecycle (mousedown / mousemove rAF / mouseup) — adding a key listener inside the same lifecycle is straightforward.

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

## 32. 🟢 DraftListing — orphan model, zero callers

**Symptom:** `model DraftListing` exists in `schema.prisma`, no migration creates the table, and `grep -rn "prisma.draftListing"` returns zero hits across `apps/`. Pure orphan from a Phase 5 design that never landed.

**Workaround:** Allow-listed in the drift check.

**Proper fix:** Decide between:

1. **Delete the model.** Lowest-risk default — if no code uses it, the schema doesn't need to describe it. Ship a one-line schema.prisma diff and remove the allow-list line.
2. **Land the migration.** Only if there's a concrete plan to use it in the next sprint. Otherwise option 1 is correct (YAGNI).

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
- **eBay**: blocked behind Phase 2A (see #31, #33).
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

## Triage summary

**🔴 P0 — tackle next:**
- **0** ✅ Schema-migration drift gate landed 2026-05-02 (script + npm script + .githooks/pre-push). Allow-list down to 1 (DraftListing only).
- **8** ✅ Resolved 2026-05-02 — verified GTIN wizard validator was already on the correct ProductImage relation; deleted the orphan `Image` model + dead Express service & route (~1,213 lines). Demoted to P2 for the remaining UX polish.
- **27** ✅ Resolved 2026-05-02 — TerminologyPreference table + CRUD API + AI prompt injection + admin UI at `/settings/terminology`. Seeded with 7 Xavia/IT entries (Giacca, Pantaloni, Casco, Stivali, Protezioni, Pelle, Rete). Verify post-deploy that "Giacca" wins consistently in regenerations; add new preferences inline as drift surfaces.
- **31** ✅ Resolved 2026-05-03 — migration `20260503_p0_31_channel_connection` adds the table + fixes substantial column-level drift on `VariantChannelListing` surfaced by the audit. eBay auth + listing flows are now operational; orders flow has separate refactor work tracked at #33.

**🟡 P1 — backlog (informed by real usage):**
- **1** `@fastify/compress` empty body on `/api/orders` (workaround in place)
- **2** Prisma in server components (workaround in place; pattern fix needs a sweep)
- **3** Orphan routes (`/logs`, `/monitoring/sync`, `/settings`)
- **6** SheetJS CVE — mitigations real, but worth swapping to `exceljs`
- **17** `/products` URL state for filters / sort / page
- **18** `/products` bulk-edit-in-place
- **25** Bulk-ops undo across saves (real user request)
- **26** Bulk-ops drag-fill cancel (real user request)
- **28** Listing wizard multi-marketplace apply — was P2 #13, **promoted** based on usage signal
- **29** `/products` "needs photos" filter (and sibling hygiene filters)
- **30** `/products` show + filter by category / productType
- **33** Rewrite `ebay-orders.service.ts` against Phase 26 unified Order schema (orders sync flow currently broken)
- **34** Bulk operations Path A-Lite deferrals — rollback, `LISTING_SYNC` handler, queue infra for big jobs, `DELETE` action, "selected items" scope
- **35** Listing wizard — channel publish not yet wired (Amazon `putListingsItem`, Shopify adapter, WooCommerce create, eBay blocked, status polling, variation expansion)

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
- **32** Delete the orphan `DraftListing` model from schema.prisma
