# D2 — the request drawer (approvals grid, wave 2) — report

Agent D2, 2026-10-05, worktree `/private/tmp/feat-approvals-grid`. Nothing committed. All files new, in `apps/web/src/app/fleet/approvals/grid/`:
`ApprovalDrawer.tsx` (+ `.module.css`, layout only), `useApprovalDetail.ts` (detail + plan reads), `drawerWords.ts` (pure), `PlanSteps.tsx`, `EditValue.tsx`; tests `drawerWords.vitest.test.ts`, `PlanSteps.vitest.test.ts`, `ApprovalDrawer.vitest.test.ts` (SSR, Drawer + data hook mocked).

**What it does.** DS `Drawer` modal (width 640, `className="fleet-portal …"`), focus in/out and Esc as PublishRunDrawer; questions inside it are `DrawerOverlayCard`s. Top to bottom: status Pill (+ live `Countdown` "Runs in 14 s" for starting/on hold, `onDone` → `actions.refresh`), product (`Link` when `target.href`), where, "what it means" (reaches outside · undoable) → verbs via `actions` only (Approve held with `aria-disabled` + visible `cannotApproveWhy`; Reject… asks an optional reason; Retry; Undo + Hold 10 min; Automate this kind…; per-row busy lock and dismissable error) → why it waits / Banner for failed and handed back → every change (`ChangeValue`) or a bulk request's items list (≤50, "and N more") → a plan: kind sentences, `JobProgress` "34 of 120 steps done", the steps as ONE list (roving Keep ticks while pending, else the list is the one tab stop), "Keep only these N steps" (plan-amend) → "Claude says" as plain text → Timeline (API events + fallback words + the channel's answer; `unknown` = "Nexus cannot see the channel's answer") → Undo this change… (asks first, `claudeApi.undo`, notice with "Show the undo") or `whyNotUndoable` → edit, then approve → footer facts (id + copy, asked, expires countdown, decided by). 404 → "This request no longer exists."; a failed re-read keeps the last detail with a warning. After an edit / smaller plan / asked undo the drawer FOLLOWS the new id (internal state; reset when the page changes `id`).

**Edit spec** (`drawerWords.ts` `EDIT_SPECS`; amend patches args shallowly, so only unambiguous keys; server refusal shown verbatim; success = new request to approve):

| tool | arg | kind | needs request args |
|---|---|---|---|
| set-price | `price` | money, master currency | no (start value from the "Base price" line) |
| set-target-bid / graduate-keyword | `proposedBidCents` / `bidCents` | money, cents, €0.05–€10 (old card) | no |
| set-campaign-budget / set-ebay-campaign-budget | `dailyBudgetCents` | money, cents | no |
| reply-to-review / set-product-sku | `body` (2–80) / `sku` (≤100) | text | no |
| set-listing-price | `price`, only when `action: set-price` | money | **yes** |
| set-listing-stock | `quantity` (pin-quantity) / `buffer` (set-buffer) | whole number | **yes** |
| set-stock | `items[0].quantity`, one row only | whole number | **yes** |

Any other `canEdit` request: "To change it, ask Claude for a new request."

**Contract changes I need (not made):**
1. `QueueDetail.editArgs: Record<string, unknown> | null` — the request's args, sent only when `canEdit` (same gate as `askerReason`). Without it the 3 "yes" rows show the ask-again hint; the drawer already reads it (`requestArgsOf`).
2. Optional: `ApprovalDrawerProps.onFollow?(id)` if the page should own the followed id (its `?item=` and row highlight stay on the old id now).
3. `drawerWords.STATE_WORDS` = D1's `queueWords.STATE_META` (same words and tones, copied): merge into one.
4. F (clean-up) must keep `../planWords.ts` (+ `approval-words.ts` `plainValue`): the drawer imports its types and `kindSentence/stepWhat/stepMatches/rovingTarget/STEP_STATUS`.

**Decisions to check:** modal, not dock (no `mode` in the contract; a dock needs a width reserve on the page). Plans: no "tick each kind" gate (one-click approve as the grid). Hand-back → Approve (as D1), failed → Retry.

| check | command | result |
|---|---|---|
| web typecheck | `npx tsc --noEmit -p tsconfig.json --tsBuildInfoFile /private/tmp/claude-501/approvals-D2-web.tsbuildinfo` | pass (incl. D1/E files at the time) |
| grid tests | `npx vitest run src/app/fleet/approvals/grid` | 5 files, 82 pass (mine: 3 files, 37) |
| neighbours | `npx vitest run src/app/fleet/approvals src/app/settings/ai/claude` | 15 files, 170 pass |
| static gates | `node scripts/ci/run-static-gates.mjs` | 61/65; the same 4 pre-existing failures, none new |
| browser | — | not run (no servers in this lane; lead's wave-3 check) |
