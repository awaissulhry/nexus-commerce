# E0 — Competitor Teardown: eBay Promoted Listings Tooling

> eBay Ads workstream, Phase E0 deliverable 4 of 5. Compiled 2026-07-03 from live vendor docs, help centers, press, and community sources (URLs inline). E6 is scored item-by-item against the checklist at the end of this document.
> Context: we build inside Nexus (catalog, COGS, eBay fees, multi-marketplace listings already in-system) for a motorcycle-gear seller on eBay IT/DE/FR/ES.

## 0. The 2025–26 platform shifts that frame everything

- **"Any-click" attribution (General):** a fee is charged when a promoted item sells and *any buyer* clicked *any* ad for it in the prior 30 days (rolling window; each click extends it; the fee = ad rate **at time of sale**, not at click). Rollout: **DE Feb 2025; UK/AU/FR/IT/ES June 2025; US/CA Jan 13, 2026** — i.e. **all four of our markets have been on any-click for over a year** (the master prompt's "Jan 13 2026" date is the US/CA wave). Reported fallout: share of sales carrying ad fees jumped from ~35–50% to 80–90%+ for some sellers. Sources: [VAR 2026](https://www.valueaddedresource.net/ebay-promoted-listings-ad-attribution-us-canada-2026/), [eBay announcement](https://export.ebay.com/en/services-tools/advertising/seller-announcement-updates-to-ebays-promoted-listings-are-coming-soon/), [fallout](https://www.valueaddedresource.net/ebay-promoted-listings-ad-attribution-update-fallout/).
- **Direct vs Halo attribution reporting was REMOVED** with the rebuilt Advertising dashboard — sellers can no longer see which fees came from the purchaser's own click ([VAR](https://www.valueaddedresource.net/ebay-new-ads-dashboard/)). Attribution honesty is now a differentiator no one owns.
- **Top-of-search is exclusive to Priority (CPC)** since Jan 2026; General lost that slot ([Webinterpret](https://webinterpret.com/en/solutions/advertising), [M2E](https://blog.m2epro.com/promoted-listings-now-in-m2e-pro-what-s-new-and-what-s-changing-on-ebay/)).
- **Monthly budget pacing (CPC family — Priority/Stores/Offsite):** eBay may spend up to **2× the daily budget in a single day**, capped at **30.4× daily per month** ([Offsite FAQ](https://export.ebay.com/en/services-tools/advertising/promoted-offsite-faq/), [VAR overspend](https://www.valueaddedresource.net/ebay-promoted-stores-priority-ads-overspending-daily-budgets/)).
- **Dynamic ad-rate floor silently raised to 5%** (US, late 2025) and dashboard migration switched some sellers to **uncapped dynamic rates** without consent ([VAR](https://www.valueaddedresource.net/ebay-boosts-promoted-listings-dynamic-ad-rate-minimum/), [community](https://community.ebay.com/t5/Selling/Promoted-Listings-Dynamic-Rate-Minimum-Now-5-Check-Your-General/td-p/34765609)) — a live trust gap our hard margin caps answer.
- **Video ads in Priority** launched Apr 15, 2026 (≤45s, one per listing, CPC unchanged) ([ChannelX](https://channelx.world/2026/04/new-ebay-promoted-listings-video-ads-with-a-priority-strategy/)).

## 1. eBay Seller Hub Advertising (native incumbent)

**General (CPS):** listing selection by manual pick / **rule-based auto-select (current + future listings)** / paste item IDs / **CSV upload (item ID + rate per row)** / bulk-select capped at **200 listings** from Active Listings. Ad-rate strategies **Dynamic** (follows eBay's daily suggested rate; factors: "item attributes, seasonality, past performance, current competition") or **Fixed**; range **2%–100%** of **total sale amount including item price, shipping, taxes**. Fee charged under any-click at the **rate in effect at sale** → rate changes act retroactively on already-clicked inventory. **No spend cap exists for General.** ([help](https://export.ebay.com/en/services-tools/advertising/general-campaign-strategy/), [ebay.com id=4164](https://www.ebay.com/help/selling/ebay-advertising/promoted-listings/general-campaign-strategy?id=4164))

**Priority (CPC):** Smart (daily budget + optional max-CPC ceiling; eBay picks keywords/bids; supports rule-based auto-inclusion) or Manual: up to **500 ad groups/campaign**, **1,000 listings/ad group**, **1,000 keywords + 1,000 negatives per ad group**, match types **BROAD/PHRASE/EXACT**, negatives **exact + phrase**, suggested keywords & bids, dynamic (daily-updated, cappable) or fixed bids, bid range **$0.02–$100**, second-price auction. Eligibility: Above Standard/Top Rated, fixed-price. No dayparting, no placement bids. ([help](https://export.ebay.com/en/services-tools/advertising/priority-campaign-strategy/), [id=5299](https://www.ebay.com/help/selling/ebay-advertising/promoted-listings/priority-campaign-strategy?id=5299))

**Offsite/Stores (adjacent):** Offsite = CPC on Google etc., **eBay-set dynamic CPC (no bid control)**, daily budget with the same monthly pacing; Promoted Stores = brand-level CPC. ([Offsite](https://export.ebay.com/en/services-tools/advertising/promoted-offsite/), [Stores id=5472](https://www.ebay.com/help/selling/ebay-advertising/promoted-stores?id=5472))

**Dashboard/reports:** impressions, clicks, CTR, avg CPC, qty sold, ad sales, ad fees, ROAS, CVR; ad-vs-organic trending; suggested campaigns. Keyword + search-query reports for Priority manual; per-transaction clicks/fees in the sales report. Metrics reconcile in "at least 72 hours… some ad types might require more." **Regressions in the rebuilt dashboard:** daily granularity only for 7–14-day ranges (31-day → every-other-day bars, 90-day → weekly), Direct/Halo removed, migration bugs. ([dashboards](https://export.ebay.com/en/services-tools/advertising/ebay-advertising-dashboards/), [VAR](https://www.valueaddedresource.net/ebay-new-ads-dashboard/))

**Bulk:** CSV "bulk campaign management" templates (Priority-centric; Entity/Operation/Campaign ID/Ad group ID/Item ID rows) ([id=5640](https://www.ebay.com/help/selling/listings/promoted-listings/bulk-campaign-management?id=5640)); General CSV at create/edit; grid bulk-edit capped and long-complained-about ([community](https://community.ebay.com/t5/Selling/Can-You-Bulk-Edit-Promotional-Ad-Rates/td-p/33016077)).

**Automation limits:** dynamic-rate-follow, rule enrollment, smart targeting, suggested campaigns — but **no conditional rules engine, no alerting, no scheduling/dayparting, no General spend ceiling**, and suggestion logic is suspected of optimizing eBay revenue (5%-floor incident).

**Multi-marketplace:** campaigns are **per-site**; IT+DE+FR+ES = four separate dashboards, no cross-site rollup/cloning/currency view. eBay's own cross-border answer (eBaymag, free) only syncs **fixed** General rates to international copies — no creation, no dynamic, no Priority ([eBaymag](https://help.ebaymag.com/en/articles/10319122-promoted-listings-general-plg-requirements-and-how-it-works-on-ebaymag)).

## 2–5. Third-party tools

| Tool | eBay ads capability | Pricing | Decisive gaps |
|---|---|---|---|
| **Rithum** (ex-ChannelAdvisor) | General + Priority (since 2021); rate automation = **Configured Rate** (peg to eBay category *trending rate* ± range) and **Discover Rate** (auto-tests rates in a range for ROI); campaign-level rates ([blog](https://www.rithum.com/blog/whats-new-with-rithum-and-ebay-promoted-listings/), [press](https://www.rithum.com/press/channeladvisor-adds-support-for-ebay-promoted-listings-advancedbeta-helping-brands-and-retailers-boost-product-visibility-and-drive-online-sales/)) | Enterprise, unpublished | Market-following not margin-derived; campaign-level not SKU-level; docs gated (capabilities look 2019–2021 vintage); heavyweight onboarding |
| **Linnworks** | Create General campaigns + set rates from the ERP ([partner page](https://www.ebay.co.uk/sellercentre/grow-your-sales/service-providers/linnworks-promoted-listings)) | ~$150–449+/mo reported | General-only; no rules, no keywords, no PL reporting, no margin linkage despite holding cost data |
| **3Dsellers** (closest focused competitor) | General CRUD multi-**account**; rate = fixed / suggested / **suggested±offset with max cap**; **rules engine**: campaign triggers (impressions, ROI → pause/adjust + email) and listing triggers (impressions, clicks, ad fees, items sold, sales, ROAS → update rate / remove / move campaign); scheduled launches; CSV create; scheduled email reports ([product](https://www.3dsellers.com/ebay-ads), [help](https://help.3dsellers.com/en/articles/13250069-how-to-use-ebay-ads-campaign-management-and-automations)) | $19–79/mo | **No COGS/margin anywhere** (ROI = eBay-attributed revenue); Priority claimed in marketing but absent from help docs; no multi-site pane; no rollback; no any-click handling |
| **Adspert** | **Priority-only** AI bid optimizer (explicitly not General); per-keyword bids, query harvesting with auto-add, goals: ACoS/ROAS/cost caps/"profit" (without seller COGS) ([eBay page](https://www.adspert.net/ebay-advertising/)); markets claimed US/UK/DE/AT/IT (no FR/ES) | €99–499/mo | No General (where any-click pain lives); no campaign creation; black-box bids, no propose/approve; revenue-proxy "profit" |
| **Webinterpret** | Fully **automated** General+Priority+Offsite across **11 markets in one dashboard** — auto item selection, auto rates/budgets, per-site T&C acceptance ([solution](https://webinterpret.com/en/solutions/advertising)) | 0.49% of transaction value | Autopilot-or-nothing; no granular rules, no per-SKU strategy, no COGS; their item selection, not yours |
| **Frooition** | Ads Manager + managed service; keyword/search-query analysis (CPC), optimization suggestions, budget tools, **A/B via campaign cloning**; eBay Gold Partner ([page](https://www.frooition.com/ebay-advertising/)) | Bundled/unpublished | Agency-first; no rules automation; no margin awareness; 2026 editorial line is literally "organic SEO over ads" |
| **Sellercloud** | Key-based (spreadsheet) + rule-based General per site; suggested-rate pull; **ad fees surfaced in order-level P&L** — the only tool that puts fees next to order economics ([help](https://help.sellercloud.com/omnichannel-ecommerce/ebay-promoted-listings/)) | Quote-based | General only; no Priority/keywords/rules/dashboard |
| **M2E Pro** | General from Magento; attribute-based listing filters; campaign groups ([site](https://m2epro.com/promote-your-ebay-listing-from-magento-adobe-commerce)) | Tiered | Magento-only; no Priority, no rules |
| **SixBit** | General create/schedule/edit from desktop app; suggested-rate integration ([docs](https://www.sixbitsoftware.com/promoted-listings-support/)) | License | Desktop; no Priority/automation/alerts |
| **Ad-Lister** | Standard + claimed Priority; thin public docs ([blog](https://www.ad-lister.co.uk/ebay-promoted-listings-made-easy-with-ad-lister/)) | Small vendor | Nothing verifiable on automation/reporting |
| **eBaymag** (eBay, free) | Syncs fixed General rates to international listing copies across 8 sites | Free | No creation, no dynamic rates, no Priority; rules degrade to item-based abroad |
| **InkFrog** | Had PL CRUD — **shut down permanently 2026-06-01** ([VAR](https://www.valueaddedresource.net/inkfrog-shut-down/)) | — | Defunct; its users are in the market for a replacement |

**Checked and EXCLUDED** (no real eBay ads management): Optiseller (data quality/aspects only), ZIK Analytics (research), Title Builder (research), BaseLinker (own FAQ: eBay Ads campaigns cannot be created), ChannelEngine (promotions mapping only), Sellbrite, Nembol, ExportYourStore, Kyozou, ChannelGrabber (educational content only), Flowlister/SellerChamp/CLOSO (listers). **MyListerHub**: marketing claims PL management but no help-center evidence — flagged for re-check at E6 scoring.

## 6. Condensed capability matrix

| Capability | eBay native | Rithum | Linnworks | 3Dsellers | Adspert | Webinterpret | Frooition | Sellercloud | M2E | SixBit |
|---|---|---|---|---|---|---|---|---|---|---|
| General CRUD | ✔ | ✔ | ✔ | ✔ | ✖ | auto | ✔ | ✔ | ✔ | ✔ |
| Priority CRUD/keywords | ✔ | ✔ (2021) | ✖ | claimed | optimize-only | auto | ✔ | ✖ | ✖ | ✖ |
| Rate/bid automation | dynamic-follow | trending±range | ✖ | suggested±cap, rules | AI bids | autopilot | suggestions | suggested pull | ✖ | suggested |
| Metric→action rules engine | ✖ | partial | ✖ | **best-in-market** | implicit | ✖ | ✖ | ✖ | ✖ | ✖ |
| Profit/COGS awareness | ✖ | ✖ | ✖ | ✖ | proxy | ✖ | ✖ | fees in P&L only | ✖ | ✖ |
| Bulk/CSV | templates, 200-cap grid | feeds | ✖ | CSV create | ✖ | n/a | ✖ | spreadsheets | filters | ✖ |
| Multi-site single pane | ✖ | platform | ✖ | multi-account only | account list | **✔ (11)** | ✖ | ✖ | ✖ | ✖ |
| Alerting/digest | ✖ | ✖ | ✖ | rule emails | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ |
| Any-click attribution honesty | ✖ (removed Direct/Halo) | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ |

**The strategic gap nobody fills:** every tool is a thin mirror (Linnworks/M2E/SixBit/Sellercloud/Ad-Lister), a black-box autopilot (Webinterpret/Adspert), or a rules layer without economics (3Dsellers/Rithum). **Nobody computes break-even ad rates from COGS+fees, nobody operates on products across marketplaces, nobody has adapted reporting to any-click.** All three are native strengths of Nexus.

---

# "BEAT THEM HERE" CHECKLIST (E6 scoring sheet)

Scoring rule: each item is pass/fail against the stated bar, verified by exercising the finished console.

## (a) Product-first operations
1. **Product → item IDs everywhere.** Bar: opening any product shows every eBay item ID it maps to across IT/DE/FR/ES with live ad state per market (campaign, type, rate/bid, status); ≤1 click from product to any of its ads. (Best today: none — everyone operates on item IDs.)
2. **Family-level operations.** Bar: select a product family (one jacket family, all sizes/colors) and apply one ad action to all mapped item IDs in all four markets in a single confirmed operation. (Best today: none.)
3. **Attribute-driven enrollment beyond eBay's rule fields.** Bar: enrollment rules can reference any in-system field (margin band, stock level, season tag, sell-through, listing age); a newly published matching listing is enrolled ≤24h with no human action. (Best today: eBay brand/category/price/condition; M2E one custom attribute.)
4. **Cross-market coverage audit.** Bar: one daily-refreshed report lists every product promoted in ≥1 market but unpromoted in another, with one-click "create matching campaign". (Best today: none.)

## (b) Margin-aware decisioning
5. **Break-even ad rate per SKU per market.** Bar: every SKU×market shows break-even General rate = net margin % after COGS, FVF, shipping, VAT; visible next to every rate input; recomputed on cost/price change. (Best today: nobody.)
6. **Net-margin-after-ads as first-class metric.** Bar: campaign/listing/product tables all show € net margin after ad fees using real COGS; sortable/filterable; ROAS never shown without it. (Best today: ROAS everywhere.)
7. **Margin-derived max CPC.** Bar: each Priority keyword shows suggested max CPC = margin € × trailing CVR; bids above the ceiling visually flagged. (Best today: Adspert, without seller COGS.)
8. **Bounded auto-rates.** Bar: every automated rate/bid hard-capped at the SKU's break-even-derived ceiling; exceeding requires an explicit named override; the cap survives eBay-side suggestion changes. (Best today: 3Dsellers caps vs suggestion, not vs economics; eBay's dynamic had a silent 5% floor raise.)
9. **Click-debt-aware rate changes.** Bar: before applying a General rate increase, console shows the number of in-window clicked items and estimated extra fee exposure on their pending sales; estimate logged with the change. (Best today: nobody models rate-at-sale × rolling 30-day window.)

## (c) Automation & guardrails
10. **Rules engine ≥ 3Dsellers, plus economics.** Bar: all 3Dsellers triggers/actions (impressions, clicks, ad fees, items sold, sales, ROAS → pause/adjust/remove/move + alert) plus net-margin and effective-fee-% triggers, per-market scoping, and minimum-data thresholds (no firing under N clicks/impressions). Demonstrable with a test rule.
11. **Propose → apply mode.** Bar: every rule can run in propose mode producing a per-item diff (old→new + triggering metric); operator applies all/some; autopilot opt-in per rule, never default. (Best today: none.)
12. **One-click rollback.** Bar: every bulk or automated change is a versioned changeset restorable for 30 days, re-applying prior rates/bids/status within 15 minutes. (Best today: none.)
13. **True spend ceilings across both fee models.** Bar: monthly ceiling per market and per family covering projected General fees (attributed-fee run-rate) + actual CPC spend; breach → auto-pause + alert; verifiable by simulating a breach. (Best today: CPC daily budgets only; **General is uncapped everywhere**, and CPC monthly pacing can spend 2×/day.)
14. **Scheduling/dayparting.** Bar: rates/bids/pause schedulable by day-of-week and hour in each marketplace's local timezone; scheduled change executes within 10 min of its slot. (Best today: none — eBay has start/end dates only.)
15. **Holdout experiments.** Bar: per product family, run a promote-vs-pause alternation (e.g. 14-day blocks) and output incremental sales lift + true incremental cost; result stored on the product. (Best today: Frooition A/B by cloning; nobody measures incrementality vs any-click-taxed organic.)

## (d) Reporting depth & attribution honesty
16. **Restatement-visible metrics.** Bar: daily snapshots of eBay metrics; any restated figure shows delta vs first report (badge + history); figures older than the stability window marked final. (Best today: eBay silently restates ≥72h.)
17. **Any-click honesty.** Bar: General "ad sales" explicitly labeled any-click-attributed; per product: effective ad-fee load = ad fees ÷ total sales (ad + organic) and organic-share trend before/after promotion — all on one screen. (Best today: nobody; eBay removed Direct/Halo.)
18. **Fee-to-order audit trail.** Bar: 100% of charged General ad fees reconcile to an order + campaign + rate-at-sale; unreconciled fees land in an exceptions queue. (Best today: none; community documents un-auditable fees.)
19. **Query-to-margin keyword intelligence.** Bar: search-query rows join to product margin; auto-suggested negatives for queries with >X clicks and zero sales or negative net margin; one-click apply. (Best today: query reports without margin.)
20. **Full-grain history.** Bar: daily-grain metrics retained indefinitely for every campaign/listing/keyword; any date range exports at daily grain. (Best today: eBay UI degrades beyond 14/31 days.)

## (e) Bulk & power tools
21. **CSV/XLSX round-trip.** Bar: one export contains all campaigns/listings/rates/bids/keywords across all four markets; edited file re-imports with dry-run row-level validation before commit; 1,000-row round-trip ≤5 min. (Best today: eBay per-site Priority templates; 3Dsellers create-only.)
22. **Unbounded bulk rate ops.** Bar: a filter-defined selection of any size accepts a single rate/bid operation with progress + per-item failure reporting. (Best today: eBay grid caps at 200.)

## (f) Multi-marketplace single pane
23. **Four markets, one console.** Bar: one dashboard shows IT/DE/FR/ES side-by-side with consolidated EUR totals, **including campaigns created outside our console** (synced from eBay). (Best today: Webinterpret — own campaigns only, autopilot-only.)
24. **Cross-market campaign cloning.** Bar: "clone to other markets" recreates a campaign (General or Priority) on target sites with per-site suggested rates/bids and correct currency in ≤3 clicks, incl. keyword translation stubs. (Best today: eBaymag fixed-rate sync only.)

## (g) Alerting / weekly-digest UX
25. **Real-time guardrail alerts.** Bar: configurable alerts for spend spike (>X% vs trailing 7d), ROAS/margin floor breach, budget exhausted early, campaign ended/rejected, fee-restatement anomaly — in-app + email within 1 hour of detection. (Best today: 3Dsellers rule-fire emails.)
26. **Monday digest.** Bar: weekly digest per market: spend, ad sales, net margin after ads, effective fee load, top 5 winners/losers by margin impact, and proposed actions deep-linking into propose-mode — every section present every week. (Best today: 3Dsellers raw scheduled reports.)

---

**Caveats recorded for E6:** ebay.com help pages intermittently timed out (cross-verified via export.ebay.com mirrors); Rithum post-rebrand depth unverifiable (gated docs, 2019–2021 materials); 3Dsellers Priority support is marketing-claimed, not documented; MyListerHub unverified — re-check both at scoring time.
