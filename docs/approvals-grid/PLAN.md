# Approvals grid — PLAN (2026-10-05, waiting for the Owner's yes)

## Summary
- One grid for every request, from Claude, the fleet agents or a rule. Today Claude's requests sit in a second,
  uncounted list of cards, capped at 100, with no checkboxes.
- One row = one request: **status · what · product · change (before → after) · where · asked by · why / result ·
  Approve / Reject**.
- A health strip on top: waiting · running · failed · ran by rule today · oldest waiting. Each number is a filter.
- Speed: Approve and Reject are each one click. You can approve many rows of the same kind in bulk, group the rows,
  use the keyboard, and edit a request before you approve it.
- "Automate this kind…" on every row. It uses the rules that exist today (Settings › AI › Claude › Rules): pre-filled
  limits, a test against your history ("34 of your last 40 would have run by themselves") and your 2FA code.
- Progress: one status column follows a request from start to end, plans show live "34 of 120 steps", a failed row
  says why and offers Retry, and the nav shows a badge.
- Safety stays as it is: re-check at run time, 20 s stop window with Undo, 24 h expiry, 2FA to raise a rule, and
  Claude can never approve.
- Build: 3 waves, 6 build agents, 4 PRs. API first, then design-system parts, then the page, then clean-up.
- 2 decisions for the Owner (§10). Research: `research/01`–`04` in this folder.

## 1. What is wrong today (verified in code, `research/01` §4 and `research/02`)
| # | Problem | Where |
|---|---|---|
| 1 | Two queues. The main "Waiting" list and its counts cover only the 3 fleet ad tools. Claude's requests sit in an uncounted list below, capped at the 100 oldest, so "Nothing is waiting for you" can show above real requests. | `approval-inbox.service.ts:65,114-137`, `agent-fleet-approvals.routes.ts:714-799` |
| 2 | No bulk for Claude. Claude rows have no checkboxes, and bulk approve can never succeed (rule S8.4 blocks every row that can execute). | `approval-inbox.service.ts:1403-1450,1544` |
| 3 | No product column. The product or SKU sits in tool-specific `args` keys, or in the preview. | `research/01` §3 |
| 4 | The page never says why a request waits, and it has no way to automate it. The rules are on another page. | `claude-trust.service.ts`, `RulesPanel.tsx` |
| 5 | Progress is invisible. A running plan leaves the list. Results and failures show only in Claude Activity. | `PlanCard.tsx:118-129` |
| 6 | Bugs: "Reject the plan" always fails (400); errors disappear within one refresh; a rule hand-back shows no banner; the Decided tab calls Claude's decisions "a setup script"; one click freezes every card; Claude's link opens the page, not the request; there is no nav badge. | `research/01` §4 D2, D3, D5, D6, D11, D14, D20 |
| 7 | Every 10 s, polling re-reads the whole decision history (cost; see the Neon data-transfer note). | `approval-inbox.service.ts:1110-1129` |

## 2. The new page
```
Approvals                                                                 [How it works]
┌───────────┬───────────┬──────────┬──────────────────┬─────────────────┐
│ 7 waiting │ 2 running │ 1 failed │ 14 ran by rule   │ oldest: 3 h     │  ← each tile is a filter
└───────────┴───────────┴──────────┴──────────────────┴─────────────────┘
[Search product, SKU, kind…]   Show: [Open ▾]   Group: [Claude plan ▾]   Views ▾   Customise
┌─┬─────────────┬────────────┬──────────────────┬───────────────┬─────────┬────────────┬──────────────────┬──────────────────┐
│☐│ Status      │ What       │ Product          │ Change        │ Where   │ Asked by   │ Why / result     │                  │
├─┼─────────────┼────────────┼──────────────────┼───────────────┼─────────┼────────────┼──────────────────┼──────────────────┤
│☐│ ● Waiting   │ Set price  │ XR-GLOVE-M Gale  │ €49.90→€44.90 │ eBay IT │ Claude · A │ Your rule: Ask me│ Approve  Reject ⋯│
│☐│ ◐ Runs in 14s│ Set stock │ XR-HELM-L        │ 3 → 5         │ Nexus   │ Claude · A │ You approved     │ Undo             │
│☐│ ◐ Running   │ Plan: 120 prices │ 120 products│ 34 of 120 done│ Amazon  │ Claude · A │                  │ Details          │
│☐│ ✕ Failed    │ Publish    │ XR-JKT-S         │ —             │ Amazon IT│ Claude · A│ Amazon: missing … │ Retry ⋯          │
└─┴─────────────┴────────────┴──────────────────┴───────────────┴─────────┴────────────┴──────────────────┴──────────────────┘
Rows ticked → the toolbar becomes:  Selected 12   [Approve 12 price changes]  [Reject 12]  [Clear]
Click a row or press Enter → side drawer: full change list, plan steps, timeline, Edit, Undo, Automate this kind…
```
- **Show** filter: Open (waiting, starting, on hold, running, failed) · Done · Everything. Each filter reads its own
  page of rows from the server, so nothing is silently capped.
- **Group** options: none · Claude plan · kind · product. Each group header has a counted "Approve all 12" button,
  same kind only.
- **Phone width:** status, what + product, and the actions only (the `PublishRuns` phone-column pattern).
- **Theme:** stays light like the other fleet pages, with the existing `fleet-portal` pin on the drawer and modals.
- **Gate state** (the "can the fleet agents ask?" readout) moves from the top of the page into the How it works
  drawer. Nothing is deleted.

## 3. One status for the whole life of a request
Computed from fields that exist today (`status`, `decisionVia`, `executeAfter`, the `reason` prefix, plan steps). No new
status is stored in the database.

| Shown | When |
|---|---|
| Waiting | pending, no comeback reason |
| Runs in 14 s · Undo | scheduled, inside the 20 s stop window (live countdown) |
| On hold until 14:20 | scheduled, held |
| Running · 34 of 120 | executing (a plan shows step counts) |
| Done · reached eBay IT | executed, and the channel confirmed it (ads, publish-listing, prices where Nexus can know) |
| Done in Nexus | executed, and Nexus cannot know the channel result. The UI says so; it never claims more. |
| Failed · why · Retry | pending again with "execution failed/error: …" |
| Back to you · why | pending again with "not run — …" or "not run by rule — …" (stale, permission or limit) |
| Rejected · Expired · Replaced by an edit | rejected / expired / superseded |

## 4. "Automate this kind…"
- Opens from the row's ⋯ menu and from the drawer. A DS `Modal` pre-filled from that row:
  "From now on, **Set price** requests: ( ) Ask me · ( ) Run by themselves within these limits · ( ) Confirm in Claude".
- The limits are pre-filled from the row, e.g. the row's change of 10% sets "max change 10%".
- A history test before saving: "With these limits, 34 of your last 40 set-price requests would have run by
  themselves. You rejected 2 of those."
- Raising a level asks for your 2FA code (today's rule; reuses `StepUpModal`). Lowering it back to "Ask me" is
  one click, with no code.
- A checkbox "Also approve this one", because a rule applies only to new requests.
- The modal offers only the levels the kind allows. 24 of 119 kinds can run by themselves. 29 more can go only as far
  as "Confirm in Claude". The other 66 (publishing, listing text, listing price and stock, refunds, messages…) say
  "This kind always needs you" plus the reason. This plan does not change those limits (§9).
- A row run by a rule says so: "Ran by rule · Set price ≤ 10%". The rule links to Settings › AI › Claude › Rules.

## 5. Speed
- Approve and Reject are both visible on every row and both one click. A reject reason is optional and goes back to
  Claude (this also fixes "Reject the plan").
- Bulk approve works only on rows of the same kind (Decision 1). The button gives the count: "Approve 12 price changes".
  Every row is still re-checked when it runs; a row whose data changed is handed back, not run.
  Never in bulk: refunds, buyer messages, closes and deletes, or any other kind that cannot be undone.
- Keyboard: ↑ ↓ to move · Space to tick · Enter for details · A to approve · R to reject · Esc to close.
- Edit, then approve, in the drawer. The server already supports this for every tool (`amend`), but today the UI
  shows it for 2 tools only.
- An action locks only its own row. An error stays next to the row until you close it.

## 6. Progress and problems
- The health strip on top, and a nav badge "Approvals 7".
- Running plans stay under Open with a live step count. The drawer shows the step list, as a list and not a grid
  (the 10-02 rule `claudePage.vitest.test.ts`).
- The drawer timeline: asked → approved (by you, by a rule, or by your code in Claude) → ran → reached the channel →
  undone.
- Refresh: one light endpoint. Every 3 s while something is starting or running, every 15 s when idle, and only
  while the tab is visible. It never re-reads the whole history.
- Claude's links point to `/fleet/approvals?item=<id>`, which opens that row's drawer. The URL of the page does not
  change.

## 7. What stays exactly the same (safety)
- Each run re-checks the data (staleness), your permission and the rule. A row that fails a check is handed back,
  never run.
- 20 s stop window with Undo and Hold; 24 h expiry.
- A 2FA code is needed to raise any automation, and Claude has no tool to change its own rules.
- The guards inside the tools stay: FBA quantity is never written; bid floors, the ads write gate and price bounds
  still apply.

## 8. Build: waves, agents, files
**Contract first (lead, before wave 1):** the row type `ApprovalQueueRow` and the counts type, in
`packages/shared/src/approvals/queue.ts`. The API and the web import it, so the two waves can run in parallel.

**Wave 1: 3 agents in parallel, on separate files**
- **A. API read.** New `services/agent-fleet/approval-queue.service.ts` and new `routes/approval-queue.routes.ts`:
  - `GET /api/agent/fleet/approvals/queue?show=open|done|all&cursor=` returns every tool and every producer, paged.
  - `GET /api/agent/fleet/approvals/queue/counts` returns the health strip numbers.
  - A target resolver turns args and preview into product, SKU, name, channel and market.
  - It also builds the status above, joins who asked (the person and the connection), and computes "why it waits"
    at read time from the tool's rule and limits (no new column).
  - It adds the approvals count to the sidebar counts.
  - Vitest for the resolver, the status mapping and the counts.
- **B. API decide.**
  - In `approval-inbox.service.ts`, bulk approve for rows of the same kind, excluding kinds that cannot be undone
    (Decision 1). Bulk reject works across kinds.
  - The reject reason becomes optional on single rows, plans and bulk.
  - New `GET /api/claude/trust/:tool/simulate`: "would have run N of the last M; you rejected K".
  - `?item=<id>` in Claude's approval links (`mcp-tool-call.ts`).
  - Vitest for each change; the existing approval-inbox, undo and staleness suites must stay green.
- **C. Design-system parts.**
  - A `ChangeCell` that shows before → after.
  - `actionsColumn` with 2 visible verbs.
  - A live `Countdown`.
  - A small keyboard-shortcut hook for grids.
  - Each part gets a catalog entry, a CHANGELOG line and a `.claude/DS-GAPS.md` line, plus a byte-identical copy in
    `apps/factory` where the file is shared.

**Wave 2: 2 agents in parallel**
- **D. The grid page.** New files in `apps/web/src/app/fleet/approvals/`:
  - `ApprovalsGrid.tsx`, `queueColumns.ts`, `useApprovalQueue.ts`, `HealthStrip.tsx` and `ApprovalDrawer.tsx`,
    built on `NexusGrid` + `GridCard`.
  - The toolbar swap and the Customise and Views menus copy the products page; the drawer copies `PublishRunDrawer`.
  - `page.tsx` switches to the grid.
- **E. The Automate modal.** `AutomateModal.tsx` plus its words, reusing `StepUpModal` and `claudeApi.setRule`, and
  calling the simulate endpoint.

**Wave 3: 1 agent + lead**
- **F. Clean-up.**
  - Remove the old card code that nothing uses any more, and the fleet-era wording; rewrite How it works; add the
    nav badge.
  - Replace the old card tests with tests for the new words and status mapping.
  - Then one local browser check (a big screen change): local API, local database, inert seeded requests, desktop
    and phone width, keyboard only.

**PRs:**
1. API (A + B)
2. Design-system parts (C)
3. The page (D + E)
4. Clean-up (F)

Each PR gets the light local checks (typecheck of every changed workspace and the tests of the changed area) and a
short check table. Nothing is merged without your word.

## 9. Not in this plan (later, only if you want it)
- Letting more kinds run by themselves (publishing, listing text, listing price and stock). Today the code caps
  these at "Ask me", so this needs its own safety plan.
- Rules per channel, market or product, or time-limited rules (Decision 2, option B).
- Live push (SSE) instead of fast polling; phone or e-mail alerts when something waits.
- Removing the 2 older approval lists (Settings › AI and Fleet overview), so this page is the only one.
- Nexus suggesting a rule by itself ("you approved 25 of 25 unchanged — automate?").

## 10. Decisions for the Owner
1. **Bulk approve for Claude's requests?** Today it is blocked on purpose (rule S8.4).
   - **A (recommended):** yes, for rows of the same kind only. Each row is re-checked when it runs; refunds,
     messages, deletes and any other kind that cannot be undone are never included.
   - **B:** no; approve each row one by one.
2. **How narrow can an automation be?**
   - **A (recommended):** per kind of change, with limits. This exists today, needs no database change and fits
     this plan.
   - **B:** also per channel, market or product. This needs a database change and about one more PR.
