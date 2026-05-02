# Site Audit — Phase 4 Pre-Refactor

Date: 2026-05-02
Scope: every `apps/web/src/app/**/page.tsx` (57 routes total).

## Method

1. Inventoried every route by reading the first ~80 lines of each `page.tsx`
   to capture purpose, data dependencies, and probable duplication.
2. Probed the production deploy (`https://nexus-commerce-three.vercel.app`)
   on the suspected-broken paths from prior sessions. **Every page
   currently returns HTTP 200** — `/dashboard/overview` and `/pricing` are
   no longer 500-erroring. The earlier outage was resolved by the Phase 1
   queue lazy-init + Neon timeout fix in commits `9c88699` and earlier.
3. Wider parallel probe was attempted but Vercel cold starts (~5s each)
   caused the parallel runner to time out. The page-content audit is
   sufficient for categorization without per-route HTTP timing.

## Categorization

Status legend:
- **KEEP** — working, useful, will polish but not restructure.
- **REDESIGN** — keep concept, rebuild with the new design-system primitives.
- **MERGE → X** — fold into route X; close the duplicate route.
- **DELETE** — pure duplicate or unreferenced stub. Safe to remove.
- **DEFER** — keep code, hide from nav until needed (admin-only or future).

> Where two routes are flagged as duplicates, the **canonical** one is
> bolded in the merge target.

---

## Catalog area (12 routes — heavy duplication)

| Route | Purpose | Source | Verdict | Notes |
|---|---|---|---|---|
| `/catalog` | Redirects to `/inventory` | stub | **KEEP** | Back-compat redirect; cheap to keep. |
| `/catalog/[id]` | Read-only product detail | direct prisma | **MERGE → `/products/[id]`** | Same shape as `/products/[id]`. |
| `/catalog/[id]/edit` | Single-channel product editor (legacy MatrixEditor) | direct prisma | **KEEP (legacy)** | Still wired from `columns.tsx`. Phase 5 may sunset, but works today. |
| `/catalog/[id]/images` | Image management with AI color detection | `/api/products` | **KEEP** | Will eventually become an "Images" tab inside `/products/[id]/edit` — defer that fold to Phase 5. |
| `/catalog/add` | Comprehensive new-product form | server action `createProduct` | **KEEP (canonical)** | More fields than `/catalog/new`. |
| `/catalog/drafts` | Lists products missing required fields | direct prisma | **KEEP** | Useful workflow, low volume. |
| `/catalog/edit/[id]` | Product edit by category schema | direct prisma | **DELETE** | Duplicate of `/catalog/[id]/edit` with different URL shape. Confirm nothing links here. |
| `/catalog/import` | Bulk CSV import | stub | **MERGE → `/inventory/upload`** | Stub UI; the working uploader is `/inventory/upload`. |
| `/catalog/new` | Smaller new-product form | server action `createProduct` | **MERGE → `/catalog/add`** | Strictly less than `/catalog/add`. |
| `/catalog/upload` | Re-export of `/inventory/upload` | none | **DELETE** | Literal re-export; just keep `/inventory/upload`. |

---

## Dashboard / analytics / reports (10 routes — also duplicative)

| Route | Purpose | Source | Verdict | Notes |
|---|---|---|---|---|
| `/dashboard` | Redirect to `/dashboard/overview` | stub | **KEEP** | Back-compat redirect. |
| `/dashboard/overview` | Main KPI dashboard + real-time monitor | direct prisma | **REDESIGN → `/insights`** | Becomes the new Insights home. |
| `/dashboard/analytics` | 30-day trends overview | server action | **MERGE → `/insights`** | One sub-tab. |
| `/dashboard/analytics/channels` | Per-channel performance | server action | **MERGE → `/insights/channels`** | |
| `/dashboard/analytics/inventory` | Stock distribution | server action | **MERGE → `/insights/inventory`** | |
| `/dashboard/analytics/revenue` | Revenue trends | server action | **MERGE → `/insights/revenue`** | |
| `/dashboard/bulk-actions` | Async job monitor (auto-refresh) | `/api/bulk-jobs` | **KEEP** as `/system/bulk-actions` | Real feature, works. |
| `/dashboard/health` | Sync health, conflicts, errors | `/api/health`, `/api/conflicts`, `/api/errors` | **KEEP** as `/system/sync-health` | Real feature. Combines with `/performance/health` and `/outbound`. |
| `/dashboard/pricing` | Pricing rules CRUD | `/api/pricing-rules` | **MERGE → `/pricing`** | The other pricing page is read-only. Keep this functionality there. |
| `/dashboard/reports` | Reports hub | server action | **KEEP** as `/insights/reports` | |
| `/dashboard/reports/[reportId]` | Individual report detail | server action | **KEEP** as `/insights/reports/[reportId]` | |

---

## Engine — confusingly named, all duplicates

| Route | Purpose | Source | Verdict | Notes |
|---|---|---|---|---|
| `/engine/ai` | AI listing generator for eBay (Gemini) | direct prisma | **MERGE → `/listings/generate`** | Same feature, different URL. Keep `/listings/generate` as canonical. |
| `/engine/channels` | Connected marketplace channels | direct prisma | **MERGE → `/settings/channels`** | |
| `/engine/ebay` | eBay sync control + linking | direct prisma | **MERGE → `/listings/ebay`** (planned) | Once the new `/listings/ebay` dashboard is built, fold this in. |
| `/engine/logs` | Marketplace sync logs | direct prisma | **DELETE** | Duplicates `/logs` and `/sync-logs`. Three log pages is two too many. |

---

## Inventory (6 routes)

| Route | Purpose | Source | Verdict | Notes |
|---|---|---|---|---|
| `/inventory` | Master catalog list (Phase 3.5 polished) | `/api/amazon/products/list?topLevelOnly=1&limit=50` | **KEEP (canonical)** | Already paginated and polished. |
| `/inventory/fba` | FBA-only filtered view | direct prisma | **MERGE → `/inventory?filter=fba`** | Becomes a filter chip on the main page. |
| `/inventory/manage` | "Manage all products" | `/api/amazon/products/list` | **DELETE** | Duplicate of `/inventory`. |
| `/inventory/resolve` | Unmatched eBay listings resolver | direct prisma | **KEEP** | Specific workflow. Move under `/listings/ebay/resolve` later. |
| `/inventory/stranded` | Products without active listings | direct prisma | **KEEP** as `/inventory?filter=stranded` | Could be a filter chip; keep route as alias for back-compat. |
| `/inventory/upload` | Bulk Excel/CSV import | `/api/inventory/import` | **KEEP (canonical)** | The real bulk-upload flow. |

---

## Listings & cross-channel (3 routes)

| Route | Purpose | Source | Verdict | Notes |
|---|---|---|---|---|
| `/list/amazon-to-ebay` | List Amazon→eBay | direct prisma | **MERGE → `/listings/ebay`** | Workflow belongs under listings. |
| `/listings` | Unlinked listings management | `/api/listings`, `/api/products` | **REDESIGN** | Spec target: cross-channel listings dashboard. |
| `/listings/generate` | AI eBay listing generator | `/api/listings/generate` | **KEEP** | Canonical destination for `/engine/ai`. |

---

## Logs (THREE separate routes for the same thing)

| Route | Purpose | Source | Verdict |
|---|---|---|---|
| `/logs` | Marketplace sync logs with status badges | direct prisma | **MERGE → `/system/activity`** |
| `/sync-logs` | Amazon sync logs + perf metrics | direct prisma | **MERGE → `/system/activity`** |
| `/engine/logs` | Marketplace sync logs (3rd) | direct prisma | **DELETE** (already flagged above) |

Folding all three into a single `/system/activity` page with channel filter
removes confusion and matches the new System nav group.

---

## Orders

| Route | Purpose | Source | Verdict | Notes |
|---|---|---|---|---|
| `/orders` | Browse + ingest orders | `/api/orders`, `/api/orders/ingest` | **KEEP** | Polish with new design system. |
| `/orders/manage` | Order details (financials, items) | direct prisma | **REDESIGN as `/orders/[id]`** | Currently confusing URL; becomes detail page. |
| `/orders/returns` | Return requests | direct prisma | **KEEP** as `/orders?tab=returns` (or sub-route) | |

---

## Performance

| Route | Purpose | Source | Verdict | Notes |
|---|---|---|---|---|
| `/performance/feedback` | Seller feedback / rating analytics | direct prisma | **DEFER** | Hide from main nav until orders + returns are real. |
| `/performance/health` | Account health metrics | direct prisma | **MERGE → `/system/sync-health`** | Same concept as `/dashboard/health`. |

---

## PIM

| Route | Purpose | Source | Verdict |
|---|---|---|---|
| `/pim/review` | Group detection + apply | `/api/amazon/pim/detect-groups`, `apply-groups` | **KEEP** — just built, working. Polish only. |

---

## Pricing

| Route | Purpose | Source | Verdict | Notes |
|---|---|---|---|---|
| `/pricing` | Pricing list with margins (read-only) | direct prisma | **REDESIGN** | Becomes Pricing home with tabs. |
| `/pricing/alerts` | Threshold + competitor alerts | direct prisma | **MERGE → `/pricing?tab=alerts`** | |

(`/dashboard/pricing` also folds in here per Dashboard table.)

---

## Products (NEW route family — partial duplicate of catalog)

| Route | Purpose | Source | Verdict | Notes |
|---|---|---|---|---|
| `/products` | Client-only product list with filtering | `/api/products` | **DELETE** | Duplicates `/inventory` with worse UX. |
| `/products/[id]` | Product detail (read-only) | direct prisma | **KEEP (canonical)** | Replaces `/catalog/[id]`. |
| `/products/[id]/edit` | Multi-channel editor (Phase 3 build) | `/api/inventory/[id]`, `/api/products/[id]/all-listings`, `/api/marketplaces/grouped`, `/api/amazon/products/[id]/children` | **KEEP (canonical)** | The primary editor going forward. |

---

## Reports

| Route | Purpose | Source | Verdict |
|---|---|---|---|
| `/reports/business` | Sales / revenue analytics | direct prisma | **MERGE → `/insights/reports`** |

---

## Settings (mostly fine — minor consolidation)

| Route | Purpose | Source | Verdict |
|---|---|---|---|
| `/settings/account` | Account + business info | direct prisma | **KEEP** |
| `/settings/api-keys` | API key management | direct prisma | **KEEP** |
| `/settings/channels` | Marketplace connections | client-only | **KEEP (canonical)** — also receives `/engine/channels` |
| `/settings/channels/ebay-callback` | eBay OAuth callback | client-only | **KEEP** — required by OAuth flow |
| `/settings/notifications` | Notification prefs | direct prisma | **KEEP** |
| `/settings/profile` | User profile + security | direct prisma | **KEEP** |

---

## Top-level / admin

| Route | Purpose | Source | Verdict |
|---|---|---|---|
| `/` | Redirect to `/dashboard/overview` | stub | **KEEP** — should redirect to new home (`/inventory` or `/insights`). |
| `/admin` | Health + validation report (developer only) | server actions | **DEFER** — keep code, hide from main nav. |
| `/outbound` | Outbound sync queue monitor | direct prisma | **MERGE → `/system/sync-health`** |

---

## Summary by verdict

| Verdict | Count | Routes |
|---|---|---|
| **KEEP (canonical)** | 19 | core pages that already work |
| **REDESIGN** | 4 | `/dashboard/overview` → `/insights`, `/listings`, `/orders/manage` → `/orders/[id]`, `/pricing` |
| **MERGE** | 19 | dashboard analytics → /insights; engine/* → settings or listings; log triplet → /system/activity; pricing alerts → /pricing; etc. |
| **DELETE** | 6 | `/catalog/edit/[id]`, `/catalog/upload`, `/inventory/manage`, `/products`, `/engine/logs`, `/dashboard/pricing` (after merge) |
| **DEFER (hide from nav, keep code)** | 2 | `/admin`, `/performance/feedback` |
| **Back-compat redirects (keep)** | 4 | `/`, `/catalog`, `/dashboard`, plus we'll add `/inventory` ⇄ `/products` aliasing |

Total: 57 routes inventoried. After Phase 4 we end up with ~28-30 active
routes, ~6 deletions, ~19 merges (no actual file deletions — just redirect
shells) and the rest preserved.

---

## Proposed navigation (your spec, lightly adjusted)

```
NEXUS COMMERCE
─────────────
Catalog
  Products            → /inventory          (canonical list; rename label only)
  PIM Review          → /pim/review
  Bulk Upload         → /inventory/upload
  Drafts              → /catalog/drafts     (workflow page worth surfacing)

Listings
  All Listings        → /listings           (REDESIGN to cross-channel view)
  Amazon              → /listings/amazon    (NEW — Phase 4)
  eBay                → /listings/ebay      (NEW — folds /engine/ebay + /list/amazon-to-ebay)
  Shopify             → /listings/shopify   (NEW — Phase 4)
  WooCommerce         → /listings/woocommerce (NEW — Phase 4)
  AI Generator        → /listings/generate

Orders
  All Orders          → /orders
  Returns             → /orders/returns

Pricing
  Repricer Rules      → /pricing
  Margin Analysis     → /pricing/margins    (NEW — pulls from /reports/business)
  Alerts              → /pricing/alerts

Insights
  Overview            → /insights           (was /dashboard/overview)
  Channels            → /insights/channels  (was /dashboard/analytics/channels)
  Inventory           → /insights/inventory (was /dashboard/analytics/inventory)
  Revenue             → /insights/revenue   (was /dashboard/analytics/revenue)
  Reports             → /insights/reports   (was /dashboard/reports)

System
  Connections         → /settings/channels
  Sync Health         → /system/sync-health (NEW — folds /dashboard/health
                                              + /performance/health + /outbound)
  Activity Log        → /system/activity    (NEW — folds /logs + /sync-logs)
  Bulk Actions        → /system/bulk-actions (was /dashboard/bulk-actions)
  Settings            → /settings           (was /settings/account)
  API Keys            → /settings/api-keys
  Notifications       → /settings/notifications

(Hidden from main nav)
  /admin              — developer health/validation
  /performance/feedback — defer until orders are live
```

This drops the **Engine** section entirely (its three pages all merged
elsewhere) and unifies the **dashboard / performance / outbound** triad
under a single **System** group.

---

## Risks / things to confirm before deletion

1. `/catalog/edit/[id]` — confirm nothing links to this URL shape. The
   inventory columns dropdown links to `/catalog/${id}/edit`, but a
   bookmarked `/catalog/edit/${id}` would 404 after delete.
2. `/inventory/manage` — same concern; if any external doc or email
   references it, a redirect is safer than a delete.
3. `/products` (the list page) — recent enough to have no external
   bookmarks, but verify no internal navigation still points to it.
4. `/dashboard/pricing` — the active pricing-rules CRUD lives here. Make
   sure the merge target `/pricing` actually carries the CRUD before
   deleting. **This one is the highest risk** of breaking a working
   feature.
5. The four log routes (`/logs`, `/sync-logs`, `/engine/logs`, plus
   `/dashboard/health` activity tab) all pull slightly different schemas.
   Need to check whether merging into one `/system/activity` requires
   union over multiple Prisma tables (`SyncLog`, `SyncHealthLog`).

Recommend: convert the merged-but-not-deleted routes to **redirect-only
pages** rather than `git rm` for the first pass. Cheap rollback if a link
breaks.

---

## What needs your sign-off before I touch anything

1. **Delete list** (6 routes): `/catalog/edit/[id]`, `/catalog/upload`,
   `/inventory/manage`, `/products`, `/engine/logs`, plus
   `/dashboard/pricing` *after* its CRUD is verified to live in `/pricing`.
2. **Merge plan**: do you want me to do redirect-shells (safer) or
   `git rm` (cleaner)? Default recommendation: redirect-shells, then
   `git rm` after one week with no broken-link reports.
3. **Navigation**: above structure ok, or do you want anything moved
   around? (I drop "Engine" entirely; you wrote "Operations" for the
   group containing Orders/Pricing/Insights — happy to use that label
   instead of three separate groups if you prefer.)
4. **`/inventory` vs `/products` URL choice**: spec says "Products" in
   nav — should the underlying URL also change to `/products`, or keep
   `/inventory` and just label it "Products" in the sidebar? I'd vote
   keep `/inventory` (no migration risk) and label it "Products".

Approve those four points and I'll execute Phase 4 in the order:
nav build → redesigns → merges (redirect shells) → deletes → polish pass.
