# Ads Change History — the canonical design

**Status:** PROPOSAL AWAITING GATE · 2026-08-03
**Supersedes** the design + phase sections of `docs/2026-08-03-ads-history-audit-hx.md`. That document's **defect audit (§3) remains valid and is referenced throughout** — this one adds the market research it lacked, the design-system pass, and a complete phase plan.

**Working rules:** nothing implemented without a gate · everything local until you say push · the builder's "Your rank goal & schedule" cockpit is untouchable (HX.8 added a history *section* to the builder shell; `RankPlanBody` is byte-identical).

---

## Part 1 — What exists today

### 1.1 The four tables that record change

Nothing in this system has a single "history" table. Four tables record different facts, written by different paths:

| Table | Grain | The question it answers | Written by |
|---|---|---|---|
| `AdvertisingActionLog` | one operation, before/after JSON, rollback anchor | "what operation ran" | `writeAdvertisingActionLog` (queued path) + `audit()` (inline path) |
| `CampaignBidHistory` | one field: old → new, actor, reason | "what value changed" | `writeBidHistory` |
| `AdMutation` | one intended change + **delivery state** (PENDING/IN_FLIGHT/APPLIED/FAILED, attempts, lastError) | "did Amazon take it" | the queued mutation path |
| `AutomationRuleExecution` | one rule firing | "did the rule run, and what did it match" | the rule evaluator |
| **`RankScheduleVersion`** *(new, HX.8)* | a snapshot of a rank plan after each save | "what did the **operator** change" | `saveRankScheduleGroup` |

The first four describe **what the machine did**. The fifth describes **what the human did**. Keeping those separate is the single most important structural decision in this design — see §3.2.

### 1.2 Every surface, and its state

| # | Surface | Route | Reads | State |
|---|---|---|---|---|
| 1 | **Change Log (Amazon)** | `/marketing/ads/changelog` | — | **STUB** — "This screen is being rebuilt to match Adtomic." |
| 2 | **Change Log (eBay)** | `/marketing/ads/ebay/change-log` | eBay `/actions` | **Complete** (ER3.4). Filter by change type **and** source, deep links, cursor pagination. Our in-house reference implementation. |
| 3 | Events | `/marketing/advertising/events` | `AdvertisingActionLog` | Real — on the **legacy** tree slated for deletion |
| 4 | Activity | `/marketing/ads-console/activity` | rule executions + SSE | Real — also **legacy** |
| 5 | Rule execution history | `RuleListTab` → drawer | `/automation-rule-executions?ruleId=` | Real, per-rule only |
| 6 | Campaign history | `GET /advertising/campaigns/:id/history` | `CampaignBidHistory` | Endpoint only — **no consumer**; ships `undoable`/`isUndo` with **no undo endpoint** |
| 7 | Bid history (raw) | `GET /advertising/bid-history` | `CampaignBidHistory` | Consumed only by legacy pages |
| 8 | **Schedule Activity** *(A4)* | drawer, Activity tab | `CampaignBidHistory` ⨝ `AdMutation` ⨝ inline audit | Built, unpushed |
| 9 | **Schedule Changes** *(HX.8)* | drawer, Changes tab **+ builder section** | `RankScheduleVersion` | Built, unpushed |
| 10 | Budget pool / replicate history | narrow endpoints | pool + blueprint tables | Real, narrow |

**The shape of it:** ten surfaces, five tables, no unified read. The current Amazon console has **no account-wide change view at all** — the two that work are on legacy trees, and the slot meant to replace them is a stub. The smaller channel (eBay) has the better audit surface.

### 1.3 What we fixed on the way here (HX.1–HX.3, built)

The rank loop's dominant action — the placement-bias write — bypassed the audit spine entirely: no `CampaignBidHistory`, no `AdMutation`, **no actor**, and a hardcoded `SUCCESS` even on a failed push. It now carries an actor and a reason, writes one history row per changed placement, and records its true outcome. **All ten placement call sites across the codebase are now attributed** (rank-defend, reconcile, rollback, two rule actions, autopilot, the TOS optimizer, blueprint apply).

---

## Part 2 — What the market does

### 2.1 Google Ads "Change history" — the gold standard

This is the reference implementation the whole industry is measured against:

| Capability | Detail |
|---|---|
| **Retention** | **2 years** |
| **Filters** | campaign · ad group · change type · **user** · **tool** · item changed · campaign experiment · date range · day of week · month |
| **Views** | three: **By user**, **By campaign**, and **Performance** — the last overlays changes as **annotations on the performance chart** |
| **Values** | expand any row to see **old and new values** |
| **Undo** | **within 30 days**; fails if a related item was removed or someone already undid it; multiple changes in one row revert **together** |
| **Automation** | changes made by automated rules, the API and Editor are all recorded and attributed to the **tool** |
| **Excluded** | password changes, deliberately |

Two ideas here are worth more than the rest: **`tool` as a first-class filter dimension** (separate from `user`), and **annotating the performance chart with changes** so "what did we change" and "what happened" are read on one axis.

### 2.2 Amazon natively — weak

A **History** tab per campaign and ad group, **90 days**, **Sponsored Products and Sponsored Brands only**. No account-wide view, no undo, no automation attribution. This is a gap third-party tools are expected to fill — and unified reporting (now GA, up to 6 years of *performance* data) makes the 90-day *change* window look worse by comparison.

### 2.3 Adobe Advertising — "History Logs"

31 days · covers users, portfolios, campaigns, ad groups, ads, keywords, placements, product targets · **old and new values plus timestamp** · show/hide columns, filter by column value · **XLSX export**. The export and the flat-but-filterable table are the takeaways.

### 2.4 Pacvue / Skai

Enterprise commerce-media platforms (Pacvue targets $50k+/mo spend; Skai spans 300+ publishers). Both position on **AI-powered auditing** and governance, but publish little public detail on their audit-log UX. Treat as directionally confirming that enterprise buyers expect an audit trail, not as a feature spec.

### 2.5 The patterns worth adopting

1. **One account-wide log**, filterable — not ten per-object silos ❌ we have silos
2. **Attribution as a filter dimension**: user vs tool vs API vs automated rule ⚠️ we have actor strings, unexposed
3. **Old → new inline** ✅ we have this
4. **Time-boxed undo** ❌ flag exists, no endpoint
5. **Change annotations on the performance chart** ❌ nobody in the Amazon third-party space does this well
6. **Export** ❌
7. **Long retention** ⚠️ unbounded today, no policy
8. **Summary views** (by user / by object), not only a flat feed ❌

### 2.6 Where we can be genuinely ahead

Three things the platforms themselves cannot offer, because they *are* the platform:

- **Delivery truth.** Google and Amazon log a change because they applied it. We are a third party pushing over an API, so **intent ≠ outcome** — a change can be recorded locally and never reach Amazon. We already model `PENDING → IN_FLIGHT → APPLIED → FAILED` with attempts and errors. **No competitor surfaces this.** It is the single most valuable differentiator here, and it is the exact thing that made the Health column lie before HX.3.
- **Two-layer history.** Plan edits (`RankScheduleVersion`) separated from execution (bid/placement moves). Google has no equivalent because it has no "plan" object. This answers "why did behaviour change" in one click instead of inferring it from a thousand bid rows.
- **Actor → name resolution.** `automation:rank-defend-<cuid>` resolves to the schedule's **name**, so a row reads *"IT AIREON raised Top-of-Search bias 100% → 115%"*. Google shows a tool name; we can show the specific automation.

---

## Part 3 — The goal and the approach

> **One place that answers: what changed, who or what changed it, did it actually reach Amazon, and what happened next.**

### 3.1 Four properties

1. **Complete** — every write attributed, no silent paths (HX.1–HX.3 did this for placement; the audit must be repeatable for any new write path).
2. **Honest** — intent and delivery are separate columns, always. A change we asked for is not a change Amazon took.
3. **Legible** — actors resolve to names; a diff reads in words, not cuids and JSON.
4. **Actionable** — filterable, exportable, correlatable with performance, and reversible where it is safe to reverse.

### 3.2 The one structural decision: two layers, never merged

```
PLAN LAYER      RankScheduleVersion        "operator moved the Friday window 18:00 → 20:00"
                    ↓ causes
EXECUTION LAYER CampaignBidHistory    +    "engine raised Top-of-search bias 100% → 115%"
                AdMutation / audit         "…and Amazon accepted it / rejected it"
```

Merging them buries a handful of plan edits under thousands of automated bid moves. Every view below keeps the split; the account log offers it as a filter rather than a blend.

### 3.3 One read model

`GET /advertising/changes` unifying the four execution tables behind one row shape, with `source` derived from the **actor prefix** (the root cause of the "automation labelled Operator" defect), and `origin` resolving that actor to a named schedule / plan / rule.

```
{ id, at, actor, source: 'automation'|'operator'|'system'|'external',
  origin: { kind, id, name }, entity: { type, id, name },
  field, oldValue, newValue, reason,
  delivery: { state, attempts, lastError } | null, undoable }
```

---

## Part 4 — Design system

**Decision: stay ads-console native** — re-confirmed for a third time, and this surface makes the case better than any other, because **we already have the reference implementation in-house**: the eBay Change Log (`ebay/change-log`) is built on `AdsDataGrid` with change-type + change-source filters and cursor pagination. The Amazon log should be the same component with the same filter idiom, so the two channels read identically.

| Need | Reuse |
|---|---|
| the log table, filters, toolbar, customise, export | `AdsDataGrid` + `GridColumn` / `GridFilter` — exactly as `EbayChangeLog` uses them |
| searchable dropdowns | `H10Select` (edge-clamped, ranked search) |
| drawer shell | `h10-hist-*` (shared by the rule drawer and the schedule drawer) |
| timeline / diff rows | `h10-ver-*` (HX.8) |
| week-shape diffs | `WeekShape` + the builder's `rank-grid-model` — one definition of what a cell means |
| status + delivery tone | `h10-pill`, `.dlv` tones (ok / bad / dry / muted) |

### 4.1 Navigation — extend, never add

**Gated rule 2026-08-03: no new pages, no new sidebar entries.** The console has enough surfaces; a new capability lands as a tab, panel, drawer, section or column on the page that already owns the subject. Where a route is genuinely unavoidable it **opens in a new tab** and is entered from a quiet, contextual link inside the section that needs it — never from global navigation.

Applied to this design:

| Phase | Where it lives | Why that isn't a new page |
|---|---|---|
| **HX.5** account Change Log | fills the **pre-existing** `/marketing/ads/changelog` stub | the route already exists; filling a stub is extension. **No sidebar entry** — the Amazon sidebar slot already points at the eBay log and stays that way. |
| entry points to it | a quiet "View all changes →" in the **schedule Activity drawer** and on the **campaign History tab**, `target="_blank"` | contextual, understated, opens in a new tab so you never lose the schedule you were reading |
| **HX.6** campaign History | a **tab on the existing campaign detail page** | not a route |
| **HX.9** annotations | markers on the **existing** performance charts / heatmap | not a route |
| **HX.10** export | the **existing** grid toolbar's export hook | not a route |
| **HX.11** summary views | segmented control **inside** the change log | not a route |

**Constraints already paid for, to be honoured:**
- **Sticky-cell stacking trap** — any row menu or modal inside `AdsDataGrid` must be **portalled to `document.body`**; `td.nm` is `position: sticky; z-index: 3` and opens a stacking context no child z-index escapes. (Recorded in memory; reference impl `ScheduleRowActions.tsx`.)
- `AdsDataGrid` needs scoped `table-layout: fixed` via a plain global class — never `auto` + `nowrap`.
- The pre-push DS ratchet greps **comments** — never write a bare `<select` in one.
- Wide rows must scroll inside their own container; the page body must never scroll horizontally.

---

## Part 5 — Phases

Each separately gated, built locally, committed only on your word.

### Already built, unpushed
**HX.1** actor + truthful outcome on placement writes · **HX.2** placement writes join the audit spine · **HX.3** Health reads real delivery · **HX.8** plan-edit history (drawer tab + builder section).

### Proposed

| # | Phase | What lands | Risk |
|---|---|---|---|
| **HX.4** | **Unified read model** | `GET /advertising/changes` — the four execution tables behind one row shape · `source` from the actor prefix (fixes the "automation shows as Operator" defect) · `origin` resolving actor → schedule/plan/rule **name** · filters for entity, source, origin, field, date, delivery state. | medium |
| **HX.5** | **Account Change Log** | Fills the **existing** `/marketing/ads/changelog` stub on `AdsDataGrid`, filter idiom matched to the eBay log. **No sidebar entry, no new route** — reached from a quiet "View all changes →" inside the schedule drawer and campaign History tab, opening in a new tab. Retires the legacy Events + Activity pages, **unblocking H1**. | medium |
| **HX.6** | **Re-point the existing views** | Schedule drawer, campaign History as a **tab on the existing campaign detail page** (fills the orphaned endpoint), rule history → one row component, one row shape. Retires `bid-history` as a UI source. | medium |
| **HX.7** | **Undo** | A real endpoint behind the `undoable` flag the API already computes. Google's model: **time-boxed (30 days)**, refuses when a related entity is gone or it was already undone, and multiple changes from one operation revert **together** (`changeSetId` already exists for this). **Writes to Amazon — own hard gate.** | **high** |
| **HX.9** | **Change annotations on performance** | Overlay change markers on the campaign / heatmap charts, Google's "Performance" tab pattern. Turns the log from a record into a diagnosis: *"ACoS moved the day this window changed."* The highest-value phase after HX.5, and nobody in this space does it well. | medium |
| **HX.10** | **Export** | CSV/XLSX of the filtered log (Adobe's pattern), reusing the grid's existing export hook. | low |
| **HX.11** | **Retention + summary views** | A stated retention policy (Google keeps 2 years; we are unbounded and will grow without limit), plus "by user" / "by object" summaries rather than only a flat feed. | low |
| **HX.12** | **Cross-channel filter** | One log spanning Amazon + eBay behind a channel filter, or a deliberate decision to keep them separate. | medium |

### Recommended order

**HX.4 → HX.5 → HX.6 → HX.9 → HX.10 → HX.11 → HX.7 → HX.12**

Rationale: HX.4–HX.6 turn ten silos into one spine and one view — that is the bulk of the value and it unblocks retiring the legacy trees. HX.9 is the differentiator and needs the unified read to exist first. HX.7 writes to Amazon, so it goes late and separately regardless of its appeal.

---

## Part 6 — Decisions I need from you

1. **Order.** Is HX.4 → HX.5 → HX.6 first the right call, or do you want HX.9 (change→performance annotations) pulled forward as the differentiator?
2. **HX.7 undo.** Build it on Google's model, or drop the `undoable` flag from the payload and stop implying a capability we don't have?
3. **Retention.** We currently keep everything forever. Google keeps 2 years, Adobe 31 days, Amazon 90 days. Pick a policy, or defer HX.11.
4. **HX.12 channel scope.** One cross-channel log, or Amazon and eBay stay separate surfaces?
5. **Push.** Everything above marked "built" is local and unpushed, and the RDX/A columns cannot show real values until the corrected API is deployed and the cron ticks.
