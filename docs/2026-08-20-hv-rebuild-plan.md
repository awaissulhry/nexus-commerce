# HV-R — Keyword Harvest, rebuilt to the two studies

**Proposal. Nothing has been changed. Read §7 before approving any phase.**
Session slug `hvr`. Measured on production 2026-08-20 with
`apps/api/scripts/_hvr-state.mts` (read-only, re-runnable) and by loading
`https://nexus-commerce-three.vercel.app/marketing/ads/rules-automation/keyword-harvest`.

Priors, all still binding: `docs/2026-08-11-hv-keyword-harvest-page.md` (2,704 lines — the wire
map, six defects and the industry research), `docs/2026-08-16-ra-h10-reference-study.md` §3.3 · §4.2
· §5.3 (H10's own shape, frame-verified), `docs/2026-08-16-ra-parked-sections.md` §U7 (what U7
parked and where each piece is headed).

---

## 0 · The one-sentence version

The page is already H10's *shape* — pill, rules grid, builder — but on production the Rules View
prints a **fabricated criterion on 4 of its 5 rows** and a **fabricated lookback on 4 of 5**, and the
Ad Group View, which the micro-study describes as the application layer holding hundreds of rows,
holds **zero**; the rebuild is therefore not a re-layout, it is making both views say what is
actually true and giving the second one something to manage.

---

## 1 · What exists today, end to end

```
/marketing/ads/rules-automation/keyword-harvest
└── page.tsx → KeywordHarvestRulesClient.tsx
    ├── AdsPageHeader (markets · Change Log)
    ├── RulesTabs active="keyword-harvest"
    ├── .h10-hv-viewseg  [ Rules View | Ad Group View ]   ← hand-rolled div[role=tablist]
    ├── Rules View  → _shared/RulesGrid.tsx   (SHARED with 10 other tabs)
    └── Ad Group View → HvAdGroupView.tsx     (HV-only)

Builder  /builder/keyword-harvesting → _shared/RuleBuilder.tsx (slug 'keyword-harvesting')
         steps: Rule Name · Positive Rule Setup (ad-group mapping matrix) · Criteria ·
                Search Terms · Advanced Settings · Control
         Preview → GET /advertising/harvest/preview      (keys fixed in HV.8c)
         Campaign picker → _schedule/CampaignSection.tsx  (THE shared picker, CS 2026-08-18)

Adapter  ads-rule-adapter.service.ts  'keyword-harvesting' → promote_to_exact (+ add_negative_exact)

Engines  A  SCHEDULE → harvest_and_negate       → ads-harvest.service.ts previewHarvest/applyHarvest
         B  SEARCH_TERM_CONVERTING → promote_to_exact → advertising-rule-evaluator.job.ts:758
Cron     ads-auto-harvest · nightly 06:30 · 81 runs · last 2026-08-20T06:30 SUCCESS
         DISARMED behind NEXUS_ADS_AUTO_HARVEST_ARMED (unset ⇒ forceDry)

Served, with NO UI since U7 parked it:
  /keyword-harvest · /keyword-harvest/cursor · /harvest-policy · /harvest-destination ·
  /harvest-promote · /harvest-cohort · (harvest-actors, inside /keyword-harvest)

PARKED in place (8 files, 18 blocks, none deleted) — manifest docs/2026-08-16-ra-parked-sections.md:
  KeywordHarvestClient(875) HvThresholds(259) HvCohort(329) HvDestination(259)
  HvPromote(277) HvActors(403) HvQueue(103) HvRepairs(34) · slot-contract.ts
```

### 1.1 Production, measured 2026-08-20

| measurement | value |
|---|---|
| advertising `AutomationRule` rows | 51 |
| harvest rules (badge and grid now agree) | **5** |
| of those, **builder**-shaped (`keyword-harvesting`) | **0** |
| of those, carrying an ad-group **mapping** | **0** |
| harvest rules with `conditions: []` | **4 of 5** |
| harvest rules whose thresholds live on the ACTION | 3 of 5 (`minOrders` 2/2/3 · `minSpendCents` 1000/1000/500 · `windowDays` 60/60/30 · bid €0.50/€0.50/€0.65) |
| harvest rules stating **no** threshold anywhere | **2 of 5** (`Daily automation digest`, `Auto match-type migration`) |
| Automation toggles reachable | **0 of 5** — all held at PROPOSE by `ads-graduation.ts` (structural actions) |
| rules `enabled: false` | 2 of 5 |
| **Ad Group View rows** | **0** |
| `AmazonAdsSearchTerm` | 12,468 rows · 2026-05-20 → **2026-08-19 (1 day old)** |
| distinct queries ≥2 orders — 60d / 30d / 14d | **20 / 10 / 6** |
| 60d search terms by match type | PHRASE 2,908 · `TARGETING_EXPRESSION_PREDEFINED` 2,547 · EXACT 1,074 · BROAD 673 · `TARGETING_EXPRESSION` 255 |
| pending harvest suggestions | **33** (`harvest_and_negate` 20 · `promote_to_exact` 8 · `add_negative_exact` 5) |
| harvest suggestions ever applied | **0** |
| `AdsHarvestPolicy` / `AdsHarvestDestination` rows | **0** / 1 |

**Two of the old study's defects are now CLOSED and should not be re-planned.**
D2 (the builder Preview read keys the endpoint never returns) was fixed in HV.8c.
D6 (the auto-targeting blind spot) is fixed: `advertising-rule-evaluator.job.ts:779` now filters
`matchType IN (BROAD, PHRASE, TARGETING_EXPRESSION, TARGETING_EXPRESSION_PREDEFINED)`, so the 2,802
auto-discovered rows are visible to `promote_to_exact`.

---

## 2 · What the page prints that is not true

All four were read off production, not off code.

### R1 — "Always → harvest and negate", on 4 of 5 rows
`summariseRule`'s engine branch reads **only `rule.conditions`**. Four harvest rules store `[]`
there and keep their thresholds on the action (`minOrders`, `minSpendCents`, `windowDays`,
`graduationBidEur`), so the cell falls through to `if (!ifs) return 'Always → …'`.

*"Always"* tells the operator the rule fires on every search term. `Harvest & negate search terms`
fires on terms with **≥2 orders and ≥€10 spend over 60 days**. This is the fabricated-cell class
this programme has already been bitten by three times ([[reference_fleet_stale_constant_class]]).

### R2 — "None" in the Lookback column, on 3 of 5 rows
`harvest_and_negate` has no entry in `ACTION_WINDOW` (`packages/shared/ads-rule-window.ts`), so a
SCHEDULE harvest rule falls to `TRIGGER_WINDOW.SCHEDULE`, whose tooltip reads *"🔴 It runs on the
clock and is handed no performance data at all… Nothing in this rule reads campaign or keyword
history before it acts."* `applyHarvest` re-queries `AmazonAdsSearchTerm` over
`action.windowDays` — 60, 60 and 30 days on those three rules.

### R3 — a window from the WRONG TAB, on 1 row
`Daily automation digest` carries `[bid_to_target_acos, harvest_and_negate, alert_operator]`.
`orderedActionTypes` correctly puts the harvest action first, but `ruleLookback` takes *the first
action that HAS a window*, and harvest has none — so it skips to `bid_to_target_acos` and the
**Keyword Harvest tab reports the bid optimiser's 30-day unsettled window**, warning triangle and
all. The `tabKey` machinery exists precisely to stop this; the missing map entry defeats it.

### R4 — the Ad Group View is empty, and the emptiness is structural
The view derives its rows from `actions[0].mappings`, which only a **builder** rule writes. Zero
builder rules exist. The empty state is honest and well-written, and it will stay true forever
unless something else populates the view — which is exactly what the micro-study says this view is
for: *"it might show you 200 rows… its primary function is to manage where the rules are applied."*

Two more, smaller: the Ad Group View's toolbar button reads **"Rule ⧉"** and jumps straight into the
builder while the Rules View's reads **"+ Rule"** and opens the type modal (B1); and the view's
filters are built from `rows` — with zero rows there is **no filter bar at all**, where H10 has a
persistent "Filters / ⌃ Hide Filters" card.

---

## 3 · The two studies against what we have

### 3.1 The general study (rule grid + creator modal)

| the study asks for | today |
|---|---|
| one grid of all active promotion rules | ✅ `RulesGrid` |
| Rule Name, hover reveals "Open" | ✅ (+ History) |
| **read-only Order Threshold and Max ACoS columns** | ❌ one `Criteria` cell, wrong on 4/5 |
| Automate toggle routing to review vs live | ⚠ present, **held on all 5** by graduation policy |
| Delete icon, far right | ✅ B1, always painted and tabbable |
| creator: Source→Destination campaign mapping | ✅ builder's Positive Rule Setup |
| creator: performance triggers (orders, ACoS) | ✅ collected · ❌ **ACoS discarded by the adapter** |
| creator: Lookback 14/30/60 excluding the last 3 days | ⚠ collected per group · ❌ discarded by the adapter · ❌ engine A applies **no** latency skip |
| creator: Frequency | ✅ |
| creator: auto Negative Exact at source | ✅ `negateInSource` · ⚠ engine A only negates when a `destinations` map exists |
| Manual output → a Suggestions holding pen | ✅ page exists · **33 waiting, 0 ever applied, and this page never links to it** |
| Automate output → live + Change Log | ✅ Change Log exists and is linked from the header |

> **New, from H10's own KB (2026-08-20 search):** the article describes the view as showing *"the
> Order and Max ACoS Thresholds configured for each rule and whether the rule is automated"* —
> which settles the disagreement between the two studies in the general study's favour. Those two
> columns are real H10 columns, not a paraphrase of `Criteria`.

### 3.2 The micro study (the two views)

| the study asks for | today |
|---|---|
| pill toggle Rule View / Ad Group View | ✅ (hand-rolled — see §5) |
| Rule View deliberately minimal, no filter bar | ✅ |
| Ad Group View: a robust filter bar | ❌ filters only exist when rows do |
| **Source Ad Group** column | ⚠ rendered as a Yes/— "Reads terms" flag |
| **Destination Ad Group** column | ❌ rows are one-per-ad-group, not one-per-pathway |
| **Assigned Rule — a dropdown that changes the governing rule** | ❌ a read-only link to the builder |
| **Status/Automate — a local toggle that pauses one mapping** | ❌ absent |
| detach a rule from one ad group without touching the rule | ❌ impossible from any screen |
| hundreds of rows = the application layer | ❌ **0** |

### 3.3 Things neither study named, worth stealing

- **H10 KB:** *"Keyword Harvest and Negative Keyword Filter now supports both campaign filters **and
  ad group filters**."* Our Ad Group View filters on Campaign and Rule only.
- **H10 KB — "Search Term Isolation":** H10's name for negate-at-source, shipped **off** by default
  with a stated caution (high-volume campaigns only). Our builder switch has no such caution.
- **H10 KB — the promotion ladder:** *auto → research (≥2 sales, ACoS ≤30%, 14d) → performance (≥4
  sales, ACoS ≤20%)*. That is **rule stacking on one destination**, which Scale Insights also ships
  ("several import rules with different parameters can point at one destination"). Our model has no
  concept of a ladder stage.
- **Scale Insights:** bid = **a percentage of the term's own average CPC**, and *"60 days of search
  term stats, skipping the past 2 days to account for data latency."* `applyHarvest` already
  implements CPC inheritance and every caller defeats it with a constant (five different constants:
  0.50 · 0.50 · 0.60 · 0.65 · 0.75).
- **Scale Insights / H10 Control:** *"exclude a search term from being imported if it already exists
  in the ad group."* Our builder collects `dedupe`; the adapter drops it.
- **Nobody ships** post-graduation performance — what a harvested keyword did *after* it was
  harvested. We built it (`HvCohort`) and parked it. It is the one place we can beat the field.

---

## 4 · The phases

Ordered so that no phase depends on a later one, and so that the phase that turns dormant code live
(P4) lands **before** the phase that starts creating rules that use it (P3b).

---

### **P1 — The Rules View stops fabricating** · shared layer · ~half a day

Closes R1, R2, R3.

1. `_shared/RulesGrid.tsx` `summariseRule()` — when an engine rule's `conditions` is empty, read the
   matching action's **parameters** (`minOrders`, `minClicks`, `minSpendCents`, `maxAcosPct`,
   `windowDays`, `graduationBidEur` / `bidEur`) and render them as clauses:
   `≥ 2 orders · spend ≥ €10 · 60d → harvest & negate @ €0.50`.
2. A rule with **no** threshold anywhere must say that, and name what will actually bind it —
   `No criteria on this rule — the engine's defaults apply (≥2 orders / 60 days)` — never *"Always"*.
3. `packages/shared/ads-rule-window.ts` — give `harvest_and_negate` an `ACTION_WINDOW` entry that
   honours `action.windowDays` (default 60) and is marked **`settled: false`**, because
   `previewHarvest` does not drop Amazon's provisional tail. That single entry also fixes R3: the
   digest rule stops borrowing the bid optimiser's window on this tab.
4. `promote_to_exact` keeps the trigger's 30-day settled window; assert that with a unit test beside
   the existing `ads-rule-window.vitest.test.ts`.

**Verification:** all 5 rows on prod carry a Criteria and a Lookback derived from stored values;
zero rows read "Always"; the digest rule's Lookback differs between the Bid and Keyword Harvest tabs
and both are right.

🔴 **Collision:** `RulesGrid.tsx` and `ads-rule-window.ts` are the file another session shipped B1
and B2 into **today**. See §7.

---

### **P2 — H10's two threshold columns** · shared layer · ~half a day

The columns the general study and H10's KB both name: **Order Threshold** and **Max ACoS**.

- Derived from the same parameter reader P1 builds — one source, two renderings.
- Rendered as `Min 3 orders` / `Max 30% ACoS`, and **"—" when the rule states none**, which on this
  account is 2 of 5 rows and is itself the finding.
- 🔴 **Not a prop fork.** `RulesGrid` is shared by ten tabs and the house rule is that shared means
  exactly the same. The columns come from a per-tab **column set** declared in `_shared` beside
  `RULE_TAB_ACTION_TYPES`, so Negative Targeting can later declare its own (Click / Spend
  threshold) through the same mechanism rather than a second grid.
- Needs decision **D-D** (§6).

---

### **P3 — The Ad Group View becomes the application layer** · the big one · ~3–4 days

Split in two so the write half never ships before the read half is proven.

#### P3a — the read: pathways, not ad groups
- One row = **one Source→Destination pathway**, matching the micro-study and H10's bundle columns:
  `Ad group Type · Source Ad Group · Campaign · Destination Ad Group · Assigned Rule · Keyword P/E/ASIN
  · Negative Keyword · Negative Targets`.
  *"Of Target" stays omitted* — its semantics were never recoverable and inventing a column is worse
  than omitting one (U7's own ruling, unchanged).
- A **persistent Filters card** above the grid — Source Campaign · Destination Campaign · Source Ad
  Group · Destination Ad Group · Harvest Rule · Clear — rendered whether or not there are rows, and
  sourced from `/advertising/scope-options` (which already returns campaigns with their ad groups).
  Adds H10's newer ad-group filters.
- **The view lists eligible pathways, not only assigned ones** (decision **D-B**). Source = an ad
  group in an AUTO campaign or a BROAD/PHRASE ad group; destination = an ad group in a MANUAL
  keyword-targeted campaign. On this account: 39 AUTO + 40 BROAD + 43 PHRASE sources against 54
  EXACT destinations. Unassigned rows read **"Not assigned"**, which is the operator's actual
  question ("which of my ad groups is harvesting, and which is not?") and the reason the empty grid
  is useless today.

#### P3b — the write: Assigned Rule + a per-pathway Automate toggle
- **Assigned Rule** becomes a dropdown (the D-series pattern that shipped for Budget Rules on
  2026-08-20 — same interaction, staged Apply, one shared cell).
- **Automate** becomes a per-pathway toggle that pauses one mapping without touching the rule —
  the micro-study's "stop harvesting for one product that is out of stock."
- Storage: decision **D-A**. Recommendation is a new additive table
  `AdsHarvestAssignment(sourceAdGroupId, destinationAdGroupId, ruleId, matchTypes, negateAtSource,
  enabled)` — a mirror of the campaign-rule assignment that just shipped, rather than editing
  `actions[0].mappings`, because an **engine** rule has no `mappings` field at all and 5 of 5 rules
  here are engine rules.
- 🔴 **The executor must read it in the same phase.** A binding no engine reads is the
  [[reference_fleet_stale_constant_class]] defect this repo has now measured four times. `applyHarvest`
  and `buildSearchTermConvertingContexts` both gain an assignment lookup, and the phase is not done
  until a probe shows a run honouring one.

---

### **P4 — Everything the builder collects must survive into execution** · ~1–2 days

This is old D5, and it has **zero victims today only because zero builder rules exist**. P3b starts
creating them, so P4 must land first or alongside.

`ads-rule-adapter.service.ts` `translateConditions` currently maps five metrics (Orders, PPC Orders,
Clicks, Spend, Sales) and `continue`s past the rest into a `logger.warn`. Dropping an AND-condition
does not tighten a rule, it **loosens** it: *IF orders ≥ 2 AND ACoS ≤ 25%* executes as *IF orders ≥ 2*,
and the ACoS ceiling is the only thing between harvesting and buying unprofitable traffic.

- Map the remaining six: `ACOS · ROAS · Impressions · CVR · CTR · CPC`.
- Carry through what is silently dropped besides conditions: the **lookback/exclude windows**, the
  **ad-group mapping matrix**, `dedupe`, `filters.brandExclude`, `filters.competitorOnly`,
  `searchTerms`.
- Anything still unmappable must **fail the save with a named reason**, never warn and continue.
- Wire `dedupe` to H10's Control switch — *"do NOT suggest search terms that already exist with the
  same match type in this rule group"* — the setting Scale Insights ships and the reason our engine's
  nightly graduations were 0-of-14 genuinely new.
- Bid: stop overriding `applyHarvest`'s CPC inheritance with a constant. The builder already offers
  H10's four modes (Current CPC · Ad Group Default · Custom · CPC + %); make them reach execution,
  and expect the marketplace bid ceiling to clamp (IT €0.80 · DE €1.90 · ES €0.90) and **say so**.

---

### **P5 — Design-system alignment** · ~1–2 days

The page loads `ads.css`'s tokens, not the DS's — `--space-4` and `--radius-md` are unset on
`:root` here — and the pill is a hand-rolled `div[role="tablist"]` with `role="tab"` children, no
`tabpanel` and no arrow-key navigation, while DS `SegmentedControl` is already in use two
directories away (`dayparting/_rd/GrainSwitch.tsx`, `automations/AutomationsClient.tsx`).

- Import the four DS stylesheets on this page, as `budget-schedules` and `dayparting` already do.
- `h10-hv-viewseg` → DS **`SegmentedControl`**. Empty state → DS **`EmptyState`**. Match-type badges
  → DS **`Tag`**. Buttons → DS **`Button`**. Assigned-Rule dropdown → DS **`Listbox`/`Combobox`**.
  Filters card → DS **`FilterBar`**. Confirmations → DS **`Modal`** + **`Toast`**.
- Make "+ Rule" identical in both views (type modal, same label, same icon).
- 🔴 **`AdsDataGrid` stays.** It is the section's one H10 grid and ten other pages render through it;
  swapping it for DS `DataGrid` is a section-wide decision, not this page's (decision **D-C**).
- Verify numerically on prod, in **both** themes — `.dark` never redefines the tone/link tokens, so
  warning/danger/link measure 2.94:1 and 3.18:1 on a dark panel — and probe each element's **own**
  background, never its parent's.

---

### **P6 — One harvest, not two** · ~2 days

| | A `harvest_and_negate` | B `promote_to_exact` |
|---|---|---|
| window | 60 days | 30 days |
| latency skip | **none** | yes |
| match types | all | four (D6 now fixed) |
| cap | none | 300 contexts |
| bid | `graduationBidEur ?? 0.50` | `bidEur ?? 0.50`; adapter 0.75, template 0.60/0.65 |
| a rule can loosen the threshold? | yes | **no** — the context builder filters first |

- One window source (`packages/shared/ads-rule-window.ts`), one latency policy (skip the 2
  provisional days — Scale Insights' published behaviour and engine B's already), one bid derivation.
- Retire the four surplus bid constants.
- Surface, do not silently fix: `ads-control-room.service.ts:293` hardcodes
  `masterOff ? 'OFF' : 'AUTO'` for `auto-harvest` while HV.0 holds the engine at Propose — the
  registry reports a level it reads from nowhere. Already handed to the Control Room programme.

---

### **P7 — Close the loop: where the output goes** · ~1 day

H10's division of labour is explicit — Manual output lives on **Suggestions**, Automate output on the
**Change Log**, numbers on **Analytics**. Ours does too, and the harvest page links to none of it.

- **33 harvest suggestions are pending and 0 have ever been applied.** Add the link H10 has: a
  count on this page → `/marketing/ads/suggestions` filtered to the harvest types. A propose-only
  engine whose queue nobody can find is a propose-only engine that never proposes anything to anyone.
- Change Log is already in the header; filter it to harvest writes from here.
- The parked `HvCohort` — post-graduation performance, the one thing no competitor ships — goes to
  **Analytics** per the U7 manifest, with a one-line "N harvested in the last 30 days · M served"
  strip on this page linking to it.

---

### **P8 — Arming and operator readiness** · decision, not code

- `NEXUS_ADS_AUTO_HARVEST_ARMED` is unset, so the nightly 06:30 cron has run 81 times in `forceDry`.
  **HV.4's first live write has still never run.** Arming is the operator's call and nobody else's.
- Two of five rules are `enabled: false`; two state no thresholds at all; all five are held below
  AUTO by `ads-graduation.ts` because harvesting **creates** things and creation has no retirement
  path. Whether that ceiling should be lifted for harvest once P3b gives every write a named,
  detachable pathway is the question P8 exists to ask.
- Re-verify the local-only backlog HV.9c archived, on the current census.

---

## 5 · What is deliberately NOT in this plan

- **The 18 parked blocks are not coming back to this page.** They are real, working surface —
  candidates grid, live thresholds, destination panel, promote dialog, cohort, actors, queue — and
  U7 parked them because the operator's instruction was that this tab is *"Rules, Ad Group View,
  Rule Builder"*. Their homes are already named in the manifest (Suggestions · Analytics ·
  Automations). P7 links to the first two; nothing un-parks.
- **`RuleBuilder`'s Keyword Harvesting steps are not rebuilt.** They are frame-verified against
  H10 already (§4.2 of the reference study) and every field the SellerApp/Scale Insights comparison
  asks for is collected. The defect is the wire, not the form — that is P4.
- **Rank & Dayparting stays untouched**, including `rules-automation.css` edits that would reach it.
- **`AdsDataGrid` is not replaced** (D-C).

---

## 6 · Decisions — ✅ D-A · D-B · D-C · D-D ANSWERED 2026-08-20 (operator)

| | question | **answer** |
|---|---|---|
| **D-A** | Where does an ad-group↔rule binding live? | ✅ **A new additive `AdsHarvestAssignment` table.** 5 of 5 rules are engine rules and have no `mappings` field at all, so a rule-embedded binding would leave every rule this account owns unassignable; and detaching one pathway must not mean rewriting a live rule. |
| **D-B** | Does the Ad Group View list **all eligible pathways**, or only assigned ones? | ✅ **All eligible.** Unassigned rows read "Not assigned". Only-assigned is what we have and it renders **0 rows**; the micro-study's view is an application layer, not a mirror of the rule list. |
| **D-C** | DS alignment depth? | ✅ **Compose DS primitives inside the existing H10 grid shell.** `AdsDataGrid` stays — ten RA tabs plus the campaigns console render through it, and replacing it would break "the page a component is extracted from must not change". |
| **D-D** | Where do the Order / Max-ACoS columns live? | ✅ **A per-tab column set declared in `_shared` beside `RULE_TAB_ACTION_TYPES`** — no prop fork, no second grid, and Negative Targeting can later declare Click/Spend thresholds through the same mechanism. |
| **D-E** | P8: arm `NEXUS_ADS_AUTO_HARVEST_ARMED`, or retire the nightly cron? | **Deferred to after P3b** — once every write has a named, detachable pathway the question changes shape. |

**✅ Collision protocol, answered 2026-08-20:** proceed on the shared layer and commit with explicit
pathspecs (`git commit --only`), verifying the resulting sha is an ancestor of the remote ref before
calling it landed. The index hazards in §7 are surfaced, not repaired, unless they block a commit.

---

## 7 · 🔴 Repository hazards, found while surveying — read before any commit

These are not this plan's doing and none has been touched.

1. **The git index is polluted and would delete live files.** 81 paths are staged with content
   older than `HEAD`, and **10 Rules & Automation client files are staged as deletions while
   present on disk and untracked** — including `keyword-harvest/KeywordHarvestRulesClient.tsx` and
   `keyword-harvest/HvAdGroupView.tsx`, i.e. the two files this page renders. Any commit that
   includes the RA tree would remove them. The worktree itself matches `HEAD`; only the index is
   wrong, so `git reset -- <paths>` fixes it without touching a file.
   ([[reference_concurrent_session_commit_only_trap]] — an untracked path in `--only` kills the
   whole commit, and the chain can still print EXIT 0.)
2. **`packages/database/prisma/schema.prisma` is missing from disk** while git reports +63 lines
   against it. P3a's migration cannot be written until that resolves.
3. **A concurrent session owns `_shared/RulesGrid.tsx`** — B1 and B2 landed today and the working
   tree still carries uncommitted changes to it. P1 and P2 edit that exact file, and
   `packages/shared/ads-rule-window.ts` is B2's too. Sequence or hand off; do not both edit.

---

## 8 · Order and size

```
P1  Rules View stops fabricating        ~0.5d   shared layer   ← start here
P2  Order / Max ACoS columns            ~0.5d   shared layer
P4  Adapter carries the whole rule      ~1–2d   backend        ← must precede P3b
P3a Ad Group View — pathways + filters  ~2d     HV only
P3b Ad Group View — assign + toggle     ~2d     backend + HV
P5  Design-system alignment             ~1–2d   HV only
P7  Close the loop (Suggestions link)   ~1d     HV only
P6  One harvest, not two                ~2d     backend
P8  Arming                              decision
```

P1 and P2 are the smallest and fix what is visibly wrong on the live page, so they go first. P4 is
promoted above P3b because P3b is what first creates a builder rule and therefore what first runs
the adapter that silently drops half of it.

---

## P1 — built (commit `0c2a768da`, 2026-08-20)

Scope as approved: `packages/shared/ads-rule-window.ts` (+ its test),
`_shared/RulesGrid.tsx`, `automation-action-handlers.ts`, and the two census scripts.

**What shipped**

| | before | after |
|---|---|---|
| Criteria, engine rule with `conditions: []` but thresholds on the action | `Always → harvest and negate` | `≥ 2 orders · spend ≥ €10 → harvest and negate @ €0.50` |
| Criteria, rule with no thresholds anywhere | `Always → harvest and negate` | `Defaults: ≥ 2 orders · spend ≥ €10 → harvest and negate` |
| Criteria, `SCHEDULE` rule whose action reads nothing | `Always → …` | `No criteria — runs on the clock → …` |
| Criteria, rule whose trigger does the selecting | `Always → …` | `Any row its trigger selects → …` |
| Criteria tooltip | the cell's own text | a sentence explaining which of those four it is |
| Lookback, SCHEDULE + `harvest_and_negate` | `None` | the rule's own `windowDays` |
| Lookback, a rule carrying harvest **and** a bid action | the bid window, on **both** tabs | the harvest window on Keyword Harvest, the bid window on Bid |

`PARAM_CLAUSE` is a strict IF-side allowlist (`minOrders`, `minClicks`, `minSpendCents`,
`maxAcosPct`). The census that produced it — `_hvr-params.mts`, every action type in the account —
is mostly THEN-side (`reason`, `message`, `percent`, `target`, `campaignIds`, `floorCents`), and
rendering any of those as a condition would have invented a criterion the same way `Always`
invented an absence. `maxAcosPct` is supported with **zero rows carrying it**, because the builder
can produce it and P2's column needs it: the reader exists before the data, not after.

### 🔴 A defect the new test found that was not harvest's, and was live

When an ACTION supplies the window, `ruleLookback` appends the TRIGGER's sentence for context.
`describeTrigger('SCHEDULE', …)` is written as an absolute — *"🔴 It runs on the clock and is
handed no performance data at all… Nothing in this rule reads campaign or keyword history before
it acts."* True of a SCHEDULE rule whose action reads nothing; **false** of one whose action
re-queries. Appended verbatim, it produced a tooltip that said

> "This rule computes from the last 60 days of Amazon performance data … 🔴 It runs on the clock
> and is handed no performance data at all."

**23 of 51 rules are SCHEDULE-triggered**, and this has been true since B2 for every one of them
carrying `bid_to_target_acos` or `defend_top_of_search` — not a harvest bug, found by a harvest
test. `describeTrigger` now takes `actionSuppliesWindow` and phrases that case as a contribution
("Its trigger adds nothing to that…"), keeping the absolute where it is still true. Pinned by a
regression test that asserts both directions.

### Two things deliberately recorded rather than fixed

- **`previewHarvest` defaults `minSpendCents` to 1500 and the handler to 1000**, and the nightly
  `ads-auto-harvest` cron calls `previewHarvest({})` with no arguments — so **the cron negates at
  €15 while every rule negates at €10**. Written into `HARVEST_DEFAULTS`' docblock. Either number
  moves live writes; that is P6.
- The harvest window is `settled: false` because `previewHarvest` builds its own dates and never
  calls `ruleWindowBounds`, unlike `SEARCH_TERM_CONVERTING`. The cell now says the two harvest
  engines disagree instead of averaging them.

### Also generalised

`tosWindowDays` → `tunableWindowDays`. It keys on the `ACTION_WINDOW` entry's own `tunable` flag
rather than a literal action name, and walks the same tab order `ruleLookback` walks. The old pair
could disagree about *which action they were describing* on a rule carrying both re-queriers —
nothing in the account triggered it, which is why it was worth removing rather than leaving armed.

### ✅ Verified on production 2026-08-20 (deploy `27gdcjv1d`)

**Keyword Harvest — 5 of 5 rows, every cell now derived from stored values:**

| rule | Lookback | Criteria |
|---|---|---|
| Auto harvest & negate | 60 days ⚠ | `≥ 2 orders · spend ≥ €10 → harvest and negate @ €0.50` |
| Auto match-type migration (broad → exact) | 30 days | `search-term orders ≥ 2 → promote to exact @ €0.60` |
| Daily automation digest | **60 days ⚠** *(was 30 — the bid half)* | `Defaults: ≥ 2 orders · spend ≥ €10 → harvest and negate` |
| Exact match discovery engine | 30 days ⚠ | `≥ 3 orders · spend ≥ €5 → harvest and negate @ €0.65` |
| Harvest & negate search terms | 60 days ⚠ | `≥ 2 orders · spend ≥ €10 → harvest and negate @ €0.50` |

**The cross-tab leak, closed and proven by the same rule reading differently in two places:**

| Daily automation digest | Lookback | Criteria |
|---|---|---|
| on **Keyword Harvest** | 60 days | `Defaults: ≥ 2 orders · spend ≥ €10 → harvest and negate` |
| on **Bid** | 30 days | `No criteria — runs on the clock → bid to target ACoS` |
| on **Negative Targeting** | 60 days | `Defaults: ≥ 2 orders · spend ≥ €10 → harvest and negate` |

**Section-wide, measured by DOM probe, four tabs:** Keyword Harvest 5 rules · Bid 18 · Negative
Targeting 7 · Placement 8 — **0 rows reading "Always", 0 reading "None", 0 tooltips containing both
"computes from the last N days" and "no performance data at all".** All three honest replacements
appear and stay distinguishable: `Defaults: …`, `No criteria — runs on the clock`, `Any row its
trigger selects`.

**Geometry — no cap was needed, and none was added.** The Criteria strings roughly doubled in
length, and `.h10-nt-crit` carries no truncation. Measured rather than guessed
([[reference_grid_name_cell_content_cap]] — U2's px cap was a guess about another stylesheet):
the column absorbed the growth at `table-layout: auto`, 411px → **516px**, table width **1600px
against a 1600px card**, `pageOverflowX: false`, `tableOverflowsCard: false`, **0 clipped Criteria
cells** on every tab checked. A speculative cap would have been the defect, not the fix.

### 🔴 P7 partly overtaken while P1 was building

A concurrent session shipped B4, which adds an **Activity** column to the shared grid — "10
waiting" / "13 waiting" / "0 waiting" per rule. That is a large part of what P7 was going to build
(the harvest queue's 33 pending suggestions being invisible from this page). **Re-scope P7 before
starting it:** what remains is the link out to `/marketing/ads/suggestions` filtered to the harvest
types, and the Change Log filter — not the count, which now exists.

🔴 **And when P7 builds that link, key it on `ruleId`, never on the rule NAME** —
`/marketing/ads/suggestions?rule=<ruleId>`. Reported by the B-series session, measured on prod:
`AdsRuleSuggestion.ruleName` is a **snapshot frozen at creation**, and **7 of the 11 rules with
pending suggestions carry two spellings** after the emoji rename ("Low CTR bid reduction" is 74 + 51
= 125 rows under two names). A name-keyed link would show a fraction of the queue and look like a
working filter. The Suggestions page's Rule filter is now id-keyed to match, and
`GET /advertising/suggestions` resolves the live name onto every row.

---

## P2 — built + prod-verified (commits `2239448a3` · `6aef6cf8f`, 2026-08-20)

H10's **Order Threshold** and **Max ACoS** columns, as a per-tab column set (`RULE_TAB_THRESHOLDS`
in `_shared/ruleThresholds.ts`), never a prop. Three states per cell — a value the rule sets, a
handler fallback (muted, labelled `default`), and an em dash whose tooltip says what the absence
*means*. P1's inline reader moved into the same module so the Criteria clauses and the columns read
one table, and a threshold is a column **or** a clause, never both.

🔴 **Max ACoS is an em dash on every row, and that is the finding.** No rule in this account carries
`maxAcosPct`. The tooltip says it: *a harvest rule with no ACoS ceiling will promote a converting
search term however expensive that conversion was — order count is the only bar it has to clear.*

### 🔴 Caught by loading prod one minute after it shipped

`Order Threshold` read **"—"** with the tooltip *"This rule names no order threshold"* directly
beside a Criteria cell reading **"search-term orders ≥ 2"**. "Auto match-type migration" keeps its
bar as a flat CONDITION rather than an action parameter, and the reader looked only at parameters.
Two cells on one row contradicting each other is worse than the "Always" this series began by
removing, because the truth was one column away.

`readThreshold` now falls through to the flat conditions and `columnedConditionIndexes` removes
whichever of them a tab has promoted — the column-or-clause law extended from parameters to
conditions. **`gte`/`lte` only**: `orders > 2` is a minimum of THREE, so matching `gt` would ship an
off-by-one dressed as a fact. Fixed in `6aef6cf8f`, verified: 0 contradictions on all 5 rows.

Also caught by the tests: the money formatter had `maximumFractionDigits: 2` and no minimum, so
€15.50 rendered **"€15.5"**. Latent — no rule stores a non-round cent amount — but there were two
formatters, and one amount formatted two ways in one row is what the shared module exists to stop.

**Verified on prod:** `Min 2 orders` · `Min 2 orders default` · `Min 3 orders` · `—`, Criteria
correctly stripped to `spend ≥ €10 → harvest and negate @ €0.50`, table 1600px in a 1600px card,
no page overflow.

---

## P3a — built (commit `10d48bb09`, 2026-08-20)

The Ad Group View now lists **every ad group that can source a harvest**, from a new read-only
`GET /advertising/harvest-pathways`.

🔴 **"Not assigned" would have been a lie on every row.** A rule with neither `mappings` nor
`sources` is **account-wide**, not unscoped-and-inert: `harvest_and_negate` harvests by threshold
across everything, so it reaches every ad group here. A row reports its REACH — mapped to it
specifically, or the N account-wide rules that cover it (named, with how many are enabled), or
genuinely nothing.

### 🔴 Classify by the TARGETS present, never by the ad group's name

| | by name | by targets |
|---|---|---|
| sources | 122 | **166** |
| destinations | 53 | **77** |
| neither | 114 | **46** |

Name vs targets: **agree 136 · disagree 1 · blank-but-knowable 110.** 58 of the 166 sources have
names that say nothing at all ("Ad group - 06/07/2023 06:09:36.860", holding nothing but BROAD
targets). A name-based view would have hidden 38% of the account.

⚠ **`AdGroup.targetingType` is not the signal** however much it looks like one — it reads `MANUAL`
on all 289 rows, including the 39 inside AUTO campaigns. Another column rendering a constant
([[reference_fleet_stale_constant_class]]).

The auto-expression fallback went **into** the shared `roleOf`, not beside it: it fires only where
that returned `null`, so no existing answer moves, and `expressionType` is normalised there because
two ingests rewrite it between `EXACT` and `_EXACT` at ~65 rows/minute.

Roster line, stated because the grid cannot: **166 of 289 can source · 56 in an enabled campaign ·
77 can receive.** Two thirds of the sources are not running.

---

## Appendix — scripts

`apps/api/scripts/_hvr-state.mts` — read-only, re-runnable. Rule shapes and parameters, campaign and
ad-group role census, search-term freshness and candidate volume at 14/30/60 days, the match-type ×
targeting-type cross-tab, the suggestion inbox, the harvest policy/destination tables, and the cron
history. Every number in §1.1 comes from it.
