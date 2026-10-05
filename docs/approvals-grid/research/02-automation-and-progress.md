# 02 — Automation and progress model (read-only research, 2026-10-05)

Worktree `/private/tmp/feat-approvals-grid` at `7039b95ef`. Paths are relative to the repo root; `api/` = `apps/api/src/`,
`web/` = `apps/web/src/`. Everything below was read in code. Items marked **(not verified)** were inferred and not
run or traced end to end.

## Summary
1. Claude's automation is **per business × per tool**: `AgentTool.claudeTrust` (`off | ask | confirm | auto`, default `ask`) plus `AgentTool.claudeLimits` (Json, in the tool's own zod `limits` schema). There is no per-product, per-channel, per-connection or time-boxed scope.
2. Each tool has a **code ceiling** (`maxClaudeTrust`). Only **24 change tools** can ever be `auto`. Publishing, listing price/stock, all content tools, drafts/fields, identity, photos and most ads tools are capped at `ask`. Stock counts, labels, returns, rules and bids are capped at `confirm`.
3. **Brakes** are per business (`AgentAutonomy`): Pause, a daily cap (default 200 rule-runs in 24 h), and an **automatic pause** after 5 stale or failed rule-runs within an hour. The Claude connection also needs the `nexus.run` OAuth scope, or nothing runs by rule.
4. **Raising** a level, loosening limits, raising the cap or resuming all need `settings.security.manage` **plus a fresh 2FA code**. Lowering, tightening and Pause need only `ai.run`. Claude has no tool to change any of it.
5. The settings screen is **Settings › AI › Claude › Rules** (`web/app/settings/ai/claude/`). The API is `GET/PUT /api/claude/trust[/:tool]`, `PUT /api/claude/autonomy` and `POST /api/claude/pause|resume`. The Approvals page has **no link to it and no automation control**.
6. **"Automate this kind" can map onto `PUT /api/claude/trust/:tool {level:'auto', limits, code}` with no schema change.** It only works for the 24 auto-ceiling tools. A new level applies to **new** requests only; the row in front of you still needs its own approve.
7. The **stop window is 20 s** (`UNDO_WINDOW_MS`), the same for a person's approve and a rule-run. Hold adds 10 min and can be repeated. Undo sends the request back to a person. The window is shown on the Approvals page's parked row and returned to Claude as `runsAt`/`stopAt`.
8. **Execution**: a single change runs **inline** in whichever process commits it: the browser's `POST …/commit` at 0 s on the API, or the 30 s sweep cron on the scheduler. A plan runs as a **BullMQ `agent-plan` job** on the worker, step by step, with step statuses stored. Channel pushes then go through the outbound queue and other per-domain logs.
9. **No live push and no notification**: fleet pages poll every 10 s by design. The MCP server is stateless (no server→Claude push), so Claude must poll `approval-status`. No bell, email or sidebar badge fires when a request waits. The `agent.*` outbox events have **no subscriber**.
10. **Biggest stall today**: every Claude change is stored as a request (`forceAsk`) and defaults to `ask`. A request expires after 24 h. **Bulk approve is refused for any row that can execute**, which means every Claude row (S8.4), so each must be approved one at a time. When a rule does not apply, the reason is told only to Claude and never stored on the row.

---

## 1. Trust / automation settings today

### 1.1 Levels
| Level | Meaning | Code |
|---|---|---|
| `off` | Not offered to Claude (`tools/list` hides it). A call by name is refused before anything runs. | `api/services/agents/tool-types.ts:68-79`; refusal `api/services/mcp/mcp-tool-call.ts:115-123`; hidden in `mcp-server.ts` via `claudeOffTools()` (`claude-trust.service.ts:144-147`) |
| `ask` | A person approves in Nexus. This is the default, and every tool with no row is at `ask`. | `claude-trust.service.ts:111-113` |
| `confirm` | The person who asked approves **in Claude** with a 6-digit TOTP code (`confirm-change`). A person can still approve in Nexus. | `claude-confirm.service.ts:1-15, 111-169` |
| `auto` ("runs_by_rule") | Scheduled **as the person who asked** (`decisionVia='auto'`), through the same 20 s window and commit. It applies only inside the tool's limits, with `nexus.run`, outside a Pause and under the daily cap. | `claude-trust.service.ts:21-25, 192-205`; `mcp-tool-call.ts:125-158` |

- **Ceiling**: `trustCeiling()` returns `ask` for read and control tools, and otherwise `tool.maxClaudeTrust ?? 'ask'` (`claude-trust.service.ts:83-86`). A stored level above the ceiling is read as the ceiling (`:126`).
- **Contract rules** (`tool-contract.vitest.test.ts:121-127`): every change tool states a ceiling. An irreversible tool (`reversibility:'none'`) is `ask` at most. `auto` needs `limits` and `withinLimits`.
- `alwaysAsk` does **not** block Claude's `auto`. It only forces `requiresApproval` in the in-app policy (`tool-policy.service.ts:1-12`). For Claude, every non-read call is `forceAsk` anyway (`mcp-tool-call.ts:286`), and the trust level decides who approves. Example: `set-price` has `alwaysAsk: true` **and** `maxClaudeTrust: 'auto'` (`tools/mutate.tools.ts:101-106`).

### 1.2 Scope of a rule, and limits
- The scope is **one business × one tool name**: the `AgentTool` row is unique on `(workspaceId, name)` (`packages/database/prisma/schema.prisma:13521-13545`). Row-level security keeps businesses apart. Nothing narrower exists: no product, SKU, channel, market, connection, person, time window or count.
- **Limits** are the tool's own zod object. `limits.parse({})` gives the code default. `withinLimits(preview, limits)` returns null when the change is inside, or a sentence saying why not. Naming convention (`tool-types.ts:258-268`): `max…` (lower is tighter), `min…`, `allow…` booleans, ordered `max…` enums, allow-lists. `limitsTighten()` uses that convention to decide whether a change is a brake (`claude-trust.service.ts:436-466`).
- Examples of limits:
  - `set-price`: `maxChangePercent` (default 10 %) (`mutate.tools.ts:48-67`)
  - `bulk-price-change` / `set-master-prices`: `maxProducts` 25 and `maxChangePercent` 10 (`bulk.tools.ts:60-81`)
  - `bulk-attribute-change`: `maxProducts` 25 (`bulk.tools.ts:84-93`)
  - `bulk-listing-price-change`: `maxListings` and `maxChangePct` 10 (`price-change.tools.ts:92-104`)
  - `apply-content`: `fields` allow-list (`mutate.tools.ts:247-263`)
  - `set-ad-guardrail`: `allowLoosen` false (`automation-change.tools.ts:490`)
  - `stop-automation`: `areas` (`:407`)
- Plans (`submit-change-plan`) run by rule **only when every step's tool is at `auto`** and every step is inside its limits, with room under the cap for **all** steps. One `ask` step sends the whole plan to a person (`claude-trust.service.ts:219-257`).

### 1.3 Storage (Prisma, `packages/database/prisma/schema.prisma`)
- `AgentTool` (13521): `claudeTrust String @default("ask")`, `claudeLimits Json?`, `updatedBy`. It also holds the in-app policy fields (`riskTier`, `enabled`, `requiresApproval`, `rateLimitPerHour`, `dailyBudgetUSD`).
- `AgentAutonomy` (13636): one row per business. `autoPausedAt`, `autoPausedBy` (a name, or "Nexus"), `pauseReason`, `dailyAutoCap @default(200)`.
- `AgentApproval` (13548): `status` (pending | scheduled | executing | executed | approved | rejected | expired | superseded), `decisionVia` (nexus | auto | claude-confirm), `executeAfter`, `expiresAt`, `snoozedUntil`, `reason` (the system's words), `operatorNote` (the person's words), `summary`, `planHash`.
- `AgentPlanStep` (13609), `AgentChange` (13654), `AgentControlAudit` (18525; every rule change is audited under `charterKey 'claude'`, action `policy | pause | resume`, via `recordControlChange`).

### 1.4 Brakes
- **Pause**: `pauseAutoRuns` (`claude-trust.service.ts:353-390`). It is instant and needs no code. It hands every `scheduled` + `auto` row back to `pending` in one transaction and publishes `agent.autorun.paused`.
- **Resume** needs settings.security.manage + 2FA (`:393-410`).
- **Daily cap**: `autoRunsInLastDay` counts single rule-runs plus plan steps (`:173-180`). It is checked when a rule-run is scheduled (`:200-203`) and again after scheduling, to catch a race (`overDailyCap` / `withdrawRuleSchedule`, `:279-307`).
- **Auto-pause**: after `AUTO_PAUSE_FAILURES=5` audit rows `stale_refused | permission_refused | execution_failed` with `decisionVia auto` within 1 h, Nexus pauses itself (`:46-51, 327-347`).
- **At commit**, a rule-run is checked again. If the business paused, lowered the level or tightened the limits during the window, it goes back to a person (`autoCommitRefusal` `:313-321`, called at `approval-inbox.service.ts:560-563`).
- **`nexus.run` scope**: without it every change waits for a person, whatever the level (`claude-trust.service.ts:193-195`; `oauth-config.ts:16-21`; run without write is dropped, `oauth-server.ts:214`). **(not verified)** whether the Claude connect screen offers `nexus.run` by default.

### 1.5 Who may change it — UI and API
- **UI**: Settings › AI › Claude, tabs Rules and Activity (`web/app/settings/ai/claude/ClaudeClient.tsx`, `RulesPanel.tsx`, `StepUpModal.tsx`, `claudeApi.ts`). The Rules tab lists one row per tool: a Level select (only levels ≤ ceiling), "At most", "Limits for Auto" (a dialog), the Pause switch and the daily cap. Raising opens the 2FA `StepUpModal`. The **limits form edits only number/integer limits** (`claudeWords.ts:117-129`). Boolean, enum and list limits (apply-content `fields`, `allowLoosen`, `allowRaise`, `areas`, …) cannot be edited in the UI today and stay at their defaults.
- **API** (`api/routes/claude-control.routes.ts`):
  - `GET /api/claude/trust` (72) → `listClaudeRules()`: every offered tool's level, stored level, ceiling, levels, limits, defaultLimits, `limitsSchema` (JSON Schema), reversibility, openWorld, plus the autonomy and `autoRunsLastDay` (`claude-trust.service.ts:632-662`)
  - `PUT /api/claude/trust/:tool {level?, limits?, code?}` (74) → `setClaudeRule` (`:502-572`)
  - `PUT /api/claude/autonomy {dailyAutoCap, code?}` (79)
  - `POST /api/claude/pause {reason?}` (84)
  - `POST /api/claude/resume {code}` (89)
  - `POST /api/claude/changes/:id/undo` (94)
  - `GET /api/claude/activity` (102)
- **RBAC**: `/api/claude/*` reads need `ai.view` and writes need `ai.run`. `POST /api/claude/resume` needs `settings.security.manage` (`api/lib/auth/permissions-manifest.ts:136-137`). The service then refuses any raise or loosening without `settings.security.manage` and a fresh single-use 2FA code (`claude-trust.service.ts:67-78, 412-428, 537-546`).
- Claude itself has **no** tool to change trust: "raising its own levels and limits is never for Claude" (`claude-control.routes.ts:15-18`).

### 1.6 Ceilings per tool (from `maxClaudeTrust` in `api/services/agents/tools/*.ts`)
- **Can be `auto` (24)**:
  - Prices: set-price, bulk-price-change, set-master-prices, bulk-listing-price-change, set-pricing-rule
  - Content: apply-content (master content only, not set-content)
  - Catalogue: bulk-attribute-change, set-product-tags, move-workflow-stage, save-view
  - Platform: set-alert-rule, acknowledge-alerts, organize-image-library
  - Order desk: update-customer, triage-reviews, create-shipments
  - Stock: stock-count, transfer-stock
  - Supply: draft-purchase-order, replenishment-action, upsert-supplier
  - Automations: set-ad-guardrail, turn-down-automation, stop-automation

  Lines: `mutate.tools.ts:104,377`; `bulk.tools.ts:600,679,805`; `price-change.tools.ts:225`; `pricing.tools.ts:177`; `organize-catalog.tools.ts:164,321,530`; `organize-platform.tools.ts:262,497,704`; `order-desk.tools.ts:274,411`; `shipping.tools.ts:119`; `stock.tools.ts:318,521`; `supply.tools.ts:216,450,1402`; `automation-change.tools.ts:223,405,489`.
- **`confirm` at most**:
  - Ads: set-target-bid, create-negative-keyword, graduate-keyword, suppress-campaign
  - Automations: save-ad-rule, save-ops-rule, decide-automation-suggestions, tune-ad-engine, steer-fleet, turn-up-automation
  - Stock: set-stock, reconcile-stock-count, reserve-stock, set-stock-location, bulk-listing-stock
  - Orders and shipping: update-order, create-return, update-return, buy-shipping-label, void-shipping-label, update-shipment
  - Pricing: schedule-price-change, set-tier-prices
  - Structure: save-attribute, save-category, save-product-family
  - Supply: receive-stock, set-product-costs, update-inbound-shipment
- **`ask` only** (a person always approves):
  - Publishing and listings: publish-listing; set-listing-price, set-listing-stock, revert-listing-change (Matrix); close-listing, reopen-listing
  - Content: set-content, set-listing-content, bulk-content-change, set-shopify-content. The comment reads: "the person's Approve in Nexus is the review of the text" (`content-change.tools.ts:556`).
  - Drafts and products: create-draft-listings, remove-draft-listings, set-listing-fields, create-product, create-variations, discard-new-products
  - Identity: set-product-sku, set-gtin, set-brand, set-listing-sku, link-channel-id, unlink-channel-id, fix-parent, merge-duplicate-products
  - Photos: add-photo-from-url, arrange-photos, remove-unused-photo
  - Amazon ads: bulk-ad-bid-change, set-campaign-budget, set-placement-multipliers, restore-campaign, set-campaign-live-writes, create-ad-campaign, undo-ad-change
  - eBay ads: set-ebay-ad-rates, promote-ebay-listings, set-ebay-campaign-budget, ebay-keywords-change, create-ebay-campaign
  - Pricing: set-price-bounds, resend-prices, set-promotion, set-ebay-price-promotion, save-price-rule
  - Orders and customers: send-customer-message, cancel-order, issue-refund, dispose-return-items, request-review, reply-to-review, confirm-shipment, schedule-pickup, sync-orders-now
  - Supply and fiscal: advance-purchase-order, cancel-purchase-order, email-supplier, issue-fiscal-document, plan-fba-shipment
  - Settings and data: set-stock-policy, set-stock-source, save-channel-mapping, save-listing-template, set-business-settings, import-catalog, rollback-bulk-operation
  - Control: resume-automation, confirm-change
- ⇒ The Owner's main Claude workloads (publish, listing content, listing price/stock, drafts, ads bids) **cannot run by rule without a code change to the ceiling**. Each such change has to pass the contract rules in 1.1.

### 1.7 Hard denies
- **Permission deny lists**: no change tool may require `users|roles|invitations|sessions|settings.security|apikeys|webhooks|privacy|integrations.manage`, `channels.connect/disconnect`, `ads.connect`, `admin.repair|purge|restore` or `jobs.manage`. No tool at all may require the four `settings.*.manage` (`api/services/agents/tool-never.vitest.test.ts:17-41`).
- **Ceilings** (1.6): `none`-reversibility tools are ask-only. Read and control tools are off/ask only.
- **In-tool guards** (run in every dry run, so also at the staleness re-check):
  - FBA quantity is never written (`tools/listing-stock.tools.ts:10,166`; `tools/stock-sync.tools.ts:19-22,261-267`)
  - The ads bid floor and suppression flag (`tools/ads-tool-guards.ts:11,99`)
  - The ads write gate (`WRITE_GATE_DENIED`, counted in `approval.tools.ts:178-186`)
  - Price bounds (the `set-price` preview checks them, per `mutate.tools.ts:57`)
- **Bulk approve guard** (`approval-inbox.service.ts:1424-1450, 1544-1548`): a bulk approve may span only one tool and one worker, and **no executable row**. In practice every Claude row is blocked from bulk approve.

### 1.8 The short stop window
- `UNDO_WINDOW_MS = 20_000` (`approval-inbox.service.ts:308`). `scheduleApproval` sets `status 'scheduled'`, `executeAfter = now+20 s` and `decisionVia` (`:317-390`). The same applies to a person (`nexus`), a rule (`auto`, from `mcp-tool-call.ts:146`) and a confirm (`claude-confirm`, `claude-confirm.service.ts:148`).
- **Stop**:
  - Undo returns the row to `pending`; a rule-run then waits for a person (`POST /api/agent/fleet/approvals/:id/undo`; `undoScheduledApproval` `:410-439`)
  - Hold (`POST …/:id/hold`) pushes `executeAfter` to now+10 min; it can be pressed again (`agent-fleet-approvals.routes.ts:431-466`)
  - Pause the whole business (1.4)
- **Run**: the browser's countdown calls `POST …/:id/commit` at 0 s (`web/app/fleet/approvals/ApprovalLists.tsx:254-271`). Otherwise the scheduler's `approval-maintenance` cron runs every 30 s (`api/jobs/approval-maintenance.job.ts:14-16,37-49`; started in `api/runtime/scheduler.ts:940`). So a rule-run lands about 20-50 s after Claude's call when nobody has the page open.
- **Where it is shown**:
  - The Approvals page's parked row: "Runs by your rule — Running in N seconds — the undo window. Nothing has changed yet." with Hold and Undo (`ApprovalLists.tsx:276-330`; `byRule={a.decisionVia==='auto'}` at `ApprovalsClient.tsx:988`)
  - Claude's tool answer: `status:'runs_by_rule', runsAt, stopAt` (`mcp-tool-call.ts:163-177`)
  - The page shows a parked row **only while the page is open**. Nothing notifies the Owner (section 4).

## 2. Mapping "Automate this kind of request" onto the existing model

The model's unit of "kind" is **the tool**, in this business, inside limits. Options:

**A. "Let Claude run this kind by itself" = set this row's tool to `auto` (no schema change).**
- **Call**: `PUT /api/claude/trust/:toolName {level:'auto', limits?, code}`. The grid reuses `claudeApi.setRule` and `StepUpModal` from Settings › AI › Claude.
- **Shown only when** the row's tool ceiling is `auto` (24 tools). The read is `GET /api/claude/trust`, which has `ceiling` and `levels`.
- **Other ceilings**: show the reason instead of a button ("a person always approves publish-listing" for `ask`; "can be set to confirm in Claude at most" for `confirm`).
- **Per row**: compute **"would this one have run by rule?"** with the tool's `withinLimits(preview, rule.limits)` at read time. The preview is stored on the row; this is a pure function, so no schema is needed. Show "inside your limits" or the sentence ("the master price moves 14 %, more than the 10 % allowed"), and offer the limits dialog prefilled.
- **Keeps control**: it needs `settings.security.manage` + a fresh 2FA code, is audited (`AgentControlAudit` `policy`), and is braked by Pause, the daily cap and auto-pause. Lowering back to `ask` is one click with no code.
- **Important**: setting `auto` does **not** decide the row already waiting. `decide()` ran once, at queue time (`approval-gate.service.ts:166`). The UI must either also approve the row ("Approve + automate", two calls: `decide` then `PUT trust`) or say plainly that it applies to the next requests.

**B. "Let Claude confirm this kind with my code" = set `confirm` (no schema change).**
- Same call, `level:'confirm'`. It covers the 29 confirm-ceiling tools as well.
- Claude still has to ask the person for a 6-digit code (`confirm-change`), so it is **not** uninterrupted. It moves the interruption from the Nexus page into the chat. It needs 2FA enrolled and `nexus.run`.

**C. A narrower guarded rule (per product / channel / SKU / time-box / N runs).**
- Not in the model today.
- **Per product or channel**: new limit keys in a tool's `limits` zod schema plus `withinLimits` logic. That is a code change per tool; `claudeLimits` is Json, so **no migration**. Allow-lists already have a tighten direction (`limitsTighten` lists).
- **Time-boxed ("for the next 2 h") or count-boxed ("next 20")**: needs a new column (e.g. `AgentTool.claudeTrustUntil`) or a revert job. **Schema change**, more code, and a new brake to reason about. Not recommended under "only what is necessary".

**D. "Approve all like this" / "approve the rest of this plan".**
- A plan already is one approval. After the one approve, all its steps run (re-checked one by one), so "the rest of the plan" adds nothing new.
- "Approve all N waiting rows of this tool" is **refused today** by S8.4 (`approval-inbox.service.ts:1446-1450`), because every Claude row is executable. Relaxing it for one-tool, one-origin selections is a code change only, but it reverses a deliberate safety rule, so it is an Owner decision.
- The no-code lever is to **make Claude bundle work into `submit-change-plan`** (up to 200 steps, one approve). The `nexus:change-plan` skill already does this.

**Recommendation (no schema)**: A, plus the "would have run by rule" verdict on each row, plus a visible link to Pause. Add B only where the ceiling is `confirm`. Treat C and D as separate Owner decisions.

**Safety checks that must stay, whatever the UI does**
- **Staleness re-check at commit**: the tool's own dry run is compared on `MATERIAL_PREVIEW_FIELDS` (`approval-inbox.service.ts:684-925, 980-1057`). It **fails closed** for an executable tool with no declared fields (`:1004-1009`). A plan is re-checked per step (`change-plan.service.ts:278-285`).
- **The approver's permissions, re-checked at run time** (`deciderPrincipal`, `approval-inbox.service.ts:473-490`). A plan approver needs every step's permissions (`:393-404`).
- **Rule re-check at commit** (`autoCommitRefusal` / `autoPlanStepRefusal`), plus Pause, cap and auto-pause.
- **In-tool guards**: FBA untouchable, bid floors and the write gate, price bounds, the EU shared Amazon quantity. They live in handlers, so a rule-run inherits them.
- **The 24 h expiry clock** (`EXPIRY_HOURS`, `approval-gate.service.ts:52`); a snooze never outlives it (`agent-fleet-approvals.routes.ts:595-628`).
- **Edit = supersede, never mutate** (`…/amend` `:491-575`; `plan-amend` → `amendPlan`).
- **Ceilings and the deny lists** (1.6, 1.7). The 2FA step-up for any raise.

## 3. Progress and visibility

### 3.1 Life of a request (`AgentApproval.status`)
```
Claude call ─► pending ──(person approve / rule auto / confirm code)──► scheduled (executeAfter = +20 s)
   │             ▲  ▲                                                     │  Undo → pending · Hold → +10 min
   │             │  └── "not run — <why>" (stale / permission / rule) ◄───┤  commit re-checks
   │             └───── "execution failed: …" (decidedBy cleared) ◄───────┤
   │                                                                      ▼
   │         single: pending→executing (claim) → executed     plan: executing → (worker) → executed
   ├─► rejected · expired (24 h) · superseded (edited / unticked) · approved (preview-only tool)
```
- Handed-back and failed rows are **plain `pending` rows** with a `reason` prefix: `not run —`, `not run by rule —`, `execution failed:` or `execution error:`. Their `expiresAt` is restamped (`approval-inbox.service.ts:496-539, 610-627`; `claude-trust.service.ts:287-302`). `claude-activity` already turns these into outcomes `queued | handed-back | failed | auto | approved | confirmed | rejected | expired | superseded | undone` (`claude-activity.service.ts:171-196`). A grid can reuse that logic.
- The `/agent/fleet/approvals/rollup` route still counts "returned" as `pending` with `decidedBy` set (`agent-fleet-approvals.routes.ts:650-712`). The commit path now clears `decidedBy`, so that bucket likely stays 0 for page-path failures. **(by reading; not run)**

### 3.2 How execution runs after approval
- **Single change**: `commitScheduledApproval` (`approval-inbox.service.ts:545-657`) re-checks the rule, then the person, then staleness. It releases the row to `pending` and calls `decideApproval` (`approval-gate.service.ts:325-428`). That claims `pending→executing` and runs `executeTool(...)` **inline, synchronously**, in the process that committed: the API for a browser commit, the scheduler for the sweep. It then writes `executed`, or `pending` with the reason, records `AgentChange` plus the outbox event `agent.change.executed` (`change-record.service.ts:136`), and writes `AgentControlAudit` (`approve_action` / `execution_failed`).
- **Plan**: the commit claims `scheduled→executing` and calls `enqueuePlan` (BullMQ queue `agent-plan`, jobId `agent-plan-<approvalId>`, `api/lib/queue.ts:226-238`; `api/workers/agent-plan.worker.ts`). `runPlan` takes the pending steps in order (`change-plan.service.ts:325-373`). Each step is claimed (`pending→executing`), then checked again (rule, person, staleness), then executed and recorded. The step ends `done`, `skipped` or `failed`, with `reason`, `changeId`, `startedAt` and `endedAt`. The approval ends `executed` with reason "X of N changes ran; k skipped, m failed". A step stuck in `executing` for over 10 min is marked failed ("may or may not have changed something"). The sweep re-enqueues a plan untouched for 2 min, or runs it inline when `ENABLE_QUEUE_WORKERS!=='1'` (`:391-415`).
- **To the channels** (asynchronous, after `executed`):
  - Price tools queue `OutboundSyncQueue` rows (`PRICE_UPDATE`, payload.source `MASTER_PRICE_CHANGE`) with a **30 s hold** (`MASTER_PRICE_HOLD_MS`, `bulk.tools.ts:51-55`)
  - Amazon ad writes go through `AdvertisingActionLog.executionId = approvalId` and the outbound queue, with a **5-minute cancel window** (`approval.tools.ts:286`)
  - eBay ad writes go to `CampaignAction.executionId`
  - `publish-listing` makes a studio publication (`AgentChange.after.publicationId`)

  All of these are processed by the worker service.

### 3.3 Where results and errors are stored
| What | Where |
|---|---|
| Decision, outcome, failure reason | `AgentApproval.status`, `reason`, `decisionVia`, `decidedBy`/`decidedByUserId`, `decidedAt`, `executeAfter` |
| Plan step progress | `AgentPlanStep.status`, `reason`, `changeId`, `startedAt`/`endedAt`. Read via `GET /api/agent/fleet/approvals/:id/plan` (`planView`, `change-plan.service.ts:448-494`) |
| What changed + undo | `AgentChange.before`/`after`/`undoTool`/`undoArgs`/`undoneAt`/`undoneByApprovalId`/`outbound` |
| Who did what (audit) | `AgentControlAudit`: approve_action, reject_action, undo_approval, stale_refused, permission_refused, rule_refused, execution_failed, amend_action, pause, resume, policy |
| The call itself | `AgentRun` (`via 'claude'`, `oauthGrantId`, `userId`, `input`, `status awaiting_approval/done/failed`, `errorMessage`) (`mcp-tool-call.ts:230-241, 262-276`) |
| Channel delivery | `OutboundSyncQueue.syncStatus`/`errorCode`/`errorMessage`; `AdvertisingActionLog`; `CampaignAction.channelResponseStatus`; studio publication status |

**Not stored**: why a tool at `auto` or `confirm` still went to a person (the `RuleVerdict.why`). It is returned to Claude only (`mcp-tool-call.ts:194-198`), and `ending()` stores just `{mode, approvalId}` (`:230-241`). It can be recomputed at read time from `claudeRuleOf` + `withinLimits` + `autonomyOf` (no schema).

### 3.4 "Reached the channel" — what exists
`approval-status` already computes it per tool. The helpers are exported (`api/services/agents/tools/approval.tools.ts`):
- `channelQueueOf()` (`:94-119`) for set-price, bulk-price-change and set-master-prices. This is a **heuristic** join: product ids + syncType + `createdAt ≥ decidedAt−2 s` + payload.source. The queue does not record the approval.
- `adDeliveryOf()` (`:188-240`): **exact**, by `executionId=approvalId`, giving waiting / sent / refused by write gate / failed / not sent / sandbox.
- `ebayDeliveryOf()` (`:250-264`): exact.
- `publishedMeaning()` + `readStoredPublication` for publish-listing (`:43-54, 349-354`).

Other tools (Matrix listing price/stock, close/reopen, content, stock) have **no channel tracking** in `approval-status` **(not verified whether they keep their own operation ids)**. `bulk-attribute-change` says plainly "Nexus only".

### 3.5 Live push
- **SSE exists** in the API for ~9 domains. They use `createCrossReplicaBus` (`api/lib/events/bus.ts:76`) and `sseResponseHeaders` (`api/lib/sse.ts`): listings, orders, outbound, inbound, PO, reviews, marketing, ads-execution, sync-logs. Examples are `GET /api/listings/events` and `/api/sync-logs/events`; the web side is `web/lib/sync/use-*-events.ts`.
- **There is no approvals or agent stream.** The fleet pages decided on **visibility-gated polling every 10 s** ("No SSE, no new infrastructure", `web/app/fleet/_shared/use-visibility-poll.ts:3-11`), and the Approvals page uses it (`ApprovalsClient.tsx:70,1179`).
- The outbox events `agent.change.executed`, `agent.change.undone` and `agent.autorun.paused` are declared (`packages/events/catalog.ts:372-405`) and written, but **nothing subscribes**. The only durable subscriber in the API is the oversell watchdog (`subscribeEvents` callers).
- **Options**:
  - (a) Keep the 10 s poll, plus poll a running plan's `/plan` endpoint while it executes. No new infrastructure.
  - (b) Add an approvals bus with `createCrossReplicaBus` and a `/api/agent/fleet/approvals/events` SSE route. This needs new catalogue event types (hard rule 8) and publish calls at each status change. That is more code than the Owner's "only necessary" rule likely justifies.

### 3.6 Suggested grid state column (from existing fields only)
| Grid state | Rule |
|---|---|
| Waiting for you | `pending`, no `reason` |
| Came back — why | `pending` + reason starts `not run` (stale / permission / rule changed). Show `reason`. |
| Failed — why | `pending` + reason starts `execution failed` / `execution error`. Show `reason`. |
| Runs in Ns (by you / by your rule / confirmed in Claude) | `scheduled` + `executeAfter` + `decisionVia` |
| Running | `executing`. For a plan, add `byStatus` (e.g. 12/40 done, 1 skipped) from `/plan` |
| Done | `executed` (+ `AgentChange` undo state) |
| Reached channel / waiting / failed at channel | approval.tools.ts helpers (3.4); only for executed rows of those tools |
| Rejected / Expired / Replaced | `rejected` / `expired` / `superseded` |

## 4. Interruptions for Claude
- **The MCP call never blocks.** A change returns at once with `status:'waiting_for_approval', approvalId, expiresAt, approveAt` (the page URL), `preview` and `next`, or with `runs_by_rule`, or a `confirm` block (`mcp-tool-call.ts:161-213`).
- The MCP server is **stateless**: a fresh server per request, `listChanged:false`, GET/DELETE answer 405 (`mcp-server.ts:1-16,140`). So **no server→Claude notification is possible**. Claude must poll `approval-status` (`approval.tools.ts:296-404`) or `claude-activity`. Rate limits are 120 calls/min per connection and 600 per business (`mcp-rate.ts:1-23`) **(not verified whether tight polling would hit them)**.
- **The Owner is never notified that something waits**:
  - No `Notification` row is written by the gate or the door (no `notification` writes in `services/agents`, `services/mcp` or the inbox service)
  - No e-mail
  - `/api/sidebar/counts` has no approvals count (`api/routes/marketplaces.routes.ts:19-66`), so the rail item "Approvals" has no badge
  - An automatic pause emits only an unconsumed event, so the Owner learns of it only in Settings › AI › Claude
- **What makes Claude stall today**:
  1. **Every Claude change waits for a person by default.** It is `forceAsk` (`mcp-tool-call.ts:286`) and every tool starts at `ask`.
  2. Even at `auto`, a change falls back to a person when: there is no `nexus.run`, a Pause is on (incl. auto-pause after 5 failures in 1 h), it is outside the limits, or the daily cap is reached. A plan also falls back when **any** step is not auto.
  3. **One-at-a-time approval**: bulk approve is refused for executable rows (S8.4), so 40 Claude rows means 40 approvals unless Claude used a plan.
  4. **24 h expiry**: an unanswered request expires and Claude has to ask again.
  5. **Hand-backs** (stale facts, lost permission, rule changed in the window) and **execution failures** return to `pending` silently. Claude only learns by polling.
  6. No notification, so the Owner only acts when he opens the page.
  7. A plan needs an approver holding **every** step's permissions (`planApprovalRefusal`).
  8. The 6-digit `confirm` path needs the person present with an authenticator.
- **Second approvals surface**: Settings › AI also lists approvals (`web/app/settings/ai/AiApprovalsClient.tsx` → `GET /api/agent/approvals`, last 50; approve and reject go through the same `decideFleetApproval` with the 20 s window, `api/routes/agents.routes.ts:151-201`).

## 5. Audit and undo — what a row could offer
- **Inside the 20 s window**: **Undo** (back to `pending`; a rule-run becomes a person's decision) and **Hold** (+10 min) (1.8).
- **After it ran**:
  - **What it does**: **Undo change** = `POST /api/claude/changes/:changeId/undo` (`change-undo.service.ts:28-68`). The click asks for the inverse change through the same gate (that tool's permissions, preview and staleness), approves it as the clicker (20 s window again), and re-checks at commit.
  - **Refused when**:
    - `reversibility none`
    - the tool has no `undo`
    - no before/after was recorded
    - it was already undone
    - an undo already waits
    - **the value changed since** (compare-and-swap, `change-record.service.ts:190-250`)
  - **There is no time limit** on an `AgentChange` undo.
  - **Undo state for a row** comes from `undoStateOf` (`claude-activity.service.ts:199-204`): `possible | waiting | done | not possible`.
- **Plans**: each step's `changeId` can be undone individually through the click route. **Whole-plan undo** (one undo plan of the inverse steps, in reverse order) exists only through the MCP tool `undo-change {approvalId}` (`change-record.service.ts:190-194` → `planUndo` `:259`). There is no web route for it **(not verified whether the web PlanCard offers it)**.
- **Ads**:
  - `undo-ad-change` (ceiling `ask`, reversibility none) and the rollback service (`api/services/advertising/rollback.service.ts`). Change sets can be rolled back within **24 h**; per action, bids within 24 h and budgets and placements within **7 d** (`:31-72`).
  - The ad writes themselves have a 5-min cancel window in the outbound queue.
- **Matrix**: `revert-listing-change` (once, ask). **Bulk jobs and imports**: `rollback-bulk-operation`.
- **Audit views**:
  - `AgentControlAudit` (all decisions and rule changes)
  - `claude-activity` (Settings › AI › Claude › Activity, and the MCP read tool)
  - `audit-trail` (entity-level AuditLog; MCP read, `tools/platform-activity.tools.ts:146-176`)

## 6. Surprises worth knowing for the plan
- **The Approvals page knows nothing about trust levels.** It renders `decisionVia==='auto'` as "Runs by your rule" and that is all. There is no link to Settings › AI › Claude and no "why not by rule".
- The Approvals page's `waiting` view is fleet-tools-only (`whereFor`, `approval-inbox.service.ts:114-119`). Claude rows come only from `/outside`, which is capped at `take: 100` (`agent-fleet-approvals.routes.ts:714-735`).
- The web limits editor supports numeric limits only (1.5).
- `confirm-change` and the `confirm` level need `nexus.run` **and** 2FA. Without them a confirm-level tool silently becomes "a person approves in Nexus" (`mcp-tool-call.ts:126-131`).
- If the rule engine itself throws, the request stays with a person and is never run (`approval-gate.service.ts:177-189`). That is safe.
