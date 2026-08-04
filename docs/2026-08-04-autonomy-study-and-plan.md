# Autonomy — the study, re-cut, and the plan that finishes the goal

**Date:** 2026-08-04
**Goal (yours, verbatim):** *"instead of me trying to manage the levers manually, we must automate it all so that it doesn't really require my attention at all"* — with proper control of everything, and no new sidebar navigation.

The earlier research asked *what features do these products have*. This asks the narrower and more useful question: **how does each one actually let an operator stop doing things by hand?**

---

## 1. What exists — measured, not read

| Mode | Rules |
|---|---|
| **AUTONOMOUS — acts on its own** | **1** |
| Proposes only — needs your approval | **21** |
| Off | 29 |
| Proposals waiting on you | **227** |

Tonight moved the account from *nothing works* to *everything works and asks permission*. That was the necessary order — an engine that had never executed once could not be trusted with autonomy, and bounds had to exist before anything ran unattended.

But it is not yet the goal. **21 rules now ask you for permission where previously they produced nothing at all**, which is more of your attention, not less. The job is half done, and the second half is graduation.

### What each piece serves

| Layer | Purpose | State |
|---|---|---|
| `AutomationRule` + evaluator | decides | ✅ runs (was 0 successes ever) |
| `AdsRuleSuggestion` | proposes for approval | ✅ emits (was 2 rows ever) |
| `ads-write-gate.ts` | the only door to Amazon | ✅ bounds, protections, allowlist |
| `Campaign.min/maxBidCents` | absolute bid bounds | ✅ enforced, none set |
| `AdKeywordProtection` | never/always negate | ✅ enforced, **empty** |
| `liveBidWritesEnabled` | which campaigns automation may touch | ✅ 82 of 216 |
| `AdvertisingActionLog.evidence` | why a change happened | ✅ recorded + surfaced |
| `rank-defend` / dayparting | holds rank on a schedule | ✅ already autonomous |
| **`rule.dryRun`** | **the graduation control** | ❌ **binary — this is the blocker** |

---

## 2–3. The market, re-cut around autonomy

| Product | How it lets you hand over control |
|---|---|
| **Pacvue** | **Four legs: thresholds · approval workflows · automation-intensity dial · audit.** The canonical model. |
| **Quartile** | Guardrails as **columns per portfolio** (`TargetACOS`, `BudgetCap`, `Min Bid`, `Max Bid`, `Stop Placement Management`) plus a **managed / not-managed** split |
| **Teikametrics** | `ACOS Limit` + `Bid Modifier` bounding opaque ML; **sequencing loops that ramp aggression** through a launch; guardrails that stop rules exceeding cost thresholds |
| **M19** | Five operator dials, two of them overrides — force-visibility and **competition-tactics intensity** |
| **Skai** | Rules, with **multi-condition as an advanced tier** above single-condition |
| **Perpetua** | Goal + target ACOS + budget, then hands-off. Most-cited weakness: you cannot tell it what it doesn't know |
| **Scale Insights** | 200+ parameters, **preview before execute**, whitelist/blacklist |
| **BidX** | If-X-then-Y; payback threshold €10k/mo |
| **Stackline** | Measures; does not activate |
| **Rithum** | Sells you people |

### The finding

**Pacvue's four legs are the answer to "proper control of everything", and Nexus now has three of them.**

| Leg | The fear it answers | Nexus |
|---|---|---|
| Thresholds | *"it will chase volume and destroy my margin"* | ✅ bounds, ACOS caps, rule caps |
| Approvals | *"it will do something drastic while I'm asleep"* | ✅ **built tonight** — Propose pipeline |
| **Intensity dial** | *"it's all or nothing and I'm not ready for all"* | ❌ **missing — binary `dryRun`** |
| Audit | *"something changed and I'll never know what or why"* | ✅ change log + evidence + `/trust` |

Your own desktop study reached this in July and wrote: *"Approvals and the intensity dial do not exist."* Approvals now do. **The dial is the single missing mechanism between 1 autonomous rule and 21.**

> *"Most systems offer automation as a binary. A dial lets the operator start at 10%, watch it for a month, and move to 50%. That is how trust is actually built, and it is a product decision rather than a technical one."*

That is exactly the shape of the current problem. `dryRun` is a binary, and a binary is why 21 rules are stuck.

Second, from Quartile: **managed / not-managed** as an explicit split. G5 accidentally built this — 82 managed, 134 not — but it is not surfaced as a concept anywhere.

---

## 4. The goal and the approach

**Deliver: routine work happens without you; exceptional work asks.**

The industry consensus on where that line sits is unusually clear and matches what you already have:

> **Automatic, within bounds:** bids on mature campaigns, search-term negations under clear criteria, budget rebalancing within limits.
> **Always gated:** new campaign creation, structural restructuring.

Applied to the 21 rules:

| Disposition | Actions | Rules |
|---|---|---|
| **Can go autonomous** | `bid_to_target_acos` (5), `bid_up`/`bid_down`, `lower_bid_to_floor`, `adjust_ad_budget`, `retail_guard` | **~14** |
| **Stays gated** | `promote_to_exact`, `archive_keyword`, `sync_negatives_across_campaigns`, entity creation | ~7 |
| **Blocked until the whitelist has entries** | `harvest_and_negate`, `add_negative_exact` | (within the 14) |

---

## 5. Design system

**Closing the gap I flagged**: I have now read the Pacvue UI teardown. Its ranked lessons, in effort order:

1. **Price every problem in €** — highest value, lowest effort. *Third independent arrival* (Pacvue's alerts board, BidX's Wasted Ad Spend Analyzer, your own study's "counted problems board"). Nexus computes it better than any of them: `ProductProfitDaily` + real fees = margin actually lost, not an estimate.
2. **Counts in tab labels** — `Targeting (263) | Negative Targeting (3)`. The IA does the prioritising. Near-zero effort.
3. **A user-defined tag as the default reporting dimension** — tag by family (GALE, AIREON, MOSS) and by intent (rank-defend, clearance, launch), aggregate there by default.
4. **Multiple time windows side by side** — 7/14/30 simultaneously, no toggle-and-remember.
5. **Audit as a stored, timestamped object** — Nexus's trust surfaces are live views answering "what is wrong now"; a stored audit answers *"what did we fix, and what came back."*

**Constraints held:** no new sidebar entries, app rail or ads rail. Everything below lands on existing rail entries. Styling follows the `h10-*` language this console uses throughout — the design system is not imported anywhere under `/marketing/ads`, and a lone DS component reads as a foreign element.

---

## 6. The phases — Feature 2: Autonomy

Each separately gated. This is the feature that delivers the stated goal.

**N1 · Clear the stale proposal queue**
227 pending, ~90% created before the noise filter landed — notifications and zero-change rows. Nothing can graduate while the queue misrepresents what the rules actually propose.
*Exit: the queue shows only real, current proposals.*

**N2 · The intensity dial** 🔴 *the blocker*
Replace binary `dryRun` with a per-rule autonomy level: **Off · Observe · Propose · Auto-within-bounds · Auto**. Stored on the rule, changeable without a deploy, defaulting to today's behaviour so nothing moves on ship.
*Exit: a rule can be moved one notch and moved back.*

**N3 · Per-category graduation policy**
The consensus split as a default: bids / negatives / budget auto within bounds; structural always gated. Per-rule override. Blocks graduation of `harvest_and_negate` while the whitelist is empty.
*Exit: the policy is data, and it explains itself.*

**N4 · The accountability strip**
Per rule: applied this week · last run · enabled since · **net effect in €**. Pacvue's fourth leg plus BidX's one-number idea. This is what makes ramping safe rather than hopeful.
*Exit: you can see what a rule has actually done before trusting it further.*

**N5 · Graduate, one category at a time**
Bids first (largest, best-bounded, most reversible), watch a week, then budget, then negations once protected terms exist. `retail_guard` is already there and is the reference case.
*Exit: ~14 rules autonomous; ~7 gated by design.*

**N6 · Price every problem in €**
Design lesson 1. Wasted spend, suppressed listings, dead letters — every row with money attached.
*Exit: one number that says what inattention is costing.*

**N7 · Counts in tab labels**
Design lesson 2. Cheapest real win in the study.

### Deliberately not doing
The Control Console as a separate build (N2+N4 give its substance on existing pages), scraped SOV, cross-retailer breadth, ML bidding — at €4.5k/month the payback is not there, and your own study already concluded rules-first at this volume.

---

## What I need from you

1. **Go on N1** — clearing 227 stale rows is destructive-ish and they are your queue.
2. **The dial's shape** — five named levels, or a 0–100 intensity? Named levels are more legible; a percentage ramps more finely.
3. **Protected terms** — the whitelist is still empty, and it gates two of the best autonomy candidates.
