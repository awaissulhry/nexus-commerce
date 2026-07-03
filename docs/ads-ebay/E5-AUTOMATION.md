# E5 — Automation & Weekly Agent

> eBay Ads workstream, Phase E5. The Owner's operating model: **zero daily involvement, one weekly review.** Ships DORMANT: global dial OFF, all starter rules disabled + PROPOSE. The E4 gate is live (`NEXUS_MARKETING_WRITES_EBAY=1`), so turning the dial makes automation real — which is why the guardrails below are hard.

## Engine (`ebay-ads-automation.service.ts`)

- **Rules** = conditions over `EbayAdsDailyPerformance` windows (`fee_pct_of_sales`, `clicks`, `sold_qty`, `ctr_pct`, `acos_pct`, `rate_minus_breakeven`, …) → actions (`adjust_ad_rate`, `set_rate_to_breakeven_factor`, `pause_ad`, `reactivate_ad`, `pause_keyword`, `bid_down_keyword`, `alert`), scoped `CPS_AD` or `CPC_KEYWORD`.
- **Modes**: rule `PROPOSE` → `EbayAdsProposal` queue; `AUTOPILOT` → applies via the E4 audited write service. **Global dial overrides** (`MarketingAutomationState` channel EBAY): OFF = evaluator skips · SUGGEST = proposals only (autopilot rules downgrade) · AUTO = rule modes decide. Halted state + `MarketingSpendCeiling.killSwitch` block applies (checked again inside the write service).
- **Automation guardrails (harder than operators')**: rate targets clamp to **break-even — no override path exists for automations**; unknown-economics entities (MISSING_COGS/PRICE) are **skipped entirely**; one PENDING proposal per (kind, entity); per-entity + per-rule cooldowns after applies; proposals expire in 14 days.
- **Reversibility**: every candidate stores its inverse; `rollbackProposal()` re-applies it through the audited write path (APPLIED → ROLLED_BACK).
- **Spend ceilings**: monthly cap per marketplace vs MTD ad fees (General has no native cap — this is the only one); ≥80% warns, breach **auto-halts the engine** + critical alert. **Verified live: a simulated breach halted automation automatically.**
- **Anomalies** (hourly guard → `notifyAutomation` + digest): fee spike vs trailing 7d, CTR collapse, campaign ended outside Nexus (Seller Hub / "easy boost" drift).
- **Weekly digest** (`EbayAdsDigest`, Monday ~06:30 Rome + on demand): week totals vs prior, campaign movers, autopilot actions, pending proposals (deep-link to the approval queue), anomalies, economics health. Data + renderer split — email/WhatsApp can consume the same payload later.

## Starter rule-pack (installed via one click; all disabled + PROPOSE)

1. **Fee % creep-down (CPS)** — fee>20% of sales over 14d → rate −10% (clamped to break-even)
2. **Click bleeder — remove ad (CPS)** — ≥30 clicks, 0 sold in 30d (any-click makes these expensive)
3. **Rate above break-even — repair (CPS)** — rate>BE → BE×0.8 (the margin-anchored substitute for the missing IT/FR/ES suggested-rate API)
4. **Restock re-promote (CPS)** — STALE ad whose listing is live with stock → re-promote
5. **Keyword bleeder — pause (CPC)** — ≥20 clicks, 0 sold in 30d
6. **Keyword bid-down on thin CTR (CPC)** — ≥1000 impressions, CTR<0.2% → bid −20%

Catch-all enrollment: create via the builder (General · rules, auto-select ON) — eBay then adds/removes matching listings daily; keyword harvesting from search-query reports activates when a CPC campaign runs again (all 4 are paused since 2024).

## Surfaces

- `/marketing/ads/ebay/automation` — dial (Off/Suggest/Auto), halt-everything, ceilings (+% used), rules (enable / PROPOSE↔AUTOPILOT / last-run stats / Evaluate now), **approval queue with bulk approve-reject**, recently-applied with **one-click rollback**.
- `/marketing/ads/ebay/digest` — the weekly review page + "Mark week reviewed".
- Crons: evaluator daily 05:45 UTC, anomaly guard hourly, digest Monday — all in `/sync-logs` with manual triggers.

## Verification

**Live write-path validation (operator-authorized by the gate flip)** — sacrificial campaign `164088027018`, total exposure ≈90s of one 2–2.5% ad: live create → live promote (real adId `3395323338018`) → proposal approve → **live rate 2%→2.5%** → **rollback → eBay itself confirms 2.0%** → remove ad → END. Bonus finding fixed en route: eBay's per-item bulk errors were under-parsed; the first attempt surfaced "*An ad for listing Id … already exists*" (one listing = one active General campaign — the sliders were already in "Xavia Slider Standard"), now reported honestly per item.
**Engine on prod data (SUGGEST)**: starter pack installs (6), evaluator ran 6 rules over 51 entities with 0 errors, **manual-only proven** (zero evaluator-generated rate proposals while COGS missing), 6 executions recorded, digest generated with real totals/movers, anomaly guard clean, **ceiling-breach auto-halt verified**, posture restored to OFF. Suite: 104 unit tests + tsc clean.

## Turning it on (the Owner's dial, not a deploy)

1. `/marketing/ads/ebay/automation` → Install starter pack → enable the rules you want (start with #3 once costs land).
2. Dial to **Suggest** for a week or two — review Monday digests, approve/reject.
3. Dial to **Auto** + flip chosen rules to AUTOPILOT when the proposals have earned trust. Ceiling for EBAY_IT is pre-set at €300/month — adjust on the same page.
