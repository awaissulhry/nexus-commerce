#!/usr/bin/env node
/**
 * AG.4 — the AG Grid import boundary.
 *
 * AG.1 established that ONE file may import the AG Grid React binding, so the migration's seam is
 * a single file and a rollback is a single change. That was a comment. A comment is not a
 * boundary — the feature lab needed a second importer within hours of the rule being written, and
 * nothing would have noticed a third.
 *
 * ALLOWED, and why:
 *   design-system/patterns/workspace-grid/engine/  the engine itself — the seam.
 *   app/design/grid-lab/                           the labs. Design-system routes, no product
 *                                                  surface depends on them, and the feature lab
 *                                                  exists precisely to use APIs the engine's
 *                                                  narrow prop surface does not expose.
 *
 * Anything else is a page reaching past the seam, which is the thing this exists to stop.
 *
 * Usage: node scripts/check-ag-grid-import-boundary.mjs
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const ALLOWED = [
  'apps/web/src/design-system/patterns/workspace-grid/engine/',
  'apps/web/src/app/design/grid-lab/',
]

// Matches a real import/require of the packages, not the words in prose.
const IMPORT = /(?:^|\n)\s*(?:import[\s\S]{0,200}?from\s*|import\s*|export[\s\S]{0,200}?from\s*)['"](ag-grid-[a-z]+|ag-charts-[a-z]+)['"]|require\(\s*['"](ag-grid-[a-z]+|ag-charts-[a-z]+)['"]\s*\)/

// Tracked files only — an untracked scratch file is not something a push can ship.
const files = execSync('git ls-files "apps/**/*.ts" "apps/**/*.tsx"', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)

const offenders = []
for (const f of files) {
  if (ALLOWED.some((a) => f.startsWith(a))) continue
  let src
  try { src = readFileSync(f, 'utf8') } catch { continue }
  if (!src.includes('ag-grid-') && !src.includes('ag-charts-')) continue
  const m = src.match(IMPORT)
  if (m) offenders.push(`${f} → ${m[1] ?? m[2]}`)
}

if (offenders.length) {
  console.error(`\n❌ ag-grid import boundary: ${offenders.length} file(s) import AG Grid outside the engine and the labs:\n`)
  for (const o of offenders) console.error(`   ${o}`)
  console.error(`\n   The engine is the migration's seam — `)
  console.error(`   apps/web/src/design-system/patterns/workspace-grid/engine/AgWorkspaceGrid.tsx.`)
  console.error(`   A page should talk to it through WorkspaceGridProps, never to AG Grid directly,`)
  console.error(`   so that swapping or reverting the engine stays one file.\n`)
  process.exit(1)
}

console.log(`✓ ag-grid import boundary: only the engine and the labs import AG Grid (${files.length} files scanned)`)
