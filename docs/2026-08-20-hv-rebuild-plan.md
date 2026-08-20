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

## Appendix — scripts

`apps/api/scripts/_hvr-state.mts` — read-only, re-runnable. Rule shapes and parameters, campaign and
ad-group role census, search-term freshness and candidate volume at 14/30/60 days, the match-type ×
targeting-type cross-tab, the suggestion inbox, the harvest policy/destination tables, and the cron
history. Every number in §1.1 comes from it.
