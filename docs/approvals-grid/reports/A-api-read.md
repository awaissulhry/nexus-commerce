# A — API read (approvals grid, wave 1) — report

Agent A, 2026-10-05, worktree `/private/tmp/feat-approvals-grid` (branch `feat/approvals-grid`). Nothing committed.

## Files
| File | What |
|---|---|
| NEW `apps/api/src/services/agent-fleet/approval-target.ts` | Pure resolver: `resolveRequest(tool, args, preview, ctx)` → target, channel, market, change lines, change count, summary, items; `productRefsOf` for the one batched Product lookup |
| NEW `apps/api/src/services/agent-fleet/approval-queue.service.ts` | `queuePage`, `queueCounts`, `queueDetail`, `approvalsNeedYouCount`, `queueStateOf` |
| NEW `apps/api/src/routes/approval-queue.routes.ts` | 3 GET routes, 0 Prisma calls |
| NEW `…/approval-target.vitest.test.ts`, `apps/api/src/routes/approval-queue.routes.vitest.test.ts` | 30 + 29 tests |
| `apps/api/src/index.ts` | 1 import + 1 register line |
| `apps/api/src/routes/marketplaces.routes.ts` | `/api/sidebar/counts` gains `approvals: { needsYou }` (one COUNT, imported on use) |
| `apps/api/src/services/agents/claude-activity.service.ts` | **outside my list**: `undoStateOf` exported (one line, structural param type) so the drawer's undo state is the same function `/api/claude/activity` uses |
| `apps/api/src/services/mcp/mcp-coverage.ts` | row `approval-queue` (part 05), per the lead's note |

Permissions: the new paths sit under `/api/agent/` → `ai.view` (same rule as the other approvals GETs); no manifest change. RBAC coverage: 0 unmapped.

## Endpoints
- `GET /api/agent/fleet/approvals/queue?show=open|done|all&cursor=&limit=` (100 default, 200 max; 400 on a bad value). Open = statuses pending/scheduled/executing, every tool and every asker, `requestedAt asc, id asc`; done/all newest first. Cursor = base64url `[requestedAt, id]`. `total` = count for `show`.
- `GET /api/agent/fleet/approvals/queue/counts` → `QueueCounts` (6 COUNT/aggregate queries + one tiny select of scheduled rows' two dates).
- `GET /api/agent/fleet/approvals/queue/:id` → `QueueDetail` (404 when not in this business).

Example row (from the route test; a Claude set-price, +4 %, set-price at "Run by itself"):
```json
{ "id": "…", "toolName": "set-price", "title": "Set master price", "area": "pricing", "state": "waiting", "rawStatus": "pending",
  "note": "Your rule for Set master price would run it by itself now; when it was asked, it did not",
  "target": { "kind": "product", "id": "…", "sku": "AQ-GLOVE-M", "name": "Gale glove M", "count": 1, "href": "/products/…/edit" },
  "channel": null, "market": null, "changes": [{ "label": "Base price", "from": "€50.00", "to": "€52.00" }], "changeCount": 1,
  "summary": null, "asker": { "kind": "claude", "label": "Claude · Ana", "person": "Ana Plan", "connection": "Claude Desktop" },
  "decider": null, "reversibility": "full", "reachesOutside": true, "plan": null, "canApprove": true, "cannotApproveWhy": null,
  "bulkApprovable": true, "bulkBlockedWhy": null, "automation": { "level": "auto", "max": "auto", "whyWaits": "…same as note…" } }
```

## Cost per list call (polled)
1 page query (lean select) + 1 count; then batched: AgentRun, UserProfile, OAuthGrant, AgentPlanStep groupBy + first steps, AgentTool rules (1 query for all tools on the page), Product (1 query, ids and SKUs). Only when needed: fleet labels (ad rows whose visible preview names nothing), `planApprovalRefusal` per pending plan, and the trust brakes (`autonomyOf` + `autoRunsInLastDay`, once) when a waiting Claude row is at "auto". No track records, no history.

## Resolver coverage
- 32 tools have their own reader (ads ×15 incl. eBay, publish, drafts, close/reopen, Matrix ×3, bulk prices/attributes, refund, message, cancel, stock, plan); every other tool goes through the convention reader (`changes` map or list, `summary`/`effect`, `sku`/`product`, `family`, `destination`, `totals`, `more…`).
- 86 of 119 change tools name a target from their argument ids alone (measured over the registry); more from the preview (issue-refund's order, a new campaign's name). The 33 without one are settings/rules/structure tools (save-*, tune-ad-engine, set-business-settings …) and a few return/review tools — target `null`, never guessed.
- Money: master prices in `masterCurrency()`; ad cents in the campaign's currency (EUR for old rows, as the web card did); list lines with their own `currency`; otherwise the bare amount.
- Change lines come from the viewer's money-filtered preview only; arguments only name ids. A viewer who may not use the tool sees `changes: []`, no `askerReason`.

## Tests and checks (local, loopback test env)
| Check | Command | Result |
|---|---|---|
| Typecheck API | `npx tsc --noEmit -p tsconfig.json` (apps/api) | pass |
| New + neighbour suites, profiles OFF | `npx vitest run` approval-queue.routes, approval-target, claude-activity, marketplaces.presence, marketplaces-seed | 5 files, 76 tests pass |
| Same, profiles ON | `NEXUS_WORKSPACES_ENABLED=1 npx vitest run …` | 76 pass |
| MCP coverage | `npx vitest run src/services/mcp/mcp-coverage.vitest.test.ts` | my row OK; 2 tests still fail on 4 pre-existing missing rows (listing-actions, publication-batches, publication-history, publish-actions) — on main, not mine |
| Route-Prisma ratchet | `node scripts/check-route-prisma-ratchet.mjs --check` | pass (new route file 0 calls) |
| Context boundary / gateway / cron / events / global exposure | `check-context-boundary --check`, `channel-gateway-ratchet.mts --check`, `check-cron-clustered`, `check-event-contract`, `check-global-exposure` | pass |
| RBAC coverage | `npx tsx src/scripts/check-rbac-coverage.ts` (registration only, no listen) | 0 unmapped |

## Decisions the lead should check (no contract edit made)
1. `canEdit` is true for every pending state (waiting, back to you, failed) — the server's amend path accepts any pending row; the brief said "waiting". False for plans (they use plan-amend).
2. Plans' `bulkBlockedWhy` uses the brief's words "A plan is approved on its own"; B's `bulkApproveRefusal` has a longer sentence for plans. Pick one.
3. `ruleOf` in the service copies claude-trust.service.ts `ruleFrom` (not exported; B's file) to read all rules in one query. Exporting `ruleFrom` would remove the copy.
4. `cannotApproveWhy` is set only for pending rows (null for decided ones).
5. `channelResult.state` `unknown` is also used for sandbox ad writes and a price change that queued nothing (the words say exactly what happened). A `not_sent` state in the contract would be more precise.
6. Timeline: no `held` or `reached_channel` events — their moments are not stored (HOLD_MS is local to the hold route; channel helpers return no times). Failed/back-to-you moments = `expiresAt − 24 h` only when the clock was restamped.
7. List-mode plan with every kind at "auto": `whyWaits` says to open it; the drawer checks each step's limits (keeps polls light).
8. `ranByRuleToday` counts from 00:00 UTC (no business time zone on Workspace). Sidebar count is not gated on `ai.view` (the sidebar route is any signed-in user; it is a number only).
9. Contract kinds have no `return`/`review`: a refund is shown on its order (`Order X · return RMA`).
