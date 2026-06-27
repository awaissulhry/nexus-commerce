# Nexus Rebuild — Strategy & North Star

**Status:** Draft for review · **Date:** 2026-06-27 · **Type:** Program strategy (parent spec)

This is the parent spec for a full rebuild of the Nexus commerce platform. It captures the audit findings, the agreed operating model, the target architecture, and the module decomposition + build order. **Each module listed in §7 gets its own spec → plan → build cycle.** This document does not get implemented directly — it governs the ones that do.

Full per-domain audit reports (13) live in the session scratchpad under `rebuild-audit/` (`00-design-system-foundation.md` … `12-platform-sync-admin.md`) and can be promoted into `docs/` on request.

---

## 1. Context & Goal

Nexus is the single operating hub for one seller (Xavia — Italian motorcycle gear; ~279 master SKUs / 266 live products) selling on **Amazon (multiple EU markets), eBay, and Shopify**, using **both FBA and FBM**.

The platform has been built far past its needs: **326 Prisma models, 900+ API endpoints, ~70 cron jobs, 550 service modules**, and several 3,000–17,000-line UI files. Most of it is redundant, dead, or ships dark.

**Goal:** rebuild Nexus to be **simple, consistent, and genuinely real-time**, composed entirely from a shared **design system**, so the operator runs the *system* (rules + bulk actions + exceptions) rather than micromanaging thousands of individual cells.

---

## 2. The Thesis & Evidence

Across all 12 business domains the pattern is identical: **a small, genuinely excellent core, buried under redundant / dead / dark scaffolding.** Estimated **>50% of the codebase is deletable**: ~326 models → ~100, endpoints cut ~60%, the mega-files broken up.

| Domain | Core to keep | What collapses |
|---|---|---|
| Catalog/PIM | Product + `parentId` variants | Akeneo families/attributes/workflow-QA (**10 tables, 0 rows**), mapping engine (~3k LOC, gated off), 3 product UIs→1; *create is broken in prod* |
| Listings/Publishing | `ChannelListing` + outbox | **6 editors→1**, 15 publish paths→1, mapping engine delete, ~46k UI lines→a few k |
| Images/DAM | One image set per product | 22 models→~5 (2 have 0 refs), 3 image UIs→1, enterprise DAM gone |
| Orders/Customers | `Order`/`OrderItem` (excellent) | mock-data generator on a live endpoint, RFM/segments (un-actionable), buyer-messages stub |
| Fulfillment/Returns | FBM ship + label + returns | single-warehouse routing, 6-tier carrier cascade; much ships dark |
| Inventory/Stock | `applyStockMovement` ledger | 24 models→~3; lots/serials/bins/cycle-count all **0 rows** |
| Procurement | `replenishment-math` | Holt-Winters+weather forecaster→velocity; PO 11 states→4; 42 tables→12 |
| Pricing | `RepricingRule` | 6 routes/5 engines/3 rule-models→1+2; legacy inert; dup engine with a live bug |
| Marketing OS | (almost nothing) | **100% sandbox**; delete the whole campaign tree |
| Advertising | read + target-ACOS bid | 283 endpoints/3 UIs/~43k LOC, ~20% usable; **6–8 bidders→1**; DSP/AMC = fantasy |
| Insights | one "how am I doing" view | **3 dashboards→1**, 2 profit engines→1, scenarios/builder/notebook = localStorage toys |
| Platform | outbox + SSE + audit | **~90 crons→~6 essential**; auth/2FA/GDPR unenforced; AI-agents + automation dark; 15 obs tables→5 |

---

## 3. Operating Model (the product principles)

1. **Design-system-first.** Every page is one of a handful of archetypes composed from shared components. When a needed component doesn't exist, it is built *into* the design system, never locally. One component per concept → platform-wide consistency. (See [[feedback_design_system]].)
2. **You rule the system, not each item.** At 279 SKUs × 3 channels × N markets there are thousands of cells. The primary way to operate is: **surface what needs attention → select → preview before→after impact → apply across channels/markets**, plus standing rules for the routine.
3. **Real-time by default.** One canonical available-to-sell number, pushed inline in seconds — no cron-floor oversell windows.
4. **Single operator.** No multi-user auth / 2FA / consumer-GDPR theatre (the API is single-tenant).
5. **Cut everything dark by default.** Re-add only what earns its keep. A short list of cuts are genuinely the owner's call (§9).
6. **Density, not minimalism.** Salesforce/Airtable information density — "simpler" means *fewer features and consistent patterns*, not sparse screens. (See [[feedback_visibility_over_minimalism]].)

---

## 4. The 6 UI Archetypes

Everything reduces to: **List/Workspace · Detail · Tabbed-editor · Quick-edit Drawer · Wizard/Builder · Dashboard** (+ the untouchable flat-file spreadsheet as a single wrapped component).

The shared component library the rebuild composes from (build/harden order):

1. **Virtualized DataGrid** — NEW; consolidate the toy DS grid + the real `app/_shared/grid-lens` (22 files). *The single highest-leverage component — every workspace rides on it.*
2. **ListPage template** — NEW; the universal CRUD shell = PageHeader + FilterPanel + DataGrid + BulkActionBar.
3. **Form/Field system** — NEW; none exists today (field + label + validation + error).
4. **TabbedEditor scaffold** + dirty/save/nav-guard hooks — NEW (promote editor `_shared` hooks).
5. **CommandPalette** — NEW (unify the two existing forks).
6. **ConfirmDialog / useConfirm** — NEW.
7. **Chart family + KPICard** — NEW (promote `components/insights/charts`).
8. **Modal + Drawer focus-trap** — HARDEN.

**Promote, don't rebuild:** `grid-lens` (grid), `insights/charts` (charts), editor hooks already carry the app — lift them into the DS. Coordinate with the concurrent DS-hardening session; **check `apps/web/src/design-system/components/` before assuming a gap** (it ships pieces continuously).

---

## 5. Target Architecture (the clean spine)

**Data model (the keep-spine, everything else deleted):**

- **Product** (master) with `parentId` self-relation for variants. Attributes as JSON on Product. *Delete* `ProductVariation` (0 rows), the EAV/families/workflow machinery, `masterProductId`, redundant `isMaster*` flags.
- **ChannelListing** = Product/variant × channel × marketplace. **One `overrides` JSON** (delete the 4 overlapping override mechanisms). Carries `fulfillmentMethod` (FBA|FBM) per coordinate, status, `externalId`, `lastPublishedAt`. *Delete* legacy `Listing`/`DraftListing`.
- **Inventory** — per SKU, **two pools**: `warehouseOnHand`/`warehouseReserved` (operator-controlled, feeds all FBM channels) and `fbaSellable` (read-only mirror of Amazon). `available` derived. **One `StockMovement` ledger** (delete `StockLog`, bins, serials, lots, cost-layers unless §9 says otherwise). Merge `Warehouse`⇄`StockLocation` into one `Location`.
- **Order / OrderItem** — kept as-is (excellent). One `ingestCanonicalOrder()` + thin per-channel adapters (delete the per-channel re-implementations + the mock generator).
- **Pricing** — `RepricingRule` + `PricingSnapshot` + `PriceChangeEvent`. *Delete* legacy `PricingRule*`, the duplicate repricer engine (carries a live bug), and 4 of 6 pricing routes.
- **Sync/outbox** — **one `OutboundSyncQueue` + one drainer + one gate + one adapter per channel.** Delete the BullMQ/Redis second drain, `channel-sync.worker` (noop), the phase9 duplicate, and the 2 extra gate services.
- **Observability** — ~5 tables: `OutboundApiCallLog`, `CronRun`, `WebhookEvent`, `OutboundSyncQueue`, `AuditLog` (delete the other ~10, incl. zero-writer tables).
- **Crons** — ~6 essential + a handful of nice-to-have; delete the ~65 gated/no-op/dead.

**Inbound:** Amazon SQS (ORDER_CHANGE) + eBay/Shopify webhooks → the one canonical ingest + reserve path. **Outbound:** the outbox → adapters. **Live UI:** one SSE event bus.

---

## 6. The Real-Time Inventory Spine (centerpiece)

The single most important re-architecture, and the heart of "sell on Amazon → stock drops everywhere."

- **One canonical warehouse available-to-sell** per SKU = `warehouseOnHand − warehouseReserved − buffer`.
- **Any FBM sale, any channel** → reserve immediately → recompute available → **push inline (target <5s)** to every *other* FBM channel via the adapters. No 60-second cron floor on the order-driven path.
- **An FBA sale** draws from Amazon's separate pool → updates `fbaSellable` mirror only; does **not** touch the warehouse pool. (FBA and FBM are distinct pools per SKU; a channel reads the pool its `fulfillmentMethod` points to.)
- **Both FBA and FBM are first-class** — the FBM ship/label/returns flow stays; the FBA pool is mirrored read-only.
- A reconciliation cron remains as a **backstop** for missed webhooks, but the primary path is event-driven and inline. This closes today's ~16-minute oversell window.

---

## 7. Decomposition & Build Order

A **Foundation** + **7 modules**, built in dependency order. Each is its own spec → plan → build, cut over strangler-fig.

- **Module 0 · Foundation** — the DS component library (§4), the clean schema (§5), the real-time event spine (§6), and the **Bulk Grid + diff-preview** operating layer. *This is where the highest-leverage shared pieces are built once.*
- **Module 1 · Catalog** — Product + variants, simplified; one product surface (grid + detail). Fix the broken create paths.
- **Module 2 · Listings & Publishing** — **one editor** (grid + detail modes) over `ChannelListing`; **one publish pipeline** (adapter per channel); the hub's core value.
- **Module 3 · Inventory + Orders + Fulfillment** — the real-time operational loop on top of the spine (stock, order ingest, FBM ship/label/returns).
- **Module 4 · Pricing + Procurement** — one rule engine; velocity-based reordering + 4-state POs.
- **Module 5 · Insights** — collapse `/insights` + `/analytics` + `/dashboard` into one analytics surface on one data source; one True-Profit engine.
- **Module 6 · Ads + Marketing** — mostly cuts: 1 ad UI, 1 target-ACOS bidder, suggestions-only automation (never auto-pause); marketing → scheduled sale prices + eBay markdowns + Amazon coupon link.

The **Bulk Grid** ships in the Foundation; each module plugs its own actions and columns into it.

---

## 8. Execution: Strangler-Fig, Module by Module

For each module:
1. Build the new surface(s) on the design system, extending the DS with any missing shared components.
2. Reach **feature parity on the kept features** (per the audit's "core" list), not the dead/dark ones.
3. **Route-switch** the nav from the old surface to the new behind the same path.
4. **Verify live on prod** (per [[feedback_verify_on_prod_not_docker]]) — selling must never break.
5. **Delete** the old code + now-dead models/migrations (per [[feedback_workaround_sweep]] — actually remove, don't just leave dead).

The DS grows with every module and stays the single source of truth. Coordinate continuously with the in-flight DS-hardening session to avoid forking.

---

## 9. Open Decisions (owner's call, resolved per module)

These are genuine business calls, not engineering defaults. Default shown; confirm at the module's brainstorm:

- **A+ Content / Brand Story** — do you actually publish these? (default: keep a minimal A+ editor only if used)
- **GPSR lot/recall + serials** — legally required for helmets? (default: cut — 0 rows today)
- **Amazon competitive-pricing / Buy Box API** — does it work on this account? Decides whether the repricing/BuyBox pillar is real. (default: keep rule-based repricing, drop competitor-scraping if unavailable)
- **AI automation + autonomous agents** — activate or cut? (default: cut; keep copilot/assist only)
- **B2B tier pricing** (Amazon Business) — cut or keep dormant? (default: cut)
- **Italian e-invoice (FatturaPA/SDI)** — keep in-house or outsource SDI dispatch? (default: keep current generation, revisit dispatch)
- **Per-market Amazon images** — confirm never needed (Amazon is global-per-ASIN). (default: single image set)
- **Flat-file editors** — currently "untouchable" ([[feedback_flat_file_untouchable]]). The unified editor (Module 2) would eventually supersede them; until it reaches parity **and** you approve, they stay untouched.

---

## 10. Risks & Safeguards

- **Live revenue system** — parity-before-retire on every cutover; never break selling.
- **Concurrent sessions on `main`** — surgical commits (`git commit --only <path>`); watch for index collisions ([[project_concurrent_sessions]]).
- **Data migrations** — diff-then-apply, backups, phase-by-phase approval for destructive/migration steps ([[feedback_approval_before_implementing]]).
- **Don't delete preserve-by-default config** — `ChannelConnection` / `Marketplace` / OAuth / API keys survive all cleanups ([[feedback_preserve_sensitive_config]]).
- **Verify on prod**, not local Docker.

---

## 11. Next Step

Brainstorm **Module 0 · Foundation** in detail (its own design → spec → plan): the exact component contracts, the clean schema migration strategy, the real-time spine implementation, and the Bulk Grid. Nothing in the modules can be built consistently until the Foundation exists.
