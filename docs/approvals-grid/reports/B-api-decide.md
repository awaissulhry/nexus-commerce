# B — API decide (build agent B, 2026-10-05)

Worktree `/private/tmp/feat-approvals-grid`, branch `feat/approvals-grid`. Nothing was committed. Owner decisions: 1 = A (bulk
approve), 2 = A (rules per kind, no schema change). The contract `packages/shared/approval-queue.ts` is unchanged.

## Files
Changed:
- `apps/api/src/services/agent-fleet/approval-inbox.service.ts`: the bulk rule (replaces S8.4), an optional reject reason,
  and `bulkDecide` now returns `QueueBulkResult` plus the old `failed`.
- `apps/api/src/routes/agent-fleet.routes.ts`: decide and bulk-decide accept an empty reason; bulk ids are deduped and
  capped at 200 (400 above that); bulk-preview passes the viewer.
- `apps/api/src/routes/claude-control.routes.ts`: new GET `/claude/trust/:tool/simulate`.
- `apps/api/src/services/agents/tools/approval.tools.ts`: approval-status outcomes.
- `apps/api/src/services/mcp/mcp-tool-call.ts`: `?item=` links.

New:
- `apps/api/src/services/agent-fleet/bulk-approve-policy.ts`: `bulkApproveRefusal(toolName): string | null`,
  `NEVER_IN_BULK` and `BULK_MAX_IDS = 200`.
- `apps/api/src/services/agents/claude-rule-simulate.service.ts`.

Tests:
- New: `routes/agent-fleet-approvals.bulk.vitest.test.ts` (PGlite, real routes and tools),
  `services/agent-fleet/bulk-approve-policy.vitest.test.ts`, `services/agents/claude-rule-simulate.vitest.test.ts` (PGlite).
- Updated: `approval-undo.vitest.test.ts` (the S8.4 pins now pin decision 1 = A, with a comment), `approval-inbox.vitest.test.ts`
  (+1 case: reject with no reason), `claude-control.routes.vitest.test.ts` (route list and 2 simulate cases),
  `mcp.routes.vitest.test.ts` (`approveAt` now ends in `?item=<id>`).

`claude-trust.service.ts` was not touched.

## Never in a bulk approve
The registry's `reversibility: 'none'` kinds are always refused. These are also refused, each with its own sentence:

| Tool | Why |
|---|---|
| `issue-refund` | sends the buyer money, cannot be taken back |
| `send-customer-message` | a buyer message cannot be recalled |
| `email-supplier` | a supplier e-mail cannot be recalled |
| `reply-to-review` | a public reply cannot be recalled |
| `request-review` | reaches the buyer, cannot be recalled |
| `cancel-order` | reaches the buyer, cannot be undone |
| `cancel-purchase-order` | cannot be undone (reaches the supplier) |
| `close-listing` | takes an offer off sale |
| `unlink-channel-id` | cuts the product off from its live listing |
| `remove-draft-listings` | deletes drafts |
| `discard-new-products` | removes products from the catalog |
| `remove-unused-photo` | deletes a photo; can only be partly undone |
| `merge-duplicate-products` | folds one product into another; can only be partly undone |
| `dispose-return-items` | restock or scrap; cannot be undone |
| `buy-shipping-label` | spends money with the carrier |
| `void-shipping-label` | cancels the label at the carrier |

Also refused: change plans (`submit-change-plan`: "approved on its own"), control and read tools, and unknown tools.

## The new bulk rule
A bulk approve covers pending rows of ONE tool from ONE worker (the UiPath rule, kept). The tool must pass
`bulkApproveRefusal`. At most 200 ids per call, for either verb. Each row is then approved through
`decideFleetApproval → scheduleApproval`, exactly like a single approve: the claim with the approver's permission, the
20-second stop window, then `commitScheduledApproval`. The commit re-checks staleness (`MATERIAL_PREVIEW_FIELDS`), the
approver's permission now and the rule. A row the viewer may not approve (`cannotApproveFor`; a plan refusal and an
expired claim behave the same way) is skipped with its sentence, and the rest go ahead. A row that is not found or not
pending is skipped too. `previewBulk(ids, decision, viewer?)` uses the same function on the same rows, so the count, the
sentence (including the euro clause) and `blockedReason` (null when allowed) always match. Partial reversibility is now
said ("N of them can only be partly undone"). Bulk reject still works across kinds.

## Endpoints
- POST `/api/agent/fleet/approvals/:id/decide`: `reason` is optional on reject, and this fixes "Reject the plan". With no
  reason, `reason` = "rejected by <person>" and `operatorNote` = null. With a reason, both hold the person's words.
- POST `…/bulk-decide`: same. Returns `{ok, done, of, skipped:[{id, why}], failed, error?}`. A refused bulk approve is still
  HTTP 200 with `ok:false` (as before); more than 200 ids returns 400 in the same shape.
- POST `…/bulk-preview`: gets the viewer and the 200 cap.
- NEW GET `/api/claude/trust/:tool/simulate?days=30&level=auto&limits=<url-encoded json>` returns `RuleSimulation`.
  - It counts Claude's requests only (`agentRun.agentKey = 'claude'`), leaves out withdrawn duplicates, and reads every row
    in pages of 500.
  - Each row's verdict is the tool's strict `limits` parse plus its own `withinLimits` on the stored preview. A test checks
    this against `autoCommitRefusal` row by row.
  - Without `limits`, the business's current limits are used. Only `auto` can return `wouldRun > 0`.
  - Pause, nexus.run and the daily cap are not replayed.
  - Errors: 400 for a level above the ceiling (`setClaudeRule`'s words), for bad limits (the schema's words), and for days
    outside 1–90; more than 90 is read as 90. A tool Claude is not offered returns 404.
  - Permission is ai.view (the existing `/api/claude/` manifest row). Examples go through the reader's money filter.
- MCP: `approveAt` and `stopAt` are now `…/fleet/approvals?item=<approvalId>` (a plan uses the plan's id).
- approval-status now adds:
  - `rejectedReason`, with the person's words, and the meaning "<who> rejected it, saying: …" or "…without giving a reason".
  - `replacedBy`, the new id, taken from the amend audit row.
  - `handedBack: why` for "not run — …" and "not run by rule — …".
  - `failed: why` for "execution failed/error: …".
  - A withdrawn row is described as withdrawn.
  - Expired already said so.

## Checks
| Check | Command | Result |
|---|---|---|
| Typecheck api | `cd apps/api && npx tsc --noEmit -p tsconfig.json --tsBuildInfoFile /private/tmp/claude-501/approvals-B.tsbuildinfo` | pass (with A's files present) |
| Area tests, profiles OFF | `npx vitest run` on 29 files: inbox, undo, decider-recheck, staleness ×3, gate, change-plan, trust, confirm, activity, tool-contract, money-and-business, mcp-tool-call, mcp.routes, claude-control, agent-fleet-approvals ×3, tools ×7, decisions, plus the new ones | 387/387 pass |
| Same, `NEXUS_WORKSPACES_ENABLED=1` | same | 387/387 pass |
| Other MCP and agent suites | `src/services/mcp/`, tool-schema, call-tool, tool-policy, tool-never, fleet-council, change-record | pass, except `mcp-coverage` (below) |
| Ratchets | route-prisma, context-boundary, cron-clustered, event-contract, global-exposure, inbound-ledger, stock-writer-lock, sync-ledger-source, graph-contract, alias-form, channel-gateway | all pass |
| Real PostgreSQL suites | `mcp-cross-business-postgres`, `change-plan-postgres` | not run (they need Docker); read: the cross-business bulk case still expects `done: 0`, which holds |

## Notes and what I could not do
- The vitest runs used dummy `EBAY_CLIENT_ID/SECRET/RUNAME` and `EBAY_ENVIRONMENT=SANDBOX`. Without them the
  logger-mocking suites (approval-inbox, approval-undo) fail to load ("logger.warn is not a function" at ebay-auth import).
  That failure is the same at HEAD; it is caused by the environment, not by this change.
- `src/services/mcp/mcp-coverage.vitest.test.ts` fails because 4 committed route files have no coverage row
  (listing-actions, publication-batches, publication-history, publish-actions). This is already on main at 7039b95ef and is
  not from this lane. Agent A's new `approval-queue.routes.ts` will also need a row there.
- Possible contract additions (optional, not made): `RuleSimulation.editedAmongWouldRun` (requests a person edited instead
  of rejecting are counted in `considered` but not as rejected), and `skipped` reasons as codes if the page wants to group
  them.
