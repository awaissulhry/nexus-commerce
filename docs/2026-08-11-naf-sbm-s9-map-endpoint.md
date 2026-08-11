# NAF.SB.M-S9R — Section 9, the map endpoint: eight fields nobody reads, and a comment that names the surface that does not render it

*`GET /api/agent/fleet/map` — the single read behind the census band, the canvas,
both rails, the list, entity mode and the window.*

Code: `apps/api/src/services/agent-fleet/fleet-map.service.ts` (933 lines, 185 of
them comment), `agent-fleet-map.routes.ts`, `scripts/_sbm-map-check.mts`.

Measured against production data 2026-08-11. **No pixels: the database is this
section's browser**, and every claim below was proved by querying a second way
rather than by reading the service and reasoning about it.

**Status: BUILT AND VERIFIED ON PRODUCTION.** Parts 0–8 are the study as
approved; **Part 9 is the execution record**, including the latency figure §0.0
could not take and a parser bug that repeated Section 8's exactly.

---

## PART 0 — Phase 0: the instrument, and the six inherited raises

### 0.0 · The instrument

```
deployed API build   11220c83   (ancestor of local HEAD — prod is at or behind)
probe path           tsx → src/db.js → Neon, read-only
```

**And one instrument failure worth stating, because it produced a number I
nearly reported.** My first cost probe returned `latency_ms=20000` — a
suspiciously round figure that was a pool connect timeout, not work. A warm-pool
re-run gave `11634, 10078, 452789` ms, the last of which is a stall. **My laptop
→ Neon is not the path an operator waits on**, so no latency figure from it
appears below; §4 uses what can be measured honestly instead.

The Chrome extension disconnected part-way through, so the authenticated
round-trip could not be re-timed from the browser this session. That gap is
stated rather than filled with the local number.

### 0.1 · `spendLedgerReadable` — **SURVIVES, and it is worse than the raise says**

```ts
const spendLedgerReadable = true      // fleet-map.service.ts:723
```

A literal. It cannot be `false`. The comment above it is *sound* — `todayRows`
is inside the `Promise.all`, so an unreadable ledger throws before this line —
but that is precisely what makes the field constant.

And it is not merely constant: **nothing reads it.** It is declared on the API
type, declared again on the web type (`map/lib.ts:144`), and consumed by no
component. Section 1's *"the spend ledger could not be read"* state was designed
and never built; the field that would drive it cannot vary.

### 0.2 · `notOkWindow` from a 400-row slice — **real, but theoretical today**

`runs.window` is a `groupBy` over all matching rows; `notOkWindow` is counted in
JS from `lastRunRows`, which is `take: 400`. Two numbers on one card from two
populations.

Measured — service value against a direct `groupBy` over **all** rows:

| worker | service | direct |
|---|---|---|
| fleet-selftest | 24 | 24 |
| amazon-negative-miner | 1 | 1 |
| amazon-bid-tuner | 1 | 1 |
| *(four others)* | 0 | 0 |

**0 mismatches**, because the fleet is at **57 runs against a 400 cap** —
headroom 343. The divergence is real in principle and unreachable in practice
today. **And the cap already warns** (§0.3), which the raise did not know.

### 0.3 · "Silent caps" — **HALF DISSOLVES, and the surviving half is live**

There are four warning sites, and two of the caps are already disclosed
honestly:

| cap / failure | current value | disclosed? |
|---|---|---|
| `lastRunRows take: 400` | 57 of 400 | ✅ *"Run detail is read from the most recent 400 fleet runs; totals and costs are counted over all of them."* |
| stored wiring unreadable | not firing | ✅ warning + `wiring.degraded` |
| topological sort fails | not firing | ✅ warning + `unorderedReason` |
| `planRows take: 200` | **1** of 200 | ❌ no warning — but nowhere near |
| **`recentRuns` cap of 5** | **2 nodes capped NOW** | ❌ **no warning** |
| **`schedule` read fails** | — | ❌ **no warning, degrades to `[]`** |

The 400-run warning is a model of the thing: it says what is capped *and* what
is not. So the raise's premise — caps hidden — is wrong for the two big ones and
right for the two small ones.

**`recentRuns` is capped on production right now:** `fleet-selftest` ships 5 of
39 lifetime runs, `amazon-negative-miner` 5 of 7, and `warnings[]` is `[]`.

### 0.4 · The three-way "today" — **SURVIVES**

| | boundary | spend today |
|---|---|---|
| map (`utcDayStart`) | `2026-08-11T00:00:00Z` | $0.0000 |
| Workers roster (`setHours(0,0,0,0)`, **in the browser**) | `2026-08-10T22:00:00Z` | $0.0000 |

The operator is UTC+2, so **the two pages disagree for a two-hour window every
night**. Both currently read $0.00, so the disagreement is invisible today and
structurally present. `WorkersClient.tsx:494` computes it client-side, so it is
the *operator's* timezone, not the server's — the two can never be reconciled by
deploying anything.

### 0.5 · D5 — **SURVIVES, unchanged since day one**

```
findings with planId set:  0 of 64
```

`AgentFinding.planId` is declared and indexed and **never written**. Every edge
count still resolves through `AgentPlan.items[].findingId`. §6 proposes it to its
owner rather than taking it.

### 0.6 · The shared rollup — **SURVIVES, and the number in its own comment has moved**

`WorkersClient.tsx:297-303`, verbatim:

> *"`runs` is capped at 100 server-side (`Math.min(limit, 100)`) and is NOT
> per-worker — it is the newest 100 runs across the whole fleet. **At 47 lifetime
> fleet runs** every worker's history is fully covered; once the fleet is lit and
> runs nightly, "last run" for a quiet worker would fall off the end. **The fix is
> a per-charter aggregate endpoint**, which belongs in the API the parallel
> session currently owns — until then this is exact, and **this comment is here so
> it is noticed before it is not**."*

The fleet is now at **57**. The roster fetches **five** endpoints and joins them
in the browser. **This endpoint is the per-charter aggregate that comment asks
for** — it already computes runs, last run, findings and cost per charter with
uncapped `groupBy`s. §6 proposes it.

---

## PART 1 — The field inventory

Proved by grepping every field against `apps/web/src/app/fleet/**` in **both**
`.ts` and `.tsx`, tests excluded, **with a control first** — my first pass
restricted to `.tsx`, which excludes `lib.ts`, `overlays.ts` and `run-health.ts`
and returned a false zero for all 41 fields.

### 1.1 · Eight fields are computed, serialised, and read by nothing

| field | why it exists | reader |
|---|---|---|
| `state.spendLedgerReadable` | a degraded state that was never built | **0** |
| `wiring.unorderedReason` | the cycle's reason; its twin `degraded` has **9** | **0** |
| `nodes[].recentRuns` | comment says the inspector rail renders it | **0** |
| `nodes[].runs.notOkWindow` | the 400-slice failure count | **0** |
| `nodes[].runs.runningRunId` | deep-link to the live run | **0** |
| `nodes[].runs.runningSince` | how long it has been running | **0** |
| `nodes[].cost.todayUSD` | per-node today (state-level **is** read) | **0** |
| `nodes[].cost.inputTokensWindow` / `outputTokensWindow` | token accounting | **0** |
| `edges[].lineage` | how `crossed` was counted (`lineageNote` has **2**) | **0** |

Everything else has a reader — `halted` 18, `lastRun` 18, `open` 11, `degraded`
9, `lastCritique` 9, `totals` 9, `verdicts` 6.

**`recentRuns` alone is 28% of the payload**: 27.1 KB with it, 19.5 KB without.

### 1.2 · Two comments are wrong about the world outside this file

| comment | verdict |
|---|---|
| `:132` *"Newest first, capped at five. **The inspector rail renders these**"* | ❌ **FALSE** — nothing renders `recentRuns`; the rail imports only `ago` from run-health |
| `:275` *"§M1 **discloses the difference** rather than quietly showing a third number"* | ⚠ **STALE** — §M1's own definition still reads *"since midnight"*, unqualified. The disclosure does now exist, in S7.d's window sentence and S8.c's drawer, written days later and on different surfaces. Neither mentions the roster's different figure. |
| `:36` *"the Workers stream owns and the Workers roster calls"* (run-health) | ✅ **TRUE** — `WorkersClient.tsx:365` and `map/lib.ts:17` both call `deriveStatus` |
| `:719` *"an unreadable spend ledger throws before this point"* | ✅ **TRUE**, and it is why §0.1's field is constant |
| `:610` *"`AgentFinding.planId` … never written by any code path"* | ✅ **TRUE** — 0 of 64, re-proved |

### 1.3 · One failure path degrades where the others disclose

```ts
const schedule = await getFleetSchedule(asOf).then((s) => s.jobs).catch(() => [])
```

No warning. So **"the fleet has no scheduled jobs" and "the schedule could not
be read" render identically** — the defect class this page has removed from
every other surface, still live at the source. The same file gets it *right*
three lines of code away, for wiring.

---

## PART 2 — What the research says

**Truncation belongs in the payload, not in the reader's head.** AWS ships
`IsTruncated` on list responses; the common REST idiom is `has_more` /
`hasMoreRecords`. The map already does this well once — the 400-run warning says
both what is capped and what is not — and not at all for `recentRuns`, which is
capped today.

**Partial failure is a design choice, and this file makes it three different
ways.** GraphQL's `data` + `errors` shape exists so *"even if an error occurs
during execution, only the failed part is dropped"* — the canonical example being
a dashboard where one failing service should not cost you the other panels. The
map endpoint currently: **throws** (spend ledger), **degrades and says so**
(wiring), and **degrades silently** (schedule). Two of those are defensible; the
third is the one to fix.

**Sources:** [AWS IsTruncated](https://docs.aws.amazon.com/sdk-for-sap-abap/v1/api/latest/iam/model/_AWS1_CL_IAMLISTINSTPFLSRSP.html) ·
[Qualys pagination & truncation](https://docs.qualys.com/en/ca/api/get_started/truncation.htm) ·
[GraphQL response spec](https://graphql.org/learn/response/) ·
[Apollo — errors and partial data](https://www.apollographql.com/tutorials/apollo-kotlin-android-part2/03-handle-errors-partial-data)

---

## PART 3 — The design

### D-S9.1 · A field that cannot be false is deleted, not defended

`spendLedgerReadable` goes, from the API type and the web type. The state it
promised does not exist and cannot occur while `todayRows` sits in the
`Promise.all`. **Retiring it is a factual correction, not a feature loss** — and
it is the same rule the page applies to controls: *a thing that is not enforced
must not be rendered.*

### D-S9.2 · The comment names the surface, or the field goes

`recentRuns` is 28% of a 27 KB payload, read by nothing, under a comment naming
a renderer that does not render it. Two honest options, and the study picks:
**delete the field and the comment.** The inspector rail deliberately ends in
links to Activity, which is where run history lives — the field was built for a
panel that was designed differently.

The other unread fields split:

- **Delete**: `notOkWindow` (the only consumer of the 400-slice derivation),
  `cost.inputTokensWindow` / `outputTokensWindow`, `cost.todayUSD` (per-node),
  `edges[].lineage`.
- **Keep, and fix the reader instead**: `wiring.unorderedReason` — its twin is
  read 9 times, the warning that accompanies it is rendered, and a cycle in the
  wiring is exactly the state an operator must be able to see. **This one is a
  missing reader, not a dead field**, and the fix belongs to whoever renders
  warnings.
- **Keep**: `runs.runningRunId` / `runningSince` — a running fleet needs both,
  the fleet is off, and deleting them would have to be undone the day it is lit.
  **Marked in the type as awaiting a reader** rather than silently unread.

**This distinction is the section's judgement call**, and the study states it
plainly: *delete what the design has moved past; keep what the fleet being off
is the only reason nobody reads.*

### D-S9.3 · `schedule` discloses its own failure

One `warnings.push` in the `catch`, matching the wiring path three lines away:
*"The schedule could not be read, so no next-run times are shown."* Two lines,
and it removes the last place on this page where absence and failure look alike.

### D-S9.4 · `recentRuns`' cap, if the field survives review

If the operator would rather keep `recentRuns` for a future panel, then it warns
like the 400 does — *"Recent runs are the newest five per worker."* The study
recommends deletion, but **the cap must not stay both live and silent** either
way.

### D-S9.5 · The `$0.0000` of this section: the two "today"s

Nothing here can fix it — `WorkersClient` computes local midnight **in the
browser**, so no deploy reconciles them. What this section can do is **stop the
comment claiming §M1 discloses it**, and say plainly in the type what the field
means: `todayUSD` is a **UTC** day, and the Workers roster's figure is not.

Whether the roster should change is the Workers stream's call, and §6 puts it to
them with the measurement.

### D-S9.6 · Every correction gains a check that fails first

`_sbm-map-check.mts` was written by the same person who wrote the bug, and its
13 checks did not catch `everCrossed`. Section 8 shipped two tests that were
*seen to fail* before they passed; the same here:

1. **No unread field.** Every leaf of the payload type must be referenced in
   `apps/web/src/app/fleet/**` — the exact check that finds all eight above, and
   the one that would have found `recentRuns` on the day the rail was built
   differently.
2. **No comment naming a renderer that does not render.** For each comment of
   the form *"the X renders these"*, assert X references the field.

Both are greps over the tree, both fail against today's `main`, and both are the
`teaching.vitest.test.ts` pattern pointed at the payload instead of the prose.

---

## PART 4 — What the endpoint costs

First figures ever recorded for this endpoint.

| | |
|---|---|
| queries per read | **≈36** (107 across three reads) |
| payload, 7d | **27.1 KB** — 7 nodes, 4 edges |
| payload without `recentRuns` | **19.5 KB** — **28% is unread** |
| network floor, same host | ~0.4–1.3s (401), ~1.5s (`/api/health`, 200) |
| authenticated round trip | **not measured this session** — see §0.0 |

The ~36 queries are dominated by `getEffectiveWiring`'s per-workflow revision
reads — the `2N+2` shape the brief names. At 4 workflows that is cheap; it is
listed so the next person has a baseline rather than a guess.

---

## PART 5 — Honesty rules and degenerate states

- **A field that cannot be false must not exist.** §0.1.
- **Absence and failure must never render alike.** §1.3 is the last violation on
  this page.
- **A cap that is live must be disclosed.** The 400 warning is the model.
- **A comment is a claim.** §1.2 marks each true/false/stale, and D-S9.6 makes
  two of those classes testable.
- **Degenerate — the fleet is off.** Four unread fields are unread *because*
  nothing runs. That is a reason to mark them, not to delete them, and the study
  says which is which.
- **Read-only.** Unchanged; the endpoint performs no writes and gains none.

---

## PART 6 — Two proposals for other streams, with their exact text

Neither is taken here. Both go in the locks doc.

**To whoever owns `agent-executor.ts` — D5, five years of one line:**

> `AgentFinding.planId` is declared and indexed on the model and **written by no
> code path** — re-proved 2026-08-11, 0 of 64 findings have it set. Every
> finding→plan edge on `/fleet/map` therefore resolves through
> `AgentPlan.items[].findingId`, the same join `scorecard.service.ts` runs. The
> fix is one assignment in the executor's plan branch. The map does not need it —
> the join is exact for what the director kept — so this is **a correctness tidy,
> not a request**, and the map will keep working either way.

**To the Workers stream — the aggregate endpoint your own comment asks for:**

> `WorkersClient.tsx:297` says *"the fix is a per-charter aggregate endpoint …
> this comment is here so it is noticed before it is not."* It has been noticed.
> The fleet has moved **47 → 57 runs** against your fleet-wide `limit=100`, and
> `/api/agent/fleet/map` already computes per-charter runs, last run, findings
> and cost with **uncapped `groupBy`s** — the roster's five browser-side fetches
> could become one. **Nothing is asked of you**; if you want it, say so and the
> map stream will factor the aggregate out rather than have you re-derive it.

---

## PART 7 — What this section must never become

- **Not a write path.** D3 stands.
- **Not a second status derivation.** `run-health.ts` is shared and correct;
  comment `:36` is one of the true ones.
- **Not a general-purpose fleet API.** It answers one page's question in one
  read. The Workers proposal above is an *offer to factor*, not a mandate to
  generalise.
- **Not a place to delete a field because the fleet is off.** §D-S9.2's split
  exists precisely to stop that.

---

## PART 8 — Build order

| phase | change | exit criterion |
|---|---|---|
| **S9.a** | `schedule` failure pushes a warning (D-S9.3) | forced failure produces a warning, not an empty list |
| **S9.b** | retire `spendLedgerReadable` (D-S9.1) | gone from both types; no consumer breaks |
| **S9.c** | delete `recentRuns` + its false comment (D-S9.2) | payload 27.1 → ~19.5 KB; eight surfaces still verified |
| **S9.d** | delete the four other dead fields (D-S9.2) | `tsc` clean; no web change needed |
| **S9.e** | mark `runningRunId`/`runningSince`/`unorderedReason` as awaiting a reader | comments say so; fields retained |
| **S9.f** | correct the two wrong comments (§1.2) | `todayUSD` says UTC; no comment names a non-renderer |
| **S9.g** | the two tests (D-S9.6) | both **seen to fail** on today's `main`, pass after S9.b–S9.f |

`S9.a` first: it is the only change that alters what an operator can be told,
and it is two lines.

**S9.g last and seen to fail first**, for the reason Section 8 gave: a test
written after the fix that has never failed is a test nobody knows works.

---

---

## PART 9 — The execution record

### 9.1 · Measured on production, after deploy

| | before | after |
|---|---|---|
| payload, 7d | 27.1 KB | **18.9 KB (−30%)** |
| fields read by nothing | 9 | **3, each marked and argued** |
| `schedule` read fails | `[]`, silent | **`[]` + a warning** |
| comments asserting a non-fact | 2 | **0** |
| **round trip, browser → prod** | never recorded | **3,911 ms** |

**The latency figure §0.0 refused to guess at.** My local probe gave `20000ms`
(a pool timeout), then `11634 / 10078 / 452789`. None of those was the endpoint;
they were my laptop's path to Neon. The real number — 3.9s from the browser to
Railway — only became measurable when the Chrome extension reconnected. Stating
the gap instead of filling it was worth four hours of not having the number.

### 9.2 · The eight shipped surfaces, re-verified after six fields were removed

The hard constraint of this section. Verified after deploy, on production:

| surface | state |
|---|---|
| census band | halt sentence, spend, open findings ✓ |
| canvas | 7 cards, `3 runs · 5 open · $0.11 spent` ✓ |
| edges | 4 drawn, `7 carried` / `blocked` ✓ |
| inspector rail | renders on selection ✓ |
| list | 7 rows ✓ |
| entity mode | 111 rows, band agrees ✓ |
| window + denominator sentence | S7.d present ✓ |
| console | **0 errors** |

### 9.3 · Both tests were seen to fail first

```
S9.a   against main    1 failed | 2 passed
S9.g   pre-deletion    6 failed | 76 passed
       after           76 passed
whole apps/api suite   351 files | 4484 tests, green
```

### 9.4 · My parser had Section 8's bug, three days later

S9.g/1's first cut sliced from `export interface MapNode` to end-of-file and
reported **`where`, `select` and `tool`** as unread payload fields — two Prisma
query keys and a member of a local `PlanItem` interface, none of which the
browser ever sees. Section 8's glossary-key parser failed in the identical way,
for the identical reason, and I had written the guard against it myself.

The parse is bounded to the three exported interfaces now, and the first `it()`
asserts those three names never reappear.

### 9.5 · The test forced two exception sets into the open, which is the point

Neither existed as a concept before the test demanded one:

- **`AWAITING_A_READER`** — `unorderedReason`, `runningRunId`, `runningSince`,
  `asOf`, `modelProvider`. Unread because the fleet is off or the reader was
  never built, **not** because the field is dead.
- **`MUST_NOT_BE_RENDERED`** — `scopePortfolioIds`, `scopeCampaignIds`. Stored,
  accepted at create, merged onto the charter, and enforced by no query, filter
  or prompt. **A reader for these would itself be the defect**, under
  `scope-filter.ts:6-7`.

A test that had simply demanded "every field has a reader" would have been wrong
about seven fields. Being forced to say *why* each one is exempt is the durable
half of this section.

### 9.6 · What was deliberately not taken

Both proposals are posted to the locks doc §5 as rows 8 and 9 and neither is
acted on: D5's one-line write in `agent-executor.ts`, and the per-charter
aggregate the Workers roster's own comment asks for. The map keeps working
either way, which is exactly why an audit of a read-only endpoint should not be
the thing that changes the shared execution path.

---

*Measurements: production data, 2026-08-11. Field readership proved across `.ts`
and `.tsx` with a control. Latency deliberately not claimed — see §0.0.*
