# D1 — the approvals grid page (build agent D1, 2026-10-05, not committed)

## Files (apps/web/src/app/fleet/approvals/)
| File | What it does |
|---|---|
| `grid/ApprovalsGrid.tsx` | Client root: `FleetPageShell` (title, one line, the existing `HowApprovalsWork` unchanged, its expiry numbers read once from gate-state) → `HealthStrip` → kept row errors (Banners) → `GridCard` + `QueueToolbar` + `NexusGrid` → Show more → key hints; `ApprovalDrawer`, `AutomateModal`, the bulk confirm `Modal` and `PreferencesModal` (all `fleet-portal`). `?item=` opens the drawer at load; closing removes it (`router.replace`). Row click / Enter opens; A approve (Retry on a failed row), R reject, Space tick, Esc close. |
| `grid/useApprovalQueue.ts` | `/queue?show=&limit=` + `/queue/counts` per tick through `useVisibilityPoll`: 3 s while a row is starting/running/on hold (or counts say so), 15 s otherwise. Re-reads what is on screen (100–200 rows); "Show more" pages by cursor. A failed read keeps the last rows and says so; a stale answer after a Show change is dropped and re-read. |
| `grid/approvalActions.ts` | `useApprovalActions` = `ApprovalActions` + `commit`, `bulkPreview`, `bulkDecide`. Per-row busy set, per-row errors kept until dismissed, re-read after each decision. Toast "Approved — runs in 20 s" with Undo (20 s). Commit once per run time; its refusal is not shown (the 30 s sweep is the fallback). Content-type only with a body. |
| `grid/queueColumns.tsx` | ☐ · Status (Pill; `Countdown` "Runs in 14 s" / "On hold · runs in 9 min", onDone → commit) · What ("Plan · N steps" / "34 of 120 done") · Product (`Link`, "12 products") · Change (`changeColumn`, more = changeCount − shown) · Where · Asked by · Why / result (a kept error shows here in red) · Asked (`AsOf`) · Expires (`Countdown`) · Actions (`actionsColumn`, ⋯: Open details, Hold 10 min, Automate this kind… held "This kind always needs you"). Hidden group columns. |
| `grid/HealthStrip.tsx` | `MetricStrip` tiles (FilterChips on a phone): Needs you · Running · Failed · Ran by rule today · Oldest waiting. Each is a filter (pressed; click again clears); Ran by rule switches Show to Done. |
| `grid/QueueToolbar.tsx` | Search (AG quick filter) · Show · Group · Views (`useGridState` surface `fleet-approvals`) · Customise. Ticked rows → "Selected N", "Approve N · <kind>" / "Reject N" (held with the plain reason, never silently disabled), Clear. |
| `grid/queueWords.ts` + `.vitest.test.ts` | Every word and rule, pure: states/tones, Where, verbs, bulk verdicts and outcome text, tiles, groups, phone columns, poll cadence and page merge (24 tests). |
| `grid/approvalsGrid.css`, `page.tsx` | Layout only, `--nds-*` only. `page.tsx` renders `ApprovalsGrid` in `.aq-page` (same URL, `force-dynamic`); it no longer loads `fleet-sections.css` (nothing uses `ap-*` now). |

## Checks
| Check | Command | Result |
|---|---|---|
| Web typecheck | `npx tsc --noEmit -p tsconfig.json --tsBuildInfoFile /private/tmp/claude-501/approvals-D1-web.tsbuildinfo` | pass (with D2's and E's files present) |
| Area tests | `npx vitest run src/app/fleet/approvals` | 11 files, 145 tests pass |
| Static gates | `node scripts/ci/run-static-gates.mjs` | 61/65 — only the 4 known failures (shell pin freshness, dark ⇄ pin parity, token resolution, DS api guard) |
| Grid identity · AG boundary · modules · links | the four scripts alone | pass (identity and raw-primitives scan untracked files too) |
| Browser | — | not run (the lead's check) |

## Open, and decisions to check
1. **"Group: Claude plan" is not built.** `QueueRow` has no run/plan id. Offered: None · Kind · Product · **Asked by**. To add it: `runId: string \| null` on `QueueRow` (packages/shared/approval-queue.ts; A's service already joins `AgentRun`), then one `GROUP_COLUMN` entry + one `groupKey` case.
2. **Phone (< 640 px):** one visible verb + ⋯ (the second verb is the menu's first item) and no checkboxes: two verbs + ⋯ are 200 px of a 390 px screen.
3. Show is restored from a NAMED view only; the last-used layout restores columns and Group, and the page always opens on Open.
4. When the cadence flips (15 s ↔ 3 s) `useVisibilityPoll` restarts its timer with one immediate read; the shared hook was left unchanged.
5. No contract change: `contracts.ts` untouched; `QueueActions` extends `ApprovalActions` (D2 receives it as `ApprovalActions`).
6. Not checked in a browser: Space/Enter on a focused AG row (Enter has two idempotent paths), row grouping with group checkboxes on the client row model, toasts under a dark OS (`ToastProvider` takes no className).
