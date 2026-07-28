# Enterprise Ads Benchmark

→ [[00 - Nexus Commerce MOC]] | [[33 - Cross-Channel Ads Review]]

Research date: 2026-07-28. Subjects: Pacvue, Skai, Perpetua, CommerceIQ, Teikametrics, Quartile (ad suites); Rithum/ChannelAdvisor (enterprise commerce); Linnworks, Channable, Feedonomics, Productsup (multichannel/feed); Salsify, Akeneo, inriver, Pimcore, Syndigo (PIM).

This supersedes the 11-file `plans/RITHUM-*` study from April 2026, which was research-only and never implemented.

---

## 1. Rithum — the incumbent, and its seam

**Rithum is two platforms wearing one brand.** Three years after the CommerceHub↔ChannelAdvisor merger the stacks have not merged:

| | Rithum **for Brands** (ChannelAdvisor) | Rithum **for Retailers** (CommerceHub + Dsco) |
|---|---|---|
| API host | `api.channeladvisor.com` | `api.dsco.io/api/v3` |
| Async model | **Webhooks — still Beta in 2026** | **Streams** — partitioned event log, 90-day retention, replayable, consumer checkpoints. Kafka semantics over HTTP |
| Auth | OAuth2 + legacy SOAP credentials | OAuth2 client-credentials → JWT |
| Rate limit | **2,000 req/min per profile**, 5 concurrent; more apps do **not** raise throughput | Batch APIs explicitly bypass rate limits |

Separate identity, separate APIs, separate knowledge bases, separate support queues, no cross-side referential integrity.

**The finding that matters most: Rithum has no advertising API.** No campaign, ad-group, keyword or bid resource on either side; no ad webhooks; no bulk ad file format. Ad management is UI plus managed service only. For a competitor, this is the largest single integration gap in the incumbent.

Other exploitable gaps: **no audit trail documentation, no SCIM, no free sandbox** (test accounts are client-only and **all transactions are billable**), **no SLA** (ToS §7.1 disclaims availability outright), **no BI/warehouse connector**, primary data store is a **leased colo in St. Louis**, not public cloud. Retail media coverage is thin — ~7 networks direct, with Instacart, Kroger, DoorDash, Chewy and Sam's Club absent, Walmart Connect API-only, and the Roundel API only arriving Q2 2026.

Commercially: subscription + **% of GMV** + % of ad spend, 2-year contracts, $30k–$100k year one, **fees charged even on feed-driven GMV**, and anti-circumvention clauses that lock the customer out of their own managed channel accounts. G2 3.9, TrustRadius 7.0 in retail media (rank #9). The most-repeated complaint is cost escalation with scale; the second is "software good, service bad."

**What they get right and we should copy:** inventory-, margin- and returns-aware ad automation. Their own conference positioning is "real-time budget adjustment on stock levels and delivery capability." Pacvue has the networks; Rithum has the operational signal. **Whoever has both wins — and we have the operational signal already.**

**Their moat we cannot copy:** the two-sided retailer↔supplier network. Compete around it.

---

## 2. The enterprise capability bar

From the ad-suite research, scored across Pacvue / Skai / Perpetua / CommerceIQ / Teikametrics / Quartile.

### Tier 1 — table stakes, absence loses the deal

Org→brand→advertiser→profile hierarchy with scoped RBAC · adopt existing campaigns without rebuild · cross-campaign budget pacing with thresholds and alerts · threshold-based auto-pause · custom report builder with scheduled multi-channel distribution · bulk edit and bulk import · SSO/SAML · some change log · dedicated CSM and structured onboarding · per-channel data-freshness transparency.

**We have:** budget pacing (pools, schedules, rebalance), auto-pause, bulk import/export on Amazon, a change log on both channels, campaign adoption. **We lack:** the org/brand/advertiser hierarchy with scoped RBAC, and SSO/SAML.

### Tier 2 — differentiating, held by one or two vendors

| Capability | Held by |
|---|---|
| Publisher-agnostic entity model | Skai |
| Warehouse-native push (Snowflake/BigQuery) | Pacvue DaaS only; **Skai explicitly not** |
| Cross-*channel* budget pool + scenario planning | Skai |
| Hourly optimisation via push streams | Pacvue (AMS) |
| AMC with audience activation back into campaigns | Pacvue deepest |
| Incrementality / attribution-agnostic comparability | Skai Impact Navigator, CommerceIQ iROAS |
| Approval-gated execution | Pacvue — **AI actions only**; extending it to all human bulk edits is unclaimed |
| Public outbound API over your own normalised model | Skai (Kenshoo v3) |
| Billable/managed profile state with soft-delete + re-attach | Pacvue |
| Cost-allocation tagging for agency billing | Pacvue |
| Grid performance at real row counts | **Nobody convincingly** |

### Tier 3 — absent across the entire market

Ranked by buyer pain × tractability. **Build these and you are ahead of every incumbent.**

| # | Capability | Our position |
|---|---|---|
| 1 | **Per-user spend authorisation ceilings** (max daily budget, max bid delta %, max absolute) | Not built. Highest-frequency unanswered RFP question, and trivially implementable as constraints on a permission grant |
| 2 | **Blast-radius caps and change budgets on automation** | eBay has per-entity cooldowns and a channel auto-halt; Amazon has neither |
| 3 | **Dry-run / shadow mode** — "show me what this rule would have done for 14 days" | eBay has `previewRule`; Amazon has bulk preview and `backtest` on autopilot plans only |
| 4 | **One-click revert of an applied change set** | **We have it on Amazon** (`rollbackByChangeSetId`) and per-proposal on eBay |
| 5 | **Change attribution to immutable rule *versions*** | **eBay has `EbayAdsRuleVersion`**; Amazon does not |
| 6 | **Distinguishing retailer-autonomous changes** (eBay `DYNAMIC` rates, Amazon dynamic bidding) | `ads-core/drift.ts` classifies `EXTERNAL_CHANGE` — Amazon only, campaign-only |
| 7 | **Attribution-window-aware metric rendering** — provisional metrics badged, unsettled rendered `—` not `0` | **`ads-core/data-vintage.ts` exists and is unenforced and unsurfaced** |
| 8 | **Customer-facing sandbox** | We have sandbox mode + write gate + per-campaign allowlist — better than any of them |
| 9 | **Learning-period enforcement / per-entity cooldowns** | eBay only |
| 10 | **Canary / staged rule rollout** | Nobody, including us |
| 11 | **Fiscal-calendar budget planning, plan/actual/invoiced reconciliation** | Nobody |
| 12 | **Published uptime SLA and audit-retention commitment** | Pure procurement-friction removal |
| 13 | **Explicit non-CPC pricing-model support** | **We are the only ones who have to solve this, and therefore the only ones who can claim it** |
| 14 | **Audit log export to warehouse** | Nobody |
| 15 | **Structure linter on adoption** (naming conformance, orphans, limit headroom) | Nobody |

**The pattern is unmistakable: we already hold fragments of nine of the fifteen Tier-3 items. Every one exists on exactly one channel.** The differentiator is not building them — it is unifying them.

---

## 3. The five architectural decisions the research converges on

**1. `AdContext` is the atomic unit.** A generalised Amazon "profile": credentials, RBAC scope, currency, timezone, rate-limit bucket, billable state, marketplace. Get this object right and hierarchy, permissions, budgets and rate limiting all resolve cleanly. Pacvue's billable/managed state with soft-delete and boomerang re-attach is the elegant version — one field solving commercial metering and reversible offboarding.

**2. Split *edit* from *publish*; make the change set a first-class, addressable, versioned object.** Maker-checker, staging, blast-radius counting, dry-run, rollback and audit all derive from this single decision. It is the cheapest path to Tier-3 items 2–6, and **we already have half of it** in `AdvertisingActionLog` + `rollbackByChangeSetId`.

**3. The channel capability descriptor is the anti-leak mechanism.** Declare, per channel × ad product: bid kinds and ranges, entity levels, limits, modifiers, supported metrics, write semantics, retailer-autonomous behaviours. Drive every UI control, validator and rule action from it. Leaks then surface as *declared capability differences* rather than runtime errors or silently wrong numbers. **Nobody has built this** — Skai has the entity model without the descriptor.

**4. eBay CPS breaks the CPC assumption at the root.** `bid.kind = PERCENT_OF_PRICE` (2.0–100.0), **no budget object**, no payable clicks, sale-based and refundable spend accrual, and — uniquely — the fee is set by the rate *at time of sale*, not at click. It must be modelled explicitly and excluded from any cross-channel budget pool as `CONTINGENT` rather than `CONTROLLABLE`. No vendor documents handling this correctly.

**5. Amazon's rate limit is one regional queue shared across all tenants, and adding tokens does not help.** Build a per-region, priority-classed, tenant-fair scheduler with an AIMD circuit breaker, prefer bulk operations for large writes, and use Marketing Stream rather than polling for any hourly ambition. **We already built exactly this shape for eBay** in `ads-core/quota-ledger.ts` — it just doesn't govern Amazon.

---

## 4. Patterns worth porting

### From feed platforms (Channable, Productsup)

**Declarative generator + reconcile loop with pause-not-delete.** Model campaign/ad-group/target/ad as *derived* objects. A generator = (selector rules, grouping key, naming template, entity templates, bid/budget expressions). Each run: materialise desired state → fetch actual → diff → apply. Deactivating a generator **pauses** its objects; it never deletes. This is the core architecture, and it is what `ads-blueprint.ts` is already reaching toward.

**Threshold-gated pipeline halt.** Before applying a diff, compute change-magnitude metrics — % created/paused/bid-changed, absolute count, **projected daily budget delta**. If any exceeds a threshold settable at org/account/campaign-type level with narrower overriding, **halt the run**, write a typed event, notify, require explicit approval. Productsup does this for feeds. **Nobody in ads has it.** Single highest-leverage safety feature available.

**Cardinality-changing rule actions** — `split` (row → N rows on a list field, e.g. match-type fan-out), `group` (rows → grouping key = ad group), `dedupe`, `exclude`. These four turn a product row set into a campaign tree.

**Four-level rule cascade with declared precedence** — import → account → channel → generator, each ordered, each labelled, order editable, plus shared rules and reusable rule bundles. Explicitly reject Linnworks' "all rules run and overwrite each other" model.

**Typed error surfacing with deep links** — error class → affected item count → *View items* (filtered) → *View in build* (the mapping screen) → *Edit template*. "312 targets would exceed eBay's 80-char keyword limit" should be three clicks from the fix.

**Rule *recommendation* mined from operator behaviour** — watch manual bid edits and negations, detect recurring patterns, propose the rule that would have made them, pre-filled, with a backtest over the trailing 30 days.

### From PIM (Salsify, Akeneo, Productsup)

**Three-stage override pipeline: source → normalised → per-destination.** Source immutable; the middle layer holds transforms affecting all destinations; the destination layer holds channel-only transforms that provably cannot leak sideways. Answers "why does this ad differ from the master?" **by location, not by archaeology.** This is the correct shape for per-marketplace ad settings.

**Channel-readiness scoring — required vs recommended, per destination, computed continuously, with blocking vs warning tiers.** Blocking = the channel will reject (missing landing URL, ineligible category, below bid floor). Warning = will run but underperform (no negatives, one creative, missing labels). Then make it the **publish gate, not a report**: a campaign cannot enter the publish queue for channel X until X's blocking readiness passes.

**Centralised channel-feedback inbox with triage state.** Capture sync *and* async channel responses, link each to the exact entity + field, keep last-N-runs and 30-day history, provide **snooze 24h/7d/14d/30d, blacklist, purge**, and a 0–1000 severity ranking. Productsup's is the reference implementation and it ports almost verbatim. The triage state is the piece most teams forget — without it the dashboard is noise within a month.

**Maker-checker with attribute-level partial approval, where the reviewer's authority is itself scoped.** An agency user proposes budget +30% and three new headlines; the brand approver accepts the headlines and rejects the budget in one pass. Finance can approve budget deltas but not creative. Critically: **a proposal is a diff against the live object, not a copy of it** — which is exactly what `EbayAdsProposal` already is.

**Permissions derived from workflow place, intersected with role.** `effective = role_grants ∩ place_grants`. A campaign in `pending_spend_approval` is editable only by finance regardless of owner. Eliminates the "someone edited it while I was approving" race without pessimistic locks.

**Multi-axis permission lattice with explicit precedence** — Network > Market > Brand/Product-line > **setting group** (Targeting / Budget & Bidding / Creative / Tracking / Compliance). The setting-group axis is the highest-value one for delegated ownership and almost nobody builds it.

**Dry-run impact count before activating a rule** — "this will modify 4,812 ad groups across 11 accounts and change committed daily spend by €38,400." A ~2-day build that prevents the worst failure mode in ad automation.

**Provenance on every value.** Every setting shows `source: manual | inherited | rule:<id> | agent:<id> | import:<run>` plus actor and timestamp. This is the prerequisite for readiness, approvals, undo and AI trust alike — all of which reduce to "can you tell me where this value came from."

**AI writes to the proposal layer only.** Never direct-to-live. Universal across PIM vendors in 2026, and note that **none of them publishes an AI accuracy figure** — they sell the guardrail instead.

### Two anti-patterns to design out

- **Don't build entity-level "published vs working copy" duplication.** Akeneo is retiring exactly that. Duplication doubles the conflict surface and still can't answer per-field questions. Use channel-scoped values + status + readiness gating.
- **Don't make readiness global to the entity type.** inriver's documented weakness. Make it a function of **(entity type × channel × market)** from the first schema.

---

## 5. What this means for us

The external bar is lower than it looks. Across six enterprise ad suites: **nobody** has per-user spend ceilings, blast-radius caps, rule dry-run against history, change-set revert, rule-version attribution, retailer-autonomous change detection, vintage-aware metric rendering, a sandbox, canary rollout, fiscal-calendar budgets, a published SLA, correct non-CPC modelling, audit export, or a structure linter.

We have working fragments of nine of those fourteen — split across two channels that share almost nothing at the engine layer.

**The opportunity is not to build more. It is to unify what exists, fix the seven defects, and enforce the safety machinery that is already written but unwired.**

---

## Related Notes

- [[33 - Cross-Channel Ads Review]] · [[31 - Amazon Ads Competitor Teardown]] · [[30 - Amazon Ads Platform Audit]] · [[28 - eBay Ads Strategy Research]]
