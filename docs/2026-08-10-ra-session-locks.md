# RA — parallel-session file ownership

Two or more Claude sessions build the six Rules & Automation pages at the same time, on the same
`main`, in the same working tree. **This file is the protocol and the live claim register.**

Read this before editing any file in §3. Record a claim before you edit one. Release it when you
commit. It follows the same protocol as `2026-08-07-naf-sb-session-locks.md`, which is battle-tested
across the ten `/fleet` pages — read that file's §6 before your first commit.

---

## 0 · Scope boundary — operator directive, 2026-08-10

> *"In this session, we are not touching the Fleets page. We are only working on the Automation
> page. That's it. And same goes for any alternate sessions that might mention the subpages or
> the tabs, etc. Will not go touch other pages out of context if they're not related to
> automations and stuff."*

**A session is scoped to one page. That scope binds even where this document names other
surfaces.** Specifically, an Automations session:

- **must not edit `apps/web/src/app/fleet/*` or `…/rules-automation/fleet/*`** — another
  programme owns them. Read for a pattern; never write.
- **must not retire the `AutomationDock`, the Portfolios page, the Family Cockpit, the Control
  Room or `/marketing/ads-console/*`.** Part 6 of the plan is a map, not a licence. Each is
  retired in the session that owns it, after its replacement is live and verified.
- touches shared/app-wide files (`AppRail`, `AdsPageHeader`, `app-nav.ts`) only when the
  operator asked for that specific fix, and then minimally and additively.
- **when the work genuinely needs another page: say so and stop.** Do not reach in.

Why this is a rule and not a preference: every session shares one working tree and one `main`,
and a broken shared file blocks *every* session's push. That happened on 2026-08-10 —
`fleet/approvals/ApprovalsClient.tsx` failed the web build mid-session and held the queue.

---

## 1 · The rule

**One session owns one page's files.** Cross-page edits go through a claim.

1. Your page's own directory (`…/rules-automation/<page>/*`) is yours. Edit freely, no claim.
2. A file in §3 (shared) needs a **claim recorded in §2 before you touch it**, and released in the
   same message as the commit that lands it.
3. If a file you need is claimed: **do not wait silently and do not edit around it.** Do every other
   part of your task first, then either (a) post a one-line request in §4 and continue elsewhere, or
   (b) tell the operator you are blocked and on what, so they can sequence it.
4. **Never `git commit -a` and never `git add -A`.** Use `git commit --only <your paths>`.
   See §5 for why that is not sufficient on its own.
5. **Never `--no-verify`.** Standing house rule, no exceptions.

---

## 2 · Current claims

| file / area | session | since | state |
|---|---|---|---|
| `docs/2026-08-10-ads-rules-automation-ra.md` | RA.0 (planning) | 2026-08-10 | **released** |
| `docs/2026-08-10-ra-session-locks.md` | RA.0 (planning) | 2026-08-10 | **released** |
| `apps/web/src/app/_shared/AppRail.tsx` | RA.0 (rail active-state fix) | 2026-08-10 | **released** |
| `…/rules-automation/rules-automation.css` | RA.SB (scope bar) | 2026-08-10 | **released** — appended at EOF only |
| `…/rules-automation/RulesAutomationClient.tsx` | RA.SB (scope bar) | 2026-08-10 | **released** |
| `…/marketing/ads/_shell/AdsPageHeader.tsx` | RA.SB (`showMarket`, additive) | 2026-08-10 | **released** |
| `apps/api/src/services/advertising/rule-category.ts` | RA.2 (category honesty) | 2026-08-10 | **released** |
| `apps/api/src/routes/advertising.routes.ts` | RA.AUTO (`GET /autonomy/rules`, additive fields only) | 2026-08-10 | **released** |
| `…/rules-automation/_shared/tabs.tsx` | RA.AUTO (one additive tab entry) | 2026-08-10 | **released** |
| `…/rules-automation/rules-automation.css` | RA.AUTO (Automations page) | 2026-08-10 | **released** — appended at EOF only |
| `apps/api/src/routes/advertising.routes.ts` | RA.GRAIN (scope route + `GET /advertising/scope-options`) | 2026-08-10 | **released** |
| `apps/api/src/services/automation-rule-scope.ts` | RA.GRAIN (product grain) | 2026-08-10 | **released** — see §3 row 11 |
| `apps/api/src/jobs/advertising-rule-evaluator.job.ts` | RA.GRAIN (product identity resolution) | 2026-08-10 | **released** |
| `packages/database/prisma/schema.prisma` | RA.GRAIN (`scopeProductId`, additive) | 2026-08-10 | **released** |
| `…/rules-automation/rules-automation.css` | RA.GRAIN (scope form, `h10-au-*` at EOF) | 2026-08-10 | **released** — appended at EOF only |
| `…/rules-automation/_shared/tabs.tsx` | KT.1 (`keyword-tracker` → `routed: true` + subtitle) | 2026-08-11 | **released** — landed `f6f526dda` |
| `…/rules-automation/RulesAutomationClient.tsx` | KT.1 (drop the `keyword-tracker` branch only) | 2026-08-11 | **released** — landed `f6f526dda`; `share-of-voice` branch untouched |
| `…/rules-automation/rules-automation.css` | KT.1 (`h10-kt-*` at EOF) | 2026-08-11 | **released** — appended at EOF only, `f6f526dda` + `5a24ef3aa` |
| `apps/api/src/routes/advertising-intel.routes.ts` | KT.1 (`GET /advertising/keyword-tracker`, additive) | 2026-08-11 | **released** — landed `31cba2535` |
| `apps/api/src/services/advertising/automation-action-handlers.ts` | NEG.0 (enforce `protectConverting`; pass `marketplace`) | 2026-08-12 | **released** |
| `apps/api/src/services/advertising/ads-harvest.service.ts` | NEG.0 (enforce `protectConverting` in `applyHarvest`; pass `marketplace`) | 2026-08-12 | **released** |
| `apps/api/src/routes/advertising-intel.routes.ts` | NEG.1 (`GET /advertising/negatives`, additive) | 2026-08-12 | **released** |
| `…/rules-automation/_shared/tabs.tsx` | NEG.1 (`negative-targeting` → `routed: true` + subtitle) | 2026-08-12 | **released** |
| `…/rules-automation/RulesAutomationClient.tsx` | NEG.1 (drop the `negative-targeting` branch only) | 2026-08-12 | **released** |
| `…/rules-automation/rules-automation.css` | NEG.1 (`h10-ng-*` at EOF) | 2026-08-12 | **released** — appended at EOF only |
| `…/rules-automation/rules-automation.css` | KT.1b (3 lines finishing the `h10-kt-*` keyword-cell override at EOF) | 2026-08-12 | **released** — see §5's new trap: these lines shipped inside NEG.1's `1df95d678`, not in a KT.1b commit |
| `apps/api/src/routes/advertising-intel.routes.ts` | NEG.2 (`GET /advertising/negatives/term-context`, additive) | 2026-08-12 | **released** |
| `…/rules-automation/rules-automation.css` | NEG.2 (`h10-ngd-*` at EOF) | 2026-08-12 | **released** — appended at EOF only; 🔴 the 130 lines landed inside PLC.0's `341d08e31`, not in a NEG.2 commit (see §5's `commit --only` trap, now observed in both directions) |
| `apps/api/src/services/advertising/ads-api-client.ts` | NEG.3 (negative-aware `updateTarget` routing, additive descriptor) | 2026-08-12 | **released** |
| `apps/api/src/workers/ads-sync.worker.ts` | NEG.3 (pass the routing descriptor; 2 select sites) | 2026-08-12 | **released** |
| `apps/api/src/services/ads-core/amazon-entity-gone.ts` | NEG.3 (`isNegative` axis on the orphan guard) | 2026-08-12 | **released** |
| `apps/api/src/services/advertising/ads-mutation.service.ts` | NEG.3 (select `isNegative`; pass it to `isContradictoryOrphan`) | 2026-08-12 | **released** |
| `…/negative-targeting/NegativeTargetingClient.tsx` | NEG.2 (two entry points + the drawer mount; no restructuring) | 2026-08-12 | **released** |
| `apps/api/src/services/advertising/keyword-tracker.service.ts` + `…/keyword-tracker/*` | KT.1b (one SQP period per view; the four unsaid things) | 2026-08-12 | **released** — landed `a3692fc80` (API) + the web commit that follows it |
| `apps/api/src/services/advertising/ads-auto-harvest.service.ts` | HV.0 (propose-only by default behind `NEXUS_ADS_AUTO_HARVEST_ARMED`) | 2026-08-12 | **released** — landed `42af69317` |
| `apps/api/src/routes/advertising-intel.routes.ts` | HV.1 (`GET /advertising/keyword-harvest`, additive) | 2026-08-12 | **released** — landed `b32262393`; see §5's new trap, its import line shipped early inside `6d50a6783` |
| `…/rules-automation/_shared/tabs.tsx` | HV.1 (`keyword-harvest` → `routed: true` + subtitle + the slug the builder writes) | 2026-08-12 | **released** — landed `46cba4968`; `RULE_TAB_ACTION_TYPES` is now DERIVED from `ruleTypes.ts`, scoped to tabs that already had an entry |
| `…/rules-automation/RulesAutomationClient.tsx` | HV.1 (drop the `keyword-harvest` branch only) | 2026-08-12 | **released** — landed `46cba4968`; `share-of-voice` branch untouched |
| `…/rules-automation/rules-automation.css` | HV.1 (`h10-hv-*` at EOF) | 2026-08-12 | **released** — landed `46cba4968`, appended at EOF only, every hunk diffed and mine |
| `apps/web/next.config.js` | HV.1 (one `?tab=keyword-harvest` redirect, same shape as NEG.1's) | 2026-08-12 | **released** — landed `46cba4968` |
| `packages/database/prisma/schema.prisma` | KT.2 (`KeywordWatchlist` + `KeywordWatchlistTerm`, additive) | 2026-08-12 | **released** — landed `cae154aec` |
| `apps/api/src/routes/advertising-intel.routes.ts` | KT.2 (watchlist CRUD, additive) | 2026-08-12 | **released** — landed `cae154aec` |
| `…/rules-automation/rules-automation.css` | KT.2 (`h10-kt-*` at EOF) | 2026-08-12 | **released** — EOF-append only; diffed before each commit, every hunk mine |
| `apps/api/src/routes/advertising-intel.routes.ts` | BID.S0 (`GET /advertising/bid-grid` + `/bid-grid/cursor`, additive) | 2026-08-12 | **released** — landed `b4655efd0`; both routes 401-verified on prod |
| `…/rules-automation/_shared/tabs.tsx` | BID.S0 (`bid` → `routed: true` + subtitle) | 2026-08-12 | **released** — landed `313828494` |
| `…/rules-automation/rules-automation.css` | BID.S0 (`h10-bd-*` at EOF) | 2026-08-12 | **released** — the main block landed `313828494`; 🔴 the one-line `.derived` override landed inside PLC.0's `341d08e31`, not in a BID.S0 commit (see §5, now observed in both directions) |
| `apps/web/next.config.js` | BID.S0 (one `?tab=bid` redirect, same shape as NEG.1's) | 2026-08-12 | **released** — landed `313828494`; verified on prod: `?tab=bid` → 308 → `/bid`, and `?tab=budget` still 200 |
| `apps/web/src/app/marketing/ads/campaigns/_grid/AdsDataGrid.tsx` | BID.S0 (`onSortChange` + `onFilterChange` + seed re-sync, additive) | 2026-08-12 | **released** — landed `313828494`. Re-sync is GATED on the callbacks, so the ~20 existing grids are untouched. Back/forward verified on prod. See §4 |
| `apps/api/src/services/advertising/keyword-tracker.service.ts` + `keyword-watchlist.service.ts` + `…/keyword-tracker/*` | KT.2 (per-market watchlists) | 2026-08-12 | **released** — `cae154aec` · `421b6d002` · `6d50a6783` · `b78ae2655` |
| `apps/api/src/routes/advertising-intel.routes.ts` | SOV.0 (`GET /advertising/share-of-voice-page`, additive) | 2026-08-12 | **released** — landed `a07460f58`, staged as TWO HUNKS not the whole file; see §5 |
| `…/rules-automation/_shared/tabs.tsx` | SOV.0 (`share-of-voice` → `routed: true` + subtitle) | 2026-08-12 | **released** — 🔴 swept into PLC.0's `341d08e31`, see §5 |
| `…/rules-automation/RulesAutomationClient.tsx` | SOV.0 (drop the `share-of-voice` branch only) | 2026-08-12 | **released** — 🔴 swept into PLC.0's `341d08e31`. The `SovTrackerTab` IMPORT went with the branch (it was its last caller — an unused import fails the web build); the component FILE stays |
| `…/rules-automation/rules-automation.css` | SOV.0 (`h10-sov-*` at EOF) | 2026-08-12 | **released** — 🔴 the first block swept into PLC.0's `341d08e31`; the 2-line cursor override landed in my `32dc3e585` |
| `…/rules-automation/_shared/tabs.tsx` | BSP.0 (`budget-schedules` → `routed: true` + label + subtitle) | 2026-08-12 | | **released** — 🔴 these lines shipped inside PLC.0's `341d08e31`, not in a BSP.0 commit; see §5 |
| `…/rules-automation/RulesAutomationClient.tsx` | BSP.0 (drop the `budget-schedules` branch only) | 2026-08-12 | | **released** — 🔴 these lines shipped inside PLC.0's `341d08e31`, not in a BSP.0 commit; see §5 |
| `…/rules-automation/rules-automation.css` | BSP.0 (`h10-bsp-*` at EOF) | 2026-08-12 | | **released** — 🔴 these lines shipped inside PLC.0's `341d08e31`, not in a BSP.0 commit; see §5 |
| `apps/web/next.config.js` | BSP.0 (one `?tab=budget-schedules` redirect, same shape as NEG.1's) | 2026-08-12 | | **released** — 🔴 these lines shipped inside PLC.0's `341d08e31`, not in a BSP.0 commit; see §5 |

| `…/rules-automation/dayparting/*` | RD.P0 (Rank & Dayparting foundation) | 2026-08-12 | **released** — landed `a993fe6bb` (data layer + scope) · `2381486b0` (URL) · `b1bfe40b2` (slots + stylesheet) |
| `…/rules-automation/tabs/RankGoalsList.tsx` | RD.P0 (the grid moves onto the page's own data layer) | 2026-08-12 | **released** — landed `a993fe6bb` + `2381486b0`. Still exactly one importer; it now reads `dayparting/_rd/*`, so it is this page's file in everything but its path |
| `docs/2026-08-10-ra-session-locks.md` | RD.P0 (§2 rows + two §4 hand-offs) | 2026-08-12 | **released** — `a9ec018d2` + this commit |
| `apps/api/src/routes/advertising-intel.routes.ts` | PLC.0 (`GET /advertising/placements`, additive) | 2026-08-12 | **released** — landed `de61254f8`; prod-verified with the 401-vs-404 trick (`401 {"required":"ads.view"}`) before the web deploy went out.
| `…/rules-automation/_shared/tabs.tsx` | PLC.0 (`placement` → `routed: true` + subtitle; then the active-tab scroll in `c04fc5b3f` — see §4) | 2026-08-12 | **released** — landed `341d08e31` + `c04fc5b3f`.
| `…/rules-automation/RulesAutomationClient.tsx` | PLC.0 (drop the `placement` branch only) | 2026-08-12 | **released** — landed `341d08e31`.
| `…/rules-automation/rules-automation.css` | PLC.0 (`h10-plc-*` at EOF) | 2026-08-12 | **released** — landed `341d08e31` + `c04fc5b3f`, EOF-appended only, no `.dark` block. ⚠ `341d08e31` also carries NEG.2's, BSP.0's, SOV.0's and BID.S0b's uncommitted blocks — named in that commit's own message rather than swept silently.
| `apps/web/next.config.js` | PLC.0 (one `?tab=placement` redirect, same shape as NEG.1's and BID.S0's) | 2026-08-12 | **released** — landed `341d08e31`.
| `apps/web/src/app/marketing/ads/_shell/AdsPageHeader.tsx` | PLC.0 (`dateRange?` — the existing date control becomes optionally CONTROLLED, additive) | 2026-08-12 | **released** — landed `341d08e31`; prod-verified: `?preset=custom&start=…&end=…` renders in the header's own label.
| `apps/api/src/routes/advertising-intel.routes.ts` | PLC.1 (`GET /advertising/placements/cursor`, additive) | 2026-08-12 | **claimed** — `grep -a`ed both route files; the path is disjoint from every registered route including PLC.0's own `/advertising/placements` (Fastify treats the two as distinct) and from BID.S0's `/advertising/bid-grid/cursor` |
| `…/rules-automation/rules-automation.css` | PLC.1 (`h10-plc-*` at EOF, flags + census strip) | 2026-08-12 | **claimed** — EOF-append only, no `.dark` block; will `git diff` every hunk before committing (§5) |

**RD.P0 holds nothing in §3, by construction.** The Rank & Dayparting foundation is web-only and
page-local: no route (so `advertising.routes.ts` and `advertising-intel.routes.ts` are untouched and
there is no duplicate-registration risk), no `tabs.tsx`, no `rules-automation.css`, no
`next.config.js`, no schema, no `AdsDataGrid`. One consequence worth copying: with no API change,
every unit is a single Vercel deploy and the two-deploy ordering trap does not apply to this session
at all.

**Two findings from KT.1 that bind every page in this section:**

1. 🔴 **The page gutter is ZERO, not 24px.** Measured on prod at 1728px: `.h10-hdr`,
   `.h10-rules-tabs` and `.h10-am-card` all sit at **96→1698** — `h10-main`'s 30px padding is the
   gutter. A block styled `margin: … 24px` inside `.h10-rules-page` is inset 24px past everything
   else on the page. (`.h10-svt-seg` carries that 24px and is the likely source of the pattern.)
2. 🔴 **The shared grid paints its first column blue.** `.h10-am-grid td.nm .t` sets
   `#1f6fde` at specificity (0,3,1), so a page-level `.my-cell .t { color }` loses. Every existing
   consumer makes that column a link, so it reads correctly there — a page whose first column is
   NOT a link must override it (match the specificity; `!important` is not needed).

*(The scope bar has shipped. RA.AUTO held §3 rows 1, 2 and 6 — all additive. RA.GRAIN holds
rows 2, 6, 10, 11 and the evaluator; all additive, all released.)*

**🔴 `AdsPageHeader` correction (KT.1, verified 2026-08-11).** The note that used to sit here said
the header had gained a `showMarket?: boolean` prop. **It has not** — that work was reverted with
the scope bar and `showMarket` has zero hits repo-wide. The props a page can rely on today are
`market` / `onMarketChange` (the market picker, always rendered) and `showLearn` / `showDataSync` /
`showDateRange` / `showChangeLog` / `primaryAction`. A page that wants scope pickers of its own must
own one market state and pass it into the header, rather than rendering a second market control.

**`advertising-intel.routes.ts` belongs on the §3 list in practice.** It is not the 600 KB file, but
it is now edited by more than one session and a duplicate route registration there is the same boot
crash. Claim it before adding a route.

---

## 3 · Shared files — claim before editing

| # | file | why it is shared |
|---|---|---|
| 1 | `…/rules-automation/_shared/tabs.tsx` | the tab/route substrate every page renders |
| 2 | `…/rules-automation/rules-automation.css` | one stylesheet, nine pages |
| 3 | `…/rules-automation/control-room/control-room.css` | the `acr-*` family the fleet pages also use |
| 4 | `apps/web/src/app/marketing/ads/_shell/nav.ts` | the ads rail |
| 5 | `apps/web/src/app/_shared/app-nav.ts` | the app rail's tree |
| 5b | `apps/web/src/app/_shared/AppRail.tsx` | the app rail's rendering + active state — **every section in the app** |
| 6 | `apps/api/src/routes/advertising.routes.ts` | **600 KB, one file, every ads route** — see §5 |
| 7 | `apps/api/src/services/advertising/ads-control-room.service.ts` | the engine registry |
| 8 | `apps/api/src/services/advertising/ads-autonomy.ts` | `resolveAutonomy` — the mode contract |
| 9 | `apps/web/src/app/marketing/ads/_shared/AutomationDock.tsx` | reads/writes the same rules as page 4 |
| 10 | `packages/database/prisma/schema.prisma` | every migration |
| 11 | `apps/api/src/services/automation-rule-scope.ts` | `ruleMatchesScope` — the one answer to "does this rule apply here". Added to this list by RA.GRAIN: the generic name suggests app-wide, but `grep -a` finds exactly ONE importer (`advertising-rule-evaluator.job.ts`) plus its own test, so it is advertising-only in practice — and load-bearing for all four grains |

**Also shared, and currently owned by another programme:** everything under `apps/web/src/app/fleet/*`
and `…/rules-automation/fleet/*` belongs to the NAF sessions. Do not edit them; the RA pages link to
`/fleet`, they do not reach into it.

---

## 4 · Requests and hand-offs

**NEG.1 → KT.1b, 2026-08-12.** `…/keyword-tracker/KeywordTrackerClient.tsx:74` failed the web build
at 01:40 — `'rowState' is declared but its value is never read`. Recorded only so the next session
to hit a red push knows it is not theirs: the pre-push builds the whole TREE, so one session's
in-progress file holds everyone's push. (Two `keyword-tracker.service.ts` errors — `since` and
`pickTermPeriod` undefined — were present at 01:20 and gone by 01:35, so this is active work.)

  **↳ RESOLVED (KT.2, 2026-08-12).** All three were mid-edit states of KT.1b, which has since
  shipped: `apps/web` and `apps/api` both build clean and 29 KT tests pass. Nothing is outstanding on
  those files.

- 🔴 **To whoever owns the Family Cockpit (`…/portfolios/[id]/FamilyCockpitClient.tsx`) — from KT.2,
  2026-08-12.** That page's coverage-set toggle calls `PATCH /advertising/coverage-sets/:id
  { enabled }` and says nothing about what enabling does. Measured: the ACR coverage engine is
  **scheduled daily at 07:10 and has run six nights** (`mode=observe sets=0`), and it selects
  `{ enabled: true }` sets — so that toggle is what starts nightly evaluation of a set's terms, and at
  `NEXUS_COVERAGE_ENGINE_MODE=auto` those decisions become real keyword-bid writes through
  `updateAdTargetWithSync`. All 97 terms of the one existing set already carry a `leadAsin`, the
  engine's precondition for acting on a term. One sentence on that control would close this. KT.2 did
  not touch the page (locks §0) and built its own entity instead, which is why the Keyword Tracker
  can no longer be the thing that arms it.

**HV.1 ⇄ KT.2, 2026-08-12 — two sessions on `advertising-intel.routes.ts` and
`rules-automation.css` at the same time.** Both claims are live and I am proceeding rather than
blocking, because both pairs are provably disjoint: the routes are `GET /advertising/keyword-harvest`
vs the watchlist CRUD (no duplicate path ⇒ no boot crash), and the CSS is EOF-appended under
`h10-hv-*` vs `h10-kt-*` (no shared selector). **Neither of us can safely `git commit --only` those
two files while the other's hunks are uncommitted** — that is §5's trap, which already misattributed
three lines inside `1df95d678`. I will `git diff` both before committing and, if KT.2's hunks are
present, stage only my own rather than sweeping theirs under an HV message.

🔴 **`git commit --only` swept an entire page's shared edits — the third occurrence, and the first
load-bearing one. SOV.0, 2026-08-12.** PLC.0's `341d08e31` ran while SOV.0's three shared-file edits
sat uncommitted in the tree, so that commit carries **`tabs.tsx`'s `share-of-voice` → `routed: true`,
the `RulesAutomationClient` branch removal, and 69 lines of `h10-sov-*` CSS** under a Placement
message. KT.1b's occurrence was three cosmetic CSS lines; this one **published a tab pointing at a
route that did not exist in the same commit** — between `341d08e31` and SOV.0's `9811f5ec0`, the
Share of Voice tab was a live 404 in any deploy built from the commits in between. The web build
does not catch it: `rulesTabHref` builds the path in a function call, so nothing references the
missing module.

**Two things follow for every remaining session.** (1) `git diff <shared file>` before
`commit --only`, as §5 already says — but also (2) **if your `--only` sweeps a `routed: true` you did
not write, you have just shipped someone's 404; tell them rather than assuming their push is next.**

🔴 **And the trap runs the other way in the same file on the same day.** SOV.0's own API commit
(`a07460f58`) could NOT use `commit --only`: a NEG.2 session had uncommitted work in
`advertising-intel.routes.ts` whose new route imports `getTermContext` from a `negatives.service.ts`
that was not in HEAD. Committing the file whole would have been green in the shared tree and **red on
its own**. The fix that worked, and is repeatable: `git diff` the file to a patch, drop the hunks
that are not yours, `git apply --cached` the rest, then plain `git commit` on the index — and verify
isolation with `git worktree add --detach <tmp> HEAD` plus `tsc` there.

**Still open, and it needs one line from whoever owns it:** `?tab=share-of-voice` and
`?tab=keyword-tracker` both resolve to **Apply Rules**, because `RulesAutomationClient` maps a routed
`?tab=` to `'rules'`. NEG.1 established the fix (one `has: [{type:'query', key:'tab'}]` redirect in
`next.config.js`). SOV.0 did not take it: `next.config.js` is claimed by HV.1 *and* BID.S0 with
uncommitted hunks, and it is not among SOV.0's briefed files.

**NEG.1 finding that binds every routed tab, `next.config.js`.** NEG.1 added a
`has: [{ type: 'query', key: 'tab', … }]` redirect for `?tab=negative-targeting`, because
`RulesAutomationClient.tsx:91-94` resolves a **routed** `?tab=` to `'rules'` — so the moment a tab
is flipped to its own page, every existing link to it silently renders **Apply Rules**. No 404, no
message, and `check-link-targets.mjs` cannot see it because `RulesTabs` builds its href in a
function call rather than a literal.

🔴 **`?tab=keyword-tracker` has that bug live right now** — KT.1 flipped the tab and no redirect was
added. It is one entry of the same shape, and it belongs to whoever owns KT; not fixed here because
a session is scoped to one page.

**BID.S0 blocked on HV.1, 2026-08-12 02:5x.** `keyword-harvest/page.tsx:12` imports
`./KeywordHarvestClient`, which does not exist yet, so the pre-push web build fails and **every
session's push is held** — the same shape as the KT.1b note above, three files along. Recorded only
so the next session to see a red push knows it is not theirs. Not touched: it is HV.1's directory
and it is obviously mid-flight. Retrying.

**PLC.0 blocked on NEG.2, 2026-08-12 ~01:2x.** `negative-targeting/NegativeTargetingClient.tsx`
has a syntax error mid-file (`TS1109: Expression expected` at :272-277, cascading to :570), so
`tsc` and the pre-push web build fail and **every session's push is held**. Third instance of the
same shape in this file's history (KT.1b → NEG.1, HV.1 → BID.S0). Recorded only so the next
session to see a red push knows it is not theirs. Not touched: it is NEG.2's directory and it is
obviously mid-flight. `tsc` with that one file excluded is clean, which is how PLC.0 confirmed its
own files compile. Retrying.

**PLC.0 → every session whose page keeps a date control, 2026-08-12.** `AdsPageHeader` declares
`rangePreset` and `onRangePreset` in its props type and **never destructures either** (`:52-53`
against `:60`), so those two props are dead: the only callback that fires is `onDateRange(start,
end)`. Worse for a linkable page, the header owns the range in its own `useState` seeded to the last
7 days (`:76`), so a page arriving on `?preset=last30` or `?start=…&end=…` renders a header label
that disagrees with its own grid — two controls for one fact, which is the defect that sank the
reverted scope bar.

PLC.0 is adding one strictly additive prop: `dateRange?: { start: Date; end: Date }`. Passed, the
header renders that range and keeps calling `onDateRange` on change (controlled); omitted, the
header keeps its own state and is **byte-identical for all 49 pages**. `DateRangePicker` already
takes `value` as a prop — the header simply never let a parent reach it. Take it if your page's
window has to survive a copied link.

⚠ One residue, stated rather than fixed: `DateRangePicker` seeds its *calendar highlight* from
`value` at mount only (`:60`, `useState(() => …)`), so a range change that does not originate from
the picker — the back button — updates the button label but not the highlighted days until the
popover is reopened. Not fixed here because it is a second behaviour change to a control 49 pages
render, and the label (which is what you read) is correct in every case.

**PLC.0 → every session, two things measured on prod that bind all eleven pages, 2026-08-12.**

🔴 **1. The tab bar hides the tab you are standing on.** At innerWidth 1380, on `/placement`:
`.h10-rules-tabs` `scrollWidth 1642` against `clientWidth 1254` — **388px of overflow** — with the
active tab at L=1355 against a bar ending at 1350. The bar also hides its scrollbar
(`ads.css:2063-2064`), so nothing signals that more tabs exist. **Placement, Share of Voice and
Keyword Tracker are all in that dead zone**, which is the last three routed pages. `RulesTabs` now
scrolls the active tab into view on mount (`c04fc5b3f`) — `scrollLeft` on the container, never
`scrollIntoView`, because the shell scrolls `main.flex-1.overflow-auto` and an element-level scroll
walks up to it and jumps the whole page on load. Deliberately the minimum; the edge fade, the four
clusters and keyboard scroll remain substrate S6.

🔴 **2. The section's link blue fails AA on the page ground.** The ground behind every band is
`.h10-shell`'s **#f4f6f9**, not white — `.h10-rules-page`, `.h10-main` and the `<p>` wrappers are
all transparent. `#1f6fde` is 4.79:1 on white and **4.42:1 on #f4f6f9**. So every `.lnk` that sits
on the page ground rather than inside a white card is below AA: `.h10-kt-note .lnk`,
`.h10-ng-note .lnk`, `.h10-hv-*`, `.h10-bd-*` and the rest. PLC.0 uses **#1a61c6** (5.33:1 on the
ground, 5.88:1 on white) for its own on-ground link and left the others alone — they are other
sessions' blocks. `getComputedStyle` reports the DECLARED colour and calls all of them a pass;
composite against the real ancestor background instead.

**PLC.0 → the twelfth pass, on `?page=`.** `AdsDataGrid` holds `page`, `rowsPerPage` and `search`
in private `useState` with no seed and no callback (`:225-226`, `:582`). BID.S0 closed the sort half
of this; the pager half is still shut, so `?page=<n>` — which the substrate spec names in the
per-page vocabulary — **cannot round-trip on any page in this section**. PLC.0 therefore does not
emit `?page=` rather than emit a param that does not restore the view, and works around the search
half by owning its own `?q=` input and filtering server-side. Same additive shape as `onSortChange`
would close it: `initialPage?` + `onPageChange?`.

**BID.S0 → every session that renders an `AdsDataGrid`, 2026-08-12.** `AdsDataGrid` accepts
`defaultSort` but exposes **no sort callback** — `onSort` (`AdsDataGrid.tsx:351`) is internal — so a
header click cannot reach the URL and `?sort=` cannot round-trip on any page that uses it. BID.S0 is
adding two strictly additive things: an optional `onSortChange?: (s | null) => void` fired from that
same handler, and a re-sync effect keyed on **`defaultSort?.key` / `defaultSort?.dir` primitives**
(never the object — every consumer passes an inline literal, and an effect on the object identity
would loop forever). Consumers that pass neither prop are untouched. Take it if your page needs a
linkable sort; it is not a Bid-page type.

**SHIPPED, `313828494` — and it is `onFilterChange` too.** The filter half had the same hole:
`initialFilters` could seed the panel and nothing could read a change back, so a page could be
linked *into* a filtered view and never linked *out of* one. Both callbacks are now on
`AdsDataGridProps`, and **the re-sync is gated on their presence** — pass neither and the component
behaves byte-identically, which is why the ~20 existing grids needed no audit.

Two things to know if you take it:
- The filter re-sync **merges** the seed into the live state rather than replacing it, or the
  numeric ranges an operator typed vanish the moment the URL changes.
- The outward emit is suppressed for one tick after an inbound seed. Without that, URL → seed →
  emit → URL is an infinite loop, and it is not obvious from reading either half on its own.

Verified on prod: back and forward restore the view, the filter chips and the sorted column.

**BID.S0 finding, shared layer.** `automations/ScopeForm.tsx` is the rule-scope **binding editor**
(it ends in a write), not a page filter bar, so it cannot be reused as one. The page scope bar has
now been forked three times — `KeywordScopeBar`, `NegativeScopeBar`, `BidScopeBar` — same structure,
same comments. The *server* resolver is genuinely shared and under-used: `resolveScopeReach()` in
`ads-scope-reach.ts` already resolves market × portfolio × campaign × product → campaign ids with
`applied` / `notes` / `contradiction`, and it is what the rule evaluator enforces with. **A page that
resolves scope any other way is answering a different question from the one the gate answers.**
The twelfth pass should extract the bar and point it at that resolver.

**RD.P0 → the twelfth pass, 2026-08-12 — the scope bar is now FOUR, and its CSS is what blocks
the extraction.** BID.S0's finding above counted three. This page needs a fourth (market ·
portfolio · product line · campaign), which makes the duplication worth stating as a number:
`KeywordScopeBar.tsx` and `NegativeScopeBar.tsx` are the same file — `inMarket`, `lineOpts`,
`pfOpts`, `campOpts`, the cascade, the most-specific-wins note, comment for comment — differing only
in the class prefix and NEG's fifth ad-group grain.

**RD.P0 deliberately shipped NO bar.** Authoring the canonical one here would mean the session with
the least information about the other three choosing the shape all four inherit, and the moment a
`_shared/` filename is taken the reconciliation either adopts a design chosen blind or renames across
four pages. Four honest forks are a better starting state than one premature abstraction. This page
ships the *contract* instead — URL params, a resolution module and a data layer that honour them —
and leaves the control to P2, by which time one more session will have reported in.

🔴 **The precondition nobody has named yet: the CSS.** `h10-kt-scope` and `h10-ng-scope` are both
defined in `rules-automation.css` — the one stylesheet nine pages share, and the file three sessions
are currently queuing EOF-appends against. An extracted `RaScopeBar` would still have to put its
selectors there, so the extraction does not actually reduce contention until the component has a
stylesheet of its own that it imports directly (the pattern `_schedule/DaypartingHeatmap.tsx` →
`dayparting.css` already uses). **Give the bar a CSS home outside `rules-automation.css` first;
the component extraction is the easy half.**

**RD.P0 → NEG.1 / HV.1 / BID.S0 / SOV.0, 2026-08-12 — one generic `next.config.js` rule supersedes
all four per-tab redirects, and three tabs are broken on prod right now.** The per-tab entry NEG.1
introduced is correct and is not scaling: it has to be remembered by each session separately, and
three of them have not been. Measured on prod 2026-08-12 by fetching each `?tab=` with
`redirect: 'manual'` (an opaque `status: 0` is the redirect; `200` is the silent wrong page):

| routed tab | `?tab=` on prod |
|---|---|
| `negative-targeting` · `bid` | redirects ✅ |
| `keyword-harvest` | 200 — entry is committed but not yet deployed |
| **`automations` · `dayparting` · `keyword-tracker`** | **200 → renders Apply Rules** 🔴 |

**Three of six routed tabs silently land on the wrong page.** All of them are subsumed by one rule
derived from `RULES_TABS`:

```js
...RULES_TABS.filter((t) => t.routed).map((t) => ({
  source: RULES_BASE,
  has: [{ type: 'query', key: 'tab', value: t.key }],
  destination: `${RULES_BASE}/${t.key}`,
  permanent: true,
})),
```

It must filter on `routed === true` and nothing else: `?tab=budget`, `?tab=placement`,
`?tab=share-of-voice` and the rest are the correct, deliberate contract for non-routed tabs, so a
blanket `?tab=*` redirect would break the majority to fix the minority.

**The catch to price in before taking it:** `next.config.js` is CommonJS evaluated by Node at build
time and `_shared/tabs.tsx` is a `'use client'` TSX module — the config **cannot import it**. Making
the rule genuinely derived needs the routed-key list lifted into a plain `.mjs` both sides can read;
otherwise it is a second copy of the list and the drift just moves. That is the whole cost, and it
is a one-file job for whoever holds the config.

**RD.P0 did not touch `next.config.js`.** HV.1 (**held**) and BID.S0 (**claimed**) both hold it in
§2 and neither has released, so the rule above is a hand-off, not a change. `?tab=dayparting` stays
broken until one of you takes it — it is one line inside the rule you are already writing.

**🔴 BSP.0 — the `commit --only` trap fired again, and this time it shipped a broken tab to prod.**
All four of BSP.0's shared-file edits — `_shared/tabs.tsx`, `RulesAutomationClient.tsx`,
`rules-automation.css`, `next.config.js` — plus its own claim rows in §2 above, were swept into
**PLC.0's `341d08e31`** while they sat uncommitted in the shared tree. Second instance in this
file's history after NEG.1 → KT.1b (`1df95d678`), and materially worse than the first:

> **`341d08e31` set `budget-schedules` to `routed: true` without the route.** Measured on prod at
> 03:2x: `/marketing/ads/rules-automation/budget-schedules` returned **404** while the tab bar
> rendered "Budget Pacing & Schedules" and linked to it. Every operator who clicked that tab got a
> 404, and nothing in the tree said why — the page files were untracked in another session.

Nothing was mis-authored and nothing was lost; the attribution is simply wrong in git and the
window between the two commits was a live regression. The lesson is narrower than "diff before you
commit", which both sessions did: **flipping `routed: true` and creating the route are ONE atomic
change, and they live in two different sessions' files.** A session that finds a foreign
`routed: true` hunk in `tabs.tsx` is looking at a tab that will 404 the moment it lands. Leave that
hunk unstaged, or land it and say so loudly.

**BSP.0 → the twelfth pass, 2026-08-12. The scope bar is now forked FIVE times.**
`BudgetScopeBar` joins `KeywordScopeBar`, `NegativeScopeBar`, `HarvestScopeBar` and `BidScopeBar`.
Same refusal, same reason as BID.S0's finding above: the BSP.0 brief asked for
`automations/ScopeForm.tsx` to be promoted to `_shared/` with an additive `mode: 'filter'` prop, and
it cannot be. Two facts settle it, and the second is the one the brief missed:

1. `ScopeForm` is a **binding editor** — its value type is `{scope*Id}` and it ends in a
   "Bind this scope" button that writes to a rule. A `mode` prop would not convert it.
2. 🔴 **Its component consumer is `automations/RuleDetail.tsx:167`, not `AutomationsClient`.**
   `AutomationsClient.tsx:36` imports only its *types*. So "move the file and update one import"
   is actually two edits inside another page's directory, which §1.1 reserves to that session.

Five forks is past the point where the twelfth pass should discover it. The extraction is real work
— the five differ in what they resolve reach *with* (BID.S0 uses the server's `resolveScopeReach`
via its own grid payload; the other four, including this one, compute the same intersection
client-side off `/advertising/scope-options` because they have no server payload to carry it). Any
extracted bar must keep both paths or it will silently change what four pages count.

**BSP.0 took `?tab=budget-schedules` in `next.config.js`, one entry, not the derived rule.** The
hand-off above prices the derived version at a `.mjs` lift of the routed-key list out of
`_shared/tabs.tsx` — four sessions hold that file right now, so BSP.0 added its own literal entry
alongside NEG.1's, HV.1's and BID.S0's rather than restructure a file three other sessions are
mid-edit on. `?tab=dayparting` and `?tab=keyword-tracker` remain broken and remain unclaimed.

**RD.P0 → P1–P7, 2026-08-12 — what the foundation guarantees, so no later section re-derives it.**

- **One data layer**, `dayparting/_rd/RdData` — `useRdData()` inside `<RdDataProvider>`. Four
  requests, down from five with `/rank-schedule-groups` fetched twice. Do not add a fetch to a
  section; add a field here. It keeps `error` instead of swallowing it, and `refresh()` is the seam
  a cursor poll lands on — **not** the SSE bus, which carries 0.21% of writes.
- **Two grains, typed.** `RdGroupRow` is real today. `RdCampaignRow`'s identity half is real today
  (all 45 campaigns under rank control resolve name, market, portfolio, line and schedule); its
  `runtime` half — mode · placement · goal · signal · ceiling — is `null` and belongs to P2's
  endpoint. The field names come from the approved structure doc, so P2 widens rather than invents.
- **Scope is derived and set-valued**, `dayparting/_rd/scope`. Never read
  `RankScheduleGroup.marketplace`: it is null on **9 of 16** groups, two of which resolve to DE, so
  a stored-column filter hides DE groups from a DE filter. `groupMatchesScope` takes anything with
  a `.scope`, and 17 tests pin the precedence.
- **The URL is the state**, `dayparting/_rd/useRdUrlState`. `?market= &portfolio= &product=
  &campaign= &grain= &row= &drawer= &tile=`. Filters `replace`, opening a row `push`es. Defaults are
  absent from the URL and unknown params survive a filter click.
- **`RdSection` is the geometry contract.** Mount inside it and a section cannot acquire a
  horizontal inset — the gutter here is 0, not 24px. It gives each section an id (`#rd-p2`).
- **Page-scoped CSS**, `rank-dayparting.css`, prefix `rd-*`, plus the four DS stylesheets (verified
  namespaced under `.h10-ds-*`, so they restyle nothing). `rules-automation.css` is inside the
  builder boundary — do not append to it from this page.

Measured on prod after the change: sections at x=96 w=1602 with no stagger, 16 rows, and all five
builder entry points byte-identical. Nothing in P0 changed engine behaviour, edited a `RankTarget`,
raised a ceiling or armed a schedule.

---

## 5 · Traps this repo has already paid for

- **`advertising.routes.ts` defeats grep.** The default `grep` here is `ugrep` and returns nothing on
  that file. Use `grep -a`. A duplicate route registration is a **boot crash**, not a warning —
  check before adding a route.
- **`git commit --only` can push a non-compiling commit.** The pre-push hook builds the working
  **tree**, not the commit. Your commit can be green in the tree and red on its own. Before pushing,
  confirm your commit compiles in isolation.
- **A commit is TWO deploys.** Web (Vercel) and API (Railway) land independently and not together.
  A UI that depends on a new route must ship **after** the route is live. Prove a route is deployed
  with the 401-vs-404 trick: `GET` it unauthenticated — **401 means it exists and is RBAC-mapped**,
  404 means it is not deployed yet.
- 🔴 **`git commit --only <shared file>` can ship ANOTHER session's uncommitted work under your
  message.** The hazard §5 already names runs the other way — "your commit can be red on its own".
  This is the same mechanism pointing outward. Measured 2026-08-12: NEG.1 committed
  `rules-automation.css` while KT.1b's appended `h10-kt-*` block sat uncommitted in the shared tree,
  so `1df95d678` carries three lines of KT.1b CSS under a Negative-Targeting message. Nothing broke
  — the selectors are disjoint and EOF-appended, which is exactly why the append convention exists —
  but the git history now attributes them wrongly, and had the other session's lines been mid-edit
  the commit would have shipped a broken stylesheet for nine pages. **Before `commit --only` on a
  file in §3, `git diff` it and check every hunk is yours.**
- 🔴 **`git add` is the same trap as `git commit --only`, and it fires OUTWARD — it can push a
  `main` that does not build.** Measured 2026-08-12. HV.1 added an import line to
  `advertising-intel.routes.ts` for a service file that was still untracked. KT.2 then committed
  that shared file with `--only`, sweeping the import in — so `6d50a6783` was pushed carrying an
  import of a module that **does not exist in the repo**, and the API build from `origin/main`
  could not have succeeded. The pre-push hook builds the working **TREE**, where the file existed,
  so it went green. Repaired minutes later by `b32262393`, the commit that adds the service.
  **Two rules follow.** (1) An import of a NEW file and that file must land in the SAME commit —
  if you are adding both, `git add` the new file the moment you write the import, so no other
  session can ship half of it. (2) The `git diff` check before touching a §3 file must also ask
  *"does this hunk reference anything untracked?"* — a hunk that is textually someone else's is
  obvious; a hunk that is textually yours but depends on a file only you have is not.
- 🔴 **It has now happened twice, and the second time it ran the OTHER way.** The note above is
  NEG.1 sweeping KT.1b's lines outward. On 2026-08-12 BID.S0's one-line `h10-bd-*` CSS append was
  swept *inward* by **PLC.0's `341d08e31`**, and BID.S0's own commit two minutes later reported
  "2 files changed" because git had nothing left to record for the stylesheet. Nothing broke again
  — EOF-append, disjoint selectors — but note the second-order hazard: **a session can believe its
  CSS did not ship.** Before concluding a shared-file change is missing, `git show HEAD:<file> |
  grep <your selector>` rather than trusting your own commit's file list. Six sessions appended to
  this stylesheet tonight; the convention is holding, the attribution is not.
- **An untracked file can block every session's push.** The DS-conformance ratchet greps comments
  too — a comment can fail it.
- 🔴 **Vercel does not always build your commit, and `vercel ls` showing "Ready" is not proof it
  built YOURS.** Measured 2026-08-12: HV.1's web commit `46cba4968` was pushed green, the newest
  production deployment read `● Ready`, and the new route still 404'd — because that deployment had
  cloned `b78ae26`, the commit before it, and **no build was ever queued for `46cba4968`**. When
  several sessions push within minutes, a deploy already in flight can absorb the trigger. Check
  the deployment's actual commit (`vercel inspect --logs | grep Commit`), not its status, and if
  yours was skipped, land another commit that touches the tree to force a build.
- **Two Next dev servers in one repo fight over `.next`** ("Another write batch or compaction is
  already active") and pages render blank. Kill one or clear `.next/dev`.
- 🔴 **The `commit --only` trap also runs INWARD: another session can stage a file into the shared
  index while you are working.** The two instances recorded above are both about your commit
  sweeping up someone else's *working-tree* changes. Measured 2026-08-12 by RD.P0: a `git add` of
  five explicit paths came back with **six** staged files — `_schedule/BudgetScheduleTab.tsx`, a
  125-line deletion, had been staged by another session in the seconds in between. So a plain
  `git commit` (no paths) is **not** the safe alternative to `commit --only` — it commits the whole
  index, including whatever another session has just put there. Check `git diff --cached
  --name-only` immediately before every commit and pass explicit paths, whichever form you use.
- **A `2>/dev/null` on a CLI that writes to stderr manufactures a zero.** `vercel ls` prints its
  deployment table to **stderr**, so `npx vercel ls 2>/dev/null | grep -c "Queued\|Building"`
  returns 0 whatever is happening, and a deploy-wait loop exits immediately claiming everything has
  settled. Same failure class as the `.catch(() => [])` the study warns about, one layer out: the
  check reports "nothing pending" when what it means is "I read nothing at all". Verify a zero from
  any CLI poll against a second reader before acting on it.
- **Local dev hits the PROD API** unless `NEXT_PUBLIC_API_URL` is set. Running the API locally needs
  `NEXUS_WEB_ORIGINS` to include your web port — CORS allow-lists only `:3000`, and any other port
  silently returns data the browser refuses to read. The page renders **empty with no console
  error**, which looks exactly like a data bug.

---

## 6 · Before you commit

1. `git status --porcelain` — confirm nothing of another session's is staged.
2. `git commit --only <your explicit paths>`.
3. Confirm the commit compiles on its own (§5).
4. Release your claims in §2 in the same message.
5. Push. Never `--no-verify`.
