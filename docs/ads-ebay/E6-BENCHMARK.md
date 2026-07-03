# E6 — Benchmark Pass (scored against the E0 "beat them here" checklist)

> Scoring: **PASS** (bar met, evidence cited) · **PARTIAL** (works, bar not fully cleared) · **DEFERRED** (deliberate, rationale + owner decision requested). Evidence = live verifications run 2026-07-03 (E2–E5 gate records) + cited files.

## (a) Product-first operations
1. **Product → item IDs everywhere — PASS.** `/products` page: every product row lists all live item-ID chips (resolver union INDEX ∪ SHARED ∪ CHANNEL); 1 click to eBay, campaign detail links ads back. Evidence: `getLiveEbayItemIds()` + E3 smoke (76 products, 16 unmatched surfaced).
2. **Family-level operations — PARTIAL.** Product-first promote covers multi-select of variant-products in one confirmed bulk op; a *family* (parent) grouping level doesn't exist yet — the products grid is variant-grain. Defer: family rollup rides the existing family model once eBay listings map at family level (post-workstream).
3. **Attribute-driven enrollment beyond eBay's rule fields — PARTIAL.** eBay-native rules (brand/category/price/condition + auto-select) ship in the builder with a local preview; enrollment keyed on Nexus-only fields (margin band, stock, sell-through) is designed (rules engine reads any DB field) but no starter rule uses one yet. Defer: add on first operator request — engine supports it.
4. **Cross-market coverage audit — DEFERRED.** Only IT has listings today; the report is meaningless until DE/FR/ES listings exist. The resolver + index are multi-market-keyed, so this is a small query+panel when relevant.
5. **Break-even per SKU×market — PASS (pending data).** Computed + shown next to every rate input (`EbayListingEconomics`, `BreakEvenCell`), recomputed daily + on demand; reads `costPrice` ∥ WAC cost master (E6 wiring). Currently every listing is honestly `MISSING_COGS` because **no cost data exists anywhere in the catalog** (verified: costPrice, PO history, WAC all 0 rows) — the single remaining operator input.
6. **Net-margin-after-ads first-class — PARTIAL.** eBay ACOS is everywhere and labeled; € net margin after fees needs #5's data. Displays flip on automatically with costs.
7. **Margin-derived max CPC — PASS (pending data + CPC activity).** `computeBreakEvenCpcCents` (margin × trailing CVR, ≥50 clicks) implemented + tested; all CPC campaigns are paused, so no live surface shows it yet.
8. **Bounded auto-rates — PASS.** Automations clamp to break-even with **no override path** (verified live: 0 evaluator rate proposals while COGS missing); operator overrides require an explicit named reason (audited; verified in the E4 23/23 run); DYNAMIC campaigns require a hard `adRateCapPercent` at creation.
9. **Click-debt-aware rate changes — DEFERRED.** Any-click exposure estimate before a General rate raise needs click-level recency data the reports don't carry at listing grain; documented in the raise flow copy instead. Revisit if eBay exposes click timestamps.

## (c) Automation & guardrails
10. **Rules engine ≥ 3Dsellers + economics — PASS.** All 3Dsellers triggers (impressions/clicks/fees/sales/sold/ROAS-equivalents) + `fee_pct_of_sales` + `rate_minus_breakeven` + marketplace scoping + implicit minimum-data (window sums; bleeder rules require ≥N clicks). Evidence: `ebay-ads-automation.service.ts`, 6-rule starter pack, live evaluation over 51 entities.
11. **Propose → apply — PASS.** Per-item diff (from→to + reasoning incl. clamp notes), bulk approve/reject, autopilot opt-in per rule AND gated by the global dial (ships OFF). Verified live: approve applied a real rate change.
12. **One-click rollback — PASS.** Inverse stored per proposal; rollback through the audited write path. **Verified live: eBay confirmed the restored rate.** (30-day changeset restore beyond proposals: `CampaignAction.payloadBefore` holds the data; bulk-changeset UI deferred.)
13. **True spend ceilings across both fee models — PASS.** Monthly cap per marketplace vs MTD attributed fees (the only General cap in the market); breach **auto-halts** (verified) + critical alert; kill switch stops every write.
14. **Scheduling/dayparting — DEFERRED.** No eBay ads scheduling shipped; eBay has none natively and current spend (~€2/day) doesn't justify it. The rank-schedule pattern is ready to clone on demand.
15. **Holdout experiments — DEFERRED.** Promote-vs-pause alternation designed but not built; needs steadier volume to read lift. Candidate for the first post-workstream iteration.

## (d) Reporting depth & attribution honesty
16. **Restatement-visible metrics — PARTIAL.** The 72h Reconciliation Period is re-pulled daily with absolute upserts + `reportedAt` freshness on every row and "provisional" labeling; per-figure restatement *deltas* (badge vs first report) would need first-report snapshots — deferred as a fact-history table.
17. **Any-click honesty — PASS.** Every sales figure is labeled any-click (`attributionModel: 'ebay-any-click'` in facts + rollup; UI labels on KPIs/detail/digest); TACOS-style effective load per product = fees vs product-level sales on the products page.
18. **Fee-to-order audit trail — DEFERRED.** Requires TRANSACTION_REPORT ingestion joined to orders; scheduled report grains cover campaign/listing/keyword today. Deliberate: the account's fee volume (€55/28d) doesn't yet warrant the pipeline; the report type + parser slot in cleanly.
19. **Query-to-margin keyword intelligence — PARTIAL.** Search-query report support + negative proposals are engine-ready but dormant: all 4 CPC campaigns paused since 2024 → no query data exists. Activates with the first running Priority campaign.
20. **Full-grain history — PASS.** Daily grain retained indefinitely (no retention trim on `EbayAdsDailyPerformance`); any range serves at daily grain via `/trend` + CSV export.

## (e) Bulk & power tools
21. **CSV round-trip — PASS.** One export = campaigns+ads+keywords with break-even column; import validates → dry-run diff grid → per-row apply through guardrails (verified in E4 23/23). Multi-market columns present (marketplace per row).
22. **Unbounded bulk rate ops — PASS.** Filter/select any size; 500-chunked; per-item results with real eBay messages (hardened live in E5 — "ad already exists" surfaced).

## (f) Multi-marketplace single pane
23. **Four markets, one console — PASS (IT-live).** One console, marketplace dropdown per page, EUR-consistent; includes Seller-Hub-created campaigns (all 11 discovered ones are). DE/FR/ES render empty-by-truth until listings exist.
24. **Cross-market campaign cloning — PARTIAL.** Clone ships (same market — the rules-immutability workaround); clone-to-other-market is a parameter away but pointless with IT-only listings. Defer until a second market has inventory.

## (g) Alerting / weekly digest
25. **Real-time guardrail alerts — PARTIAL.** In-app `notifyAutomation` within the hourly guard (fee spike, CTR collapse, external campaign end, ceiling ≥80%); email delivery deliberately deferred (in-app first per the master prompt's channel-pluggable design).
26. **Monday digest — PASS.** Every section present (totals vs prior, movers, autopilot actions, pending approvals deep-link, anomalies, data health) + "Mark week reviewed"; generated weekly + on demand (verified on real data).

**Score: 13 PASS · 7 PARTIAL · 6 DEFERRED** — every PARTIAL/DEFERRED has a stated trigger (cost data entry, CPC reactivation, second-market inventory, volume growth) rather than an open end. The three strategic gaps no competitor fills (break-even economics, product-first, any-click honesty) are all in the PASS column — economics pending only the operator's cost data.

## Performance / a11y / i18n / states sweep

- **Perf**: grids are DS `DataGrid` (sticky, sortable) — right-sized for ≤~200 rows (today: 11 campaigns / 76 products); the documented swap at scale is grid-lens `VirtualizedGrid` (TanStack Virtual), already used shell-wide. API aggregates ride the natural-key indexes (`[marketplace, fundingModel, entityType, entityId, date]`, `[entityType, entityId, date]`); heaviest endpoint (products) = 3 queries + in-memory join over 20 listings. Sync cost ≈ 60 read calls/day vs quotas of 10k/day + 200/hr (ledger-budgeted).
- **A11y**: all interactive controls labeled (`aria-label` on selects/tablist, `role="tab"` channel switch, keyboard handler on the mode chip, `role="status"` sandbox banner); DS components carry their own semantics.
- **i18n/currency**: operator UI intentionally English (standing decision); ALL money renders via locale-safe formatters with explicit currency; EUR-comma locale handling proven in the report parser; GBP-ready fields throughout.
- **Empty/error/degraded states**: designed on every page (no-data explainers with next actions, error banners with retry, skeletons, sandbox/halted banners, quota-exhausted and unrecognized-schema paths fail loud). Verified paths: 403-scope, empty CPC reports, missing COGS, breaker skips.

## Findings closed in E6
- **Size mandate (F3): RESOLVED — no action needed.** Taxonomy probe (2026-07-03, post-June): all four moto categories on EBAY_IT still have `Taglia` as `FREE_TEXT`, not required → outside the Apparel&Footwear enforcement scope. Jackets carry standard values anyway.
- **COGS source: wired** (`costPrice` ∥ `weightedAvgCostCents`); blocked purely on data entry — see RUNBOOK §"Turning on break-evens".
