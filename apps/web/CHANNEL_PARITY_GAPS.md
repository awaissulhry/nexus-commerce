# Channel Parity Gaps

> Last updated: 2026-05-10 — Phase RECON (pre-activation)
>
> Tracks what Nexus can do vs. what still requires Seller Central / eBay Seller Hub.
> Update this file when a gap is closed or a new one is discovered.

---

## Amazon — What Nexus can do now

### Inbound (channels → Nexus)
- ✅ FBA inventory sync every 15 min (`amazon-inventory-sync`)
- ✅ FBA status polling every 15 min (`fba-status-poll`)
- ✅ Amazon orders — 15-min polling cron enabled; 12-month backfill script available
- ✅ Amazon financial events — daily cron (02:00 UTC); 12-month backfill script available
- ✅ FBA restock recommendations (`fba-restock-ingestion`)
- ✅ FBA PAN-EU sync (`fba-pan-eu-sync`)
- ✅ MCF shipment status sync
- ✅ Amazon returns polling
- ✅ Sales & traffic data (via Amazon reports — `sales-report-ingest`)
- ✅ Amazon suppressions tracked in `AmazonSuppression` table
- ✅ Channel stock drift detection (CS-series)

### Outbound (Nexus → Amazon) — GATED (publish gate OFF during observation)
- ✅ Price updates — wired via `masterPriceService` → `OutboundSyncQueue` → `pricing-outbound.service.ts` → `amazonSpApiClient.patchListingPrice()`
- ✅ Listing publish — full listing create/update via `amazon-sp-api.client.ts` (LISTING + LISTING_OFFER_ONLY semantics)
- ✅ Inventory quantity updates — via `ReviseInventoryStatus` / SP-API patch
- ✅ FBA inbound shipment creation (`amazon-mcf.service.ts`)
- ✅ Buy Shipping (purchase labels)
- ✅ Coupon management (`amazon-coupon.service.ts`)
- ✅ A+ Content publish (`aplus-amazon.service.ts`)
- ✅ Brand Story publish (`brand-story-amazon.service.ts`)

### Activation gates remaining
- ⏳ Reconciliation not yet run (operator must trigger `/reconciliation`, review all rows)
- ⏳ 1-week observation period (read-only crons running, no writes)
- ⏳ Canary test (single low-stakes listing, €0.01 price change)
- ⏳ Graduated rollout (5 → 25 → 100 → full)

---

## Amazon — Still requires Seller Central

| Task | Why still in Seller Central | Nexus roadmap |
|------|-----------------------------|---------------|
| Account-level settings (business info, banking) | Seller Central-only UI | Out of scope |
| Trust & Safety responses | Must respond via Seller Central messaging | Out of scope |
| Brand Registry management | Amazon Brand Registry portal | Out of scope |
| GTIN exemption applications | Seller Central form | Stub in Nexus (`GtinExemptionApplication`) |
| Sponsored Products / PPC | Amazon Advertising console | Out of scope (future MC wave) |
| Vine program enrollment | Seller Central-only | Out of scope |
| FBA dangerous goods review | Amazon-controlled | Out of scope |
| Report downloads (custom) | Seller Central reports UI | Partially in Nexus (`ScheduledReport`) |
| Invoicing to Amazon (Vendor) | Vendor Central | Out of scope |

---

## eBay — What Nexus can do now

### Inbound (channels → Nexus)
- ✅ eBay OAuth connection active (token refresh cron running, 64+ runs)
- ✅ eBay orders — 15-min polling cron enabled
- ✅ eBay financial events — daily cron (03:30 UTC); 12-month backfill script available
- ✅ eBay returns polling
- ✅ eBay token refresh (automatic)

### Outbound (Nexus → eBay) — GATED
- ✅ Listing publish via eBay Inventory API (`ebay-publish.service.ts`)
- ✅ Price update — `ReviseInventoryStatus` wired in `pricing-outbound.service.ts`
- ✅ Listing markdown management (`EbayMarkdown`, `ebay-markdown.service.ts`)
- ✅ eBay Promoted Listings campaigns (`EbayCampaign`, `ebay-markdown.service.ts`)
- ✅ Listing reconciliation — pull all eBay offers, match to Nexus products

### Inventory gap
- ⚠️ eBay has sparse listings vs Amazon (per Phase 0 audit). Phase 3 (eBay listing creation) needed to reach parity.
- Target: every Amazon IT/DE/FR product also listed on eBay IT/DE/FR at 50/day ramp.

### Still requires eBay Seller Hub

| Task | Reason | Nexus roadmap |
|------|-----------------------------|---------------|
| eBay account settings | Seller Hub-only | Out of scope |
| Trust & Safety / policy violations | Seller Hub messaging | Out of scope |
| Managed Payments disputes | Seller Hub UI | Visible via financial sync |
| Store design / banner | Seller Hub | Out of scope |
| Performance metrics dashboard | Partially in Nexus (`EbayWatcherStats`) | MC wave future |
| Feedback responses | Seller Hub | Out of scope |
| Promoted Listings analytics | Seller Hub reporting | Partially via `EbayCampaign` |

---

## Shopify — What Nexus can do now

### Inbound
- ✅ Orders via webhook (Shopify sync job)
- ✅ Inventory via Shopify API (`shopify-locations.service.ts`)

### Outbound — NOT FULLY WIRED
- ⚠️ Price / inventory updates to Shopify are stubbed in `outbound-sync.service.ts` (NOT_IMPLEMENTED)
- ⚠️ Shopify financial events not ingested (no FinancialTransaction rows from Shopify)

### Still requires Shopify Admin
- Everything beyond order viewing requires Shopify Admin until outbound sync is wired

---

## Channels out of scope (per active channel decision)

- **WooCommerce** — not a target channel; sync jobs exist but are not enabled
- **Etsy** — not a target channel; routes exist but credentials not configured
- **Amazon EU marketplaces beyond IT** — DE/FR/ES connection is single-account (same SP-API credentials), activation follows IT parity proof

---

## Phase gating summary

| Phase | Status | Gate |
|-------|--------|------|
| 0 — Pre-flight audit | ✅ Done | — |
| 1A — Amazon IT connection verified | ✅ Done (inventory sync running 129x) | — |
| 1B — Reconciliation infrastructure | ✅ Built | Operator must run + review |
| 1C — Activation (canary) | ⏳ Blocked | Reconciliation review complete |
| 2A — Amazon data ingestion | ✅ Built (orders + financials) | Backfill scripts ready |
| 2B — eBay data ingestion | ✅ Built (orders + financials) | Backfill scripts ready |
| 3 — eBay listing creation | 🔲 Not started | Reconciliation + activation first |
| 4 — Bi-directional sync verification | ⏳ Blocked | Needs reconciled listings (externalListingId set) |
| 5 — Operational handoff | 🔲 Not started | All prior phases |
