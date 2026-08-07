# NAF.SB.W — Can anything spend while the fleet is off?

**Answer: no, and it is measured rather than argued.** Operator constraint
2026-08-07: *"all the workers must be off. I do not plan to spend as of now."*
This is the audit behind that, re-runnable from the scripts named at the end.

---

## 1 · The state right now

| | |
|---|---|
| Charters with a settings row | **7 of 7** (`fleet-auditor` seeded 2026-08-07 — see §5) |
| Charters not OFF | **none** |
| Fleet halted | no |
| Fleet daily ceiling | $2.00 |
| Lifetime fleet spend | $0.3787 across 47 runs |

---

## 2 · Where spend is gated, and how early

`executeCharter()` — the single entry point for every fleet run — checks the
dial **first**, before it writes a run row, before the kill switch, before the
budget guards, and long before any model call:

```ts
const effectivelyOff = !charter.enabled || charter.autonomyLevel === 'OFF'
if (effectivelyOff && !opts.ignoreEnabled && !opts.preview) {
  return { runId: null, ok: true, skipped: 'disabled' }   // the dark ship
}
```

Everything scheduled reaches the model through this function:

- `fleet-sweep` cron → `runFleet('sweep')` → orchestrator → `executeCharter(key, {trigger:'schedule'})` — **no bypass flag**
- the nightly auditor → `executeCharter('fleet-auditor', {trigger:'schedule'})` — **no bypass flag**
- `fleet-council` cron → `runFleetCouncilOnce()` → `runFleet('council')` → same orchestrator, **no bypass flag**

Both crons are gated on the same env var, `NEXUS_ENABLE_FLEET_SWEEP_CRON`, and
it is set on production — the sweep runs at `45 4 * * *`, the council at
`15 5 * * 1`.

**And it is enabled, and it costs nothing.** The sweep fired on 2026-08-07 at
04:45 and recorded:

```
started=6 ok=0 failed=0 skipped=6 reclaimed=0 graded=0 scorecards=14
graph[VARIANT_OF:0/0 TARGETS:3285/0 SHARES_INVENTORY:2530/0 …] demoted=0
audit=skipped cost=$0.0000
```

Six charters, six skipped, **$0.00** — while still doing all the deterministic
work: 14 scorecards recomputed and ~5,800 entity-graph edges reconciled. That is
the "double-dark by construction" design working, observed rather than assumed.

---

## 3 · The three controls that DO ignore the dial

By design — it is how you test a worker without granting it anything — and
therefore the only way to spend on a dark fleet:

| Path | Flag | Reached from |
|---|---|---|
| `POST /agent/fleet/run/:key` | `ignoreEnabled: true` | the worker page's **"Run it now"** |
| `POST /agent/fleet/charters/:key/preview` | `preview: true` | Charter Studio preview |
| `charter-eval.service` | `preview: true` | Charter Studio "evaluate" / A-B |

None of them fire on a schedule. All three require a human click or a script.

**"Run it now" fired immediately, with nothing said about cost.** With the fleet
deliberately dark that was the likeliest way to spend by accident, so it now
asks first and states the ceiling — see §5.

---

## 4 · The $0.21 that looked wrong, and was not

The last 24 hours showed **$0.2126 across 4 runs while every charter is OFF** —
more than half of all spend the fleet has ever done. Two of those runs carried
`trigger: schedule`, which reads like a cron spending on a dark fleet.

It is not. The timestamps settle it:

| | |
|---|---|
| `amazon-ads-director` and `plan-critic` created | 2026-08-06 **19:52** |
| council runs, $0.1944 + $0.0182 | 2026-08-06 **19:54** and **19:57** |
| both charters' `updatedAt` (switched OFF) | 2026-08-06 **19:57** |

A prior session created those two charters enabled, ran one supervised council,
and switched them off — the runs are bracketed exactly by the create and the
disable. `trigger: schedule` is what the council *service* stamps on its runs,
not proof a cron fired: there is **no `CronRun` row for `fleet-council`**, so it
was invoked directly by a script.

The other two runs were `mode: preview` at $0.0000.

And the check that matters: the most recent *actually scheduled* execution — the
sweep at 04:45 the following morning — skipped all six and cost nothing.

---

## 5 · What this audit changed

1. **`fleet-auditor` is seeded.** `seedCharters()` is create-if-absent and
   writes `enabled: false, autonomyLevel: 'OFF'`, so this started nothing and
   spent nothing. All seven workers now have a settings row; the roster's
   *Not set up* state is correctly empty. Verified after: *"none — the whole
   fleet is still dark."*
2. **"Run it now" asks first.** A `ConfirmSpend` dialog states that the worker
   is switched off, that this runs it anyway, that the run is billed, and what
   the daily ceiling is ($0.10 for the negative miner). Verified: clicking the
   button now issues **zero** POSTs until confirmed, and Cancel issues none.
3. **The autonomy confirmation states the money.** Raising workers above OFF now
   says *"this lets those 5 spend up to $0.60 a day on AI between them — a
   ceiling the server enforces before each run, not a forecast."*
4. **A latent styling defect fixed on the way.** The legacy worker route
   (`/marketing/ads/rules-automation/fleet/worker/[key]`, still reachable —
   SB.7 deliberately did not redirect it) imports only `control-room.css`, and
   the confirm's classes live only in `fleet-pages.css`. The dialog would have
   rendered completely unstyled there while looking correct on
   `/fleet/workers/[key]`.

---

## 6 · What would have to happen for money to be spent

All four, deliberately:

1. Someone raises a worker above OFF — which now confirms, names every worker,
   and states the daily total it authorises; **or** clicks Run it now / preview
   / evaluate, which now confirms and states the ceiling.
2. The fleet is not halted (`AgentFleetState.halted`).
3. The AI kill switch is off (`NEXUS_AI_KILL_SWITCH`).
4. The charter's daily budget and the $2.00 fleet ceiling both have headroom —
   checked before the model call, and a run past either is refused, not
   truncated.

Nothing on a timer can satisfy (1).

---

## Re-running this

```
apps/api/scripts/_sbw-spend-audit.mts    # cron history, lifetime + 24h spend, any charter not OFF
apps/api/scripts/_sbw-spend-audit2.mts   # what spent recently, and by which trigger
apps/api/scripts/_sbw-spend-audit3.mts   # charter state with createdAt/updatedAt
apps/api/scripts/_sbw-seed-auditor.mts   # create-if-absent seeding; writes OFF rows only
```

All read-only except the seeder, which only creates missing rows switched off.
