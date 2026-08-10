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

*(The scope bar has shipped. RA.AUTO holds §3 rows 1, 2 and 6 — all additive.)*

**`AdsPageHeader` note for other sessions:** it gained a `showMarket?: boolean`
prop, defaulted `true`. Every page that does not pass it renders byte-identically;
only Rules & Automation passes `false`, because market lives in its scope bar.

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

**Also shared, and currently owned by another programme:** everything under `apps/web/src/app/fleet/*`
and `…/rules-automation/fleet/*` belongs to the NAF sessions. Do not edit them; the RA pages link to
`/fleet`, they do not reach into it.

---

## 4 · Requests and hand-offs

*(none open)*

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
