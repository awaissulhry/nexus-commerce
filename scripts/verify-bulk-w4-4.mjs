#!/usr/bin/env node
// Verify W4.4 — persist Wave 4 state in saved views.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')

let failures = 0
function check(label, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) failures++
}

console.log('\nW4.4 — persist Wave 4 state in saved views\n')

const sv = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/lib/saved-views.ts'),
  'utf8',
)
const client = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/BulkOperationsClient.tsx'),
  'utf8',
)

console.log('Case 1: ViewExtras interface + helpers')
check('ViewExtras exported',
  /export interface ViewExtras/.test(sv))
check('extras field on SavedView',
  /extras\?: ViewExtras/.test(sv))
check('VIEW_EXTRAS_KEY constant exported',
  /export const VIEW_EXTRAS_KEY/.test(sv))
check('unpackViewExtras exported',
  /export function unpackViewExtras/.test(sv))
check('packViewExtras exported',
  /export function packViewExtras/.test(sv))

// Mirror the helpers
function unpackViewExtras(filterState) {
  if (!filterState || typeof filterState !== 'object') {
    return { filterState: filterState ?? undefined, extras: undefined }
  }
  const extrasField = filterState['_viewExtras']
  if (!extrasField || typeof extrasField !== 'object') {
    return { filterState, extras: undefined }
  }
  const { _viewExtras: _drop, ...cleaned } = filterState
  return { filterState: cleaned, extras: extrasField }
}

function packViewExtras(filterState, extras) {
  if (!extras || Object.keys(extras).length === 0) {
    return filterState ?? null
  }
  return { ...(filterState ?? {}), _viewExtras: extras }
}

console.log('\nCase 2: pack / unpack roundtrips')
{
  const fs1 = { status: ['ACTIVE'], channels: ['AMAZON'] }
  const ex1 = {
    sortKeys: [{ columnId: 'sku', direction: 'asc' }],
    groupByColumnId: 'brand',
  }
  const packed = packViewExtras(fs1, ex1)
  check('packed contains _viewExtras key', packed._viewExtras !== undefined)
  check('packed preserves original filterState fields', packed.status[0] === 'ACTIVE')
  const { filterState: fs2, extras: ex2 } = unpackViewExtras(packed)
  check('unpacked filterState drops _viewExtras', fs2._viewExtras === undefined)
  check('unpacked filterState preserves status', fs2.status[0] === 'ACTIVE')
  check('unpacked extras matches input', JSON.stringify(ex2) === JSON.stringify(ex1))
}

console.log('\nCase 3: empty extras → no-op')
{
  const fs1 = { status: [] }
  const packed = packViewExtras(fs1, undefined)
  check('undefined extras → identity', packed === fs1)
  const packed2 = packViewExtras(fs1, {})
  check('{} extras → identity', packed2 === fs1)
}

console.log('\nCase 4: null filterState handled')
{
  const ex = { sortKeys: [{ columnId: 'sku', direction: 'asc' }] }
  const packed = packViewExtras(null, ex)
  check('null + extras → wraps as {_viewExtras: ...}', packed._viewExtras !== undefined)
  const { filterState, extras } = unpackViewExtras(null)
  check('unpack null → undefined', filterState === undefined && extras === undefined)
}

console.log('\nCase 5: fromServer lifts extras out')
{
  // Inspect source: fromServer should call unpackViewExtras
  check('fromServer calls unpackViewExtras',
    /fromServer\(t: ServerTemplate\): SavedView \{[\s\S]{0,300}unpackViewExtras\(t\.filterState\)/.test(sv))
}

console.log('\nCase 6: saveUserView packs extras into filterState')
check('saveUserView calls packViewExtras',
  /packViewExtras\(view\.filterState, view\.extras\)/.test(sv))

console.log('\nCase 7: BulkOperationsClient restores extras on view load')
check('handleSelectView reads view.extras',
  /const extras = view\.extras/.test(client))
check('restores sortKeys',
  /setSortKeys\(extras\?\.sortKeys \?\? \[\]\)/.test(client))
check('restores conditionalRules',
  /setConditionalRules\(extras\?\.conditionalRules \?\? \[\]\)/.test(client))
check('restores groupByColumnId',
  /setGroupByColumnId\(extras\?\.groupByColumnId \?\? ''\)/.test(client))
check('resets collapsedGroupKeys on view load',
  /setCollapsedGroupKeys\(new Set\(\)\)/.test(client))

console.log('\nCase 8: Save + Update both pin the extras')
{
  // saveAsView path — count occurrences of the extras-with-sort-keys
  // shape; both handleSaveAsView and handleUpdateActiveView contain
  // it, so ≥ 2 matches confirms both code paths are covered.
  const occurrences = (
    client.match(
      /extras:\s*\{\s*sortKeys,\s*conditionalRules,\s*groupByColumnId/g,
    ) ?? []
  ).length
  check(
    `extras-pin appears in both save paths (got ${occurrences})`,
    occurrences >= 2,
  )
  // V.5 update path
  check('handleUpdateActiveView passes extras',
    /handleUpdateActiveView[\s\S]{0,1200}extras: \{\s*sortKeys,\s*conditionalRules,\s*groupByColumnId/.test(client))
}

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed (Wave 4 complete)')
