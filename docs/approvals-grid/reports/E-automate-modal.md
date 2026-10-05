# E — "Automate this kind…" modal (build agent E, 2026-10-05)

Worktree `/private/tmp/feat-approvals-grid`, branch `feat/approvals-grid`. Nothing committed. `contracts.ts` is unchanged.

## Files
- New, in `apps/web/src/app/fleet/approvals/grid/`:
  - `AutomateModal.tsx`: a DS `Modal` with `className="fleet-portal"`.
  - `automateWords.ts`: pure words. It reuses claudeWords (`limitFields`, `parseLimits`, `raises`, `tightens`, `raiseText`, `toolTitle`).
  - `automateWords.vitest.test.ts`: 21 tests, including a source scan for DS-only controls and classes.
  - `automate.css`: layout only, `aq-auto-*`, `--nds-*` tokens.
- Changed: `settings/ai/claude/StepUpModal.tsx` gets an optional `className`, passed to its `Modal`. Without it, the 2FA dialog turns dark over the light modal in a dark theme. RulesPanel does not pass it, so the settings page is unchanged.
- Nothing was moved out of RulesPanel. Only the pure helpers are shared, because the modal's limit rows add a hint from the request and the server's words.
- The modal imports `claude.css`, so StepUpModal looks as it does on the settings page.

## Behaviour
- Reads the rule with `claudeApi.rules()`.
- Offers the levels at or below both `automation.max` and the rule's ceiling. Off is left to the settings page. The current level is pre-selected and marked "(now)".
- A plan, a kind capped at Ask, or a kind Claude is not offered shows the reason and Close.
- Limits show only for Auto, pre-filled from the kind's limits now.
  - A hint is never filled in: "This request: −10%" only when every change line is in the row; "12 products" only when the target is of the limit's kind.
  - Switch, choice and list limits are shown read-only.
  - If changes that run by rule are paused, Auto shows a warning.
- History test: GET simulate with `days=30&level=auto&limits=<json>`, 400 ms after the last change; stale calls are aborted. A 400 shows the server's words under the limit it names.

## When a code is asked
- StepUpModal asks for the code when the level rises (off/ask/confirm upward), or when limits change and do not only tighten (`tightens`, as on the settings page).
- Level and limits go in one PUT with one code.
- Lowering, keeping, or only tightening is sent at once. If the API still answers `mfa_required`, the code dialog opens, as RulesPanel does.
- Other refusals stay in the modal in the API's words.
- After a save: `onSaved({ level, alsoApprove })`, then `onClose()`.
- "Also approve this one" starts unticked. It shows only for waiting or back_to_you rows with `canApprove`.
- With no change and the box ticked, the button reads "Approve this one" and nothing is saved.

## Checks
| Check | Command | Result |
|---|---|---|
| Web typecheck | `npx tsc --noEmit -p tsconfig.json --tsBuildInfoFile /private/tmp/claude-501/approvals-E-web.tsbuildinfo` | pass, 0 errors (D1/D2 files present) |
| Vitest | `npx vitest run src/app/fleet/approvals/grid src/app/settings/ai/claude` | 70/70 pass, 6 files (RulesPanel tests green) |
| Static gates | `node scripts/ci/run-static-gates.mjs` | 61/65; the 4 known main failures, none new |

## Differs from the brief / not done
- Read-only limits say "Cannot be changed on screen yet." The brief's "Change in Settings › AI › Claude › Rules" would be untrue: that page edits number limits only.
- The line under the choices ends "…at any time, without a code." The brief's "with one click" is not accurate: it takes a choice plus Save.
- No browser check was run (no servers, per the brief). No contract change is needed.
