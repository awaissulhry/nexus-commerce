#!/usr/bin/env node
/**
 * Frozen paths — `apps/factory` is frozen.
 *
 * WHY THIS EXISTS
 * The old factory app is kept as reference only: no new features, no fixes, and no more copies of
 * design-system changes into its `src/design-system`. A new factory app replaces it later. A
 * frozen app that still takes "small" edits is not frozen, and nothing else in the repo can tell
 * an edit there from an edit anywhere else.
 *
 * THE RULE
 * The branch may not add, change, rename or delete any file under a frozen path. "The branch" is
 * every commit since `git merge-base HEAD origin/main`: what a push would carry. Uncommitted edits
 * do not count, so a local build that rewrites a tracked file there (`apps/factory/tsconfig.tsbuildinfo`)
 * fails nothing until someone commits it.
 *
 * ONE EXCEPTION
 * `apps/factory/CLAUDE.md` holds the notice that the app is frozen. It may change, so the notice
 * can point to the app that replaces it.
 *
 * THE OVERRIDE (only for the one planned change: deleting the old app)
 *   FROZEN_PATHS_ALLOW_DELETE=apps/factory node scripts/check-frozen-paths.mjs
 * lets the branch DELETE files under `apps/factory/`. An added, changed or renamed-in file there
 * still fails. Set it only on the branch that removes the old app, and say so in its pull request.
 *
 * No merge base (for example `origin/main` was never fetched) is a FAILURE, never a pass: a guard
 * that cannot see the branch has checked nothing.
 *
 *   node scripts/check-frozen-paths.mjs                  # exit 1 on a change under a frozen path
 *   node scripts/check-frozen-paths.mjs --base <ref>     # compare with another ref (default origin/main)
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FROZEN = ['apps/factory/']
const EXCEPTIONS = new Set(['apps/factory/CLAUDE.md'])
const OVERRIDE = 'FROZEN_PATHS_ALLOW_DELETE'

const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const baseArg = process.argv.indexOf('--base')
const baseRef = baseArg === -1 ? 'origin/main' : process.argv[baseArg + 1]

let base
try {
  base = git('merge-base', 'HEAD', baseRef).trim()
} catch {
  console.error(`✗ frozen-paths: no merge base between HEAD and ${baseRef}. Run \`git fetch origin\` and try again.`)
  process.exit(1)
}

// The override names the path it opens for deletion, so it cannot open a path by accident.
const deletable = (process.env[OVERRIDE] ?? '')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => (p.endsWith('/') ? p : `${p}/`))
const unknown = deletable.filter((p) => !FROZEN.includes(p))
if (unknown.length) {
  console.error(`✗ frozen-paths: ${OVERRIDE} names a path that is not frozen: ${unknown.join(', ')} (frozen: ${FROZEN.join(', ')})`)
  process.exit(1)
}

// `-z`: paths come back unquoted and NUL-separated. `--no-renames`: a file moved out of a frozen
// path is a deletion there, and a file moved in is an addition.
const fields = git('diff', '--name-status', '-z', '--no-renames', base, 'HEAD', '--', ...FROZEN).split('\0').filter(Boolean)
const offenders = []
const deleted = []
for (let i = 0; i < fields.length; i += 2) {
  const status = fields[i]
  const path = fields[i + 1]
  if (EXCEPTIONS.has(path)) continue
  if (status === 'D' && deletable.some((p) => path.startsWith(p))) {
    deleted.push(path)
    continue
  }
  offenders.push(`  ${status}  ${path}`)
}

const since = `since ${base.slice(0, 9)} (merge base with ${baseRef})`
if (offenders.length) {
  console.error(`✗ frozen-paths: ${offenders.length} file(s) changed under a frozen path ${since}:`)
  console.error(offenders.join('\n'))
  console.error(`\n  ${FROZEN.join(', ')} is frozen: reference only, no new features, no fixes, no design-system copies.`)
  console.error(`  Take the change out of this branch. Deleting the old app is the one planned exception: ${OVERRIDE}=apps/factory.`)
  process.exit(1)
}
if (deleted.length) console.log(`✓ frozen-paths: ${deleted.length} deletion(s) under ${deletable.join(', ')} allowed by ${OVERRIDE}; nothing else changed ${since}`)
else console.log(`✓ frozen-paths: nothing changed under ${FROZEN.join(', ')} ${since}`)
