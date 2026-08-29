#!/usr/bin/env node
/**
 * GDS §8.5 — every option object / callback handed to `<NexusGrid>` has a STABLE identity.
 *
 * WHY
 * `AgGridReact` shallow-compares its props and calls `setGridOption` for each one whose identity
 * changed. An object literal or arrow function written inline in JSX is a NEW identity on every
 * render — and a page re-renders on every selection tick — so `rowSelection={{ … }}` made AG
 * re-run its column model per checkbox click (measured 2026-08-28: `aria-colindex` rewritten on
 * every Product cell per tick). Decision 12 of the GDS: memoise them. This makes that a gate.
 *
 * WHAT IT CHECKS (TypeScript AST, not a regex — a regex counts comments and misses multi-line JSX)
 * Every `<NexusGrid …>` element under apps/web/src: an attribute from OPTION_PROPS, or any `on*`
 * handler, whose initializer is an object literal, array literal, arrow function or function
 * expression is a violation. `{someIdentifier}` and `{a.b}` are fine — the identity is the
 * caller's to keep stable with useMemo/useCallback.
 *
 * Baseline ZERO. The labs are included: a demo that teaches the wrong shape is worse than none.
 *
 *   node scripts/check-grid-option-identity.mjs
 */
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const OPTION_PROPS = new Set([
  'rowSelection', 'selectionColumnDef', 'cellSelection', 'defaultColDef', 'autoGroupColumnDef', 'columnDefs',
  'localeText', 'columnDialog', 'getRowHeight', 'getRowId', 'isRowSelectable', 'isServerSideGroup', 'getServerSideGroupKey',
  'serverSideDatasource', 'getDataPath', 'initialState', 'rowData', 'pinnedTopRowData', 'pinnedBottomRowData', 'sideBar',
  'loadingOverlayComponentParams', 'noRowsOverlayComponentParams', 'cellClassRules', 'rowClassRules', 'context',
])
const GRID_NAMES = new Set(['NexusGrid'])

const files = execSync('git ls-files "apps/web/src/**/*.tsx"', { encoding: 'utf8' }).split('\n').filter(Boolean)
// Untracked files are what a fresh session writes; a `git ls-files` guard is blind to them (memory:
// reference_git_lsfiles_guards_miss_untracked). Add anything untracked under the same glob.
const untracked = execSync('git ls-files --others --exclude-standard "apps/web/src/**/*.tsx"', { encoding: 'utf8' }).split('\n').filter(Boolean)
const all = [...new Set([...files, ...untracked])]

const offenders = []
const isUnstable = (init) => {
  if (!init) return false
  if (!ts.isJsxExpression(init) || !init.expression) return false
  const e = init.expression
  return ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e) || ts.isArrowFunction(e) || ts.isFunctionExpression(e)
}

for (const f of all) {
  let src
  try { src = readFileSync(f, 'utf8') } catch { continue }
  if (!src.includes('NexusGrid')) continue
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf).replace(/<.*$/, '')
      if (GRID_NAMES.has(tag)) {
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr) || !attr.name) continue
          const name = attr.name.getText(sf)
          const watched = OPTION_PROPS.has(name) || /^on[A-Z]/.test(name)
          if (watched && isUnstable(attr.initializer)) {
            const { line } = sf.getLineAndCharacterOfPosition(attr.getStart(sf))
            offenders.push(`${f}:${line + 1}  <${tag} ${name}={…inline…}>`)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

if (offenders.length) {
  console.error(`\n❌ grid option identity: ${offenders.length} inline option object(s)/callback(s) on <NexusGrid> — memoise them (useMemo/useCallback):\n`)
  for (const o of offenders) console.error(`   ${o}`)
  console.error(`\n   An inline literal is a new identity every render; AG re-runs its column model for each (GDS decision 12).\n`)
  process.exit(1)
}
console.log(`✓ grid option identity: every <NexusGrid> option prop and handler is a stable reference (${all.length} files scanned)`)
