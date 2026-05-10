#!/usr/bin/env node
// Verify W10.3 — per-row diff drawer + duration column.
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

console.log('\nW10.3 — per-row diff drawer\n')

const svc = fs.readFileSync(
  path.join(repo, 'apps/api/src/services/bulk-action.service.ts'),
  'utf8',
)
const client = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/history/HistoryClient.tsx'),
  'utf8',
)

console.log('Case 1: API listItems exposes durationMs')
check('listItems return type has durationMs',
  /durationMs: number \| null/.test(svc))
check('listItems maps r.durationMs into the response',
  /durationMs: r\.durationMs \?\? null/.test(svc))

console.log('\nCase 2: ItemRow type updated')
check('ItemRow type carries durationMs',
  /interface ItemRow[\s\S]{0,500}durationMs: number \| null/.test(client))
check('formatDurationMs helper added',
  /function formatDurationMs\(/.test(client))
check('formatDurationMs handles ms/s/m thresholds',
  /< 1000[\s\S]{0,200}< 60_000/.test(client))

console.log('\nCase 3: items table shows duration + view')
check('Duration column header',
  /<th[^>]*>Duration<\/th>/.test(client))
check('formatDurationMs rendered per row',
  /formatDurationMs\(it\.durationMs\)/.test(client))
check('View button per row',
  /onClick=\{\(\) => setDrawerItem\(it\)\}/.test(client) &&
  /title="View full payload"/.test(client))

console.log('\nCase 4: drawer state + Modal')
check('Modal imported',
  /import \{ Modal \} from '@\/components\/ui\/Modal'/.test(client))
check('drawerItem state hooked',
  /useState<ItemRow \| null>\(null\)/.test(client) &&
  /setDrawerItem/.test(client))
check('ItemDiffDrawer component declared',
  /function ItemDiffDrawer/.test(client))
check('Modal opened with placement=drawer-right',
  /placement="drawer-right"/.test(client))
check('open binds to item !== null',
  /open=\{item !== null\}/.test(client))
check('drawer renders before/after as JSON.stringify',
  /JSON\.stringify\(item\.beforeState/.test(client) &&
  /JSON\.stringify\(item\.afterState/.test(client))
check('drawer surfaces error message when present',
  /item\.errorMessage[\s\S]{0,300}<pre /.test(client))
check('drawer shows status + duration + target metadata',
  /Status[\s\S]{0,400}Duration[\s\S]{0,400}Target/.test(client))

console.log('\nCase 5: drawer rendered inside ItemsPanel')
check('ItemDiffDrawer mounted inside ItemsPanel JSX',
  /<ItemDiffDrawer item=\{drawerItem\} onClose=\{\(\) => setDrawerItem\(null\)\}/.test(client))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
