# F — clean-up (build agent F, 2026-10-05; nothing committed or staged, deletions are plain `rm`)

## Files (apps/web/src/app/fleet/approvals/ unless said)
- **Deleted:** ApprovalsClient.tsx, ApprovalLists.tsx, ApprovalCard.tsx, PlanCard.tsx, planCard.css, approval-words.ts, planWords.ts, HowApprovalsWork.tsx, and the 6 tests ApprovalCard.cannotApprove · ApprovalCard.generic · approvals-words · content-approval · planSteps · planWords. Grep of apps/web/src: no other importer.
- **Moved, not kept:** what the drawer used → `grid/planWords.ts` (plan types, kindSentence, stepWhat, stepMatches, rovingTarget, STEP_STATUS; `plainValue` inlined; the old card's `planButton` dropped).
- **Kept:** `reversibility.ts` — imported by marketing/…/fleet/DecisionCard.tsx and ApprovalInbox.tsx (Fleet Overview, PLAN §9).
- **approvals.css:** 1819 → 63 lines: the header rules and the `.aq-page` light pin only (hex 63→2, radius 24→0, shadow 4→0).
- **New:** `grid/HowItWorks.tsx` (+ `.module.css`): request · every status (STATE_META words + one line each) · Approve = 20 s (`STOP_WINDOW_MS`, now exported) with Undo / Hold · Reject (optional reason, back to Claude) · bulk (one kind; never refunds, messages, cancellations, closing, deleting, plans, irreversible kinds) · Automate (CHOICE_LABEL levels, limits, test, code to raise, none to lower, new requests only) · expiry from gate-state `expiry.hours` (no number until read) · the keys the page binds. `grid/FleetGateState.tsx`: halt Banner, the server's conditions verbatim with state word + owner + Controls link + next time, the fleet's 3 actions (Can run / Describes only), loading Skeleton, failed read Banner + Try again. DS Drawer `className="fleet-portal"`; gate-state is read when the drawer opens, no longer on every page load.
- **Changed:** ApprovalsGrid.tsx (HowItWorks, onFollow → open id + `?item=`, subtitle without "the fleet and your rules"); contracts.ts + ApprovalDrawer.tsx (`onFollow?(id)`, called on edit / smaller plan / asked undo); drawerWords.ts (STATE_WORDS and PENDING_STATES deleted → queueWords `stateMeta` / `isPending`); automateWords.ts ("is not a tool Claude is offered" → "Claude cannot ask for …"); page.tsx comment (its rail-badge claim, D20); PlanSteps/useApprovalDetail imports; apps/api approval-target.ts (comment pointer to plainValue).

## Tests
- Ported: `grid/planWords.vitest.test.ts` (kind line, step line, no raw JSON, plainValue, filter, arrow keys); `reversibility.vitest.test.ts` (reversibilityFrom, no TOOL_CARD `undoable`, ads inbox parked row — live code).
- New: `grid/HowItWorks.vitest.test.ts` (12). Re-pointed: claudePage (`grid/PlanSteps.tsx`: `<PlanStepsList`, no `<NexusGrid`, ApprovalDrawer.module.css), command-key (PlanSteps.tsx calls plan-amend), fleet-pages (deleted card edges → `.aqg-error`), drawerWords (one vocabulary), automateWords (+1).

## Nav badge — NOT built: no mechanism for this item
Badges exist only on top-level rail items (`RailNavItem.badge`, `n(counts.x)` in app-nav.ts). "Approvals" is third level (Agent Fleet › Operate › Approvals, `RailMarketItem`: code/label/href), which has no badge and no dot; `SidebarCounts` does not declare `approvals`. Options for the lead: (a) `badge: n(counts.approvals?.needsYou)` on the top-level "Agent Fleet" item + the type field (existing mechanism), or (b) a badge on AppRail's sub-items (new mechanism).

## Checks
| Check | Command | Result |
|---|---|---|
| Web typecheck | `npx tsc --noEmit -p tsconfig.json --tsBuildInfoFile /private/tmp/claude-501/approvals-F-web.tsbuildinfo` | pass |
| API typecheck (comment only) | same, apps/api, `approvals-F-api.tsbuildinfo` | pass |
| Area tests | `npx vitest run src/app/fleet src/app/settings/ai src/app/_shared src/lib` | 39 files, 384 pass |
| Static gates | `node scripts/ci/run-static-gates.mjs` | 61/65; the 4 known; failure output byte-identical to before |
| i18n | — | not run: no `t()` key touched |
| Browser | — | not run (G's stack / lead's check) |

## Left
- Dark leak (D1/D2/E CSS, not mine): `--nds-text-strong` (ApprovalDrawer.module.css titles) and `--nds-text-muted` (approvalsGrid.css, automate.css) are not in the fleet light pin, so a dark OS gives them dark-theme values on the light surface. Fix: `--nds-text` / `--nds-text-3` (text-muted is text-3 in light). My CSS reads pinned tokens only.
- Baselines untouched (no ratchet asked to lower): raw-primitives still lists the 4 deleted .tsx (32), css-hex/radius/shadow still list approvals.css at 63/24/4.
- No row highlight exists for the open request (the drawer is modal). Follow moves the open id, the row handed to the drawer, and `?item=` when the address has one.
