# ER3.2 — Rules & Automation hub (`/marketing/ads/ebay/automation`)

Mini-spec per the ER master prompt Part VIII (double gate). Sources: CURRENT-STATE-CRITIQUE §2.6
(severity **High**: "rules are opaque… no rule editor exists"), COMPETITOR-TEARDOWN verdicts
tagged "ER3 hub" (H10 Suggestions-queue idioms; Pacvue benchmark-relative conditions — with
break-even as the benchmark nobody else has), DECISIONS.md D-3 (page keeps the name
"Rules & Automation").

**Ground truth that shapes this spec** (verified in code, 2026-07-03):

- `EbayAdsRule` already stores structured `trigger` (`{scope, all: [{metric, windowDays, op,
  threshold}]}`), `action` (`{type, …params}`), `guardrails`, `scope` (campaignIds) — and
  `candidatesForRule()` genuinely evaluates them (9 metrics × 4 ops × 2 scopes × 7 action
  types). A rule editor is therefore **pure UI + endpoint work. No migration.**
- `evaluateEbayAdsRules(onlyRuleId?)` already accepts a single-rule filter; the route never
  passes it.
- **Reject is dismiss-once**: on the next evaluation the upsert flips a REJECTED proposal
  straight back to PENDING (service line ~331). There is no snooze / stop-suggesting — the
  exact H10 queue idiom the teardown says to adopt.
- `EbayAdsProposal.expiresAt` exists on every row but is only meaningful for PENDING;
  `estimatedImpact` exists and is never populated.
- The v1 page is a 226-line single file (X1 monolith) with 4 tabs and one cramped posture row.

---

## The 10 deltas

**1 · C1 structure** — dissolve `EbayAutomationClient.tsx` into folder-per-page:
`EbayAutomationHub.tsx` (shell: header, posture band, tabs) + `tabs/RulesTab.tsx` /
`SuggestionsTab.tsx` / `AppliedTab.tsx` / `DriftTab.tsx` + `_lib/rules.ts` (DSL types, metric/
action label maps, sentence renderer) + routed editor (delta 3). ER# file headers (C13).

**2 · Glass-box rule cards** (critique: "trigger/action/guardrails invisible and uneditable").
Each rule renders as a card: enable toggle + name + mode pill (PROPOSE↔AUTOPILOT, click-to-
toggle stays) + **the rule itself in sentences** — "When, over the last 14 days *(excluding
the last 3)*: ad fees > 20% of sales AND sales > €0 → step the ad rate −15% (floor 2%,
never above break-even) · cooldown 24h" — + scope pill (`Global · EBAY_IT` or `3 campaigns`,
matching the ER3.1 ⚙ column source `scope.campaignIds`) + last-run counts + row menu:
**Edit · Duplicate · Run now · Delete**. "Run now" = per-rule evaluate (wire the existing
`onlyRuleId`). Empty state keeps the starter-pack CTA.

**3 · Routed rule editor** — `automation/rules/new` (+ `?template=` prefill) and
`automation/rules/[ruleId]`, following the Amazon builder-as-route idiom (not a modal).
Sections on `.h10-cd-sec` cards:
- **Name** (with suggest-grammar chip, as ER2 Setup).
- **Scope**: marketplace + Global ↔ specific campaigns (multi-select with status/strategy
  shown; CPS rules list CPS campaigns, CPC rules CPC).
- **Trigger**: scope selector (CPS ads / CPC keywords) + **condition stack** — AND rows of
  `metric · window (days, + "exclude recent days") · op · value`, where value is either an
  absolute threshold **or a benchmark × multiplier** (delta 4). Add/remove rows; ≥1 required.
  AND-only by design — OR = duplicate the rule (recorded decision, keeps the evaluator's
  fail-safe semantics).
- **Action**: type picker filtered by scope (rate step / rate→break-even×factor / pause /
  reactivate / alert · keyword pause / bid-down) with its params and floors inline.
- **Guardrails** (display + edit of the JSON knobs the engine honours; break-even clamp is
  shown as always-on, not editable — it's the write layer's law).
- **Cooldown** hours.
- Footer: Cancel / **Preview matches** (delta 5) / Save (create disabled+PROPOSE; edits keep
  enabled state). Validation: known metric/op/action, windowDays 1–90, excludeRecentDays 0–7
  (< windowDays), numeric thresholds, multiplier 0.1–10, params within eBay bounds (rate
  2–100).
- Templates: the 6 starter archetypes + Blank, as chips on `rules/new` — same grammar as the
  ER2 chooser's template chips.

**4 · Benchmark-relative conditions** (Pacvue adopt; **beat**: break-even benchmark). Additive
DSL: `Condition` gains optional `benchmark?: 'account_avg' | 'campaign_avg' | 'break_even'`
and `multiplier?: number` — effective threshold = benchmark value × multiplier; absent ⇒
absolute threshold exactly as today (starter rules untouched, backward compatible).
`account_avg`/`campaign_avg` = same metric aggregated over the same window across the
account / the entity's campaign; `break_even` is valid only for rate-family metrics on CPS
scope. Non-computable benchmark (no sales, no BE) ⇒ condition returns null ⇒ fail-safe skip,
same as today. Unit tests on `evalCondition` cover all three benchmarks + null paths.

**5 · Dry-run preview** — `evaluateEbayAdsRules` gains `dryRun` (no proposal writes, no
cooldown/lastEvaluatedAt bumps; execution row status `DRY_RUN` — the enum comment already
reserves it). The editor's **Preview matches** posts the *unsaved* rule body to a preview
endpoint and shows "N evaluated · M would match" + the first 10 matches (entity, the facts
that fired, the clamped to-value). Pacvue/H10 have nothing like it.

**6 · Suggestions queue** (H10 adopt: ✓ / ✕-snooze / ⏸ + Apply-N). Approvals tab becomes
**Suggestions**: kind chip-row with counts (rate steps · pauses · reactivations · keyword
actions · alerts · discovery) filtering the grid; per-row **Why** expando rendering
`reasoning` honestly (rule name → link, window, the facts, each condition pass/fail, clamp
note); campaign deep-link on every row; per-row ✓ **Apply** and ✕ menu — **Dismiss (may
re-suggest next run)** · **Snooze 7d** · **Snooze 30d** · **Stop for this target** — plus the
existing bulk bar renamed **Apply N changes** / Dismiss N. Snooze/stop = decide endpoint
gains `snoozeDays?` → REJECTED with `expiresAt = now + days` (stop = +3650d); the evaluator
skips matched candidates whose existing proposal is REJECTED with future `expiresAt`
(**reuses the existing column on rows where it was meaningless — no migration**; plain
dismiss keeps today's re-propose behaviour, now stated honestly in the UI).

**7 · Applied tab → grid** (critique: no timestamps, no pagination). AdsDataGrid: When
(timestamp) · Rule · Target (campaign link + entity) · Change (from→to) · Result
(appliedResult detail / clamp) · Actor (rule-autopilot vs operator) · Rollback button.
Pager + kind filter via the grid's built-ins.

**8 · Posture band decompression** (critique: one cramped flex row). Three `.h10-cd-sec`-style
segments in one band: **Posture** (Off/Suggest/Auto dial + one-line meaning + halted banner
state) · **Monthly ceilings** (per-marketplace chip + inline edit, MTD % bar) · **Kill
switch** (halt/resume + last halt reason). "Evaluate now" stays in the header. Add the
missing digest cross-link ("Weekly digest →") in the band footer.

**9 · Drift tab** — verified live in E-series; **structural lift only** into
`tabs/DriftTab.tsx`, rendering unchanged (Re-apply / Accept semantics untouched).

**10 · API surface** (all additive, `/api/ebay-ads` namespace, RBAC as the existing routes):
- `GET  /automation/rules/:id` (rule + last 10 executions) — editor load.
- `POST /automation/rules` — extended to accept + **validate** scope/guardrails (today it
  accepts unvalidated trigger/action only).
- `POST /automation/rules/:id` — extended: name/trigger/action/guardrails/scope/marketplace/
  cooldownHours (same validation); enabled/mode behaviour unchanged.
- `DELETE /automation/rules/:id` — executions cascade (FK), proposals keep `ruleId` string
  (history survives).
- `POST /automation/rules/preview` — dry-run an unsaved rule body (delta 5).
- `POST /automation/evaluate` — pass through existing `ruleId` for per-rule Run now.
- `POST /automation/proposals/decide` — `snoozeDays?` (delta 6).
- Evaluator: benchmark + excludeRecentDays support (deltas 4/11-below) with unit tests.

Plus **window honesty** folded into the DSL work: optional `excludeRecentDays` per condition
(default 0 = today's behaviour; templates default to 3 for fee/sales metrics, citing eBay's
72-hour attribution reconciliation) — `factsFor` honours the shifted upper bound.

## Non-negotiables honoured

- **No migration.** Everything rides existing columns/JSON. Rollback = revert the commit.
- **Amazon untouched.** No shared-file edits planned this phase (AdsDataGrid used as-is; the
  hub already has its own CSS in `ebay.css`). If build reveals a needed shared tweak, it
  follows the ER3.1 pattern: additive prop + identical-after snapshot.
- **Guarded writes only** — apply/rollback/repair paths unchanged; the editor writes rule
  *definitions*, never eBay state.
- **No fake data** — preview runs the real evaluator; Why panes render real reasoning.
- Rule-config edits are traced by `updatedAt` + execution history only; full rule versioning
  is out of scope → Findings/backlog (the audit table is campaign-scoped; rules are global).
- `estimatedImpact` stays unpopulated — surfacing it honestly needs fee-delta modelling →
  backlog, not fabricated.

## Verification script (gate 2)

Smoke (`_er32-smoke.mts`): create rule via API (benchmark condition + excludeRecentDays) →
GET :id → preview dry-run returns counts and writes NO proposals → edit thresholds → per-rule
evaluate creates proposals → snooze 7d → re-evaluate → **no re-propose** → plain dismiss →
re-evaluate → re-proposes → delete rule (executions gone, proposals retained). Unit tests:
`evalCondition` benchmark×3 + null paths + exclude-window maths. Prod click-through: starter
card sentences match their JSON; editor round-trip (open → edit condition → preview → save →
card sentence updates); Suggestions Why expando + snooze menu; Applied grid timestamps +
rollback; posture band segments; drift unchanged; Amazon `/marketing/ads/rules-automation`
before/after identical (untouched — snapshot anyway); `tsc` + builds green.

## Rollback

Single revert (no migration, no shared-file edits). Snoozed proposals degrade gracefully on
revert: REJECTED rows with future `expiresAt` are simply re-proposed by the old evaluator.
