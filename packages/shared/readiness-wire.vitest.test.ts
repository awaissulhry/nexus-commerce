import { describe, expect, it } from 'vitest'
import { decodeReadiness, encodeReadiness, READINESS_DETAIL_ENCODING } from './readiness-wire.js'

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function fixture(count = 151) {
  const ids = Array.from({ length: count }, (_, i) => `synthetic-product-${i}`)
  const missing = ids.map(productId => ({ field: 'brand', productId, label: 'Marca · 品牌', reason: 'Required and empty', requiredEmpty: true,
    requiredBy: ['Example scope'], futureFact: { zero: 0, no: false, empty: null } }))
  const optionalMissing = ids.flatMap(productId => Array.from({ length: 30 }, (_, i) => ({ productId, field: `field_${i}`, label: `Optional ${i}` })))
  const summary = { id: 'EBAY', channel: 'EBAY', market: 'IT', accountId: 'account-a', aliasId: null, language: 'it', coordinateKey: 'coordinate-a',
    pct: null, state: 'notComputed', required: { filled: 0, total: count }, optional: null, mappingRules: 0, missing, optionalMissing,
    pendingSince: '2026-09-30T10:01:00Z', computedAt: '2026-09-30T10:00:00Z', note: 'Not measured yet.', future: ['keep', false, 0, null] }
  return { market: 'IT', locale: 'it', scopes: [summary], matrix: [{ ...summary,
    byProduct: Object.fromEntries(ids.map(id => [id, { pct: null, state: 'notComputed', required: { filled: 0, total: 1 }, optional: null,
      note: 'Not measured yet.', pendingSince: '2026-09-30T10:01:00Z', computedAt: '2026-09-30T10:00:00Z' }])) }], computedAt: '2026-09-30T10:00:00Z' }
}
type Wire = { detailEncoding: string; detailTables: { products: string[]; details: Record<string, unknown>[]; lists: number[][]; states: Record<string, unknown>[]; groups: number[][] };
  scopes: Record<string, unknown>[]; matrix: Record<string, unknown>[] }
const compact = (value: unknown) => {
  const wire = json(encodeReadiness(value)) as Wire
  expect(wire.detailEncoding).toBe(READINESS_DETAIL_ENCODING)
  return wire
}

describe('readiness detail wire', () => {
  it('keeps every fact, key order, unknown field, null, false and zero under the original 50,000-byte budget', () => {
    const plain = fixture(), before = json(plain)
    const wire = compact(plain)
    expect(Buffer.byteLength(JSON.stringify(plain))).toBeGreaterThan(50_000)
    expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThanOrEqual(50_000)
    expect(JSON.stringify(decodeReadiness(wire))).toBe(JSON.stringify(before))
    expect(plain).toEqual(before)
  })
  it('does not share decoded detail arrays or per-product state between rows or scopes', () => {
    const plain = fixture(21), wire = compact(plain)
    const decoded = decodeReadiness(wire) as typeof plain
    decoded.matrix[0].missing[0].requiredBy.push('Changed locally')
    decoded.matrix[0].missing[0].futureFact.zero = 3
    decoded.matrix[0].byProduct['synthetic-product-0'].required.filled = 99
    expect(decoded.scopes[0].missing[0].requiredBy).toEqual(['Example scope'])
    expect(decoded.matrix[0].missing[1].futureFact.zero).toBe(0)
    expect(decoded.matrix[0].byProduct['synthetic-product-1'].required.filled).toBe(0)
    expect(decodeReadiness(wire)).toEqual(plain)
  })
  it('retains order and duplicates when a product appears in several separate detail runs', () => {
    const plain = fixture(21)
    plain.matrix[0].missing = [plain.matrix[0].missing[1], plain.matrix[0].missing[0], plain.matrix[0].missing[1]]
    expect(decodeReadiness(compact(plain))).toEqual(plain)
  })
  it('leaves malformed or unrecognized original fields literal instead of guessing an encoding', () => {
    const base = fixture(21)
    const plain = { ...base, matrix: [{ ...base.matrix[0], missing: [null, ['literal', 'array'], { reason: 'no product id' }] }] }
    expect(decodeReadiness(compact(plain))).toEqual(plain)
  })
  it('treats prototype-like product IDs as data', () => {
    const base = fixture(21)
    const plain = { ...base, matrix: [{ ...base.matrix[0], byProduct: Object.fromEntries([['__proto__', base.matrix[0].byProduct['synthetic-product-0']]]) }] }
    const decoded = decodeReadiness(compact(plain)) as typeof plain
    expect(decoded).toEqual(plain)
    expect(Object.getPrototypeOf(decoded.matrix[0].byProduct)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(decoded.matrix[0].byProduct, '__proto__')).toBe(true)
  })
  it('passes plain older responses through and does not enlarge a response with no useful repetition', () => {
    const plain = { market: 'IT', scopes: [], matrix: [], computedAt: null }
    expect(decodeReadiness(plain)).toBe(plain)
    expect(encodeReadiness(plain)).toBe(plain)
  })
  it.each(['version', 'product', 'list', 'flags', 'duplicate-target', 'duplicate-product'] as const)('refuses corrupt %s references instead of dropping readiness', kind => {
    const wire = compact(fixture(21))
    if (kind === 'version') wire.detailEncoding = 'future-encoding'
    if (kind === 'product') wire.scopes[0].missing = [[-1, 0]]
    if (kind === 'list') wire.detailTables.lists[0] = [999999]
    if (kind === 'flags') wire.detailTables.groups[0][2] = 8
    if (kind === 'duplicate-target') wire.detailTables.groups.push([...wire.detailTables.groups[0]])
    if (kind === 'duplicate-product') {
      const rows = wire.matrix[0].byProduct as number[][]
      rows.push([...rows[0]])
    }
    expect(() => decodeReadiness(wire)).toThrow()
  })
})
