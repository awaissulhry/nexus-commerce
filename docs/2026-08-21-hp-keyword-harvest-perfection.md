# HP — Keyword Harvest perfection (Phase 0 study)

**Date:** 2026-08-21 · **Status:** STUDY, awaiting operator approval — no application code changed.
**Target:** `/marketing/ads/rules-automation/keyword-harvest` (Rules View + Ad Group View) and
`/builder/keyword-harvesting`. Second target of the per-subpage perfection programme
(`project_ra_perfection_programme`; BP shipped `9da305684`).

**This study ABSORBS, not duplicates, `docs/2026-08-20-hv-rebuild-plan.md` (HV-R).** Its P1, P2
and P3a shipped and were prod-verified — they stand. Its P4/P3b/P5/P6/P7/P8 are re-based here,
because two events changed their premises: **W7** (all 5 engine harvest rules deleted — every
future rule is builder-shaped) and **BP** (arming path, schedule due-gate, op-aware ceiling,
starter-template scaffold, multi-block translation for the campaign family — all shipped and
inherited by harvest rules automatically).

## 1 · Census (re-run 2026-08-21, `_hvr-state.mts`)

| fact | value |
|---|---|
| advertising rules · harvest rules | **0 · 0** (post-W7 clean slate) |
| `AmazonAdsSearchTerm` | 12,640 rows · fresh to D-1 |
| distinct converting queries 60d | ≥1 order **80** · ≥2 **19** · ≥3 **8** |
| 30d (the trigger's real window) | ≥1 **48** · ≥2 **10** · ≥3 **6** |
| pending suggestions | 2 — both the **SG session's own labelled test rows** ("SG.2 preview (delete me)", rule `sg2-preview`); left for that session |
| `ads-auto-harvest` cron | **82 runs, all dry** (`NEXUS_ADS_AUTO_HARVEST_ARMED` unset), last 06:30 SUCCESS |
| ad groups | 289 · sources 166 · in-enabled-campaign 56 · can-receive 77 (P3a numbers hold) |
| `AdsHarvestPolicy` / `Destination` | 0 / 1 rows (parked-era tables; nothing reads them from this page) |

Volume honesty: the trigger emits over the **30d settled window with a ≥2-orders floor**, so a new
builder rule has ~**10 candidate terms** today. Thin but real, and the numbers on screen must say so.

## 2 · What BP already fixed for this page (do not re-plan)

Arming (create → enabled at chosen mode; harvest = structural ⇒ **Automate 409→falls back to
PROPOSE**, correctly — see F6 for the missing copy) · schedule due-gate (Frequency/Timezone real) ·
starter-template scaffold (bid-only — F8) · dead provenance filter/card gone · Learn gone · builder
typography/scroll/connector. Multi-block truth shipped for the CAMPAIGN family only — harvest still
AND-flattens groups (F3).

## 3 · The headline: the wire-completeness matrix

The harvest builder is frame-verified H10 and collects everything. **The engine honours a
fraction.** For each control: stored → reader today.

| builder control | stored | honoured today |
|---|---|---|
| Rule name · caps · market scope | ✓ | ✓ |
| Criteria conditions (11 metrics) | ✓ | ✓ all translate — **but multi-group is AND-flattened; harvest groups share one THEN, so correct semantics is OR-of-ANDs** (F3) |
| **Ad-group mapping matrix** (look ✓/✗ + create-types P/E/ASIN per group) | `actions[0].mappings` | 🔴 **NOTHING.** `promote_to_exact` creates **EXACT-only, in the SOURCE ad group** (context's own ad group), scanning ALL ad groups account-wide (F1) |
| **Search Terms contains / does-not-contain** | `actions[0].searchTerms` | 🔴 dropped by the adapter (F2) |
| **Brand exclude / competitor-only** | `actions[0].filters` | 🔴 dropped (F2) |
| **Dedupe** (H10's Control toggle) | `actions[0].dedupe` | 🔴 dropped; `createKeywordLocal`'s idempotence covers only same-ad-group duplicates, not "exists anywhere in this rule group" (F2) |
| **New Target Bid: "Suggested bid"** | `bid.mode='suggested'` | 🔴 a **€0.75 CONSTANT** in the adapter — the label promises a computed suggestion (F4) |
| New Target Bid: fixed | `bid.value` | ✓ `bidEur` |
| Negate-in-source | ✓ | ✓ (`add_negative_exact`, AD_GROUP scope — the landing scope, 99% vs 0%) |
| Frequency / Timezone / Control | ✓ | ✓ (BP) |

**Plus two engine-honesty defects:**
- **F5 — success that reached nobody.** `createKeywordLocal` pushes through the write gate and
  records `reachedAmazon` in the audit — but `promote_to_exact` returns `ok:true` even when the
  gate refused and the keyword exists only locally. The execution row (and the grid's Activity
  cell) then reports a write that silences/serves nothing — the exact mechanism behind the
  historical **209-of-218 never-reached-Amazon** cohort.
- **F7 — the invisible floor.** The trigger emits only terms with **≥2 orders** (env
  `NEXUS_CONVERTING_MIN_ORDERS`), yet the builder's default criterion reads **"PPC Orders ≥ 1"** —
  a rule that promises 1-order harvesting and can never do it. The floor must be stated in the
  builder (and the default raised to match).

**F6 — the ceiling is silent in the builder.** A harvest rule is structural (creates keywords) so
Automate can never reach AUTO — the BP save falls back to PROPOSE correctly, but nothing on the
Control step says so BEFORE saving. (The bid builder's pause-action HoverCard is the precedent.)

**F8/F9/F10 — parity + shared-component items:** no starter templates for harvest (BP scaffold is
`STARTER_TEMPLATES[slug]` — add harvest archetypes incl. a **Max-ACoS-guarded** one, the column
that is "—" on every row) · the Ad Group View's toolbar says **"Rule ⧉"** where the Rules View says
"+ Rule" (jumps past the type modal) · the view pill is a hand-rolled tablist where DS
`SegmentedControl` exists · 🔴 **the Add-Group popover's Products tab is still the "coming soon"
STUB** (measured on prod today) — the exact dead-tab class the operator had CampaignSection fix,
in a private near-copy of the picker (the operator's 2026-08-21 shared-components instruction
names this pattern).

**F11 — two engines, sharpened by W7.** The nightly `ads-auto-harvest` cron
(previewHarvest/applyHarvest: 60d UNSETTLED window, **€15** negation floor vs every rule's €10,
five bid constants, disarmed × 82 runs) is now an engine with **zero governing rules** — invisible
from the rules UI it nominally belongs to. HV-R P6's "one harvest, not two" is now also "one
engine the page can SHOW".

**Premise change on an answered decision (D-A):** `AdsHarvestAssignment` was chosen because "5 of
5 rules are engine rules with no mappings field". Post-W7 that is false — every future rule is
builder-shaped and **owns a `mappings` array the builder already writes**. The Ad Group View's
Assigned-Rule dropdown can therefore edit the RULE's own mappings (one source of truth, no
migration) — with a per-pathway `paused` flag inside the mapping entry for the micro-study's
pause-one-mapping ask. Re-presented as **HP2-decision** rather than silently overturned.

## 4 · The phases (each = one approval)

| # | phase | closes | size |
|---|---|---|---|
| **HP1** | **The wire** — mappings honoured end-to-end (scan only look=✓ groups; create the ticked types — Phrase/Exact now, ASIN behind a named refusal until a product-target create path exists); searchTerms + brand filters + dedupe honoured; "Suggested bid" becomes a real computed suggestion (term's own CPC, clamped, labelled) with H10's four modes; multi-group = OR-of-ANDs; `promote_to_exact` fails loudly when Amazon did not take the write; floor stated + default aligned | F1–F5, F7 | L (engine + adapter + tests) |
| **HP2** | **Ad Group View writes** — Assigned-Rule dropdown + per-pathway pause, storage per the D-A re-decision (recommend: the rule's own `mappings`), executor reading it in the same phase; "Rule ⧉" → the "+ Rule" idiom | HV-R P3b | M |
| **HP3** | **DS + shared components** — Products tab in the Add-Group popover made REAL (scope-options product lines → their ad groups); popover converges on the shared picker's patterns; view pill → DS `SegmentedControl`; DS sheets + both themes measured | F9, F10, HV-R P5 | M |
| **HP4** | **Loop + copy + templates** — Control-step ceiling sentence for structural rules; harvest starter templates (incl. Max-ACoS-guarded and Auto→Exact-migration archetypes); Suggestions link (ruleId-keyed) + Change Log filter; the cohort strip ("N harvested 30d · M served") linking to the parked cohort's Analytics home | F6, F8, HV-R P7 | S–M |
| **HP5** | **One engine** — unify windows (settled), floors (€10 vs €15) and bids; decide the cron's fate now that zero rules govern it (retire in favour of builder rules through the evaluator, or keep as the labelled default harvester) | F11, HV-R P6 | M + decision |
| **HP6** | **Arming** — `NEXUS_ADS_AUTO_HARVEST_ARMED` / first live harvest write, with HP1's honest write path and the Suggestions approve loop as the gate | HV-R P8 | decision |

Recommended order: HP1 → HP2 → HP3 → HP4 → HP5 → HP6. HP1 first for the same reason BP's P1 went
first: it is the phase that makes what the operator authors REAL, and every later phase builds on
an honest wire.

**Refusals carried forward (on record, unchanged):** the 18 parked blocks stay parked (homes in
the U7 manifest) · `AdsDataGrid` stays (D-C) · "Of Target" column stays omitted (U7 ruling) ·
RD untouched.

## 5 · Verification method

Per phase: tsc + vitest + ratchets · the BP local rig (`_bp-verify-stub.mts` + `NEXT_DEV_STUB_PROXY`
same-origin rewrite + `_bp-e2e-local.mjs` pattern) with harvest routes added to the stub · engine
verification by evaluator-tick probe against a mem rule (mappings/filters/dedupe honoured, write
refusal surfaced) · prod click-through after the batch lands, restore-found-state discipline.
Commit mode: assumed local-first with one batch push on command, as BP — say if this changes.

---

## 6 · Build record (2026-08-21 — HP1–HP4 BUILT + locally E2E-verified; LOCAL/UNCOMMITTED)

Verified with the extended `_bp-verify-stub.mts` (harvest reads: ad-groups · harvest-pathways ·
harvest-cohort via the real services against Neon; rule writes simulated through the REAL
`producedActionTypes`+`graduationCeiling`) + `_hp-e2e-local.mjs` (Playwright over the dev server's
same-origin proxy). Full E2E transcript in the session; headline assertions:

**HP1 — the wire.** `ads-harvest-wire.ts` (normaliser + pure predicates, 11 tests) · adapter
carries the WHOLE form (mappings → blocks, term filters, dedupe, bid {mode,value}; negate-in-source
gets the same source allowlist; condition groups = OR-of-ANDs via BP's blocks — negative-targeting
too; 5 new adapter tests) · `promote_to_exact` rewritten (9 orchestration tests): scans only
`look` ad groups, creates the ticked types in mapped destinations (ASIN = named refusal), term/
brand/competitor filters, rule-group dedupe, computed bids (CPC default — 'suggested' was a €0.75
constant), **a write Amazon did not take is a FAILURE naming the gate**, and an existing local-only
row gets `pushExistingKeyword` instead of a silent no-op. `createKeywordLocal` returns
existed/denied/pushError (additive). Builder: 4 bid modes, edit-hydration for bid/negateInSource/
brand filters (never hydrated before — an edit-save silently reset them), default criterion 2 (the
emit floor, now stated in the window note), honest ASIN chip tip.
E2E: stored rule carried `mappingGroups:36 · bid:{mode:cpc} · dedupe:true` and armed
`enabled:true PROPOSE produced=[promote_to_exact]`.

**HP2 — Ad Group View writes** (D-A re-decision executed: the binding lives on the RULE's own
mappings — post-W7 every rule is builder-shaped; no new table, no migration). Assign = a look-only
source entry via ONE `patchMappings` writer; per-pathway pause = `paused` on the entry, which
`normalizeHarvestWire` skips on BOTH sides (wire test); detach removes the entry; chips with
pause toggle + detach ✕; the "+ Rule" idiom unified (type modal, was "Rule ⧉"); grid refetches on
`ads.rule.changed` from what was STORED. RuleBuilder PRESERVES `paused` through an edit-save.
E2E: assign → chip · pause → dashed-paused chip · detach → gone; three PATCHes in the stub log.

**HP3 — DS + shared components.** The view pill is DS `SegmentedControl` (the GrainSwitch
precedent; radiogroup + arrow keys, was a hand-rolled tablist). The Add-Group popover's Products
tab is REAL (scope-options product lines → their campaigns' ad groups, honest per-tab search
placeholder, working Add All) — the "coming soon" stub is gone. E2E: 99 product groups; one
product's Add mapped its ad groups.

**HP4 — loop, copy, templates.** Control step states the graduation ceiling for structural rules
BEFORE save; 3 harvest starter templates (all Max-ACoS- or noise-guarded — the guard the census
showed no rule ever carried) + Apply/Save Template extended to harvest; the cohort strip on the
rules view (from `harvest-cohort`'s census — **219 harvested · 9 served · 152 local-only** live) +
the Suggestions link. On a failed read the strip is absent, never fabricated.

**Gates:** api 4,973 ✓ (the 6 `ads-protect-converting` reds = SG's uncommitted scope-flip;
1 `ebay-shared-listing-push` red = a sibling's freshly-landed eBay commit — both verified not
ours) · web 922 ✓ · both tsc ✓ · all five ratchets at baseline.

**HP5 (one engine) + HP6 (arming) are DECISION points, presented with numbers, not built** —
see the session report. Deploy-day: hunk-audit `automation-action-handlers.ts` (SG's scope-flip
hunk still in the tree) + re-diff shared files; batch commit; prod click-through with
restore-found-state; the SG session's two labelled test suggestions ("SG.2 preview (delete me)")
are THEIRS to clean.

---

## 7 · HP5 + HP6 — decided by Claude on the operator's delegation (2026-08-21)

The operator: "For the two decisions, I leave it up to you."

**HP5 — one engine: the `ads-auto-harvest` cron is RETIRED (code done, local).** Rationale: an
engine with zero governing rules, invisible from the rules UI, negating at €15/60d-unsettled
against every rule's €10/30d-settled, disarmed for all 82 of its runs (its counted activity was
overstated ~100× — candidates processed, not writes made). Removed: the nightly schedule +
runner (`ads-sync.job.ts`), the cron-registry entry, the manual-run route, the Automation Hub
"Run now" card, the ACR lever card + CRONS entry + detail/actors mappings, the foresight row,
the HV Actors-panel engine row (with its engine-only `heldBy`/`registryDisagrees` fields,
service + web), and `ads-auto-harvest.service.ts` itself. Every stale sentence that still
claimed the engine exists — rendered copy in HvThresholds/HvActors/HvPromote and comments in
six services — now tells the truth. Historical writes keep their `automation:auto-harvest`
stamp in the audit log and cohort view. One foresight test retargeted (daily example →
coverage-engine) + a new absence assertion.

**HP6 — arming: through the honest path only; NO bulk push of the 152.** At deploy: create ONE
governing rule from the "Harvest proven winners" starter (Max-ACoS-guarded, ≥2-orders floor),
account-wide look, at PROPOSE — the structural ceiling anyway. Its actions queue on Suggestions;
each approval passes the real write gate (mode=live · campaign allowlist — measured today:
**82 of 86 ENABLED campaigns allowlisted** · €500 cap) and HP1 reports any non-landed write as a
failure naming the gate. The 152 local-only backlog is NOT mass-pushed — stale cohort keywords
at old bids fail the quality bar; HP1's `pushExistingKeyword` heals exactly the ones a rule
re-encounters at the ≥2-orders floor, and the rest stay local, correctly.
`NEXUS_ADS_AUTO_HARVEST_ARMED` was never set (nothing to unset); if
`NEXUS_ADS_AUTO_HARVEST_SCHEDULE` exists in Railway, remove it at deploy — a flag nobody reads.

Gates after HP5: api 4,975 ✓ (only SG's 6 protect-converting reds; the earlier
`ebay-shared-listing-push` red now PASSES — resolved on the sibling's side) · web 922 ✓ ·
both tsc ✓ · all five ratchets at baseline (button-vocab 286 · silent-disabled 27 ·
help-cursor 0 · DS guard 0 · P3 sweep 0).
