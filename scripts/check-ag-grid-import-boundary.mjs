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
 *   design-system/grid/                            the engine itself — the seam (GDS).
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
  'apps/web/src/design-system/grid/',
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

// GDS §8.4 — the STYLESHEET half of the boundary. Outside the engine, no stylesheet may address an
// AG internal (`.ag-*`) or DEFINE a grid class (`.nds-ag-*`, `.nds-cell-*`, the GDS hosts): a page that restyles
// a cell from its own CSS is a fork of the grid by another name. The four DS sheets and every
// route stylesheet are in scope; the engine's own `design-system/grid/theme/grid.css` is the one
// place those selectors live. Tracked AND untracked, so a sheet a session just wrote counts.
const cssFiles = [...new Set([
  ...execSync('git ls-files "apps/web/src/**/*.css"', { encoding: 'utf8' }).split('\n'),
  ...execSync('git ls-files --others --exclude-standard "apps/web/src/**/*.css"', { encoding: 'utf8' }).split('\n'),
])].filter(Boolean)
// `.nds-cell-*` is the cell library; `.nds-grid-{pager,footstrip,card,panel,skel,noRows}` the hosts and
// toolbars. (`.nds-grid`, `.nds-grid-wrap/-sub/-kid/-empty/-prefsbar` are the RETIRING DS DataGrid's,
// defined in components.css until wave 1 — deliberately not in scope.)
const SELECTOR_LINE = /^[^/*{}]*\.(ag-[a-z]|nds-ag-|nds-cell-|nds-grid-(pager|footstrip|card|panel|skel|noRows))[\w-]*[^{};]*\{/
for (const f of cssFiles) {
  if (f.startsWith('apps/web/src/design-system/grid/')) continue
  let src
  try { src = readFileSync(f, 'utf8') } catch { continue }
  if (!/\.(ag-[a-z]|nds-ag-|nds-cell-|nds-grid-(pager|footstrip|card|panel|skel|noRows))/.test(src)) continue
  src.split('\n').forEach((line, i) => {
    if (SELECTOR_LINE.test(line)) offenders.push(`${f}:${i + 1} → stylesheet addresses the grid: ${line.trim().slice(0, 70)}`)
  })
}

if (offenders.length) {
  console.error(`\n❌ ag-grid import boundary: ${offenders.length} file(s) import AG Grid outside the engine and the labs:\n`)
  for (const o of offenders) console.error(`   ${o}`)
  console.error(`\n   The engine is the migration's seam — `)
  console.error(`   apps/web/src/design-system/grid/NexusGrid.tsx.`)
  console.error(`   A page hands NexusGrid AG's own ColDef[] and options through the DS barrel, never imports AG directly,`)
  console.error(`   so that swapping or reverting the engine stays one file.\n`)
  process.exit(1)
}

console.log(`✓ ag-grid import boundary: only the engine and the labs import AG Grid; no stylesheet outside the engine addresses it (${files.length} ts + ${cssFiles.length} css scanned)`)
