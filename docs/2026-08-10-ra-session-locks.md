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
| `apps/api/src/services/advertising/keyword-tracker.service.ts` + `…/keyword-tracker/*` | KT.1b (one SQP period per view; the four unsaid things) | 2026-08-12 | **released** — landed `a3692fc80` (API) + the web commit that follows it |

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

**NEG.1 finding that binds every routed tab, `next.config.js`.** NEG.1 added a
`has: [{ type: 'query', key: 'tab', … }]` redirect for `?tab=negative-targeting`, because
`RulesAutomationClient.tsx:91-94` resolves a **routed** `?tab=` to `'rules'` — so the moment a tab
is flipped to its own page, every existing link to it silently renders **Apply Rules**. No 404, no
message, and `check-link-targets.mjs` cannot see it because `RulesTabs` builds its href in a
function call rather than a literal.

🔴 **`?tab=keyword-tracker` has that bug live right now** — KT.1 flipped the tab and no redirect was
added. It is one entry of the same shape, and it belongs to whoever owns KT; not fixed here because
a session is scoped to one page.

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
- **An untracked file can block every session's push.** The DS-conformance ratchet greps comments
  too — a comment can fail it.
- **Two Next dev servers in one repo fight over `.next`** ("Another write batch or compaction is
  already active") and pages render blank. Kill one or clear `.next/dev`.
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
