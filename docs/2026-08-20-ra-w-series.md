# Rules & Automation — the W-series (2026-08-20)

Operator session: the H10 page research re-checked against the live section, plus the
cross-platform research (Pacvue / Quartile / Skai / Scale Insights, `docs/2026-08-04-*` and
`~/Desktop/COMMERCE-PLATFORM-RESEARCH`). Plan W1→W6 approved verbatim; **everything here is
LOCAL and UNCOMMITTED by operator instruction** — nothing was committed, pushed, or deployed.

Verification for every unit: `apps/api/scripts/_w1-verify-stub.mts` (read-only prod reads,
SIMULATED `{ok:true}` writes, port 8099) + `NEXT_PUBLIC_API_URL=http://localhost:8099 npm run
dev`, clicked in the browser. ⚠ A stub must send `access-control-allow-methods` or every
PATCH/POST dies at CORS preflight while the GETs work.

## W0 — the help cursor is gone, permanently

The question-mark (`cursor: help`) cursor removed everywhere: 55 occurrences, 17 files — the two
shared sources (`ads.css` `.info`, sync-control's `TipText` default prop) and 44 page-local
rules (ads console, control room, reporting, dashboard, fleet, bulk-ops, flat-file pages —
cosmetic class removals only). Tooltips still appear; the cursor never changes.
**Ratchet:** `scripts/check-help-cursor.mjs`, wired into `.githooks/pre-push`, baseline ZERO,
cwd-independent, and it greps comments — never write the literal in one.

## W1 — LEGACY designation for the 51 pre-existing rules

Provenance measured (`_ra20-rule-provenance.mts`): 31 seeded by `template-seeder:advertising`
(05-16→06-01), 20 by generic `user`/`user:anonymous` actors (06-01→08-03). None by the operator.

- `packages/shared/ads-rule-legacy.ts` — cutover `2026-08-20T00:00:00Z`, derived from the
  immutable `createdAt`. **No migration, deliberately** (RPT's `20260820d` is intentionally
  unapplied; a new migration would drag it in). 3 tests.
- `RulesGrid`: amber `legacy` chip beside the name (5.76:1) + a collapsed Provenance filter
  (Legacy / Created by you) on every rule tab. Works against the LIVE prod API already — the
  rules payload carries `createdAt`.
- Automations: `LEGACY` badge beside `WRITES` + the same filter; `GET /autonomy/rules` now
  returns `createdAt` + `legacy` (**needs deploy**; the client renders nothing on their absence
  rather than guessing).
- **A label, never a behaviour.** The 9 enabled-AUTO legacy rules (incl. the cap-armed budget
  pair) run exactly as armed; triage is per-rule, through the chip.

Verified: Bid 18/18 chips · Keyword Harvest 5/5 · Automations 51/51 badges · filter both
directions (Legacy → all; Created by you → 0).

## W2 — Apply Rules close-out

- **U9 defect fixed** (all four bulk verbs shared it): a successful apply used to unmount its own
  `{ok} written · {n} refused` report, because `onDone` cleared the selection and the toolbar
  with it. The selection now clears when the popover **closes**. Verified: "3 written" survives,
  Close clears; the refusal path names campaigns.
- **"+ Assign Rule"** — H10's fifth verb, for **budget rules** (the one kind with proven
  end-to-end machinery: `CampaignRuleAssignment` → resolver → reach → staged Apply). The shared
  `RuleAssignModal` opens over the whole selection; checked = assigned on EVERY selected
  campaign; toggling on completes the set, off removes from all; everything stages, the Apply
  bar commits, Discard reverts. Verified staged across 100 campaigns and discarded.
  Bid/placement kinds wait on D4+: the FIRST assignment on an account-wide rule narrows it from
  220 campaigns to the assigned set — that cutover is the operator's.
- **Target ACoS round-trip**: verified reconciled by reading — the guardrail grid derives
  `targetAcosPct` from `dynamicBidding.targetAcos` (the field the pencil writes) before falling
  back to the column.
- **Bid Automation** stays as the honestly-labelled H10-parity field (no executor reads it —
  the cell, tip and popover say so). Wiring it to a bidder is W3+/arming territory.

## W4 — Budget Schedules, completed where it was hollow

The recon corrected two stale claims (the route and hourly card were already fixed by BSP.2);
the real defect had moved UP a layer:

- 🔴 **`excludeDates` was a boolean in the builder** and the route's `Array.isArray` sanitiser
  discarded it — so the executor's blackout branch was unreachable from anything the product
  could create, and the grid's two Exclude columns were permanently "—". Now: a real range
  editor (add/remove, MM/DD/YYYY in, ISO on the wire), and edit-hydration restores ranges
  (before, an edit-save silently reset them).
- **`startDate` was nulled whenever Never-Expire was on** — the DEFAULT path — conflating "no
  end" with "no start". Start is now always sent and required; Never-Expire governs the end only.
- **Status column**: pause/resume switch (the caller-less `PATCH {enabled}`) + a derived
  Scheduled / Active / Completed / Off pill. Verified on all four fabricated states.
- **DELETE and disable now restore base budgets** (`bsRestoreBase`): the executor's revert is
  convergent and only sees `enabled: true` rows, so deleting or disabling an active schedule
  used to leave its boost applied forever. The restore keeps the executor's own laws (baseline ▸
  snapshot ▸ live; a manual override wins).
- **Executor**: the exclude range now covers its END day inclusively (date-only ISO parses to
  UTC midnight; the bare `<=` excluded every day of the blackout except the last one the
  operator chose). First-ever tests: `ad-budget-schedule.vitest.test.ts` (7).
- Stale header comment in `SchedulesSection.tsx` rewritten to the current truth.

Deferred to operator decisions: **Amazon-event presets** (BSP.5), **auto-refill** executor
semantics (a write-only column today), **precedence** among the five `dailyBudget` writers
(BSP.6 — declined in-code as the operator's call).

## W5 — from the competitor research

- **Budget tab threshold columns** — H10's "Spend Threshold" + "ACoS Threshold", declared only
  after measuring (2 of 7 rules carry `budgetUtilization ≥`, 2 carry `acos ≤`). A trim rule's
  `acos ≥` is the wrong direction for the raise-ceiling column and stays in Criteria (the
  module's gte/lte law); its absent-sentence states the operational fact — no depletion gate
  means the rule acts at any hour. Tests updated (+1 pinning the pair).
- **Noise guard** (Pacvue) — one-click quick-adds in the builder's criteria card
  (Clicks ≥ 10 · Spend ≥ €5 · Impressions ≥ 500) that append ordinary, editable AND conditions;
  offered only where the metric exists and isn't already carried. Verified: click adds the
  condition, the chip removes itself.
- Deferred: benchmark-relative conditions and Scale Insights' "Revive" — both need engine design
  (relative references; what a KEYWORD_ZERO_IMPRESSIONS context actually carries).

## W6a — InfoTip promoted into the design system

`InfoTip` — the only tooltip that survives an `overflow:auto` container — now lives at
`design-system/primitives/InfoTip.tsx`, exported from the barrel; the old
`campaigns/InfoTip.tsx` re-exports it, so the 27 relative imports are untouched. Its
`.h10-tip`/`.h10-tipwrap` styles moved to `design-system/styles/primitives.css`, and the ads
layout imports tokens+primitives tree-wide (primitives.css verified fully `.h10-ds-*`-namespaced
first, so non-DS pages are visually untouched). Verified: computed bubble identical
(fixed · #28313d · z-1000 · 290px · portal'd to body), cursor stays default.

Deferred: the ×6/×5 forked EDITORS (C-series leftover) — its own session.

## Also fixed in passing

The `ads-graduation` suite was red **at HEAD** before this session: C2 (`876a0562a`)
deliberately added `pause_target`/`enable_target` to the bid slug's expansion (structural ⇒
ceiling PROPOSE) and the test still asserted AUTO. The test now pins C2's intended behaviour.

## Gates at close

api 4,907 tests ✓ (the 8 red files under a bare `npx vitest run` are Playwright specs
mis-collected by vitest — pre-existing, untouched) · web 918 ✓ · shared 41 ✓ · tsc clean on
both apps · button-vocabulary at its 288 baseline · silent-disabled 27 · contrast 24/24 AA ·
help-cursor 0.

## What deploy day looks like (W3)

Commit + push (operator's word) → Railway + Vercel → then, on prod by clicking:
the four bulk verbs (write → report → restore), assignment staging → Apply → rule reach,
legacy on Automations, a real BudgetSchedule end-to-end (create → window applies → blackout
holds → delete restores), and the harvest arming decision presented with numbers
(engine disarmed; 209 of 218 harvested keywords never reached Amazon).

## W7 — the legacy rules are GONE (operator correction, same day)

"Make them legacy" meant **remove them**: *"remove all the legacy rules that we created with
Claude Code and that were not manually created by me… simpler and easier for me to work in the
beginning, since we will keep the format the same across."*

Executed 2026-08-20 ~20:40 UTC via `apps/api/scripts/_w7-wipe-legacy-rules.mts` (dry-run, then
`--apply`), scoped to advertising rules with `createdAt` before the legacy cutover — the exact
set W1 had labelled. Deleted in one transaction:

- **51 rules** (31 template-seeder · 20 generic user actors; 9 were enabled-AUTO — their caps and
  the write gate live on the CAMPAIGN and are untouched),
- **1,320 `CampaignRuleAssignment` rows** (cascade) — the Budget Rule column now reads "None"
  everywhere, honestly: nothing governs a campaign until the operator assigns something,
- **968,750 `AutomationRuleExecution` rows** (cascade; overwhelmingly cap-refusal counters),
- **305 pending `AdsRuleSuggestion` rows** (no FK — they would have orphaned into un-actionable
  Approve buttons). The propose→approve backlog is now empty by construction.

**Kept:** `AdvertisingActionLog` — the audit of every write these rules ever made to Amazon
(actor-string keyed, no FK) — plus the replenishment (8) and reviews (3) domains, and anything
created on/after the cutover (0 existed at wipe time). **Full backup first:**
`docs/backups/2026-08-20-legacy-automation-rules.json` — complete rule rows (conditions, actions,
caps, scope, counters), assignments, and execution aggregates; any rule can be recreated verbatim.
**No auto-reseed exists**: `seedAdvertisingTemplates` runs only on the explicit
`POST /advertising/automation-rules/seed-templates`.

Prod verified after: every rule tab "Showing 0 … Rules" with badge 0 and the H10 empty state;
Automations lists only the 15 engine/observed actors; Apply Rules' Budget Rule column reads None
on all rows. From here, every rule in the account is operator-authored in the builder — ONE
shape, no engine-native/builder split in live data.

Consequence worth deciding: the W1 provenance chip + filter can now never light up (nothing
predates the cutover, and nothing ever will again). By the section's own law — a control earns
its place only if some pixel changes — they are candidates for removal; awaiting the operator.

## FB.3c — Rank & Dayparting: one bar, richer filters, evidence on top (operator asks, same day)

Four instructions, verbatim: the duplicate Filters cards; "it doesn't really give me a lot of
options"; the CPC Ceiling section "could be done better, or there is no need for it"; and the
hourly performance "has to be on the top of the page, above filters… properly wired" to the
market and range selected.

- **The duplicate bar is closed.** The schedules grain (the default) still ran `AdsDataGrid`'s
  built-in panel — `tabs/RankGoalsList.tsx` sits outside `dayparting/` and the FB.3 conversion
  never reached it. Its Status/Health/Baseline moved into the ONE module (`_rd/rdFilters.ts`),
  their state into the URL (`?status/?health/?baseline`), and the grid now takes the controlled
  trio + `hideFilterPanel`, exactly like the campaigns grain.
- **Filters that earned their place** (every one filters a fact the grid renders):
  schedules grain adds **Windows** (a schedule with no windows can never act);
  campaigns grain adds **Signal freshness** (rendered, previously unfilterable), **Ceiling**
  (Base at cap / Cap binding / Under cap / None), **Campaign status** (fetched and never used
  by anything), and **Schedule** (filter by parent group, searchable). All URL-backed; the
  round-trip is pinned in `scope.vitest.test.ts` (51 pass).
- **RdCeilings is PARKED** (unmounted, header comment). It wrote nothing, duplicated the
  Ceiling column + the `capped` tile, ignored the page scope while claiming "in scope", and
  told the operator to sort the grid. Its unique reading — base-bid-at-cap — is the campaigns
  grain's "Base at cap" filter now, scoped and one click from the rows.
- **Hourly performance leads the page again** (operator override of P0's below-the-grid
  placement), in its own `RdSection` above the filter bar. It already obeyed the header's
  market switch (`marketplace=` on `/dayparting/heatmap`); its whole-weeks window now lives in
  the URL (`?weeks=`, default 8 absent) and gains the endpoint's 26-week maximum. Honest-window
  semantics (complete weeks, today excluded, coverage stated) unchanged.
- Also: the campaigns grain's dead checkboxes removed (`selectable` with no `selectionActions`
  — a control that could do nothing); button-vocabulary baseline lowered 288 → 286 to hold the
  two idioms the conversion removed.

DS note: nothing new was hand-rolled — the added filters render through the existing shared
AdsFilterBar/H10Select kit; no new component, so nothing new to promote.

## FB.3d — the shared range picker on Rank & Dayparting; chips retired; coverage moved up (2026-08-21)

Three operator asks, verbatim: the timeframe control "should be the same as we have on the ad
manager page… divided into two parts: the calendar for two months… and the presets", used "across
everywhere possible"; "remove the chips under the filters"; and the campaigns-under-Rank-control
section "must bring it upward as well".

- **The header range picker is ON, controlled from the URL** (`?from=/?to=`, `ymdLocal` on the
  wire). It is the existing `_shell/DateRangePicker` — the H10-matched dual-month calendar +
  preset rail the Ad Manager already shows — not a new control. Default absent-from-URL window:
  56 complete days ending yesterday (the heatmap's old 8-week default). The end clamps to
  yesterday: the card says "today excluded", and a picker showing today selected would be a
  second truth.
- **The heatmap follows the range.** `hourlyCells` accepts an explicit local-date window (same
  code path: DB-clock bounds, today excluded, zero-flooring, ratios after flooring), the route
  accepts `from`/`to` (pair-or-ignored, reversed bounds swapped), and the card's own weeks
  select is GONE — one page, one range control. DPS.4b's whole-weeks law is DISCLOSED, not
  silently lost: a non-multiple-of-7 span renders "weekdays are sampled unevenly; compare cells
  with care". The `?weeks=` param (one evening old) is superseded.
- **The fleet chips are PARKED** (`RdFleetBand`). The facet lives on in the bar's Fleet state
  select — same counts, same `tileMatch` predicate, same `?tile=` store.
- **CoveragePanel moved up** into the chips' old slot (under the filter bar, above the grid) and
  its spend window follows the header range too (`days = min(90, rangeDays)`; was a hardcoded
  30).

Standing rule recorded: the `_shell/DateRangePicker` is THE range control wherever a date range
exists. Known debts it exposes elsewhere (not this unit's): the eBay digest header renders a
picker wired to nothing; CampaignsGrid keeps its own uncontrolled copy of the range beside the
header's.

## FB.3e — the drawer tells the truth; the grids converge; the count clicks through (2026-08-21)

Operator reports, closed:

- 🔴 **The money-honesty bug, proven on the operator's own row.** The drawer's "Amazon changes"
  tab (and the account-wide Change Log, a byte-identical copy) printed the RAW stored string —
  and bids are stored in CENTS. Prod probe: `bid "35" → "2"` (€0.35 → the 2¢ suppression floor),
  `dailyBudget "2.27" → "1.49"` (EUR decimals). One shared field-aware formatter now serves both
  surfaces (`_shared/changeValue.ts`: bid/defaultBid=cents, dailyBudget=EUR, PLACEMENT_*=%),
  with tests pinning the exact reported row.
- **The drawer's other honesty gaps**: a failed changes/versions fetch used to render the
  reassuring empty copy — broke and empty are separate states now; hour buckets and version
  timestamps pin to Europe/Rome (they used the viewer's browser timezone); Escape no longer
  closes the whole drawer from behind the restore confirm; the three tabs carry real ARIA tab
  semantics (panel labelling, roving tabindex, arrow keys).
- **Grid width convergence**: the schedules grain's frozen name column now wears the SAME 240px
  cap as the campaigns grain (schedule names run to 144 chars), and a 6px frozen-column overlap
  affecting EVERY selectable ads grid is fixed at its one winning rule (`.nm.fz` still pinned at
  the old 40px after the checkbox column widened to 46px).
- **The Campaigns count is a link**: click → the Campaigns view filtered to that schedule's
  members (`?grain=campaigns&schedule=…`), with every campaigns-grain filter cleared in the
  patch (set() MERGES; a leftover ?tile= would silently narrow the destination).
- **Decision columns, per the operator's call on recommendation** (control surface, not
  analytics): **ACoS 30d is VISIBLE on both grains**; Spend/Sales (+ new ROAS/Orders on
  campaigns) sit behind Customize. The campaigns grain's numbers come from the per-campaign
  half of the SAME 30d aggregation the schedules grain sums — `/rank-schedule-groups` now emits
  the `perfByCampaign` map it always computed and discarded; zero new queries, and the two
  grains cannot disagree. Both storageKeys bumped to v2 so saved layouts don't suppress the
  new defaults.

Deferred, named: the "~2¢" hardcoded floor copy in Next 24 hours (the payload carries no floor
field; needs an API addition), and the drawer confirm's focus trap.

## BP — Bid page + builder perfection, P1–P6 (2026-08-21 — SHIPPED `9da305684`, prod-verified same day)

Study + build record: `docs/2026-08-21-bp-bid-perfection.md`. Operator approved P1–P6 ("Go
ahead"), reviewed locally, then "commit and push": **shipped as ONE commit `9da305684`** (three
shared files blob-split so the SG session's WIP stayed out — and one near-miss: the first commit
swept SG's evaluator sweep-block because a diff-grep without `-a` read as clean; caught by the
tip-worktree tsc, soft-reset to the explicit parent, recommitted clean). Railway SUCCESS +
Vercel Ready on the sha, ancestry-verified. **Prod-verified by clicking:** builder typography
13.5/14/18 + connector clears the noise guard (line x=352, label x=401) + Learn gone + caps
100/10 prefilled + Rome timezone; a REAL rule created at Manual landed `enabled:true PROPOSE
control:manual windowDays:14` server-side (the arming path, live), grid showed no off-chip ·
"14 days" · "0 waiting" · no Filters card; deleted after — account restored to 0 rules. Two new operator laws recorded: new components go INTO the
design system; **100% round-trip honesty** (displayed = real reading; changed = reaches Amazon).

- **P1** — the arming path made real: a builder rule's Control step and the grid toggle now write
  `autonomyLevel` through the ONE mode route (Manual → PROPOSE+enabled · Automate → AUTO+enabled,
  409 → PROPOSE in the server's words); the ceiling went OP-AWARE (`producedActionTypes` — a
  set/raise/lower Bid rule reaches AUTO, a pausing one stays PROPOSE; pre-P1 the slug expansion
  capped EVERY bid rule). E2E-proven against the real policy code via `_bp-verify-stub.mts`.
- **P2** — the stored schedule is HONOURED (`ads-rule-schedule.ts` due-gate in the evaluator;
  B6's deferral premise died with W7); timezone default → Rome; the €100/day + 10-runs server
  defaults surfaced and prefilled ("No cap" was false copy). Learn button REMOVED (operator, same day).
- **P3** — noise guard indented clear of the IF→THEN connector; step-nav scroll fixed (memoised
  steps + instant scrollIntoView; the un-memoised array had been cancelling smooth scrolls at
  ~6px); builder typography to the console scale (13.5 base · 14 steps · 18 h2 · 15 title).
- **P4** — H10 bid grammar completed: Current Bid metric, Revenue-per-Click +
  CurrentBid×TargetACoS/ACoS actions, per-rule Lookback (7–90d, honoured by per-window context
  passes AND targetPerformance, declared once in `ACTION_WINDOW.bid`). **P4b: multi-block rules
  made TRUE** — the adapter emitted one AND-flattened block running only groups[0].action; now
  per-block conditions+action with first-matched-block-acts selection, stated in the UI.
  (Harvest/negative group-flattening left for their sessions — it only tightens.)
- **P5** — five starter Bid templates (code-shipped, editable, noise-guarded) above Saved templates.
- **P6** — dead W1 provenance filter + legacy chip removed from RulesGrid (they could never light
  post-W7); the `__ea manual` orphan suggestion DELETED on prod same day (operator's word; re-verified 0 pending).

Gates: api 4,943 ✓ (6 red = SG's uncommitted `add_negative_exact` hunk, not BP's) · web 922 ✓ ·
shared 41 ✓ · both tsc ✓ · button-vocab 286 · silent-disabled 27 · help-cursor 0 · DS ✓ · P3 ✓.
⚠ Shared-file coordination for commit day: `advertising.routes.ts`,
`automation-action-handlers.ts` and `advertising-rule-evaluator.job.ts` carry the SG session's
uncommitted hunks beside BP's — blob-split or sequence with them before `--only`.
⚠ Chrome note: current Chrome's Local Network Access policy blocks cross-port loopback
POST/PATCH regardless of CORS headers — the 2026-08-20 stub recipe's allow-methods fix no longer
suffices in hand-Chrome; local write-path verification runs through Playwright route
interception (`apps/web/scripts/_bp-e2e-local.mjs`) — and for HAND-driven Chrome, `next.config.js`
gained an env-gated `rewrites()` (`NEXT_DEV_STUB_PROXY`) proxying /api/* same-origin to the stub.

## Unit HP — Keyword Harvest perfection (2026-08-21, HP1–HP4 BUILT; LOCAL/UNCOMMITTED)

Study + build record: `docs/2026-08-21-hp-keyword-harvest-perfection.md`. Programme target 2
(after BP). Operator approved HP1–HP6; 1–5 built; the operator delegated the two decisions
("I leave it up to you") — **HP5 decided RETIRE (code done), HP6 decided
propose-path-only/no-bulk-push (deploy-day runbook, doc §7)**. Everything below is LOCAL —
batch commit on the operator's command.

- **HP1 — the wire is WHOLE.** The harvest builder collected H10's full form while the engine
  honoured a fraction. New `ads-harvest-wire.ts` (normaliser + pure predicates, 11 tests);
  the adapter's harvest branch now carries mappings→blocks, term/brand filters, dedupe and
  `bid:{mode,value}` (4 modes — 'suggested' was a €0.75 CONSTANT, now cpc-inherit), with
  harvest+negative condition groups as OR-of-ANDs sharing one THEN (5 adapter tests);
  `promote_to_exact` REWRITTEN (9 tests): scans only look=✓ groups, creates ticked types in
  mapped destinations (ASIN = named refusal), rule-group dedupe, **non-landed writes are
  FAILURES naming the gate** (the 209-of-218 mechanism), local-only rows get
  `pushExistingKeyword`. Builder hydration for bid/negate/filters (edit-save used to reset
  them silently); default criterion aligned to the ≥2-orders emit floor and the floor stated.
- **HP2 — Ad Group View is the application layer.** D-A re-decided (post-W7 every rule owns a
  real `mappings` array): assign/pause/detach edit the RULE's own mappings through one
  `patchMappings` writer; per-pathway `paused` skipped on BOTH sides of the wire; pathway
  chips + pause toggle + detach; "+ Rule" idiom unified.
- **HP3 — DS/shared.** View pill → DS `SegmentedControl`; the Add-Group popover's Products
  tab made REAL (scope-options product lines, 99 groups live) — the "coming soon" stub is gone.
- **HP5 — one engine.** The rule-less nightly `ads-auto-harvest` cron RETIRED end-to-end
  (schedule, registry, route, Automation Hub card, ACR lever + mappings, foresight row, HV
  Actors engine row, the service file) with every surface/comment that named it made truthful;
  history keeps its actor stamp. HP6 armed through the honest path only: one starter rule at
  PROPOSE post-deploy, approvals through the real gate (82/86 ENABLED campaigns allowlisted),
  152 local-only backlog NOT mass-pushed — `pushExistingKeyword` heals re-earned terms.
- **HP4 — the loop closes.** Graduation-ceiling sentence on Control BEFORE save; 3 guarded
  harvest starters; Apply/Save Template extended to harvest; live cohort strip on the rules
  view (219 harvested · 9 served · 152 local-only) linking to Suggestions; absent-not-fabricated
  on failed reads.

Gates (after HP5): api 4,975 ✓ (only SG's 6 scope-flip reds; the transient
`ebay-shared-listing-push` red resolved on the sibling's side) · web 922 ✓ · both tsc ✓ · all
five ratchets at baseline. E2E: `_hp-e2e-local.mjs` over the `NEXT_DEV_STUB_PROXY` rig — every assertion passed,
stub log shows CREATE→LEVEL(PROPOSE)→3×PATCH[actions]. ⚠ Commit day: blob-split
`automation-action-handlers.ts` (SG scope-flip ~1076) and `rules-automation.css` (SG.1 moves);
diff-audit shared files WITH `grep -a`; tip-worktree tsc before push.
