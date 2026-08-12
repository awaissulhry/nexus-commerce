# RA.SPINE — the shared layer for eleven pages

**Date:** 2026-08-12
**Surface:** `/marketing/ads/rules-automation/*` — the shared layer only. **None of the eleven pages
was built or changed.**
**Status:** S1, S2, S5 shipped and prod-verified. S3 shipped its redirect half. **S4 not built.**
**Landed:** `707ec5401`, on `origin/main`, deployed and verified on production.

Read with: `2026-08-11-substrate-spec.md` **§0.0** (the corrections this session wrote back) and
`2026-08-10-ra-session-locks.md` **§4** (the two hand-offs).

---

## 1 · The one-paragraph version

The specification asked for a substrate to be built before the eleven pages. That is not what
happened: ten routed pages shipped first, and by the time the substrate was written **most of what
the spec asked for already existed, one page at a time**. So this session was mostly extraction. It
promoted what the page sessions had converged on, corrected six things the spec got wrong — two of
them because a page session had already found a better answer — fixed the one thing nobody owned,
and deleted one dead file. It did not touch the tab bar, because the stylesheet it needs was held by
other sessions for the whole session.

---

## 2 · What was EXTRACTED vs what was BUILT

The distinction matters, because extraction carries a promise that construction does not: **every
page must behave identically afterwards.**

| | unit | extracted from | genuinely new |
|---|---|---|---|
| **S1** | `_shared/adsScope.ts` — parse · normalise · round-trip · sentinel | `budget-schedules/urlState.ts`, wholesale | the **market policy** split (below) |
| | `resolveScopeReach` (client) | `automations/ScopeForm.tsx:93`, which had it right | `writable` as `number \| null` |
| | the date adapter | `placement/PlacementClient.tsx`'s rule | the `PICKER_TO_SERVER` table itself |
| | `grainAvailability` | — | ✅ all of it |
| **S2** | the cursor contract | `useCursorPoll.ts`'s own header, ~90% written by BUD.1 | the `enabled` guard's two documented uses |
| **S3** | eleven `?tab=` redirects | ten hand-written literals in `next.config.js` | `rulesTabRoutes.cjs` + the two-way guard |
| **S5** | `showMarket` · `scopeMarket` | — | ✅ both |

**Nothing in the "extracted" column changed a page's behaviour, and that is proved rather than
asserted**: `budget-schedules/urlState.vitest.test.ts` is **byte-unmodified** and still passes, and
the same nine URL cases were re-run against production after deploy (§5).

### 2.1 The one design decision worth arguing about

The spec said one hook owns market. Seven pages default to `'all'`; **Keyword Tracker and Share of
Voice default to `'IT'` — and they are right.** Both derive a share from `SearchQueryPerformance`,
which is reported per marketplace; summing four markets into one "share" produces a number that is
not a share of anything.

So the module does **not** own the default:

> **The module owns the mechanism and the URL contract. The PAGE declares its market policy.**

A page states whether `'all'` is meaningful for it (`MARKET_ANY` vs `marketOne('IT')`); the module
enforces the parse, the normalisation, the round-trip and the sentinel. Flattening nine defaults
into one would have broken the two that were correct — which is the general shape of the risk in
this whole session, and the reason every spine param past the four grains is **opt-in**: adopting
the module cannot give a page a `?q=` or `?sort=` it never had.

---

## 3 · What was measured

### 3.1 The divergence, re-counted (the spec said seven)

| | count | detail |
|---|---|---|
| `DEFAULT_MARKET` declarations | **9** | across 8 files |
| markets held in `useState`, **not in the URL at all** | **2** | `AutomationsClient:61`, `RulesAutomationClient:100` |
| **total market declarations** | **11**, in 10 files, **3 not linkable** | |
| client-side copies of the reach intersection | **4** | `ScopeForm` · `BidScopeBar` · `BudgetScopeBar` · `PlacementScopeBar`, against one server `resolveScopeReach` |
| hand-written `?tab=` redirect literals | **10** | four of them added *during* this session by SOV.1 |

### 3.2 The tab bar, re-measured on production

PLC.0 measured **388px** of overflow at `innerWidth 1380`. That was a *before*-number and it has
moved twice since — `rules` became the eleventh routed tab, and BUD.1/BSP.0 relabelled two tabs
("Budget Rules", "Budget Pacing & Schedules"). Re-measured on prod 2026-08-12 through a **same-origin
iframe** (a real viewport, so media queries fire — narrowing an element would have invented a
different answer):

| innerWidth | scrollWidth | clientWidth | **overflow** | scrollLeft | active tab visible? | body overflows X? |
|---|---|---|---|---|---|---|
| 1280 | 1684 | 1154 | **530px** | 274 | ✅ | ❌ no |
| **1380** | 1684 | 1254 | **430px** | 174 | ✅ | ❌ no |
| 1440 | 1684 | 1314 | **370px** | 114 | ✅ | ❌ no |
| 1728 | 1684 | 1602 | **82px** | 0 | ✅ (fits) | ❌ no |

Two things this settles for whoever takes S4:

- **PLC.0's correctness fix works.** At every width the active tab is inside the bar, and at 1728 it
  correctly does nothing. The remaining problem is *discoverability*, not reachability — which is
  what the edge fade and the clusters are for.
- **430px, not 388**, is the number to design against, and it will move again when separators and
  fades land. **Measure before and after.**

---

## 4 · Six corrections carried back into the spec

Written into `2026-08-11-substrate-spec.md` **§0.0**, with in-place pointers at §1.3, §2.1 and §2.2.

1. **`GET /advertising/pulse` is withdrawn — falsified, not superseded.** `max(AdTarget.updatedAt)`
   and the newest `AdvertisingActionLog` row were **134 minutes apart**: `ads-keyword-bid-resync`
   writes `bidCents` from Amazon's value and leaves no ledger row. A ledger cursor would have
   reported "nothing changed" through every bid edit made in Seller Central. The poll survives; the
   *single shared* cursor does not.
2. **§7's phase order is overtaken.** The receipt is §3.1's table. The honest revision is not
   "substrate must come first" but **"a shared module is worth extracting on its second copy, not
   its eleventh"**.
3. **§6's "three broken tabs" is superseded** by HV.1's derived `RULE_TAB_ACTION_TYPES`, which fixes
   a defect the spec did not know about — `RuleBuilder.tsx:499` writes the builder's URL slug as an
   action type, so the first rule created in the builder would have been invisible on the tab it was
   created from.
4. **§2.1's tab-key rename is superseded, and AR.S0's answer is better.** The spec said "only two
   places read `rules`". Four do. AR.S0 added an optional `path?` instead of renaming the key, so
   every other tab's href is byte-identical.
5. 🔴 **§3.1.7's reach claim is wrong.** `scope-options` carries **no write-gate field at all** — the
   gate is a second endpoint (`control-room/guardrail-grid`). So `ScopeReach.writable` is
   `number | null`, and **`null` means "not known here" and must never render as `0`**: the entire
   point of two numbers is that "reaches nothing" and "not permitted to write" must not read the
   same, and a fabricated zero recreates exactly that collision.
6. 🔴 **The date-vocabulary count is wrong.** The brief said three picker keys have no server
   equivalent. **Seven of fifteen map; eight do not** — `thisWeek` (Sunday vs Monday-ISO `wtd`),
   `last12m` (trailing year vs `last_year`'s calendar year), and `lastWeek` · `last3m` · `last18m` ·
   `last24m` · `lastQuarter` · `latest60`, which have no server preset at all. Forwarding one hits
   `resolveRange`'s `default:` and returns **seven days under whatever label was picked**.

---

## 5 · Verification

- **127 tests.** 46 new (`adsScope`), 13 new (`rulesTabRoutes`), 68 pre-existing in
  `budget-schedules` — of which `urlState.vitest.test.ts` is **unmodified**, which is what makes it
  evidence rather than intention.
- `tsc --noEmit` clean across `apps/web`. Link-target, P3-token and DS-conformance guards all pass.
- Full pre-push: web build, api build, RBAC coverage (2,399 routes, 0 unmapped), 82 security tests.
- **On production**, after confirming the deploy was `Ready` (a green push is not a deploy):
  - all **eleven** `?tab=` redirects return **308** to the right route, including the new
    `?tab=rules` → `/apply-rules`;
  - all **eleven** routes return **200**;
  - `?market=DE&preset=last30` survives on `/placement`;
  - the converted page normalises exactly as the pure tests say — `?market=ZZ`, `?weeks=abc`,
    `?weeks=999`, `?open=garbage` and `?portfolio=all&line=all` all render the default and rewrite
    to the bare path; **`?portfolio=pf-x&campaign=c-y` collapses to `?campaign=c-y`**; `?market=DE`
    and `?weeks=4&market=IT` survive;
  - **no page body overflows horizontally** at 1280 / 1380 / 1440 / 1728.

---

## 6 · The adoption note — for the nine remaining sessions

Adoption is **not** this session's job. One page was converted as proof (`budget-schedules`, because
the module was generalised from it and it is the only page whose behaviour could be pinned against
an existing test file). The other nine convert in their own sessions. This is what that looks like.

**1 · Declare a policy, module-level, as a constant.**

```ts
const POLICY: AdsScopePolicy = {
  market: MARKET_ANY,                 // or marketOne('IT') — see §2.1. YOUR page's call.
  date: { preset: 'last30' },         // omit entirely if the page has no date control
  sort: { keys: SORTABLE, key: 'spend', dir: 'desc' },
  search: true, paged: true, row: true, drawers: ['activity', 'versions'],
}
```

Everything past the four grains is opt-in. **Declare only what your page already has today** — that
is what keeps the conversion an extraction.

**2 · Swap your `params.get()` block and your `push()` for the hook.**

```ts
const { scope, push, reach, grains } = useAdsScope(POLICY, { options, writableIds })
```

**3 · If your page has its own params, pass BOTH `extra` and `extraKeys`.** This is the one way to
get it wrong quietly:

- Pass neither → the param survives a page load and then **vanishes the first time any control
  moves**. The symptom appears one interaction after the cause.
- Pass `extra` but not `extraKeys` → the guard counts fewer keys than the writer writes, reads the
  URL as never-canonical, and **renavigates on every render, forever**.

Both are pinned in `adsScope.vitest.test.ts`; copy `budget-schedules/urlState.ts`'s `writeOwnRaw` /
`OWN_KEYS` pair rather than inventing a third shape.

**4 · Dates: never let a picker key leave the adapter.** Use `datePatchFromPicker(key, presetRange)`
and `datePatchFromDays(start, end)`. Read your resolved dates back from the **response's own `range`
echo**, not from a local computation — the client and the server anchor presets to different clocks.

**5 · Reach: pass `writableIds` only if you actually have the gate payload.** Omit it otherwise.
Never substitute an empty set to make the number appear — see correction 5.

**6 · Adopting `useCursorPoll` costs you one measurement, not zero.** Bring a cursor whose fields
move when *your* subject moves, and **measure it**. Bid's measurement rejected the audit log;
Budget's rejected the row timestamp; neither could have used the other's shape. Copying a sibling's
cursor is the one way to misuse the hook — it produces a page that feels live and is lying, which is
worse than one that is visibly stale.

**7 · If you move your market control into a scope bar, pass `showMarket={false}`** so the page does
not ship two controls for one fact — the defect that sank the reverted RA scope bar.

**8 · Ten pages still pass `markets={…}` derived from whichever campaigns happened to load.** That
is the exact defect `AdsMarketplaceProvider` was written about: a picker can be missing DE simply
because DE had no rows in that page's window. `scopeMarket` now exists and may be `'all'`; wiring
your page to it is your session's work, and the prop and the provider support are both in place.

---

## 7 · What was NOT built, and why

**S4 — the tab bar at eleven items.** Blocked all session on `rules-automation.css`, which carried
119 uncommitted lines from at least two sessions and later went into an unresolved merge conflict
from a third. `_shared/tabs.tsx` came free mid-session when AR.S0 committed; the stylesheet did not.
Locks §1.3 says do not edit around a held file. Full hand-off in locks §4, including §3.2's numbers.

⚠ **Both files went clean at the very end of the session**, after the merge resolved. S4 is now
unblocked and is the substrate's last unit.

**The bare-index redirect and the index client's deletion.** Held because `/apply-rules` was
uncommitted, and a 308 to a route that is not in the deployed bundle is a hard 404 — strictly worse
than the silent wrong-page render it would replace. AR.S0 committed it mid-session (`3a75485a7`), so
`?tab=rules` went in; the bare-index half is a deliberate second step because it also requires
repointing four legacy `/marketing/advertising/automation/*` paths and deleting a client another
session may still be reading. Hand-off in locks §4.

**Everything else in spec §6.3** — the freshness chip, the refusal renderer, the actor resolver, the
ledger route and the four empty states — is untouched and unstarted.

---

## 8 · Two notes on working in a shared tree

Both happened to this session, an hour apart, in opposite directions.

- **RA.SPINE's twelve claim rows were swept into AR.S0's commit.** The `commit --only` trap, for the
  seventh recorded time, and the first time recorded by the session whose lines were taken. It cost
  nothing, and it is worth stating only because the countermeasure is one command: **`git diff -U0
  <file>` before staging, and confirm every hunk is yours.** This session did that for all five of
  its shared *code* files and all five were clean. It did not do it for the markdown, which is
  exactly where it got taken.
- **SOV.1 committed `next.config.js` while RA.SPINE held a claim on it**, landing four redirects as
  four more literals. Nothing was lost — SOV.1 staged hunks — and the response is the thing to copy:
  the derived table was diffed **as a set** against the committed config (54 redirects each, zero
  differences either way) before it replaced them. When someone lands in a file you hold, prove
  equivalence against what they *shipped*, not against what you remember reading.
