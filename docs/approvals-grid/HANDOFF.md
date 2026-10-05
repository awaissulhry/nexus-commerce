# Approvals grid rebuild — HANDOFF

## Summary
- Goal (Owner, 2026-10-05): rebuild `/w/<id>/fleet/approvals` as a GRID (like the product sheet) so Claude via the
  Nexus MCP works without interruption, and the Owner sees what Claude asks, progress and problems. Per row:
  approve / reject / "automate this kind". Super simple, design system only, best in the industry.
- Worktree: `/private/tmp/feat-approvals-grid`, branch `feat/approvals-grid`, from origin/main `7039b95ef`.
- Workflow the Owner set: research with sub-agents → structured plan → Owner approves → build with sub-agents.
- NO code before the Owner's yes on the plan.

## State
- Step 1 (research) DONE: `docs/approvals-grid/research/` 01-today-page-and-api · 02-automation-and-progress ·
  03-design-system-grid · 04-industry-patterns.
- Step 2 (plan) DONE: `docs/approvals-grid/PLAN.md`. APPROVED by the Owner 10-05: Decision 1 = A (bulk approve, same
  kind, never irreversible kinds), Decision 2 = A (per-kind rules with limits, no schema change).
- Step 3 (build) STARTED 10-05.
  - Wave 1 DONE + COMMITTED on feat/approvals-grid (not pushed): d83191e4c docs · 9500ea038 API (queue read
    endpoints, bulk approve of one kind, optional reject reason, simulate, ?item= link) · 58c0269fd DS parts
    (ChangeValue/changeColumn, 2-verb actionsColumn, Countdown, useGridShortcuts). Lead checks: api tsc pass;
    22 API test files 343/343 pass with profiles off AND on; web tsc pass; DS tests 145 files 1975/1975 pass.
    Known pre-existing (not ours): mcp-coverage test misses 4 rows from main; static gates 4 failures on main
    (shell pin freshness, dark⇄pin parity, token resolution, DS api guard); factory tsc 446 errors on main.
  - Wave 2 DONE + COMMITTED: 67c7e3e8d reports (docs/approvals-grid/reports/, renamed from git-ignored build/) ·
    cc5ef2700 the grid page (grid/ApprovalsGrid, drawer, Automate modal, QueueDetail.editArgs). Lead checks: web tsc
    pass; web tests 192 files 2551/2551; api tsc pass; queue route test 29/29; static gates 61/65 (the 4 on main).
  - Wave 3 RUNNING: F clean-up (delete old cards, How it works + FleetGateState, nav badge, one state map, drawer
    onFollow) in the worktree, no commits · G private stack + Playwright check OUTSIDE the repo:
    ~/nexus-archive/2026-10-05-approvals-grid-stack/ (pg :55730 copy of nexus-sheet-publish-pg, redis :6730,
    API :4730, web :3730, seed-approvals.mts seed|clean, approvals-check.mjs, STACK.md).
  - After wave 3: lead reviews F, re-runs the check, READS the screenshots, fixes, commits; then the check table and
    ask the Owner about push / PRs.
- Test env: `source ~/nexus-archive/2026-10-05-approvals-grid-stack/env.sh` (loopback guard, PGlite tests);
  `apps/api/.env` (git-ignored) holds a loopback test DATABASE_URL. Run API vitest only from apps/api.
- PRs: nothing pushed yet; push/merge only on the Owner's word.
- Chrome extension was not connected (10-05) — live page not looked at yet.

## Next session: do this first
1. `cd /private/tmp/feat-approvals-grid && git status` — review any uncommitted work.
2. Read this file, then the research files, then PLAN.md if it exists.
3. The plan IS approved. Continue the build where the State section says. Agents never commit; the lead commits.
