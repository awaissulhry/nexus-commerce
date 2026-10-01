// Keep the filter broad: sheet/save code imports auth, permissions, schema, event and shared helpers transitively.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function needsSheet(paths) {
  return paths.some(path => /^(apps\/(web|api)\/|packages\/|scripts\/|patches\/|\.github\/)/.test(path)
    || (!path.includes('/') && !path.endsWith('.md')))
}

export function ciPassed(needs) {
  if (['checks', 'api', 'postgres', 'smoke', 'sheet-changes', 'sheet', 'db-security'].some(job => !needs[job])) return false
  const changes = needs['sheet-changes']
  const run = changes?.outputs?.run
  if (changes?.result !== 'success' || !['true', 'false'].includes(run) || !needs.sheet) return false
  return Object.entries(needs).every(([job, value]) => value.result === 'success'
    || (job === 'sheet' && run === 'false' && value.result === 'skipped'))
}

export function selfTest() {
  for (const path of [
    'apps/web/src/app/products/[id]/edit/_studio/sheet/master/columns.tsx',
    'apps/web/src/design-system/components/ListboxPanel.tsx', 'apps/web/src/lib/auth/install-fetch.ts',
    'apps/web/src/design-system/grid/editors/shapeColumn.ts', 'apps/web/smoke/sheet/drivers.ts',
    'apps/api/src/services/products/bulk-edit.service.ts', 'apps/api/src/lib/workspace-hook.ts',
    'apps/api/src/services/pim/channel-specs/ebay.ts', 'packages/database/workspace-adapter.ts',
    'packages/shared/src/sheet-cell-wire.ts', 'packages/events/catalog.ts',
    'scripts/ci/seed-sheet-fixture.mts', '.github/workflows/ci.yml', '.github/actions/setup/action.yml',
    'patches/ag-grid-enterprise+36.1.0.patch', 'package-lock.json', 'package.json', '.npmrc', 'turbo.json',
  ]) assert.equal(needsSheet([path]), true, path)
  assert.equal(needsSheet(['docs/product-sheet-editing/REPORT.md', 'README.md']), false)
  const good = { ...Object.fromEntries(['checks', 'api', 'postgres', 'smoke', 'db-security'].map(job => [job, { result: 'success' }])), 'sheet-changes': { result: 'success', outputs: { run: 'true' } }, sheet: { result: 'success' } }
  assert.equal(ciPassed(good), true)
  assert.equal(ciPassed({ ...good, api: undefined }), false)
  assert.equal(ciPassed({ ...good, sheet: { result: 'skipped' } }), false)
  assert.equal(ciPassed({ ...good, 'sheet-changes': { result: 'success', outputs: { run: 'false' } }, sheet: { result: 'skipped' } }), true)
  for (const result of ['failure', 'cancelled', 'skipped']) {
    assert.equal(ciPassed({ ...good, checks: { result } }), false, `required job ${result}`)
    assert.equal(ciPassed({ ...good, 'sheet-changes': { result, outputs: { run: 'false' } }, sheet: { result: 'skipped' } }), false, `filter ${result}`)
  }
  assert.equal(ciPassed({ ...good, 'sheet-changes': { result: 'success', outputs: {} } }), false)
  assert.equal(ciPassed({ ...good, sheet: { result: 'failure' } }), false)
  console.log('✓ sheet CI policy: transitive paths trigger; only an intentional sheet skip passes ci-ok')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'self-test') selfTest()
  else if (process.argv[2] === 'paths') {
    // Releases/manual runs always sweep. A missing/invalid PR base fails closed when git exits nonzero.
    const paths = process.env.EVENT === 'pull_request'
      ? execFileSync('git', ['diff', '--name-only', '-z', `${process.env.PR_BASE}...HEAD`], { encoding: 'utf8' }).split('\0').filter(Boolean)
      : null
    console.log(`run=${paths === null || needsSheet(paths)}`)
  } else if (process.argv[2] === 'result') {
    const needs = JSON.parse(process.env.NEEDS)
    for (const [job, value] of Object.entries(needs)) console.log(`${job}: ${value.result}`)
    process.exit(ciPassed(needs) ? 0 : 1)
  } else throw new Error('Expected paths, result or self-test')
}
