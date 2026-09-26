/**
 * Tier A pre-commit (docs/ci-plan.md §2.1) — the repo's own fast gates, chosen by what is staged.
 *
 * There is no ESLint or Prettier in this repo; these ratchets are its linters. Each one checks the
 * whole tree in about a second, so the function form below runs it WITHOUT appending the staged file
 * names (the scripts do not read them). Known limit, the same as the old pre-push hook: a whole-tree
 * check also sees another session's unstaged file in a shared checkout.
 *
 * CI runs every one of these again on the pull request (scripts/ci/run-static-gates.mjs).
 */
const run = (...commands) => () => commands

export default {
  '**/*.css': run(
    'node scripts/check-css-parse.mjs',
    'node scripts/check-css-hex-ratchet.mjs --check',
    'node scripts/check-css-radius-ratchet.mjs --check',
    'node scripts/check-css-ds-shadow-ratchet.mjs --check',
  ),
  'apps/*/src/**/*.{ts,tsx}': run(
    'node scripts/check-raw-primitives-ratchet.mjs --check',
    'node scripts/check-ag-grid-import-boundary.mjs',
    'node scripts/check-route-prisma-ratchet.mjs --check',
    'node scripts/check-context-boundary.mjs --check',
    'node scripts/check-stock-writer-lock.mjs --check',
  ),
  'apps/web/src/lib/i18n/**/*.json': run('node scripts/check-i18n-catalog.mjs'),
  'packages/database/prisma/**': run(
    'node packages/database/scripts/check-schema-drift.mjs',
    'node packages/database/scripts/check-column-drift.mjs',
    'node packages/database/scripts/check-model-ownership.mjs',
    'node scripts/check-migration-expand-contract.mjs',
  ),
  'apps/*/src/design-system/tokens/**': run('npm run tokens:check --silent', 'npm run tokens:check:factory --silent'),
}
