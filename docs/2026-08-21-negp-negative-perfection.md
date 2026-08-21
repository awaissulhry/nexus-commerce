# NEG-P — Negative Targeting perfection (Phase 0 study)

**Date:** 2026-08-21 · **Status:** STUDY, awaiting operator approval — no application code changed.
**Target:** `/marketing/ads/rules-automation/negative-targeting` (post-U5: the H10-shape rules grid)
and `/builder/negative-targeting`. Third target of the per-subpage perfection programme
(`project_ra_perfection_programme`; BP `9da305684` · HP `1639282ed`).

**This study builds ON, not over, the completed NEG page programme** (NEG.0–NEG.9 + NEG.X,
`docs/2026-08-13-neg-page-closing-note.md`). Three events changed its premises:
**W7** (all rules deleted — NEG.7's rules analysis describes rules that no longer exist; its open
item "bind a scope to the 7 rules" is MOOT), **U5** (the sixteen-block page reduced to the H10-shape
grid; sections parked per `docs/2026-08-16-ra-parked-sections.md` — the server-side protections all
still armed), and **BP+HP** (arming, schedules, OR-blocks, starter scaffold, the wire pattern).

## 1 · Census (2026-08-21, `_neg-p0-census.mts` + `_neg1-endpoint.mts` re-run)

| fact | value |
|---|---|
| advertising rules · negative rules | **1 · 0** (the 1 = HP's GALE DE harvest pilot) |
| negatives · blocking (target ∧ campaign ENABLED ∧ Amazon id) | **2,062 · 947** |
| protections · review marks (the 132-contradiction triage) | **10 · 0 reviewed** — still operator work |
| **candidates at the rule floor** (30d settled · spend ≥ €3 ∧ clicks ≥ 5 ∧ 0 orders) | **55 terms · €464.51** — IT 38 · DE 8 · ES 6 · FR 3 |
| pending suggestions | 4 — SG's 2 labelled test rows + **the GALE DE rule's first 2 real proposals** (landed 11:15, ~15 min after arming — the loop works) |
| `_neg1-endpoint.mts` regression | all pass except one STALE assertion — it pins "0 create logs carry evidence" and there are now **3** (NEG.X's protezioni writes, made after the script). The world moved past the pin; update the assertion |

Volume honesty: a negative rule has **5× the harvest rule's candidate volume** (55 vs ~10) and real
money attached (€464.51 wasted in 30d) — this page's automation earns its keep faster than harvest's.

## 2 · What the tab and builder already have (KEEP)

U5's H10-shape tab (grid + "+ Rule", badge = server). The builder form is **H10-complete**: Negative
Rule Setup with the mapping matrix labelled "Create New **Negative** Targets" (P/E/ASIN), Search
Terms contains/not-contains, **Brand & competitor filters** ("Never negate your own brand terms…"),
criteria (Sales = 0 default) + noise-guard chips, Negation Level (**Ad Group default**),
protectConverting ON with an editable window, dedupe, and the full BP/HP inheritance (Frequency/
Timezone honoured, caps surfaced, market scope, ceiling sentence on Control, arming on save,
edit-hydration incl. protect*/negationLevel). Engine-side: SEARCHTERM_METRIC now covers **all 11
metrics** (HV.6's 6-of-11 landmine is defused), contexts derive ACOS/ROAS/CTR/CVR/CPC with honest
nulls, condition groups translate as OR-of-ANDs (HP1), and the wasting emitter is settled-window
correct. The protections/write-gate/protectConverting rails are server-side and armed.

## 3 · The headline: the builder collects H10's whole form; the engine honours a fraction — again

The exact HP1 gap, one tab over. For each control: stored → honoured today
(`ads-rule-adapter.service.ts` negative branch, lines ~649–671).

| builder control | stored | honoured today |
|---|---|---|
| Criteria (11 metrics, OR-blocks) · caps · schedule · market scope · control | ✓ | ✓ |
| protectConverting + protectDays | ✓ | ✓ (NEG.0's reader) |
| **Ad-group mapping matrix** (look ✓ + Neg-P/Neg-E/Neg-ASIN types) | `actions[0].mappings` | 🔴 **NOTHING.** The rule acts on every wasting context account-wide (marketplace scope only) and creates only what Negation Level says |
| **Search Terms contains / does-not-contain** | `actions[0].searchTerms` | 🔴 dropped |
| **Brand exclude / competitor-only** ("never negate your own brand terms") | `actions[0].filters` | 🔴 dropped — the copy promises per-rule whitelist behaviour the engine does not perform |
| **Dedupe** | `actions[0].dedupe` | 🔴 dropped (createNegative idempotence covers same-scope duplicates only) |
| **Negation Level "Ad Group + Campaign"** | `negationLevel: 'both'` | 🔴 `NEG_SCOPE.both → 'CAMPAIGN'` — the option silently becomes campaign-only |
| Mapping circle **P** (Negative Phrase) | in `types` | 🔴 twice-dropped: mappings unread AND `add_negative_phrase` has **no handler** (open item #7 — "implement when a rule needs it"; the mapped builder now needs it, and NEG.X proved phrase value with protezioni) |
| Mapping circle **ASIN** (Negative product target) | in `types` | 🔴 unread; `createNegativeProductTargetLocal` exists (applyHarvest uses it) — wire or refuse by name |

**Plus the invisible floor (F7's analog):** the wasting emitter feeds only terms with
**spend ≥ €3 ∧ clicks ≥ 5 ∧ 0 orders** (30d settled, top 300/tick) — the builder's window note
says only "measured over the last 30 days". A rule authored `Sales = 0` alone promises terms the
emitter will never surface. H10's own default is `Sales = 0 AND Clicks ≥ 20` — stricter than our
floor, honest by construction.

**In flight next door (SG, uncommitted — compose, don't duplicate):** the `add_negative_exact`
default scope flips to AD_GROUP with fail-closed missing-ad-group and **gate-denial-as-failure**,
with tests. The adapter always sends an explicit scope, so the flip and this work are independent;
the handler file needs the same blob-split at commit as today.

## 4 · The phases (each = one approval)

| # | phase | closes | size |
|---|---|---|---|
| **NEG-P1** | **The wire** — reuse `ads-harvest-wire.ts` (same shape, near-verbatim): mappings honoured (look-allowlist gates contexts; create-types decide what is created — Neg-Exact now, **Neg-Phrase via a new `add_negative_phrase` handler** (the client path is proven — protezioni was NEGATIVE_PHRASE), Neg-ASIN wired via `createNegativeProductTargetLocal` or a named refusal); searchTerms + brand/competitor filters + dedupe honoured (`termPassesFilters` verbatim — brandExclude composes with the account protections, it never weakens them); `'both'` = BOTH writes (ad-group + campaign) or the option goes; failures loud | N1–N4 | L (engine + adapter + tests) |
| **NEG-P2** | **Floor honesty + defaults** — window note states the emitter floor and that criteria can only raise it; default criterion aligned toward H10's `Sales = 0 AND Clicks ≥ 20` shape (via noise-guard prefill); Negation Level copy carries the landing-rate fact (campaign-scope: 0 of 20 ever landed historically; ad-group: 99%) | N5 | S |
| **NEG-P3** | **Starters + strip** — negative starter templates (incl. a BidX-Blacklist recipe: contains-list + minimal criteria; a "Wasted spend" H10-default; all noise-guarded), Apply/Save Template extended to negative (today gated `isCampaign \|\| isHarvest`); an HP4-style cohort strip on the rules view (2,062 negatives · 947 blocking · 55 candidates €464 · queue link; protections → Guardrails link); absent-not-fabricated | N7, N8 | M |
| **NEG-P4** | **Arming** — decision: first negative rule (recommend the IT cluster: 38 of 55 candidates), PROPOSE, same shape as HP6 | decision | — |

**Refusals (with evidence):** H10's "Use Algorithm" toggle — an algorithm toggle without an
algorithm is a false control; our criteria + starters cover the same ground honestly. BidX's
Revive — a Bid-page mechanic, not a negation one. Resurrecting the parked sixteen blocks — U5 was
approved and the dispositions (Analytics/Suggestions/Guardrails) stand; the cohort strip carries
the page's numbers without re-expanding it. New whitelist machinery — the protections table + its
Guardrails editor already are BidX's Whitelist; the builder links, never forks.

**Also in P1's sweep:** update `_neg1-endpoint.mts`'s stale evidence assertion (0 → the measured
count with a floor, so improvement never reads as regression).

---

## 5 · Build record (2026-08-21 — NEG-P1–P3 BUILT + locally verified; LOCAL/UNCOMMITTED)

**NEG-P1 — the wire.** The adapter's negative branch now carries the WHOLE form:
`normalizeHarvestWire(a0)` (the stored shape IS the harvest wire's shape — mappings→blocks, term
filters, brand/competitor filters, dedupe) rides as `action.negative`; `levels` honours the
Negation Level select including **'both' = BOTH writes** (`NEG_LEVELS`; the old `NEG_SCOPE.both →
CAMPAIGN` silent lie is deleted); absent level defaults to AD_GROUP (the builder's default and the
level that lands). `makeAddNegativeHandler` gained the mapped wire path (positioned clear of SG's
in-flight scope hunk): look-set gates contexts (37 of 38 IT candidates correctly skipped in the
pilot dry-run), `termPassesFilters` verbatim ("never negate your own brand terms" is now a
write-path promise), protectConverting before any write, destinations = create-ticks × types
(E → NEGATIVE_EXACT · P → NEGATIVE_PHRASE via the handler that shipped at HEAD · product → a real
negative PRODUCT target via `createNegativeProductTargetLocal` when the term IS an ASIN, named
skip otherwise), per-level dedupe, one campaign write per campaign, **every landed write mirrored
locally with its audit row** (`mirrorNegativeKeywordLocal` / `createNegativeKeywordCampaignLocal`
— the NEG.X "createNegative leaves no record" defect closed on the rule path), sandbox/id-less
results are NOT landed, and `ok = failedWrites === 0`. Tests: 12 handler + 3 adapter, all green
beside SG's updated protect-converting suite (388 files / 5,009 pass on the tree).
Real-data proof (`_negp1-dryrun.mts`): IT pilot mapping → 38 candidates, 37 gated out by look-set,
1 would negate ("giubbotto moto", €3.16 · 9 clicks · 0 orders → 3 ad-group writes), zero writes made.
Also: `_neg1-endpoint.mts`'s stale "0 create logs carry evidence" pin became a ≥3 floor.

**NEG-P2 — floor honesty.** `WASTING_FLOOR` declared ONCE in `@nexus/shared/ads-rule-window`
(spend ≥ €3 ∧ clicks ≥ 5, top 300/tick) and read by all three surfaces: the evaluator's emitter
(literals replaced), the builder's window note (interpolated — cannot drift), and the strip.
Default criteria = the PAIR `Sales = 0 AND Clicks ≥ 5` via `pcDefaultGroup` (H10's default is a
pair; ours pairs the emitter floor — `newGroup` now reads pcDefaultGroup, one source). Negation
Level copy carries the landing-rate fact (ad-group ~99% confirmed; campaign 0 of 20 ever).
Dedupe toggle copy is negative-aware ("NOT re-negate … already negated at the chosen level").

**NEG-P3 — starters + strip.** Three negative starters, each pairing its zero with an evidence
floor (Wasted spend €3/5clicks · High-evidence bleeders €10/10 · Click sink = H10's own
Sales=0+Clicks≥20 bar); a bare-contains "Blacklist" starter deliberately REFUSED (an empty terms
box would negate everything) — the blacklist RECIPE is Search Terms contains + any starter, honoured
end-to-end since P1. Apply/Save Template extended to negative. The tab gained the HP4-pattern strip
from `GET /advertising/negatives/strip` (new; `getNegativesStrip` beside `getNegatives`):
**2,062 negatives · 947 actually blocking · 55 wasting terms at the rule floor (€464.51/30d)** +
Suggestions link + protected-terms→Guardrails link; absent-not-fabricated on failure.

Gates: api 5,009 ✓ (SG's suite green beside mine) · web 922 ✓ · both tsc ✓ (shared dist rebuilt)
· all five ratchets at baseline · link-targets ✓ · Playwright smoke all-pass (strip real numbers,
floor note, default pair, 3 starters applying, negative dedupe copy, level sentence, Save Template).
⚠ Commit day: `advertising-rule-evaluator.job.ts` and `automation-action-handlers.ts` carry SG's
uncommitted hunks beside mine — blob-split; `grep -a` diffs.

**NEG-P4 (arming) — decision, presented not executed:** recommend one IT pilot rule (the
IT_Auto_* family shape from the dry-run, or wider per family), PROPOSE, "Wasted spend" starter;
volume today ≈ 38 IT candidates but per-family mapping gates most — the honest expectation is a
trickle per family, matching the €464/30d picture.
