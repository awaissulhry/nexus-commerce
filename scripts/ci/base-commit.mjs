#!/usr/bin/env node
/**
 * CI — the commit a run compares against, as `KEY=value` lines for $GITHUB_ENV.
 *
 *   pull_request            the merge commit's first parent (the base tip GitHub merged onto),
 *                           else the event's base sha
 *   push / workflow_call    the push's `before` — on main, `merge-base HEAD origin/main` is HEAD
 *                           itself, and a check against it would compare nothing
 *   anything else           merge-base with origin/main, else HEAD~1
 *
 * Read by scripts/check-migration-expand-contract.mjs and scripts/ci/check-migration-upgrade.mjs
 * (NEXUS_MIGRATION_BASE) and by `turbo --affected` (TURBO_SCM_BASE).
 *
 *   EVENT=pull_request PR_BASE=<sha> BEFORE=<sha> node scripts/ci/base-commit.mjs
 */
import { execFileSync } from 'node:child_process'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const isCommit = sha => { try { return Boolean(sha) && !/^0+$/.test(sha) && git('cat-file', '-t', sha) === 'commit' } catch { return false } }

const { EVENT = '', PR_BASE = '', BEFORE = '' } = process.env
let base = ''
if (EVENT === 'pull_request') {
  let parents = []
  try { parents = git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1) } catch { /* shallow */ }
  base = parents.length === 2 ? parents[0] : PR_BASE
} else if (EVENT === 'push') {
  base = BEFORE
}
if (!isCommit(base)) {
  try { base = git('merge-base', 'HEAD', 'origin/main') } catch { base = '' }
}
if (!isCommit(base) || base === git('rev-parse', 'HEAD')) {
  try { base = git('rev-parse', 'HEAD~1') } catch { base = '' }
}
if (!isCommit(base)) {
  console.error('✗ no base commit could be resolved — fetch the history (actions/checkout fetch-depth: 0)')
  process.exit(1)
}
console.error(`base commit for ${EVENT || 'this run'}: ${base}`)
console.log(`NEXUS_MIGRATION_BASE=${base}`)
console.log(`TURBO_SCM_BASE=${base}`)
