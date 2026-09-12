/** Read every loaded column, exercise its value boundary, then validate writes with dryRun only. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { coerceForShape } from '../src/services/pim/sheet-values.ts'
import { channelValuePatch, storedChannelState } from '../src/services/pim/channel-value-mutation.ts'

const require = createRequire(import.meta.url)
const { parseScalarValue, booleanLabel } = require('../../web/src/design-system/grid/editors/scalarValue.ts')
const { parseShape } = require('../../web/src/design-system/grid/editors/shapeValue.ts')
const { formatMeasure } = require('../../web/src/design-system/grid/renderers/shapeFormat.ts')

const base = process.env.ATTRIBUTE_QA_API ?? 'http://localhost:8091'
const product = process.env.ATTRIBUTE_QA_PRODUCT ?? 'cmokmy3a40078pm0p1fvnu523'
async function request(path: string, body?: unknown) {
  const response = await fetch(`${base}/api/${path}`, {
    ...(body ? { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  })
  const result = await response.json() as any
  assert(response.ok, `${path}: HTTP ${response.status}: ${JSON.stringify(result)}`)
  return result
}

const results = []
for (const scope of ['master', 'AMAZON', 'EBAY']) {
  const query = scope === 'master' ? 'scope=master' : `scope=channel&channel=${scope}`
  const sheet = await request(`products/${product}/studio/sheet?${query}&market=IT&locale=it`)
  const columns = []
  const changes = []
  let optionChecks = 0
  for (const col of sheet.columns) {
    let checks = 0
    const check = (condition: unknown, message: string) => { assert(condition, `${scope}:${col.key}: ${message}`); checks++ }
    const parse = (raw: unknown) => col.shape === 'list' || col.shape === 'measure' ? parseShape(col.shape, raw, col) : parseScalarValue(col, raw)
    check(sheet.rows.every((r: any) => r.values[col.key]), 'missing declared cell')
    const kinds = ['text', 'longtext', 'select', 'number', 'boolean', 'date']
    check(kinds.includes(col.kind), `unsupported kind ${col.kind}`)
    const shaped = ['list', 'measure'].includes(col.shape)
    for (const option of col.options ?? []) {
      const raw = shaped ? [option] : option
      assert.deepEqual(parse(raw), raw, `${scope}:${col.key}: option code changed`)
      const label = col.optionLabels?.[option] ?? option
      const matches = (col.options ?? []).filter((o: string) => (col.optionLabels?.[o] ?? o).toLowerCase() === label.toLowerCase())
      if (matches.length === 1 && !(col.options ?? []).some((o: string) => o === label && o !== option)) {
        assert.deepEqual(parse(shaped ? [label] : label), raw, `${scope}:${col.key}: label changed code`)
      }
      checks++; optionChecks++
    }
    if (!shaped && col.kind === 'boolean') for (const value of [false, true]) {
      const input = parse(value ? 'No' : 'Yes')
      check(input === !value, 'opposite choice did not change boolean')
      const saved = coerceForShape(col, input)
      check(saved.ok && saved.value === !value, 'API changed selected boolean')
      const patch = channelValuePatch({}, undefined, [col.key], 'SET', input)
      const stored = storedChannelState(JSON.parse(JSON.stringify(patch)), undefined, [col.key])
      check(stored.value === !value, 'storage changed selected boolean')
      check(booleanLabel(stored.value) === (value ? 'No' : 'Yes'), 'reloaded display reversed boolean')
    }
    if (!shaped && col.kind === 'number') for (const value of [0, -1.234567, 0.00001234]) check(parse(String(value)) === value, 'numeric precision changed')
    if (col.shape === 'measure') for (const unit of col.unitOptions ?? []) {
      const value = { value: 0.1234567, unit }
      assert.deepEqual(parse(formatMeasure(value)), value, `${scope}:${col.key}: measure copy/paste changed value or unit`)
      checks++
    }
    const row = sheet.rows.find((r: any) => r.values[col.key]?.editable && r.values[col.key]?.writable && r.parentId)
      ?? sheet.rows.find((r: any) => r.values[col.key]?.editable && r.values[col.key]?.writable)
    if (row) {
      const cell = row.values[col.key]
      if (scope !== 'master') check(cell.writeTarget === 'channelListing', 'channel edit targets Master')
      // A dry-run clear checks routing even for currently empty fields.
      const cannotClear: Record<string, unknown> = { name: row.name || row.sku, status: row.status || 'ACTIVE', weightUnit: 'kg', dimUnit: 'cm' }
      const value = scope === 'master' && Object.hasOwn(cannotClear, col.key) ? cell.value ?? cannotClear[col.key]
        : scope !== 'master' && ['price', 'quantity'].includes(col.key) ? cell.value ?? 0 : col.kind === 'boolean' ? false : null
      changes.push({ id: row.id, field: cell.writeField ?? col.writeField ?? col.key, value, ...(scope === 'master' ? {} : { target: 'channel' }) })
    }
    columns.push({ key: col.key, kind: col.kind, shape: col.shape ?? 'scalar', checks, writable: !!row })
  }
  const validation = await request('products/bulk', {
    dryRun: true,
    marketplaceContexts: scope === 'master' ? [{ marketplace: 'IT', locale: 'it' }] : [{ channel: scope, marketplace: 'IT' }],
    changes,
  })
  assert.equal(validation.dryRun, true)
  const result = { scope, columnCount: columns.length, rowCount: sheet.rows.length, optionChecks, columns, dryRun: { attempted: changes.length, accepted: validation.wouldUpdate, refusals: validation.errors } }
  results.push(result)
  console.log(JSON.stringify({ scope, columns: columns.length, optionChecks, dryRun: result.dryRun }))
  assert.deepEqual(validation.errors, [], `${scope}: an advertised editable column refused its routed probe`)
}
const cases = [
  { field: 'basePrice', value: 12.345, rejects: true },
  { field: 'basePrice', value: 12.34, rejects: false },
  { field: 'weightValue', value: 0.123, rejects: false },
  { field: 'weightValue', value: 0.1234, rejects: true },
  { field: 'totalStock', value: 1.9, rejects: true },
  { field: 'totalStock', value: '12items', rejects: true },
  { field: 'ebay_price', value: 12.345, channel: 'EBAY', rejects: true },
  { field: 'ebay_quantity', value: 1.9, channel: 'EBAY', rejects: true },
  { field: 'amazon_bulletPoints', value: [{ value: 'must not stringify' }], channel: 'AMAZON', rejects: true },
  { field: 'amazon_bulletPoints', value: 'must not silently clear', channel: 'AMAZON', rejects: true },
  { field: 'attr_supplier_declared_has_product_identifier_exemption', value: false, channel: 'AMAZON', rejects: false },
  { field: 'attr_supplier_declared_has_product_identifier_exemption', value: true, channel: 'AMAZON', rejects: false },
  { field: 'attr_supplier_declared_has_product_identifier_exemption', value: 'sometimes', channel: 'AMAZON', rejects: true },
]
const safetyChecks = []
for (const test of cases) {
  const result = await request('products/bulk', {
    dryRun: true,
    marketplaceContexts: test.channel ? [{ channel: test.channel, marketplace: 'IT' }] : [{ marketplace: 'IT', locale: 'it' }],
    changes: [{ id: product, field: test.field, value: test.value, ...(test.channel ? { target: 'channel' } : {}) }],
  })
  assert.equal(result.dryRun, true)
  assert.equal(result.errors.length > 0, test.rejects, `${test.field}: ${JSON.stringify(result)}`)
  safetyChecks.push({ ...test, errors: result.errors })
}
await writeFile('/tmp/nexus-attribute-edit-audit.json', JSON.stringify({ results, safetyChecks, productValuesChanged: 0 }, null, 2))
console.log(JSON.stringify({ safetyChecks: safetyChecks.length, productValuesChanged: 0 }))
