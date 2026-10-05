# 01 — Today's Approvals page and its API (read-only research)

Worktree `/private/tmp/feat-approvals-grid`, branch `feat/approvals-grid` = origin/main `7039b95ef`, read 2026-10-05.
Nothing was run (no server, no database, no tests). Every claim is from reading code; "not verified" marks what code
alone cannot prove. Paths are relative to the repo root; `web/` = `apps/web/src/app/fleet/approvals/`.

## Summary

1. The page is a fleet page (`/fleet/approvals`, 7,542 lines in 17 files). It has two queues. "Waiting for you" (tabs Waiting / Decided / Expired) holds only the **3 fleet tools**. A separate "outside" section holds **every other tool**, and that is where almost all of Claude's (MCP) requests land.
2. Claude's requests show up as one card each (`ApprovalCard`), or one `PlanCard` for a change plan. They are ordered oldest first, **capped at 100**, have **no checkboxes, no bulk action, no filter, no count in the tabs**. The empty state "Nothing is waiting for you" can render *above* real Claude requests.
3. Refresh is visibility-gated polling every 10 s (5 GETs per tick). There is no SSE. Every decision goes through `POST /api/agent/fleet/approvals/:id/decide`. An approve parks the row for 20 s (Undo, Hold +10 min). The browser or the 30-s sweep then calls `/commit`, which runs the tool **synchronously** (a plan goes to a BullMQ worker).
4. Statuses: pending → scheduled → executing → executed, plus rejected / expired / superseded / approved (preview-only). There is **no `failed` status**: a failed or stale run returns the row to `pending`, with a `reason` prefix and a fresh 24 h clock.
5. `AgentApproval` has **no entity columns**. The product, SKU, listing, market or campaign exists only inside free-form `args` (tool-specific keys) or `preview` (an optional convention). About 60 of 115 statically parsed change tools carry no product key at all.
6. Who asked comes only through `AgentRun` (`agentKey` = `claude`, `via`, `userId`, `oauthGrantId`). The page shows "Someone using Claude" and never names the person or the connection.
7. "Automate this kind of request" already exists **per tool, per business** as Claude trust levels (`AgentTool.claudeTrust`: off/ask/confirm/auto). It lives on Settings › AI › Claude, not on this page. Raising a level needs `settings.security.manage` plus a fresh 2FA code. Only 24 of 119 change tools may ever reach `auto`.
8. 119 executable change tools, plus 3 control tools (`submit-change-plan`, `undo-change`, `confirm-change`), out of 203 registered tools. Every change Claude asks for is stored as an approval (`forceAsk: !readOnly`).
9. Verified defects that matter for a rebuild: "Reject the plan" always fails (no reason, API 400). Action errors are wiped by the next refresh within milliseconds. Bulk approve can never succeed. The Decided tab calls every Claude decision "from before the fleet". Rule hand-backs show no banner. Polling re-reads the whole decision history every 10 s.
10. Earlier work (2026-10-02 browser check) deliberately replaced grids with lists, for keyboard and phone reasons, on the plan steps, Claude Rules and Claude Activity. `claudePage.vitest.test.ts` asserts that `PlanCard` does **not** use `<NexusGrid`. A grid rebuild has to answer that test and that finding.

---

## 1. The web page today

### 1.1 Files

| File | Lines | Role |
|---|---|---|
| `web/page.tsx` | 54 | Server shell: loads 4 DS sheets plus `control-room.css`, `fleet-sections.css`, `fleet-pages.css`, `approvals.css`; renders `<ApprovalsClient/>` inside `.aq-page` (`page.tsx:36-54`). |
| `web/ApprovalsClient.tsx` | 1566 | Everything else: fetches, polling, S2 gate readout, empty state, example card, outside queue, decision handlers. |
| `web/ApprovalLists.tsx` | 846 | `ViewTabs`, `ParkedRow`, `RecordList`, `PrecedentPanel`, `WaitingList` (bulk bar, groups). |
| `web/ApprovalCard.tsx` | 1375 | The one decision card: `describe()` per tool (lines 349-650), comeback banner, clock, ack, note, reject codes, edit, snooze, recheck. |
| `web/PlanCard.tsx` + `planWords.ts` + `planCard.css` | 227+130+34 | Change-plan card: tick per kind, step list, counted button, amend. The only part on DS components/primitives. |
| `web/approval-words.ts` | 404 | Pure wording: approve label, content diff, channel effect, outside heading, Claude door sentence, `plainValue`, `productEntityOf`. |
| `web/HowApprovalsWork.tsx` | 150 | Teaching drawer (DS `Drawer`). |
| `web/reversibility.ts` | 13 | `reversibilityFrom()`: anything unknown counts as `none`. |
| `web/approvals.css` | 1819 | `aq-*` rules; pinned in ratchets: 63 hex, 24 radius, 4 shadow (`scripts/css-*-baseline.json`). |
| Tool vocabulary | — | `TOOL_CARDS` / `toolCardFor` imported from `apps/web/src/app/marketing/ads/rules-automation/fleet/DecisionCard.tsx:75-426`. **36 tools** have a card; the rest use `genericCardFor` (`ApprovalCard.tsx:104-119`) or the humanized-id fallback. |

The page is mostly legacy `acr-*` / `ap-*` classes (`control-room.css`, `fleet-sections.css`), not DS. The raw-primitive ratchet holds ApprovalCard 13, ApprovalLists 16, ApprovalsClient 2, HowApprovalsWork 1 (`scripts/raw-primitives-baseline.json:75-78`).

### 1.2 Layout, top to bottom (`ApprovalsClient.tsx:1349-1565`)

1. **Header** (`FleetPageShell`): title "Approvals". Description "Nothing on this page has happened yet. Every card is a change one of your workers wants to make…" (`:286-294`). Help drawer "How approvals work" (`HowApprovalsWork.tsx`), worded for the fleet: PROPOSE dial, critic, "eighteen answered requests" (`:74-145`).
2. **Error line**: `err` (`:1366-1370`).
3. **S2 gate readout** (`GateStateSection`, `:485-639`), from `GET …/gate-state`. It covers the halt banner, 3 server-composed conditions (worker-may-ask / action-can-run / something-scheduled) with owners, and fleet tool executability. It shrinks to one line when `counts.waiting > 0`, and `counts.waiting` counts **fleet tools only**.
4. **Queue card** "Waiting for you" / "The decision record" / "Ran out of time", stamped "as of HH:MM:SS" (`:1374-1396`).
   - `ViewTabs`: Waiting / Decided / Expired, each with a count (`ApprovalLists.tsx:118-164`).
   - Bulk result line (`:1400-1426`).
   - Waiting view: `WaitingList` grouped by `charterKey`, i.e. the run's agentKey (`ApprovalLists.tsx:574-578`). Each group has "Select all N in this group", "Reject all (N)" with a required reason, and per-row checkbox + `ApprovalCard`; parked rows render as `ParkedRow`.
   - Empty waiting view: `EmptyWaiting` says "Nothing is waiting for you[, and nothing can arrive yet]" and, while blocked, shows an inert **example card** (`:759-790`, fixture `:691-757`).
   - Decided / Expired: `RecordList` (outcome word, "X asked to <shortAsk>", by whom, absolute time, risk, "waited N" for expired, "from before the fleet" for non-fleet tools, operator note in quotes, system `reason` in `<code>`) (`ApprovalLists.tsx:343-436`). A note above it says "None of these N are your decisions…" (`ApprovalsClient.tsx:1523-1538`).
   - `PrecedentPanel` "What your decisions have taught the fleet" (`ApprovalLists.tsx:440-510`).
5. **Outside section** (`OutsideQueue`, `:822-1063`), from `GET …/approvals/outside`.
   - Loading / failed (with "Try again") / empty states. The empty state names the producers and the Claude door: "N connections live" (`:898-930`).
   - Heading from `outsideHeading()`: "N requests can change something — X on your sales channels, Y in Nexus only" (`approval-words.ts:306-318`).
   - Per row, an origin line "**Someone using Claude** asked for this — a person who asked for it in Claude…" (`:1023-1026`), then `ApprovalCard`. Or `PlanCard` for `submit-change-plan` (`:990-1003`). Or `ParkedRow` for `scheduled`, labelled "Runs by your rule — …" when `decisionVia === 'auto'` (`:976-989`).
   - **No checkbox, by rule** (`:1005-1018`). No sort (server order is `requestedAt asc`), no filter, no count in the tabs.

Deep links: `?item=<id>` and `?assignment=<id>` filter **only the fleet list** (`:1074-1076`, `:1301-1304`), never the outside rows.

### 1.3 What one `ApprovalCard` shows (`ApprovalCard.tsx:826-1375`)

Head: "**<who>** <wants> in **<business>**" (business only on outside cards, from the active profile name, `ApprovalsClient.tsx:856`), then "<risk> risk · <Nh left | N min left> · <ago>" (`:979-995`).
Body, in this order:
- comeback banner. A `reason` starting `not run —` gets warning tone; `execution failed:` / `execution error:` gets danger tone (`:671-695`, `:1012-1023`).
- delta. Either the bid editor (edit mode), or a content diff table (Now / New / English meaning, `ContentDiffView :769-822`), or summary plus a before → after list with "and N more", or the fallback "This action did not describe itself."
- totals (KeyValue) and warnings (Banner) from the preview convention (`:1116-1121`).
- "on **<entity>** · <market>" (`:1124-1129`).
- consequence sentence: `wrongCost` + reversibility sentence. If `!canExecute` it reads "changes nothing on Amazon" instead (`:1141-1153`).
- "Why this was proposed" disclosure: effect, what each marketplace gets (bulk price), evidence, track record, "If you do nothing… expires <date>" (`:1162-1225`).
- ack tick "I have read what this does [— and that it cannot be undone]". Shown when `heavy && canExecute`, where heavy = not fully reversible or riskTier high (`:864`, `:897`, `:1246-1254`).
- Note (optional) input (`:1257-1265`).
- Verbs: primary **Apply — <consequence>** (label from `approveLabelFor`, `approval-words.ts:204-247`). It is disabled until ticked, and disabled with a written reason when `cannotApprove`. **Reject** replaces the row with 4 coded reasons per tool (`REJECT_CODES :178-255`); the code plus note is sent as `reason`. **Not now** offers 2 h / 6 h / tomorrow morning, filtered to before expiry (`:920-928`).
- Tertiary: "Check this is still true" (recheck), "Right idea, wrong number?" (edit). Edit is only for `set-target-bid` and `graduate-keyword` (`EDITABLE :286-305`).

`PlanCard` (`PlanCard.tsx:95-227`) shows title and summary, a "cannot approve" banner, one checkbox per **kind** of consequence (`kindSentence`), a filter box, the step list (Keep / Step / Change / What it changes / Reaches / Status), and one counted button: "Approve N changes", or "Make a plan of the N ticked changes" (amend). Plus "Reject the plan". It shows **no expiry, no requested time, no business, no recheck**.

`ParkedRow` (`ApprovalLists.tsx:187-339`): "Approved — <shortAsk>" or "Runs by your rule — …", then "Running in N seconds — the undo window" with **Hold** (+10 min, server side) and **Undo**. At zero the browser calls commit once per deadline (`:254-272`). A row with no `executeAfter` reads "stuck", with Undo only.

### 1.4 Actions and clicks

| Action | Clicks | Endpoint |
|---|---|---|
| Approve one (light) | 1 | `POST /api/agent/fleet/approvals/:id/decide {decision:'approve', reason?}` |
| Approve one (heavy or irreversible, executable) | 2 (tick + Apply) | same |
| Reject one | 2 (Reject + a code) | same with `reason` = code [+ " — " + note] |
| Undo inside 20 s | 1 | `POST …/:id/undo` (no body) |
| Hold +10 min | 1 | `POST …/:id/hold` |
| Commit at 0 s | automatic (browser) | `POST …/:id/commit` (no body) |
| Snooze | 1 (preset) | `POST …/:id/snooze {until}` |
| Edit then approve (2 tools) | 3+ | `POST …/:id/amend {args}` → new pending row, old one `superseded` |
| Recheck | 1 | `POST …/:id/recheck` |
| Bulk approve / reject (fleet list only) | select → Approve/Reject selected → (reason) → [type "approve N" if N > 24] → "Yes, do it" | `POST …/bulk-preview`, then `POST …/bulk-decide` |
| Reject all in a group | 3 (button, reason, confirm) | `POST …/reject-all {charterKey, reason}` |
| Plan: approve | tick every kind + 1 | `…/:id/decide {decision:'approve'}` |
| Plan: untick steps | untick + 1 | `POST …/:id/plan-amend {keep}` (idempotency key, `lib/command-idempotency.ts:51`) |
| Plan: reject | 1 | `…/:id/decide {decision:'reject'}` with **no reason** → fails (defect D2) |

`busy` is page-global: any in-flight POST disables every control on every card (`ApprovalsClient.tsx:1103`, `:1197-1231`).

### 1.5 Refresh

`useVisibilityPoll(load, 10_000)` (`apps/web/src/app/fleet/_shared/use-visibility-poll.ts:21-59`) ticks every 10 s while the tab is visible, and once on becoming visible. There is no SSE or websocket. Each tick runs 5 parallel GETs (`ApprovalsClient.tsx:1107-1113`). Changing tab refetches at once (`:1192-1195`). Every POST is followed by `refresh()`. `PlanCard` reads its steps once on mount (`PlanCard.tsx:118-129`), not on the poll.

### 1.6 Claude (MCP) vs fleet vs other producers on screen

| Producer (`AgentRun.agentKey` / `via`) | Tool | Where it renders | Name shown |
|---|---|---|---|
| Claude over MCP (`claude`, via `claude`) | one of the 3 FLEET_TOOLS | **Waiting for you**, group "Someone using Claude", with checkbox | `originOf('claude')` (`ApprovalsClient.tsx:203-206`) |
| Claude over MCP | any other tool (≈116) | **Outside section**, ApprovalCard / PlanCard | "Someone using Claude"; person and connection not shown |
| Claude, trust `auto` | any | outside `ParkedRow` "Runs by your rule" for ~20 s, then gone | — |
| Fleet charter (council) | FLEET_TOOLS | Waiting, group = charter name | charter name (`/agent/fleet/charters`) |
| Copilot button / Activity-page undo (`manual-action`) | any | outside | "Someone using the copilot" |
| In-app assistant (`products-copilot` etc., via `app`) | any | outside | humanized key + "a system that runs outside the fleet" (wrong, `:224-237`) |
| `pricing-watchdog`, `listing-quality-keeper` crons | set-price, apply-content | outside | named crons |

### 1.7 Every API endpoint the page calls

| Method + path (under `/api`) | Called from |
|---|---|
| GET `/agent/fleet/approvals?view=waiting\|decided\|expired` | `ApprovalsClient.tsx:1108` |
| GET `/agent/fleet/precedents?limit=25` | `:1109` |
| GET `/agent/fleet/charters` | `:1110` |
| GET `/agent/fleet/approvals/gate-state` | `:1111` |
| GET `/agent/fleet/approvals/outside` | `:1112` |
| POST `/agent/fleet/approvals/:id/decide` | `:1241` |
| POST `/agent/fleet/approvals/:id/undo` | `:1455`, `:1558` |
| POST `/agent/fleet/approvals/:id/commit` | `:1456`, `:1559` |
| POST `/agent/fleet/approvals/:id/hold` | `:1162` |
| POST `/agent/fleet/approvals/:id/recheck` | `:1250` |
| POST `/agent/fleet/approvals/:id/amend` | `:1265` |
| POST `/agent/fleet/approvals/:id/snooze` / `unsnooze` | `:1281` (unsnooze is never actually sent, D10) |
| POST `/agent/fleet/approvals/bulk-preview` | `:1458` |
| POST `/agent/fleet/approvals/bulk-decide` | `:1478` |
| POST `/agent/fleet/approvals/reject-all` | `:1453` |
| GET `/agent/fleet/approvals/:id/plan` | `PlanCard.tsx:120` |
| POST `/agent/fleet/approvals/:id/plan-amend` | `PlanCard.tsx:155` |

### 1.8 Other surfaces over the same rows (the rebuild must decide what happens to each)

- **Fleet Overview** `/fleet` → `FleetTab.tsx` renders the old `ApprovalInbox` against the same `/agent/fleet/approvals` decide and reject-all routes (`apps/web/src/app/marketing/ads/rules-automation/fleet/FleetTab.tsx:194,329,350,685`).
- **Settings › AI** `AiApprovalsClient.tsx` is a second inbox: `GET /api/agent/approvals?status=pending` (newest 50, every tool, `approval-gate.service.ts:430-436`), plus approve and reject that go through `decideFleetApproval` (`apps/api/src/routes/agents.routes.ts:153-196`).
- **Settings › AI › Claude** (`apps/web/src/app/settings/ai/claude/`):
  - **Rules**: per-tool trust level and limits, Pause, daily cap (`RulesPanel.tsx`; `GET/PUT /api/claude/trust`, `/claude/autonomy`, `/claude/pause`, `/claude/resume`, `apps/api/src/routes/claude-control.routes.ts:72-91`).
  - **Activity**: what Claude did, with Undo of executed changes (`ActivityPanel.tsx`; `GET /api/claude/activity`, `POST /api/claude/changes/:id/undo`).
  - Both are lists, not grids, on purpose.
- Nav: "Approvals" under Agent Fleet › Operate, **no badge** (`apps/web/src/app/_shared/app-nav.ts:255`), although `page.tsx:4-5` claims one.

---

## 2. The backend

### 2.1 Routes

| Route | File:line | Service |
|---|---|---|
| GET `/agent/fleet/approvals` | `apps/api/src/routes/agent-fleet.routes.ts:273-299` | `listInbox`, `inboxCounts`, `resolveFleetLabels`, `cannotApproveFor` |
| POST `…/:id/decide` | `agent-fleet.routes.ts:301-325` (reject without reason → 400, `:312-314`) | `decideFleetApproval` |
| GET `/agent/fleet/precedents` | `:329-334` | `recentPrecedents` |
| POST `…/:id/undo` | `:337-347` | `undoScheduledApproval` |
| POST `…/:id/commit` | `:351-358` | `commitScheduledApproval` |
| POST `…/bulk-preview` / `bulk-decide` / `reject-all` | `:361-409` | `previewBulk`, `bulkDecide`, `rejectAllForCharter` |
| GET `…/gate-state` | `apps/api/src/routes/agent-fleet-approvals.routes.ts:144-355` | inline (hand-kept list of 11 tools `:167-179`) |
| POST `…/:id/recheck` | `:390-400` | `checkStaleness` (read-only) |
| POST `…/:id/hold` | `:430-457` | inline: `executeAfter = now + 10 min`, scheduled only |
| POST `…/:id/amend` | `:490-577` | inline: re-runs the tool's dry run as the editor, supersedes, creates a new pending row (fresh 24 h) |
| POST `…/:id/snooze` / `unsnooze` | `:594-641` | inline; a snooze is refused past `expiresAt` |
| GET `…/rollup?assignmentIds=` | `:663-712` | inline (no caller in `apps/web`) |
| GET `…/outside` | `:714-799` | inline: `status in (pending, scheduled)`, `toolName notIn FLEET_TOOLS`, not snoozed, **`orderBy requestedAt asc, take 100`**, returns `count` and `cap` |
| GET `…/:id/plan` | `:802-806` | `planView` (money-filtered previews) |
| POST `…/:id/plan-amend` | `:809-814` | `amendPlan` |
| Legacy `GET /agent/approvals`, `POST /agent/approvals/:id/approve\|reject`, `POST /agent/actions/request` | `apps/api/src/routes/agents.routes.ts:153-196` | `listApprovals`, `decideFleetApproval`, `requestApproval` |

Permissions: everything sits under `/api/agent/` (ai.view / ai.run), per `agent-fleet.routes.ts:2-5`. Approve additionally needs the tool's own `requires` (`missingPermissions`), checked at claim time and again at commit (`deciderPrincipal`, `approval-inbox.service.ts:473-490`).

### 2.2 Data model (`packages/database/prisma/schema.prisma`)

**AgentApproval** (`:13548`). All fields:

| Field | Type | Meaning |
|---|---|---|
| `workspaceId` | String, RLS default | the business (row-level security) |
| `id` | cuid | |
| `agentRunId` → `agentRun` | String, cascade | the run that asked: producer, door, person (§2.5) |
| `toolName` | String | registry tool name (`submit-change-plan` for a plan) |
| `riskTier` | String | policy tier when created (low/medium/high) |
| `args` | Json | the request's arguments, as parsed (business name stripped). For a plan: `{title, steps:N}` |
| `preview` | Json? | raw dry-run preview (unfiltered; filtered per reader on read) |
| `status` | String, default pending | see §2.3. The schema comment lists 6 values; the code uses 8 |
| `requestedAt` | DateTime | |
| `decidedBy` | String? | display name of the decider (or the tool name for a withdrawn undo) |
| `decidedByUserId` | String? | the person; the commit runs as them |
| `decidedAt` | DateTime? | |
| `reason` | String? | **system** sentence: `not run — …`, `not run by rule — …`, `execution failed: …`, `execution error: …`, `superseded — …`, `withdrawn: …`, `expired: …`, a plan's "N of M changes ran; …", or a reject reason |
| `operatorNote` | String? | the person's own words |
| `expiresAt` | DateTime? | the 24 h clock (restamped on hand-back) |
| `executeAfter` | DateTime? | end of the undo window while `scheduled` |
| `snoozedUntil` | DateTime? | hidden from lists until then |
| `changes` | AgentChange[] | what it changed once executed |
| `decisionVia` | String? | `nexus` \| `auto` \| `claude-confirm` (null while undecided) |
| `summary` | String? | plan: Nexus-written line; single change: set only at `confirm` level (`claude-confirm.service.ts:90-100`) |
| `planHash` | String? | plan or confirm hash |
| `planSteps` | AgentPlanStep[] | |

Indexes: `[status, requestedAt]`, `[status, executeAfter]`, `[status, expiresAt]`, `[workspaceId]`. There is no index on toolName, agentRunId or any entity.

**AgentPlanStep** (`:13609`): `approvalId`, `position` (unique per approval), `toolName`, `args`, `preview`, `status` (pending / executing / done / skipped / failed), `reason`, `changeId`, `undoesChangeId`, `startedAt`, `endedAt`.
**AgentChange** (`:13654`): `approvalId`, `planStepId`, `toolName`, `via` (app / claude / fleet / system), `oauthGrantId`, `executedByUserId`, `executedAt`, `reversibility`, `before`, `after`, `undoTool`, `undoArgs`, `undoneAt`, `undoneByApprovalId`, `outbound`.
**AgentRun** (`:13450`) fields used here: `agentKey` (`claude`, `manual-action`, charter keys, crons, assistant keys), `via` (app / claude / null), `oauthGrantId`, `userId`, `mode` (non-null = fleet run), `assignmentId`, `orchestrationId`, `input` (`{tool, args, business}`). `entityType` and `entityId` exist but **MCP runs never set them** (`mcp-tool-call.ts:258-267`).
**AgentTool** (`:13521`, per business): `riskTier`, `enabled`, `requiresApproval`, `rateLimitPerHour`, `claudeTrust` (default `ask`), `claudeLimits`.
**AgentAutonomy** (`:13636`): `autoPausedAt/By`, `pauseReason`, `dailyAutoCap` (200).

### 2.3 Statuses and transitions

```
created ── pending ──approve (scheduleApproval: claim pending→scheduled, decidedBy, executeAfter=now+20s, decisionVia)──▶ scheduled
   │          │  ▲                                                                                      │   │ hold: executeAfter=now+10min
   │          │  └── undo (scheduled→pending, decider cleared)  ◀───────────────────────────────────────┘   │
   │          │  └── hand-back at commit (stale / permission / rule): pending + reason "not run — …" + expiresAt=now+24h
   │          │  └── execution failed/error: pending + reason "execution failed|error: …", decider cleared, expiresAt=now+24h
   │          ├─reject (reason required by route) ─▶ rejected
   │          ├─expiresAt passed (sweep) ─▶ expired   (also pre-switch ad requests, approval-inbox.service.ts:1151-1170)
   │          ├─amend / plan-amend ─▶ superseded (+ a NEW pending row)
   │          └─withdrawn duplicate undo ─▶ rejected ("withdrawn: …")
scheduled ──commit after executeAfter (browser or 30-s sweep)──▶ [re-checks] ──▶ executing (claim) ──▶ executed
                                                                   plan: executing ──worker runs steps──▶ executed (reason lists skipped/failed)
preview-only tool approved ──▶ approved  (reason "approved; this tool is preview-only")
```

Code: `scheduleApproval` `approval-inbox.service.ts:317-390`; `undoScheduledApproval` `:410-439`; `handBack` `:496-539`; `commitScheduledApproval` `:545-657`; `decideApproval` `approval-gate.service.ts:325-428` (failure → `pending` at `:393-399` and `:420-426`); plan claim `handPlanToWorker` `approval-inbox.service.ts:663-674`; rule hand-back `handToPerson` `claude-trust.service.ts:287-301`.
View membership (`whereFor`, `approval-inbox.service.ts:104-122`): Waiting = pending/scheduled **and FLEET_TOOLS** and not snoozed. Decided = approved/executed/rejected/executing/superseded (every tool). Expired = expired (every tool). Outside = pending/scheduled, not FLEET_TOOLS, not snoozed.

### 2.4 Expiry

`EXPIRY_HOURS = 24` (`approval-gate.service.ts:52`), set at creation (`:163`), on amend (`agent-fleet-approvals.routes.ts:561`), on plan creation (`change-plan.service.ts:184`), and restamped on every hand-back or failed execution (`approval-inbox.service.ts:527`, `:625`; `claude-trust.service.ts:298`). The sweep `runApprovalMaintenance` (`approval-inbox.service.ts:1172-1218`) runs every 30 s from the scheduler (`apps/api/src/jobs/approval-maintenance.job.ts:39`, `runtime/scheduler.ts:933-941`) through clustered cron, and is not gated on fleet flags. Each pass expires pending rows past `expiresAt`, commits up to 100 due scheduled rows, and drains plans. Approve refuses an already-expired row (`approval-inbox.service.ts:350`, `:373-375`). A snooze can never pass `expiresAt` (`agent-fleet-approvals.routes.ts:615-619`).

### 2.5 How a Claude request is born (MCP door)

`runToolForClaude` (`apps/api/src/services/mcp/mcp-tool-call.ts:243-299`):
1. Creates an `AgentRun` (`agentKey 'claude'`, `via 'claude'`, `userId`, `oauthGrantId`, `input` with secret args redacted).
2. Checks the kill switch, then the business name.
3. Calls `runOrQueueTool(name, args, principal, run.id, { forceAsk: !tool.readOnly, rule: claudeGateRule(principal) })`.

The gate (`approval-gate.service.ts:102-175`):
- Resolves policy. The rule's `refusal` stops the call when the level is `off`.
- Dry-runs as the person (`callTool`).
- Control tools branch to `askedFor` (`:196-240`): undo-change requests a new request, `submit-change-plan` goes to `queuePlan`, confirm-change goes to `confirmByCode`.
- Otherwise it creates the `AgentApproval` (pending, raw preview, 24 h), then `decideByRule`.

The rule (`claudeGateRule`, `mcp-tool-call.ts:115-158`) decides by level:
- `ask`: a person decides.
- `confirm`: a person, or the asker in Claude with a 2FA code. `summary` and `planHash` are stored on the row.
- `auto`: refused for missing `nexus.run`, Pause, limits, or the daily cap (`autoRefusal`, `claude-trust.service.ts:192-205`). Otherwise `scheduleApproval(via 'auto')`, so the row is already `scheduled` when Claude gets its answer.

The verdict's `why` (why a person must decide) is returned **to Claude only and never stored**. Claude's answer (`answer`, `:161-227`) holds `status` (`waiting_for_approval` / `runs_by_rule`), `approvalId`, `expiresAt`, `approveAt` = the plain page URL (`approvalsPageUrl :61-67`, no `?item=`), the preview, optional `plan`, `undoes`, `trust` and `confirm`.

Other producers: the in-app assistant (`tool-loop.service.ts:113`), the copilot button (`requestApproval`, `approval-gate.service.ts:282-300`), Activity-page undo (`change-undo.service.ts:43`, which approves at once as the clicker), `pricing-watchdog.ts:156`, `listing-quality-keeper.ts:202`, `fleet-council.service.ts:165`. None of them uses the trust rule; it applies only to the Claude door.

### 2.6 Change plans (`apps/api/src/services/agents/change-plan.service.ts`)

- **Queue** (`queuePlan :109-220`): up to 200 steps (`PLAN_MAX_STEPS`). Each step is dry-run as the person. Any refusal stores nothing and returns per-step refusals. Otherwise one `AgentApproval` (`toolName submit-change-plan`, riskTier high, `args {title, steps:N}`, `preview {action, title, summary, kinds[], totals{steps, reachOutside}}`, `summary`, `planHash` = sha256 of title + steps), plus one `AgentPlanStep` per step, in one transaction. A plan runs by rule only when every step may (`planRuleRefusal`, `claude-trust.service.ts:219-259`).
- **Approve**: the person needs every step's permissions (`planApprovalRefusal`, `approval-inbox.service.ts:393-404`), then the same 20-s window. Commit claims `executing` and enqueues BullMQ `agent-plan-<id>`; with no worker, the sweep runs it (`drainPlans :391-...`).
- **Run** (`runPlan :325-373`, `runStep :255-320`): steps run in order. Each one claims pending → executing, re-checks the rule (auto), re-checks the approver's permission, re-checks staleness, executes as the approver, and records an AgentChange. A stale or refused step is `skipped`, a failing one `failed`, and the rest go on. A step stuck in `executing` over 10 min is marked failed ("may or may not have changed something"). At the end the approval becomes `executed`, with `reason` "X of N changes ran; Y skipped, Z failed".
- **Amend** (`amendPlan :506-565`): untick → a new smaller plan re-checked as the person; the original is `superseded`.
- **Read** (`planView :448-500`): steps with status, reason and changeId; previews filtered by the reader's permissions.

### 2.7 After Approve: execution and how the result is recorded

Approve does not execute. It parks the row (`scheduled`, 20 s). Commit (`commitScheduledApproval`) runs these steps, in order:
1. If the row is rule-run, re-check the rule.
2. Re-check the approver now (`deciderPrincipal`).
3. If the row is a plan, hand it to the worker.
4. Check staleness: re-run the tool's dry run and compare `MATERIAL_PREVIEW_FIELDS[tool]` (`approval-inbox.service.ts:684-925`, 119 tools). A tool with no entry fails closed (`:1004-1009`).
5. Release scheduled → pending, then `decideApproval` claims `executing` and runs `executeTool` **inside the HTTP request** of `/commit` (or the sweep).
6. Set the status to `executed` or back to `pending` with `reason`, and record an `AgentChange` (`recordExecutedChangeSafely`), plus a control-audit row and an exemplar.

On screen, success means the row disappears from the outside list and appears under Decided as "Approved — and it ran". Failure brings the row back as pending with a danger banner "You approved this, it was attempted, and it failed". There is no toast. What happened afterwards at the channel (queued price pushes, publish result) is told only to Claude through `approval-status` (`tools/approval.tools.ts`), not on this page.

### 2.8 Undo

- **Inside the window**: Undo (scheduled → pending, decision cleared) and Hold (+10 min, repeatable).
- **After execution**: not on this page. `undo-change` (MCP control tool) or the Activity page's Undo creates a new request of the tool's inverse (`AgentTool.undo.request`), through the same gate. A plan's undo is a plan. A concurrent duplicate undo is withdrawn (`approval-gate.service.ts:220-238`, `:255-273`). `undo-ad-change` is the ads-specific inverse tool.

---

## 3. What a grid could show: field → where it lives → reliable?

| Column | Where it lives | Reliable? |
|---|---|---|
| Request id | `AgentApproval.id` | yes |
| Tool (machine) | `toolName` | yes |
| Human title | registry `AgentTool.title`. Returned by `/outside` only (`title`); `/approvals` (waiting / decided / expired) does **not** return it | yes, if the API adds it everywhere |
| Area / category | registry `category` (fulfillment, products, advertising, listings, pricing, automation, orders, catalog, platform, comms, settings) | yes, but no approvals endpoint returns it (only `/api/claude/trust`) |
| Status | `status` (8 values) + `decisionVia` + `executeAfter` | yes |
| Risk tier | `riskTier` | yes, but weak: high on most tools, and inverted against consequence (`ApprovalCard.tsx:938-960`) |
| Reversibility | registry, via `reversibilityOf` on every row | yes |
| Reaches marketplace or buyer | registry `openWorld` | `/outside` only |
| Requested / expires / runs at | `requestedAt`, `expiresAt`, `executeAfter` | yes (`expiresAt` restamps on hand-back) |
| Snoozed until | `snoozedUntil` | full row on `/approvals`; **not** in the `/outside` payload |
| Decided by / at / via | `decidedBy`, `decidedByUserId`, `decidedAt`, `decisionVia` | yes (cleared on hand-back) |
| System reason / person's note | `reason` / `operatorNote` | yes (`operatorNote` not in `/outside`) |
| Who asked: door | `AgentRun.via` + `agentKey` + `mode` (`requestDoor`, `approval-gate.service.ts:306-310`) | yes, through a join. `/outside` returns `originKey` only |
| Who asked: person / connection | `AgentRun.userId`, `AgentRun.oauthGrantId` | stored, **not returned** by any approvals endpoint |
| Business | `workspaceId` (RLS: a page only sees its own) | yes, implicit |
| Plan: summary / steps / kinds / hash | `summary`, `planHash`, `preview.kinds`, `preview.totals.steps`; `AgentPlanStep` rows | yes, for plans |
| Why it waits for a person (trust verdict) | **not stored** (RuleVerdict.why goes to Claude only) | no |
| Current trust level of the tool | `AgentTool.claudeTrust` (per business), ceiling `maxClaudeTrust` | yes, read live |
| **Target product / SKU** | inside `args` under tool-specific keys: `productId` (≈37 tools), `sku` (≈18), `productIds` (6), `listingId(s)` (≈11), `products` / `items` / `changes` arrays. Or in `preview` by convention (`sku`, `product` / `productName`, `listing`; `productEntityOf`, `approval-words.ts:389-397`) | **no**. No column, no index. ≈60 of 115 parsed change tools have no product key (ads, orders, shipping, rules, settings, suppliers). Bulk tools hold up to 250 products; previews keep 20 lines. Key counts are a static regex heuristic over tool input schemas, not verified |
| Market / channel | `args.channel` (≈17), `args.marketplace` (≈12), `args.market` (4); preview `campaign.marketplace`, `destination` … | no |
| Campaign / target / order / shipment / PO | args keys (`campaignId`, `targetId`, `orderId`, `shipmentId`, `purchaseOrderId` …); names via `labels` only for ads targets and campaigns (`fleet-labels.service`) | no |
| Before → after | `preview.changes {field:{from,to}}` (the optional convention, `tool-types.ts:53-79`) or a tool-specific shape. 36 tools have hand-written card parsers (`describe()`); others use the generic reader | partial. Adoption of the convention is not verified |
| Totals / warnings / one-line summary | `preview.totals`, `preview.warning(s)`, `preview.summary` or `effect` | optional, per tool |
| Can this viewer approve | computed per request (`cannotApproveFor`, `planApprovalRefusal`) | yes (live) |
| Still true? | computed on demand (`/recheck`) | live only, and costly (re-runs the dry run) |
| What it changed / undone? | `AgentChange` (before / after / undoneAt / outbound) | after execution. Not returned by the approvals endpoints (`/api/claude/activity` has it) |

---

## 4. Known defects, dead code, hidden features (each checked against current code)

Memory-note claims:
- "Labels were discarded once": **fixed**. `setLabels(aj.labels)` (`ApprovalsClient.tsx:1122-1124`) feeds `describe()` for set-target-bid and create-negative-keyword. `/outside` returns no labels; outside cards name entities from their preview.
- "Expiry not shown": **fixed for single cards** (time left in the head `ApprovalCard.tsx:986-991`; "If you do nothing… expires" `:1215-1223`). **Still missing on PlanCard** (`PlanRow`, `PlanCard.tsx:25-30`).
- "Failed execution returns to pending": **true by design**. `approval-gate.service.ts:393-399`, `:420-426`. The commit path clears the decider and restamps 24 h (`approval-inbox.service.ts:610-627`). The card shows a danger banner. A plan has no pending return: failed steps stay failed and the plan ends `executed`.

Defects (verified by reading; none were run):
- **D1 Two queues, one count.** Waiting tab, counts and S2 only know the 3 FLEET_TOOLS (`approval-inbox.service.ts:65`, `:114-119`, `:130-137`). Claude's other requests live in the uncounted outside section, and the "Nothing is waiting for you" empty state (`ApprovalsClient.tsx:1434-1436`, `:759-790`) can render above them.
- **D2 "Reject the plan" always fails.** `PlanCard.tsx:216` sends no reason, and the route answers 400 "a one-line reason is required to reject" (`agent-fleet.routes.ts:312-314`).
- **D3 Action errors vanish.** `post()` sets `err` (`ApprovalsClient.tsx:1226`). The `after()` → `refresh()` → `load()` that follows runs `setErr(null)` (`:1150`), so a 403 or 409 on decide, undo, commit, snooze or reject-all disappears within one fetch.
- **D4 Outside list silently capped** at the 100 oldest (`agent-fleet-approvals.routes.ts:734-735`). The client ignores `count` and `cap` (`ApprovalsClient.tsx:1145`).
- **D5 Decided tab mislabels Claude decisions.** Any non-fleet row gets "from before the fleet" (`ApprovalLists.tsx:397-402`) and the note "None of these N are your decisions… answered by a setup script… records no person" (`ApprovalsClient.tsx:1523-1538`). `isFleet` is just `FLEET_TOOLS.includes` (`approval-inbox.service.ts:191`). "eighteen" is hard-coded in `ApprovalLists.tsx:488-493` and `HowApprovalsWork.tsx:120-125`.
- **D6 Rule hand-backs show no banner.** `handToPerson` writes `not run by rule — …` (`claude-trust.service.ts:297`), and `classifyComeback` only matches `not run —` (`ApprovalCard.tsx:673`). The trust verdict's `why` is never stored, so the page cannot say why a request was not automated.
- **D7 Bulk approve cannot succeed.** All 3 FLEET_TOOLS now have `execute` (`tools/ads-propose.tools.ts`), and `previewBulk` blocks any executable row (`approval-inbox.service.ts:1424-1450`; `bulkDecide` re-checks at `:1544-1549`). The outside section has no checkboxes (`ApprovalsClient.tsx:1005-1018`). Bulk reject works, fleet groups only. Bulk approve also requires one tool **and one worker**.
- **D8 Fail-open wording.** If `gate-state` fails, `canExecute` is false for every fleet card (`ApprovalsClient.tsx:1287-1290`). Executable ad changes then say "changes nothing on Amazon" and lose the ack tick (`ApprovalCard.tsx:897`, `:1141-1147`).
- **D9 Plan progress is invisible.** An approved plan leaves the outside list once `executing`. The steps are fetched once on mount (`PlanCard.tsx:118-129`). The Decided record shows only the reason string, with no step list.
- **D10 Snoozed rows** have no view and cannot be brought back from the UI. `onSnooze(id, null)` is never called (`ApprovalCard.tsx:1326`), so the `unsnooze` route is unreachable.
- **D11 No deep link to a Claude request.** The MCP result links the bare page (`mcp-tool-call.ts:61-67`). `?item=` filters only the fleet list (`ApprovalsClient.tsx:1301-1304`).
- **D12 Requester anonymous.** The page shows "Someone using Claude", and `/outside` selects only `agentKey` and `mode` (`agent-fleet-approvals.routes.ts:741-744`). In-app assistant runs read as "a system that runs outside the fleet" (`ApprovalsClient.tsx:224-237`).
- **D13 Polling cost.** Every 10 s per visible tab: 5 GETs. `listInbox('waiting')` calls `trackRecords()`, which loads **every** approved, executed and rejected row of the business plus their runs (`approval-inbox.service.ts:167`, `:1110-1129`). `gate-state` runs about 10+ queries (`agent-fleet-approvals.routes.ts:144-355`). This is relevant to the Neon data-transfer cost note; the impact is not measured.
- **D14 Page-global busy.** One POST in flight freezes every card (`ApprovalsClient.tsx:1103`).
- **D15 Fleet-era copy** (PageDescription `:286-294`, HowApprovalsWork `:74-145`, outside header "Until this section existed…" `:960-970`, S2 conditions) describes a fleet queue, not Claude's requests.
- **D16 Humanized tool ids.** `ParkedRow` and `RecordList` use `toolCardFor(...).shortAsk` (`ApprovalLists.tsx:213`, `:347`). For the ≈83 tools without a TOOL_CARD that reads "set stock" rather than the registry title.
- **D17 Record lists unpaged.** Decided and Expired are capped at 100 (max 200) with no paging (`agent-fleet.routes.ts:286`, `approval-inbox.service.ts:168-171`). Expired is ordered by `decidedAt desc`, which is usually null for expired rows, so the order is effectively undefined (not verified on data).
- **D18 Schema status comment** lists 6 values; the code uses 8 (`schema.prisma:13558`).
- **D19 Gate-state tool list** is hand-maintained (11 tools, `agent-fleet-approvals.routes.ts:167-179`) against its own header (`:26-29`).
- **D20 Missing nav badge.** `page.tsx:4-5` claims a nav badge; there is none (`app-nav.ts:255`).

Hidden or dead but present:
- `GET …/rollup` has no web caller.
- `orchestrationId` and `assignmentId` are returned but only `?assignment=` uses them.
- The server-side `amend` works for **any** tool with a handler, but the UI exposes it for 2 tools only.
- The `confirm` level stores `summary` and `planHash` on single rows, but the page never shows them.
- Hold, recheck and track record exist.
- `ExampleCard` renders only while the fleet cannot ask.
- `listApprovals()` (legacy) still powers Settings › AI.
- `FleetTab` still renders the old `ApprovalInbox`.

---

## 5. Volume: tools that create approvals

Registry: `apps/api/src/services/agents/tool-registry.ts:73-171`, 46 tool files. Static parse of `services/agents/tools/*.ts`, plus 4 factory-built automation tools (`automation-change.tools.ts:195-260`, `:383-440`) and `submit-change-plan` (`name: PLAN_TOOL`):

- **203 tools**: **119 executable change tools**, 3 control tools (`submit-change-plan`, `undo-change`, `confirm-change`), 81 read-only.
- 119 = the keys of `MATERIAL_PREVIEW_FIELDS` exactly (every executable tool must declare one, or its approval fails closed).
- Ceiling `maxClaudeTrust`: **ask 66 · confirm 29 · auto 24**. Reversibility: full 64+4, partial 30, none 21. openWorld (reaches marketplace or buyer): 60 + 3 of the 4 factory tools.
- `alwaysAsk` (a hard floor, never auto-run by policy) is on most high-risk tools.
- Every change from Claude is stored as an approval whatever its policy (`forceAsk: !tool.readOnly`, `mcp-tool-call.ts:286`).

Change tools by area (tool name → max trust):

- **Ads, Amazon (11)**: set-target-bid (confirm), create-negative-keyword (confirm), graduate-keyword (confirm), set-campaign-budget, set-placement-multipliers, bulk-ad-bid-change, suppress-campaign (confirm), restore-campaign, set-campaign-live-writes, create-ad-campaign, undo-ad-change.
- **Ads, eBay (5)**: set-ebay-ad-rates, promote-ebay-listings, set-ebay-campaign-budget, ebay-keywords-change, create-ebay-campaign.
- **Automation / rules (11)**: save-ad-rule (confirm), decide-automation-suggestions (confirm), set-ad-guardrail (auto), tune-ad-engine (confirm), steer-fleet (confirm), save-price-rule, save-ops-rule (confirm), turn-up-automation (confirm), turn-down-automation (auto), stop-automation (auto), resume-automation.
- **Price (13)**: set-price (auto), bulk-price-change (auto), set-master-prices (auto), bulk-listing-price-change (auto), set-listing-price, set-price-bounds, resend-prices, set-pricing-rule (auto), set-promotion, schedule-price-change (confirm), set-ebay-price-promotion, set-tier-prices (confirm), set-product-costs (confirm).
- **Stock / warehouse / sync (10)**: set-stock (confirm), transfer-stock (auto), stock-count (auto), reconcile-stock-count (confirm), reserve-stock (confirm), set-stock-location (confirm), set-stock-source, bulk-listing-stock (confirm), set-stock-policy, set-listing-stock.
- **Listings / publish (11)**: publish-listing, close-listing, reopen-listing, create-draft-listings, remove-draft-listings, set-listing-fields, revert-listing-change, set-listing-sku, link-channel-id, unlink-channel-id, save-listing-template.
- **Content / text (6)**: set-content, set-listing-content, bulk-content-change, set-shopify-content, apply-content (auto), bulk-attribute-change (auto).
- **Products / identity / photos (13)**: create-product, create-variations, discard-new-products, set-product-sku, set-gtin, set-brand, fix-parent, merge-duplicate-products, set-product-tags (auto), move-workflow-stage (auto), arrange-photos, add-photo-from-url, remove-unused-photo.
- **Catalog structure / mapping / data (6)**: save-attribute (confirm), save-product-family (confirm), save-category (confirm), save-channel-mapping, import-catalog, rollback-bulk-operation.
- **Orders / customers / reviews / fiscal (9)**: update-order (confirm), update-customer (auto), cancel-order, sync-orders-now, triage-reviews (auto), request-review, reply-to-review, send-customer-message, issue-fiscal-document.
- **Shipping / returns / FBA (11)**: create-shipments (auto), update-shipment (confirm), buy-shipping-label (confirm), void-shipping-label (confirm), confirm-shipment, schedule-pickup, create-return (confirm), update-return (confirm), dispose-return-items, issue-refund, plan-fba-shipment.
- **Suppliers / POs / replenishment (8)**: upsert-supplier (auto), draft-purchase-order (auto), advance-purchase-order, cancel-purchase-order, receive-stock (confirm), update-inbound-shipment (confirm), replenishment-action (auto), email-supplier.
- **Platform / settings (5)**: set-alert-rule (auto), acknowledge-alerts (auto), organize-image-library (auto), save-view (auto), set-business-settings.

(Unmarked = ceiling `ask`. These counts sum to 119.)

Per-tool metadata (title, category, risk, reversibility, openWorld, trust ceiling) comes from a static regex parse, not from executing the registry. Spot-checked against `tool-contract.vitest.test.ts` expectations only by count (66/29/24 matches the `maxClaudeTrust` occurrences).

---

## 6. Tests a rebuild must keep green or replace

Web (`apps/web`, vitest):
- `src/app/fleet/approvals/ApprovalCard.cannotApprove.vitest.test.ts`: disabled Apply plus reason, handed-back text.
- `src/app/fleet/approvals/ApprovalCard.generic.vitest.test.ts`: generic card, preview convention, never raw JSON.
- `src/app/fleet/approvals/approvals-words.vitest.test.ts`: approve labels, bulk / channel lines, outside heading, Claude door sentence, comeback Banner, reversibility from the row, ads cards. It also reads `ApprovalInbox.tsx` (`:266`).
- `src/app/fleet/approvals/content-approval.vitest.test.ts`: content diff and its card.
- `src/app/fleet/approvals/planSteps.vitest.test.ts`: the step list is one tab stop, phone stacking.
- `src/app/fleet/approvals/planWords.vitest.test.ts`: kind sentence, counted button, step line, filter.
- `src/app/settings/ai/claude/claudePage.vitest.test.ts`: asserts `PlanCard.tsx` uses `<PlanStepList` and **not `<NexusGrid`**, no raw controls or Tailwind, and that `planCard.css` uses tokens only (`:49-51`, `:54-73`).
- `src/lib/command-key.vitest.test.ts`: the `plan-amend` keyed command (`:222`).
- `src/app/_shared/app-rail-active.vitest.test.ts`: the rail entry `/fleet/approvals`.
- Ratchets: `scripts/check-raw-primitives-ratchet.mjs`, `check-css-hex-ratchet.mjs`, `check-css-radius-ratchet.mjs`, `check-css-ds-shadow-ratchet.mjs` (approvals files pinned). A new file starts at zero.
- No Playwright spec covers this page (`apps/web/tests`, `apps/web/smoke`).

API (`apps/api`, vitest; run from `apps/api`):
- Routes: `src/routes/agent-fleet-approvals.cannot-approve.vitest.test.ts`, `src/routes/agent-fleet-approvals.plan.vitest.test.ts`, `src/routes/claude-control.routes.vitest.test.ts`, `src/routes/mcp.routes.vitest.test.ts`, `src/routes/mcp-cross-business-postgres.vitest.test.ts` (real-PG, expect 26).
- Inbox and sweep: `src/services/agent-fleet/approval-inbox.vitest.test.ts`, `approval-undo.vitest.test.ts`, `approval-decider-recheck.vitest.test.ts`, `approval-staleness.vitest.test.ts`, `approval-staleness-coverage.vitest.test.ts`, `approval-staleness-jsonb.vitest.test.ts`, `fleet-council.vitest.test.ts`.
- Gate, plans, trust: `src/services/agents/approval-gate.vitest.test.ts`, `change-plan.vitest.test.ts`, `change-plan-postgres.vitest.test.ts` (real-PG), `change-record.vitest.test.ts`, `claude-trust.vitest.test.ts`, `claude-confirm.vitest.test.ts`, `claude-activity.vitest.test.ts`, `call-tool.vitest.test.ts`, `tool-contract.vitest.test.ts`, `tool-policy.vitest.test.ts`.
- MCP: `src/services/mcp/mcp-tool-call.vitest.test.ts`, `mcp-server.vitest.test.ts`.
- Per-tool suites that queue or decide approvals: 30+ files under `src/services/agents/tools/*.vitest.test.ts`, `src/services/{pricing,stock,supply,advertising}/*` (44 vitest files reference `agentApproval`).
- Ratchet: `scripts/check-route-prisma-ratchet.mjs` pins `agent-fleet-approvals.routes.ts` at 16 Prisma calls. A new route file starts at 0.

---

## Not verified

- Production state (how many approvals exist, whether `canAnythingArrive` is true, Claude trust levels per tool for Xavia / Motovento). Nothing was read from any database.
- How far tools adopt the preview convention (`summary` / `changes` / `sku`). Previews are built in domain services, not counted.
- The arg-key counts in §3 come from a regex over tool input schemas (heuristic).
- Runtime behaviour of D2, D3 and D13 (code reading only; not reproduced in a browser).
