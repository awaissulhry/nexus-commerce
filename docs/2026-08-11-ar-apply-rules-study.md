# AR — Apply Rules: study 11 of 11

*Rules & Automation, tab-by-tab, right to left — the last tab, and the landing one.
[1 · Keyword Tracker](2026-08-11-kt-keyword-tracker-study.md) · [2 · Share of Voice](2026-08-11-sov-share-of-voice-study.md) · [3 · Placement](2026-08-11-plc-placement-study.md) · [4 · Budget Schedules](2026-08-11-bs-budget-schedules-study.md) · [5 · Rank & Dayparting](2026-08-11-rd-rank-dayparting-study.md) · [6 · Budget](2026-08-11-bud-budget-study.md) · [7 · Negative Targeting](2026-08-11-neg-negative-targeting-study.md) · [8 · Keyword Harvest](2026-08-11-hv-keyword-harvest-study.md) · [9 · Bid](2026-08-11-bid-study.md) · [10 · Automations](2026-08-11-auto-automations-study.md).*
**Read-only study. Nothing was changed. No code was written.**

Measured on production 2026-08-11 with `apps/api/scripts/_ar-study.mts`.

---

## 0 · The one-sentence version

Every one of the five columns renders **the same value on all 220 rows** — Target ACoS shows
*30.00%* on 220 campaigns that have **none set**, Bid Automation is off on all 220, Budget Rule is a
hard-coded "None" — while the things that genuinely vary per campaign (**171 placement multipliers,
82 open write gates, 82 bid ceilings, 72 portfolios**) appear nowhere on it.

---

## 1 · What the page is, and every wire behind it

```
/marketing/ads/rules-automation   (?tab=rules — the landing tab)
└── RulesAutomationClient.tsx
    ├── AdsPageHeader (market select · "+ Rule" → RuleTypeModal)
    ├── RuleImpactStrip            ← account-wide "did any of it do anything"
    └── AdsDataGrid over GET /advertising/campaigns?limit=500
        columns  Bid Rule · Target ACoS · Min/Max Bid · Bid Automation · Budget Rule
        filters  Status · Campaign Type · Portfolio · Campaign · Bid Automation + search
        bulk     Automation · Assign Rule · Target ACoS · Min/Max Bid
        edit     per-cell hover pencil (AdsDataGrid editMode)

Write path  PATCH /advertising/campaigns/:id/automation   (advertising.routes.ts:837)
            → dynamicBidding.bidAutomation (bool)
            → dynamicBidding.targetAcos    (FRACTION, clamped 0–5)
```

---

## 2 · The five columns, measured against 220 campaigns

| # | column | backed by | campaigns with a value | what the grid renders |
|---|---|---|---|---|
| 1 | **Bid Rule** | nothing — no field, no endpoint | — | `Target ACOS` ×220 |
| 2 | **Target ACoS** | `dynamicBidding.targetAcos` ✅ real | **0 of 220** | **`30.00%` ×220** |
| 3 | **Min/Max Bid** | `Campaign.minBidCents`/`maxBidCents` ✅ real, **write-gate enforced** — but the grid writes neither | min **0** · max 82 | `None` ×220 |
| 4 | **Bid Automation** | `dynamicBidding.bidAutomation` ✅ real | **0 of 220** | toggle off ×220 |
| 5 | **Budget Rule** | nothing — hard-coded | — | `None` ×220 |

**The grid is 220 rows of five identical cells.**

### The 30.00% is the worst of them

`RulesAutomationClient.tsx:181` renders `((c.targetAcos ?? 0.3) * 100).toFixed(2)`. **Zero campaigns
have a target set**, so all 220 display **30.00%** — a code default presented as a per-campaign
setting, to two decimal places. An operator reading this page concludes the account is uniformly
configured to a 30% ACoS goal. It is configured to nothing.

*(The default is not invented: `ads-bid-optimizer.service.ts:72` uses `opts.targetAcos ?? 0.3` as
its flat fallback. So the number is *true of the optimiser* and *false of the campaign* — which is
precisely why displaying it in a per-campaign cell is misleading.)*

### The one genuinely good thing here

**Target ACoS writes to the field that matters.** `ads-guardrails.ts:18` is explicit:

> *"`Campaign.targetAcosPct` was added in A1 and is **a mistake** — `dynamicBidding.targetAcos`
> already exists and is **read by five services** including ads-bid-optimizer. Wiring a second
> source of truth for the same number is exactly the class of bug this programme keeps uncovering,
> so the column is left deliberately unused pending a destructive migration to drop it."*

The page writes the live field, not the dead one. `Campaign.targetAcosPct` is set on **0 of 220** —
the deliberate non-use held.

**So the column works. It has simply never been used.** That is a different problem from the one I
assumed in the tab-cull proposal, and a much more fixable one.

### 🔴 Min/Max Bid is the real miss

`Campaign.minBidCents` and `maxBidCents` are **enforced on every write** in `ads-write-gate.ts`
(study 9). The grid has a Min/Max Bid column, a hover-pencil editor and a bulk action for it — and
all three write to `useState`. The value disappears on refresh.

- `minBidCents`: **0 of 220** — no campaign declares a floor
- `maxBidCents`: 82 of 220 — exactly the 82 with the write gate open, so set by some other process

**A real, enforced, unset guardrail with a fully-built UI in front of it that does not connect.**

---

## 3 · What varies per campaign, and appears nowhere

| enforced per-campaign control | campaigns | on this page? |
|---|---|---|
| **placement multipliers** (`dynamicBidding.placementBidding`) | **171** | ✗ |
| `liveBidWritesEnabled` — the write gate | **82 open** | ✗ |
| `maxBidCents` | 82 | ✗ *(column exists, doesn't write or read)* |
| `portfolioId` | 72 | filter only |
| `cpcCeiling` | 6 | ✗ |
| `maxBidChangePct` | 2 | ✗ |
| `pinBids` / `pinBudget` / `pinPlacement` | 0 / 0 / 0 | ✗ |

**171 campaigns carry a placement multiplier — the most-varied per-campaign setting in the account —
and the campaign grid shows none of it.** Study 3 found one live campaign at **+300%**.

### And 61% of the account is hidden by default

The grid's Status filter defaults to **Enabled**, so it opens on **86 of 220** rows. The 133 paused
campaigns are invisible — including the **60 paused campaigns carrying ≥100% Top-of-Search
multipliers** that study 3 called land mines. A campaign resuming with a +202% multiplier nobody
chose is exactly what this page should surface, and it is filtered out before you see it.

---

## 4 · Your proposal, measured

You asked to keep this page and **add an Automations column** — select multiple automations and
apply them to a campaign, market or portfolio. Three measurements bear on it:

1. **The page has the room.** Five columns show constants. Replacing two dead ones (Bid Rule, Budget
   Rule) costs nothing.
2. **The scope model still blocks the write.** `scopeCampaignId` is single-valued, so assigning from
   the campaign side *moves* a rule rather than adding one — it would silently unbind it from the
   other 219 campaigns. Additive `scope*Ids` arrays fix it. *(Unchanged from the tab-cull analysis.)*
3. **A read-only version works today and is worth having on its own.** 43 of 51 rules are unscoped,
   so the honest first column is *"51 automations can reach this campaign"* on every row — which is
   itself the finding. As rules get scoped, the column differentiates.

---

## 5 · How the industry does this

### The direct competitor shipped this month

**Pacvue's front page currently reads *"Introducing the Agentic Commerce Grid."*** The campaign grid
is no longer a table of settings — it is the surface where agents propose and operators approve. That
is the same idea as an Automations column, one step further on.

| platform | the campaign grid |
|---|---|
| **Pacvue** ($2,000+/mo) | *"AI-Powered Commerce Media OS unifying retail media & commerce management in one mission control"*; the Agentic Commerce Grid; bulk changes throughout |
| **Skai** | rule-based automation for enterprise, connecting **80+ advertising platforms** |
| **Quartile** ($895+/mo) | hourly bid adjustments; the grid is a monitor, not a control |
| **Amazon Bulk Operations** | the bulksheet — still the fallback every serious operator uses |

### The five properties every mature campaign grid has

1. **Only columns with values.** A column that renders the same string on every row is deleted, not
   shipped. Ours has five.
2. **Settings *and* performance in one row.** Ours has no metric columns at all — the reason a date
   control was reverted here in the first place. A campaign row without spend or ACoS cannot support
   a decision about its bid ceiling.
3. **Bulk edit that persists.** Ours has four bulk actions; two write to React state.
4. **Governance visible on the row** — the write gate, the pins, the ceilings. All enforced here, all
   invisible here.
5. **The grid is where agents surface.** Pacvue's whole 2026 pitch. Your Automations column is the
   same instinct.

### What this page has that they do not

`RuleImpactStrip` — an account-wide *"and did any of it do anything"* strip above the grid, whose
own header lists three ways its numbers could mislead and corrects each one. Nothing in the research
shows a competitor putting an honesty note above its own headline figure.

---

## 6 · What could be implemented, cheapest first

### Tier 0 — stop showing constants *(hours)*
- **Delete "Bid Rule" and "Budget Rule".** No field, no endpoint, no possibility of a value.
- **Fix the 30.00%.** Render `—` when no target is set, and show the optimiser's fallback once, in
  the header: *"campaigns without a target use 30%."*
- **Wire Min/Max Bid to `minBidCents`/`maxBidCents`.** The column, editor and bulk action already
  exist; they need an endpoint instead of `setState`.

### Tier 1 — show what actually governs each campaign *(days)*
- **Add the write gate** as a column — 82 open of 220, togglable, with the bulk-by-market route that
  already exists (`POST /campaigns/live-writes/bulk`).
- **Add the placement lane summary** — 171 campaigns carry one and nothing shows it.
- **Add the pins** — three booleans, enforced, no UI anywhere but a Control Room tab you don't use.
- **Add metric columns** (spend, ACoS, budget utilisation) so the settings can be judged. This also
  makes a date control earn its place, which it could not before.
- **Reconsider the default filter** — or badge the 133 hidden campaigns, especially the 60 with
  ≥100% multipliers.

### Tier 2 — the Automations column
Read-only first (which rules reach this campaign), then assignable once `scope*Ids` arrays land.

### Tier 3 — the agentic grid
Proposals surfacing on the campaign row, approvable inline. That is where Pacvue has gone, and the
substrate here — proposals, ceilings, audit — already exists.

---

## 7 · How this page is *supposed* to be

> **One question: for this campaign, what is automation allowed to do, what has it done, and what is
> that costing?**

- **Every column has values.** If it cannot vary, it is not a column.
- **Governance on the row**: gate · min/max · pins · which automations reach it.
- **Performance beside settings**, so a ceiling can be judged against what it is capping.
- **Bulk edits that persist**, all of them.
- **Nothing paused hidden by default without saying so.**

---

## 8 · The series, in one page

Eleven studies, one account. What they add up to:

**The five findings that cost money**

1. **The budget ratchet** (study 6) — two AUTO rules compounding 15–20% per tick, no cooldown;
   €4.42 → €1.00 in 2¾ hours; **58 of 86 live campaigns pinned at the €1 floor.** Still running.

> 🔴 **Correction, 2026-08-16 (BUD.8).** The attribution of the €1 floor to the two AUTO rules is
> wrong for 56 of the 58 campaigns. Measured on prod: **56 were floored by
> `automation:budget-manager-cron` in single writes** (`€100 → €1`), 55 of them inside one hour on
> 2026-08-05; only **2** reached €1 by rule compounding, and both were already at ~€1 when the
> rules reached them. The ratchet is real; it is not what emptied the account. Full derivation in
> [the study's §0 correction](2026-08-11-bud-budget-study.md) and
> [the BUD.8 record](2026-08-16-bud-8-armed.md).
2. **The SQP feed died on 2026-07-26** (studies 1, 2, 5) — and it is the feedback loop of
   `ad-rank-defend`, which reads it with **no recency guard**. Every live schedule is chasing a 10%
   goal on a signal reading 0.15%.
3. **The placement premium is inverted** (study 3) — +87% median into Top of Search (1.85× ROAS),
   +27% into Rest of Search (3.10×), in all four markets.
4. **132 negatives contain a protected term** (study 7), including the brand name in the brand
   campaigns; the whitelist is a going-forward gate over an unaudited base.
5. **The harvest threshold is an off switch** (study 8) — 2 orders/60d is met by 16 terms; 57
   converting terms with no keyword sit just below it.

**The three structural facts**

6. **Rules made 95 of 42,885 writes — 0.2%** (study 10). The engines do the work and appear on no
   tab; `ad-rank-defend` alone writes bids *and* placements and has no surface.
7. **The guardrails are empty.** `minBidCents` 0/220 · pins 0/220 · rule scope 8/51 (all market-only,
   none using the product grain that shipped yesterday). The architecture is right; the values are
   absent, and there is no UI to enter them.
8. **693,704 cap refusals in 60 days** (study 10) — the execution table is 99% refusals, and the cap
   is the account's real operating policy.

**What is genuinely good, and should not be rebuilt**

- The **autonomy model** and its **reversibility-based ceiling** — better than anything in the
  research.
- **`RankTarget`** as a goal object with per-lane blending — no competitor documents an equivalent.
- **The protected-terms whitelist at the single write chokepoint** — right idea, right place.
- **`previewHarvest`** and dry-run-by-default across every rule.
- **The write gate itself** — one chokepoint, bounds on the entity, `liveBidWritesEnabled`
  default-deny.

**The one-line diagnosis:** this system's problem is not capability. On several axes it is ahead of
Pacvue. Its problem is that **the surfaces describe rules while the engines do the work**, and
**every guardrail the architecture provides is unset because nothing asks for a value.**

---

## 9 · What I need from you

1. **The two dead columns — delete?** Bid Rule and Budget Rule cannot ever hold a value.
2. **The 30.00% on 220 campaigns** — render `—` instead?
3. **Wire Min/Max Bid?** The UI exists; it needs an endpoint. This also gives you the per-scope
   ceiling you asked for on 2026-08-10, at campaign grain.
4. **Should the write gate live on this page?** 82 of 220, and you said you want to widen it
   deliberately. This is where that happens.
5. **And the standing one: the budget ratchet is still running.**

---

## Appendix — script

`_ar-study.mts` — every column against its backing field · target-ACoS coverage and distribution ·
the dead duplicate column · enforced controls with no UI · the grid's population and default filter.

Read-only. `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_ar-study.mts` from
`apps/api`.

### Sources

- [Pacvue — Introducing the Agentic Commerce Grid](https://pacvue.com/) ·
  [Pacvue for Amazon](https://pacvue.com/marketplaces/pacvue-for-amazon/) ·
  [Pacvue enters AI agent race with Amazon-focused tool — Adweek](https://www.adweek.com/commerce/pacvue-enters-ai-agent-race-with-amazon-focused-tool/)
- [Best Amazon Ads management tools 2026: tested & compared — Marketplace Ad Pros](https://marketplaceadpros.com/guides/best-amazon-ads-management-tools-2026/)
- [Pacvue vs Skai (Kenshoo) — Atom11](https://www.atom11.co/blog/pacvue-vs-kenshoo-skai) ·
  [Top Pacvue alternatives — Atom11](https://www.atom11.co/blog/pacvue-alternatives)
- [18 best Amazon PPC software & tools 2026 — Eva](https://eva.guru/blog/best-amazon-ppc-tools/)
