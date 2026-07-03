# E0 — eBay Promoted Listings Verified Capability Matrix

> eBay Ads workstream, Phase E0 deliverable 2 of 5. **Verified against live sources 2026-07-03** — Sell Marketing API **v1.23.2** (live OpenAPI contract `https://developer.ebay.com/api-docs/master/sell/marketing/openapi/3/sell_marketing_v1_oas3.json` — build against this, it is the most stable machine-readable source), rendered developer.ebay.com reference pages, official eBay announcements, and localized IT/DE/FR/ES help pages. Complemented by **live production probes** against the seller's own account (`scripts/_e0-ebay-probe*.mjs`).
> Verdicts: **CONFIRMED** = master-prompt §3 claim verified · **DELTA** = corrected · each with the correction inline.

## 0. Two cross-cutting source warnings

1. **Docs migration:** old per-method URLs (`/api-docs/sell/marketing/resources/...`) redirect to a consolidated reference at `developer.ebay.com/develop/api/sell/marketing_api`; static guides (`/api-docs/sell/static/marketing/*.html`) still serve at old URLs.
2. **Stale doc text is live:** `pl-overview.html` / `pl-campaign-flow-pls.html` still contain pre-2022 sentences that contradict the current API ("1% minimum rate", "ad rates cannot be updated after campaign creation", "last click attribution", "negative keywords exact-only"). **Where guides and the OAS/announcements conflict, the OAS + release notes + announcements win.** Several master-prompt §3 beliefs traced to these stale sentences.

## 1. Verdict table (all 21 claims)

| # | Claim (master prompt §3) | Verdict |
|---|---|---|
| 1 | General = COST_PER_SALE; ad rate % of total sale | **CONFIRMED** — fee base = "total sale amount (including item price, shipping, taxes, and any other applicable fees)"; a "click" includes watchlist-add, add-to-cart, quick view; rate bounds **2.0%–100%** (the old 1% floor is stale) |
| 2 | General works on fixed-price AND auctions | **CONFIRMED** — auctions: DE pilot 2023-08-07 (v1.15.3), all marketplaces 2024-04-29 (v1.21.2, with PL Express retirement) |
| 3 | Any-click attribution "effective Jan 13 2026" | **DELTA** — mechanics exact ("any buyer purchases the promoted item within 30 days of any click … regardless of whether the buyer themselves clicked"; item must be promoted at click AND at sale; **fee = ad rate at time of sale**); but Jan 13 2026 was **US/CA**. **DE 2025-02-26; IT/FR/ES (with UK/AU) 2025-06-24** — all four of our markets have been any-click for ~1 year. Replaced Direct + Halo attribution (historical report rows keep Direct/Halo pre-cutover; new rows say "Attributed sale") |
| 4 | Priority = CPC, keywords, 2nd-price auction, exclusive top slot, fixed-price only | **DELTA** — core confirmed (second-price: "charged … between the next highest bid and your bid"); exclusivity confirmed for DE (2025-02-26) + US/CA (2026-01-13), **unconfirmed for IT/FR**; **Priority is NOT available in ES** ("Priority campaigns are not currently supported in the ES marketplace"); Priority GA (no approval gate) since v1.23.1, 2026-04-27 |
| 5 | MANUAL vs SMART targeting; suggestMaxCpc; smart = on-site only | **CONFIRMED** — `campaignTargetingType: MANUAL (default) | SMART`; maxCpc via `fundingStrategy.bidPreferences[].maxCpc` (min 0.02 / max 100), required for SMART, updatable via `updateBiddingStrategy`; `POST /ad_campaign/suggest_max_cpc` (v1.22.0). Extra: SMART capped at **3,000 listings/campaign**, has no ad groups, and **cannot be switched SMART↔MANUAL after launch** |
| 6 | Manual structure; negatives exact-only; FIXED/DYNAMIC bidding | **DELTA** — structure + match types (BROAD/EXACT/PHRASE) + keyword limits (100 chars/10 words) confirmed; **negative keywords support EXACT AND PHRASE** (`pls:NegativeKeywordMatchTypeEnum`; broad not supported); negatives attach at ad-group level via top-level `POST /negative_keyword`; `biddingStrategy` FIXED (default)/DYNAMIC changeable via `update_bidding_strategy`; under DYNAMIC manual bid edits are locked (bulkCreateKeyword warns if bid passed) — confirmed |
| 7 | Offsite = CPC + channels [OFF_SITE]; suggestBudget; available IT/DE/FR/ES | **CONFIRMED** — plus: campaign-level only (no ad groups/keywords/listing selection), **only ONE offsite campaign per seller**, eBay-set CPC, budget may spend **2× daily in a day, 30.4× daily per month**, impressions not in reporting; gate via Account API `getAdvertisingEligibility` |
| 8 | Rules-based CPS: campaignCriterion, ≤10 selectionRules, auto-select future listings | **CONFIRMED** — exact OAS fields `CampaignCriterion{autoSelectFutureInventory, criterionType, selectionRules}` / `SelectionRule{brands, categoryIds, categoryScope(MARKETPLACE|STORE), listingConditionIds, minPrice, maxPrice}`; auto-select assessed **daily** and both **adds AND removes**; `criterionType=INVENTORY_PARTITION` only for Inventory-API sellers — **omit for Trading-created listings** (ours are Trading-created); **selection rules are immutable post-creation** (clone or recreate); >50,000 matches → first 50,000 by recency |
| 9 | bulkCreateAdsByListingId / ByInventoryReference; 50k/campaign | **CONFIRMED** — plus `bulkUpdateAdsBid*`, `bulkDeleteAds*`, `bulkUpdateAdsStatus*`, `createAdByListingId`, `updateBid`; ByInventoryReference is CPS-only; **500 listings/call** (documented on bulkCreateAdsByListingId; treat as safe batch for all); 50,000 ads/campaign; **each variation counts as an ad**; no documented per-seller campaign-count limit |
| 10 | Campaign ad rate CANNOT change after creation | **DELTA — OUTDATED (biggest correction).** `POST /ad_campaign/{id}/update_ad_rate_strategy` (v1.12.0, 2022-07-11) updates `adRateStrategy` + `bidPercentage` + `dynamicAdRatePreferences` post-creation for rules-based CPS; per-ad rates via `updateBid` / bulk bid updates (key-based); name/dates via `updateCampaignIdentification`; CPC budget via `updateCampaignBudget`. **fundingModel remains immutable** (end/clone/recreate). Campaign `bidPercentage` = default, overridden by ad-level rates |
| 11 | Out-of-stock ads auto-hidden, resurface on restock | **CONFIRMED** — placement suppression only; no API status flip is exposed |
| 12 | adRateStrategy FIXED/DYNAMIC; find exact dynamic fields | **CONFIRMED** — `fundingStrategy.adRateStrategy: FIXED (default) | DYNAMIC` (CPS-only); `dynamicAdRatePreferences[]` has exactly **`adRateAdjustmentPercent`** (± vs eBay suggested rate) and **`adRateCapPercent`** (max the adjusted rate may reach); `bidPercentage` must be omitted under DYNAMIC; re-rates daily |
| 13 | Report pipeline + types | **DELTA** — pipeline confirmed (createReportTask → poll `TaskStatusEnum` → download `reportHref`, format **TSV_GZIP only**, 1M-row cap). Current `ReportTypeEnum` (9): ACCOUNT_PERFORMANCE_REPORT (CPS+CPC), ALL_CAMPAIGN_PERFORMANCE_SUMMARY_REPORT (**CPC-only**), CAMPAIGN_PERFORMANCE_REPORT, CAMPAIGN_PERFORMANCE_SUMMARY_REPORT, INVENTORY_PERFORMANCE_REPORT (**in enum but "not currently available"**), LISTING_PERFORMANCE_REPORT, KEYWORD_PERFORMANCE_REPORT (CPC-only), TRANSACTION_REPORT (per-model; CPC variant carries `sale_type`), **SEARCH_QUERY_PERFORMANCE_REPORT (CPC-only — new to us)**. **CPC tasks can be account-wide (blank campaignIds); CPS tasks must enumerate campaignIds (≤1,000)**; funding models cannot mix (multi-model deprecated); `ad_report_metadata(/{type})` returns dimensions/metrics + max counts |
| 14 | 72h adjustment window | **CONFIRMED** — official "**Reconciliation Period**": sales/ad-fee data may need up to 72h; all other metrics near-real-time |
| 15 | Quotas: reports ~200/hr; budget 15/day | **CONFIRMED (a,b) + DELTA (c)** — report methods 200/hr/seller (then blocked 1h); updateCampaignBudget 15/day/campaign; **app-level daily limits: Marketing "Ads" 10,000/day, Marketing "Promotion" 100,000/day** (defaults, raisable via Application Growth Check; re-read the api-call-limits page at integration time) |
| 16 | Sandbox can't run PL reports | **DELTA** — the documented exclusion is **gone**; reference boilerplate now claims sandbox support on report methods; KB 684 lists no Marketing gaps. Practical stance: endpoints respond, but sandbox report **data** is untrustworthy — verify on production read-only |
| 17 | Suggestion endpoints | **DELTA** — verified set: `suggest_max_cpc` (SMART), `suggest_keywords` (CPC, ≤300 listingIds), `suggest_bids` (CPC, ≤500 keywords), `suggest_items` (CPC), `suggest_budget` (Offsite only). **No Marketing API endpoint returns suggested CPS ad rates.** CPS rate suggestions exist ONLY in Sell **Recommendation API** `POST /sell/recommendation/v1/find` (`promoteWithAd` + trending `bidPercentage`) — requires **`sell.inventory` scope** and is **restricted to AU/DE/GB/US** → of our markets **only DE**; IT/FR/ES have no suggested-rate API |
| 18 | Scopes; token upgrade without re-consent? | **CONFIRMED** — `sell.marketing` (writes AND all suggest* methods; `.readonly` insufficient for suggest*); Recommendation API needs `sell.inventory`. **Re-consent IS required to add scopes** — refresh grants must be equal/subset of consented scopes; access token ~2h, refresh ~18 months |
| 19 | Per-marketplace availability | **CONFIRMED substance** — PL supported on US/GB/DE/AU/FR/IT/ES/CA; regional advertising ToS must be accepted or campaign launch errors; **ES lacks Priority**; matrix below |
| 20 | 2026 size standardization | **CONFIRMED enforcement / UNVERIFIED scope for moto gear** — scope "Apparel & Footwear" item specifics (incl. API/File Exchange/third-party listings); **June 2026** auto-normalization + custom-value removal; **July 2026** listings with non-standard/missing size **and/or condition** values "blocked from the site or placed on hold" (ebay.it: "potrebbero rimanere nascoste"); compliance via category aspect metadata (Taxonomy `getItemAspectsForCategory`); **no source names motorcycle-apparel categories in or out of scope — no category list is published**; no eBay bulk-fix tool (auto-normalization + third-party e.g. Optiseller) |
| 21 | Anything new since Jan 2026 | See §3 sweep |

## 2. Live-probe additions (this seller, 2026-07-03)

- `GET /sell/account/v1/advertising_eligibility` (works with current token): **IT/DE/FR/ES all ELIGIBLE** for `PROMOTED_LISTINGS_STANDARD`, `PROMOTED_LISTINGS_ADVANCED`, `OFFSITE_ADS`. Note the **program-name split**: Account API still speaks legacy names (bare `PROMOTED_LISTINGS` is rejected, error 50116); Marketing API speaks funding models. (ES "ADVANCED: ELIGIBLE" from the Account API vs "Priority not supported in ES" from the docs is a known eBay inconsistency — treat docs as binding and re-probe at E2.)
- `GET /sell/marketing/v1/ad_campaign` → **403 Insufficient permissions**: current grant lacks `sell.marketing` → **operator re-consent required before E2** (scope already in the code's consent list; Settings → Channels → reconnect eBay, or `POST /api/ebay/auth/initiate`).
- Account census: 20 live items, all eBay IT, mixed Trading/no-SKU (11) — see `E0-PRODUCT-LISTING-MAP.md`.

## 3. Since-Jan-2026 sweep (console must handle)

1. **"easy boost"** (launched 2026-06-03): mobile-app flow promoting ALL eligible listings at one CPS rate, auto-including new listings — **and silently replacing existing General ad rates** ("they'll be included in easy boost automatically and will use the single ad rate you select"). → Console needs **external-change drift detection** (we already sync-and-diff; alert when rates change outside Nexus).
2. **Marketing API releases**: v1.22.4 (2026-01-27) added multi-currency report keys (`daily_budget_payout_currency`, `avg_cost_per_sale_listingsite_currency`, `cost_per_click_listingsite_currency`, …) — useful for IT/DE/FR/ES; **v1.23.0 (2026-03-31) decommissioned `setupQuickCampaign` + `launchCampaign`** (do not ship); v1.23.1 (2026-04-27) Priority GA; v1.23.2 (2026-06-04) new error codes on create/clone/pause/updateCampaignIdentification/updateAdRateStrategy.
3. **Priority Video Ads** beta: AU Mar 2026 → US/UK/DE/CA Apr 2026; **not IT/FR/ES yet** (watch item, not scope).
4. **Naming**: July-2024 rebrand (Standard→General/PLG, Advanced→Priority/PLP, Offsite Ads→Promoted Offsite, Promoted Display→Promoted Stores); PL Express retired 2024-04-15. **Promoted Stores is NOT in the Sell Marketing API contract** (channels = ON_SITE/OFF_SITE only) → out of console scope.
5. **Change publication**: classic seller updates ended (archive stops Oct 2024) — monitor monthly Seller News + community Announcements.

## 4. Required OAuth scopes (consent design)

| Scope | Why |
|---|---|
| `https://api.ebay.com/oauth/api_scope/sell.marketing` | all campaign/ad/keyword/report writes AND all suggest* methods |
| `…/sell.marketing.readonly` | optional (pure reads; NOT sufficient for suggest*) |
| `…/sell.inventory` | already held; also required for Recommendation-API CPS rate suggestions (DE only) |
| `…/sell.account` | already held; `getAdvertisingEligibility` |
| (rest of existing list) | unchanged |

**Request the full set in one consent** — refresh tokens can only keep or narrow scopes; every scope addition forces operator re-consent. The code's consent list (`ebay-auth.service.ts:74–83`) already includes `sell.marketing` → one reconnect suffices.

## 5. Per-marketplace availability (verified 2026-07-03)

| Capability | EBAY_IT | EBAY_DE | EBAY_FR | EBAY_ES |
|---|---|---|---|---|
| General (CPS) | ✔ | ✔ | ✔ | ✔ |
| Priority manual (CPC) | ✔ | ✔ | ✔ | **✖** |
| Priority smart (CPC) | ✔ | ✔ | ✔ | **✖** |
| Offsite | ✔ | ✔ | ✔ | ✔ |
| Any-click attribution live | ✔ 2025-06-24 | ✔ 2025-02-26 | ✔ 2025-06-24 | ✔ 2025-06-24 |
| Priority exclusive top slot | unconfirmed | ✔ 2025-02-26 | unconfirmed | n/a |
| Suggested-rate API (Recommendation) | **✖** | ✔ (needs sell.inventory) | **✖** | **✖** |
| Priority Video Ads beta | ✖ | ✔ Apr 2026 | ✖ | ✖ |
| Seller eligibility (live probe) | ELIGIBLE ×3 | ELIGIBLE ×3 | ELIGIBLE ×3 | ELIGIBLE ×3 |

## 6. Design consequences (bound into `E0-ARCHITECTURE.md`)

1. **Rate editing, not recreate** (Δ10/12): `updateAdRateStrategy` for rules-based CPS; `updateBid`/bulk for key-based; clone-or-recreate ONLY for selection-rule changes.
2. **Hard ES branch** (Δ4): hide Priority entirely for EBAY_ES (General + Offsite only).
3. **Any-click everywhere** (Δ3): fee forecasting assumes any-click/any-buyer; rate raises expose in-window click debt (fee = rate at sale); parse "Attributed sale" sale_type, keep Direct/Halo parsing only for historical rows.
4. **Suggested rates for IT/FR/ES**: no API → offer `DYNAMIC` strategy with `adRateCapPercent` (margin-derived cap) as the "follow eBay's suggestion, bounded" option; Recommendation API for DE only.
5. **Report scheduler**: fan out per funding model; CPS tasks enumerate campaignIds (≤1,000); CPC account-wide; Redis budget for 200/hr + 10k/day; last-72h figures labeled provisional.
6. **Budget writes coalesced** (15/day/campaign hard cap; counter surfaced in UI).
7. **Sandbox untrusted for reports** — verify on production read-only tasks.
8. **easy boost drift watch** — diff-alert on external rate changes.
9. **Negatives EXACT+PHRASE; bid inputs disabled under DYNAMIC bidding.**
10. **Batch 500; 50k ads/campaign; variations count as ads; omit criterionType for Trading-listing rules campaigns.**
11. **Don't build on** `setupQuickCampaign`/`launchCampaign` (removed) or Promoted Stores (not in API).
12. **Size-standardization pre-check before July 2026** — Taxonomy-API probe of our moto categories on IT/DE/FR/ES; remediate Size/Size Type/condition on any fashion-tree listings (see `E0-FINDINGS.md`).

## 7. Primary sources

Live OAS v1.23.2 (marketing + recommendation) · `developer.ebay.com/develop/api/sell/marketing_api` (consolidated reference) · release notes `developer.ebay.com/develop/api/sell/release_notes#marketing-api` · static guides `pl-overview.html`, `pl-campaign-flow-pls.html`, `pl-campaign-flow-pla.html`, `pl-verify-eligibility.html`, `pl-supported-categories.html`, `pl-reports.html`, `offsite-ads.html` (with stale-text caveats) · type pages `pls:CampaignTargetingTypeEnum`, `pls:MatchTypeEnum`, `pls:NegativeKeywordMatchTypeEnum`, `pls:AdRateStrategyEnum`, `plr:ReportTypeEnum`, `plr:TaskStatusEnum` · `developer.ebay.com/develop/get-started/api-call-limits` · `developer.ebay.com/develop/guides-v2/authorization` · `developer.ebay.com/updates/blog/size-standardization` + ebay.it id=4105 · eBay attribution announcement (export.ebay.com + community) · localized help id=4164/5299/5471 (it/de/fr/es) · KB 684 · Q1-2026 dev newsletter · secondary corroboration: ValueAddedResource, ChannelX, wortfilter.de (URLs inline above).
