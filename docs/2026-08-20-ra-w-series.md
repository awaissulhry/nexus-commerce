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
