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
- Step 3 (build) STARTED 10-05. Contract written by lead: `packages/shared/approval-queue.ts` (+ export in
  packages/shared/package.json). Wave 1 RUNNING (3 agents, same worktree, disjoint files, no commits):
  A API read (approval-queue.service/approval-target/approval-queue.routes, sidebar count) · B API decide (bulk rule,
  optional reject reason, simulate endpoint, ?item= deep link) · C DS parts (ChangeCell, 2-verb actionsColumn,
  live countdown, grid shortcuts). Reports land in `docs/approvals-grid/build/{A,B,C}-*.md`.
- Test env: `source ~/nexus-archive/2026-10-05-approvals-grid-stack/env.sh` (loopback guard, PGlite tests);
  `apps/api/.env` (git-ignored) holds a loopback test DATABASE_URL. Run API vitest only from apps/api.
- Remaining build order: wave 1 (above) → lead reviews + commits → wave 2 (D grid page, E automate modal) → wave 3 (F clean-up + local browser check). 4 PRs, merge only on the Owner's word.
- Chrome extension was not connected (10-05) — live page not looked at yet.

## Next session: do this first
1. `cd /private/tmp/feat-approvals-grid && git status` — review any uncommitted work.
2. Read this file, then the research files, then PLAN.md if it exists.
3. The plan IS approved. Continue the build where the State section says. Agents never commit; the lead commits.
