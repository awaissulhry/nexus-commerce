import { describe, expect, it } from 'vitest'
import { decodeSheetCells, encodePooledSheetCells, encodeSheetCells, POOLED_SHEET_CELL_ENCODING, SHEET_CELL_ENCODING } from './sheet-cell-wire'

/** What the browser receives: JSON on the wire. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value))

/** A channel cell as the sheet read builds it (studio-sheet.service.ts), with synthetic ids. */
function cell(row: number, column: number, overrides: Record<string, unknown> = {}) {
  return {
    value: row % 3 ? `value ${row}-${column}` : null,
    source: row % 2 ? 'channelExplicit' : 'inherited',
    inheritedFrom: row % 2 ? null : 'parent-1',
    inherited: row % 2 === 0,
    mapped: {
      value: row % 3 ? `value ${row}-${column}` : null, derived: false,
      sourceOwner: { kind: 'listing', label: 'Listing settings', path: `listing.platformAttributes.field_${column}` },
      status: 'mapped', provenance: 'override', sourcePath: null, fallbackPath: null, usesExpression: false, legacySource: 'source',
      appliedTransforms: [], warnings: row === 4 ? [{ code: 'off_list', message: 'Not on the channel list' }] : [], errors: [], mappingErrors: [],
      autoCorrected: null, requiredByRule: column === 0, overLimit: null,
    },
    layer: 'channel', pinned: row % 2 === 1, follows: false, editable: true, linkGroupId: null,
    writeField: `attr_field_${column}`, writeVerb: 'channel', writeTarget: 'channelListing', affectsAllChannels: false,
    writable: true, writeBlockedReason: null, formula: undefined,
    contentAddress: { tier: 'pin', language: 'it', coordinate: { channel: 'EBAY', market: 'IT', accountId: 'account-1' } },
    ...overrides,
  }
}

function sheet(rows: number, columns: number) {
  return {
    scope: { kind: 'channel', channel: 'EBAY', marketplace: 'IT' },
    columns: Array.from({ length: columns }, (_, c) => ({ key: `field_${c}`, label: `Field ${c}` })),
    meta: { tookMs: 12, schemaMissing: [], schemaAge: [] },
    rows: Array.from({ length: rows }, (_, r) => ({
      id: `product-${r}`, sku: `SKU-${r}`, parentId: r ? 'product-0' : null, isParent: r === 0, version: 1 + (r % 4),
      updatedAt: new Date(Date.UTC(2026, 8, 30, 10, r)),
      completeness: { overall: { filled: 10 + r, total: 40, pct: 25 }, required: { filled: 3, total: 5, missing: [{ key: 'brand', label: 'Brand' }, { key: 'mpn', label: 'MPN' }] } },
      listing: r % 5 ? { id: `listing-${r}`, version: 7, status: 'ACTIVE' } : null,
      values: Object.fromEntries(Array.from({ length: columns }, (_, c) => [`field_${c}`, cell(r, c)])),
    })),
  }
}

describe('the sheet read, once per column', () => {
  it('decodes to exactly what JSON would have carried, for every cell and row', () => {
    const original = sheet(21, 12)
    // The awkward shapes: a column only some rows have, a cell that is not an object, a key only one cell has, a cell
    // missing a key its column shares, a Date and a value with its own JSON form, and a real key named like the marker.
    original.rows[3].values.sparse = cell(3, 99) as never
    ;(original.rows[5].values as Record<string, unknown>).field_1 = 'plain text'
    ;(original.rows[6].values as Record<string, unknown>).field_2 = null
    ;(original.rows[7].values.field_3 as Record<string, unknown>).divergence = { publishesAs: 'Rosso', note: 'differs' }
    delete (original.rows[8].values.field_4 as Record<string, unknown>).linkGroupId
    ;(original.rows[9].values.field_5 as Record<string, unknown>).value = { toJSON: () => '12.50' }
    ;(original.rows[10].values.field_6 as Record<string, unknown>)['~'] = 'a real key'
    ;(original.rows[11].values.field_7 as Record<string, unknown>).mapped = { '~': { v: 'looks like a marker' } }
    ;(original.rows[12] as Record<string, unknown>)['~'] = { u: ['sku'] }
    const encoded = wire(encodeSheetCells(original))
    expect(encoded.meta.cellEncoding).toBe(SHEET_CELL_ENCODING)
    expect(decodeSheetCells(encoded)).toEqual(wire(original))
  })

  it('keeps every object\'s key order, so the decoded JSON is the same text', () => {
    const original = sheet(8, 3) as ReturnType<typeof sheet> & { rows: Array<Record<string, unknown>> }
    // A reader shows a row's axis values in their order (measured: "Giallo · 3XL" came back as "3XL · Giallo").
    for (const [i, row] of original.rows.entries()) row.axisValues = i === 5 ? { Taglia: '3XL', Colore: 'Giallo' } : { Colore: 'Rosso', Taglia: 'M' }
    const cell = original.rows[2].values.field_1 as Record<string, unknown>
    original.rows[2].values.field_1 = Object.fromEntries(Object.entries(cell).reverse()) as never
    const { values, ...rest } = original.rows[3]
    original.rows[3] = { values, ...rest }
    const decoded = decodeSheetCells(wire(encodeSheetCells(original)))
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(original))
    expect(Object.values(decoded.rows[5].axisValues as object)).toEqual(['3XL', 'Giallo'])
  })

  it('sends a column\'s shared cell once, and per cell only what differs (≤ 200 bytes a cell)', () => {
    const original = sheet(40, 30)
    const cells = 40 * 30
    const full = JSON.stringify(original).length
    const compact = JSON.stringify(encodeSheetCells(original)).length
    expect(full / cells).toBeGreaterThan(700)
    expect(compact / cells).toBeLessThanOrEqual(200)
    const encoded = wire(encodeSheetCells(original))
    // contentAddress is the same for the whole column: it is in the base and in no cell.
    expect(encoded.cellBase.field_0.contentAddress).toEqual({ tier: 'pin', language: 'it', coordinate: { channel: 'EBAY', market: 'IT', accountId: 'account-1' } })
    expect(encoded.rows.every(row => !JSON.stringify(row.values).includes('contentAddress'))).toBe(true)
  })

  it('gives every decoded cell its own objects, as JSON.parse would', () => {
    const decoded = decodeSheetCells(wire(encodeSheetCells(sheet(4, 2))))
    const [a, b] = [decoded.rows[1].values.field_0, decoded.rows[3].values.field_0] as Array<ReturnType<typeof cell>>
    a.contentAddress.coordinate.market = 'DE'
    a.mapped.appliedTransforms.push('changed' as never)
    expect(b.contentAddress.coordinate.market).toBe('IT')
    expect(b.mapped.appliedTransforms).toEqual([])
  })

  it('passes a sheet that was not encoded through unchanged', () => {
    const plain = wire(sheet(3, 2))
    expect(decodeSheetCells(plain)).toBe(plain)
    expect(decodeSheetCells(null)).toBeNull()
  })
})

/** UTF-8 bytes of the JSON text, as the response carries it. */
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
type Row = { id: string; values: Record<string, unknown> } & Record<string, unknown>

/**
 * A synthetic sheet shaped like the real eBay · IT variation family the budget is measured on (21 rows × 59 columns,
 * 1,239 cells): column definitions with channel specs and option lists, a parent row first whose localized cells keep
 * their keys in another order, axis values, cells inherited from the parent, listing settings per row, media shared by
 * colour and completeness shared by most rows. Every id and value is made up.
 */
function realisticSheet() {
  const ROWS = 21, COLUMNS = 59, COLOURS = ['Nero', 'Giallo', 'Rosso', 'Blu'], SIZES = ['S', 'M', 'L', 'XL', 'XXL', '3XL']
  const options = (n: number) => Array.from({ length: n }, (_, i) => `Opzione ${i} per il campo`)
  const spec = (c: number) => ({
    key: `field_${c}`, attribute: `aspect_Field ${c}`, path: [], label: `Campo ${c}`, requirement: c % 5 ? 'bestPractice' : 'required',
    cardinality: { min: 1, max: 1 }, maxLength: 65, ...(c % 3 === 0 ? { options: options(c < 6 ? 110 : 12) } : {}), mode: 'open',
    store: { kind: 'platformAttribute', key: `aspect_Field ${c}` }, hidden: false, editableOnExisting: true, categories: ['100001'],
  })
  const columns = Array.from({ length: COLUMNS }, (_, c) => ({
    key: `field_${c}`, writeField: `attr_field_${c}`, label: `Field ${c}`, group: `Group ${c % 11}`, groupKey: `EBAY:group_${c % 11}`,
    kind: c % 3 === 0 ? 'enum' : 'text', storage: 'platformAttribute', scope: 'global', ...(c % 3 === 0 ? { options: options(c < 6 ? 110 : 12) } : {}),
    mode: 'open', requiredBy: c % 5 ? [] : ['eBay · IT'], maxLength: 65, capFrom: 'eBay · IT', channelLabel: `Campo ${c}`,
    applicableProductTypes: ['100001'], editable: true, width: 160, ...(c % 4 ? {} : { helpText: `What field ${c} says about the item, as the channel explains it.` }),
    defaultVisible: c < 30, shape: 'scalar', channels: { 'eBay · IT': { ...spec(c), byCategory: { 100001: spec(c) } } }, localizable: c < 5,
    writeVerb: 'channel', writeTarget: 'channelListing', affectsAllChannels: false, writable: true, writeBlockedReason: null, axis: c === 6 || c === 7, formulaWritable: true,
  }))
  const media = (colour: number) => Array.from({ length: 17 }, (_, i) => ({ id: `media-${colour}-${i}-0000000000000`, type: 'IMAGE',
    preview: `https://images.example.test/catalog/family-a/${COLOURS[colour].toLowerCase()}/view-${i}-preview-large-0000000000.jpg?width=1600&format=webp&q=80`, alt: '' }))
  const groups = Array.from({ length: 10 }, (_, g) => ({ group: `Group ${g}`, filled: 1 + (g % 3), total: 1 + (g % 5) }))
  const missing = Array.from({ length: 28 }, (_, i) => ({ key: `field_${i + 30}`, label: `Field ${i + 30}` }))
  const cell = (r: number, c: number) => {
    const parent = r === 0, colour = COLOURS[(r - 1 + 4) % 4], size = SIZES[(r - 1 + 6) % 6]
    let value: unknown = c % 7 === 1 ? 'Valore condiviso dalla famiglia' : null
    if (c === 6) value = parent ? null : colour
    if (c === 7) value = parent ? null : size
    if (c === 8 && !parent && r % 2) value = 109
    const inheritedFrom = !parent && (c === 9 || c === 10) ? `product-${r}-0000000000000000` : null
    const base = {
      value, source: 'inherited', inheritedFrom, inherited: false,
      mapped: { value, derived: true, sourceOwner: null, status: 'mapped', provenance: 'override', sourcePath: `field_${c}`, fallbackPath: null,
        usesExpression: false, legacySource: 'source', appliedTransforms: [], warnings: [], errors: [], mappingErrors: [], autoCorrected: null,
        requiredByRule: c % 5 === 0, overLimit: null, listingLevel: { scope: 'listing', variation: false } },
      layer: 'default', pinned: false, follows: true, editable: true, linkGroupId: null, writeField: `attr_field_${c}`, writeVerb: 'channel',
      writeTarget: 'channelListing', affectsAllChannels: false, writable: true, writeBlockedReason: null,
      contentAddress: { tier: 'pin', language: 'it', coordinate: { channel: 'EBAY', market: 'IT', accountId: 'account-0000000000000000' } },
      resettable: false,
    }
    if (c >= 5) return base
    // Localized content: the parent's cell lists the same keys in another order than its variations'.
    const localized = { tier: 'family', language: 'it', requested: 'it', provenance: 'master' }
    const { value: v, source, inheritedFrom: from, inherited, ...rest } = base
    return parent ? { ...base, ...localized } : { value: v, source, inheritedFrom: from, inherited, ...localized, ...rest }
  }
  const rows: Row[] = Array.from({ length: ROWS }, (_, r) => ({
    id: `product-${r}-0000000000000000`, sku: r ? `FAMILY-A-${COLOURS[(r - 1) % 4].toUpperCase()}-${SIZES[(r - 1) % 6]}` : 'FAMILY-A',
    name: `Synthetic family A jacket, a long marketplace title with materials, fit and protection notes (${r ? `${COLOURS[(r - 1) % 4]}, ${SIZES[(r - 1) % 6]}` : 'family'})`,
    parentId: r ? 'product-0-0000000000000000' : null, productRole: r ? 'CHILD' : 'PARENT', parentSku: r ? 'FAMILY-A' : null, isParent: r === 0,
    rowKind: r ? 'variation' : 'parent', status: 'ACTIVE', productType: 'JACKET', categorySource: { source: 'channel', label: 'Category 100001' },
    familyId: 'product-0-0000000000000000', version: 1 + (r % 3), basePrice: 109, childCount: r ? 0 : 20,
    imageUrl: `https://images.example.test/catalog/family-a/${COLOURS[(r + 3) % 4].toLowerCase()}/view-0-preview-large-0000000000.jpg?width=1600&format=webp&q=80`,
    photoCount: 17, imageInherited: r > 0, productMedia: media(r ? (r - 1) % 4 : 0), axisValues: {}, aliasId: null,
    values: Object.fromEntries(Array.from({ length: COLUMNS }, (_, c) => [`field_${c}`, cell(r, c)])),
    listing: { id: `listing-${r}-0000000000000000`, version: 13, listingStatus: 'ACTIVE', isPublished: true, price: 109, quantity: r % 4,
      externalListingId: `1000000000${r}`, offerActive: true, offerActiveHonoured: false, offerClosedAt: null, offerClosedBy: null, offerCloseReason: null,
      syncPaused: false, lastSyncedAt: null, follows: { followMasterTitle: true, followMasterDescription: true, followMasterPrice: r % 5 > 0,
        followMasterQuantity: true, followMasterImages: true, followMasterBulletPoints: true } },
    readiness: { state: r % 6 ? 'ready' : 'blocked', issues: [], ref: `ready-${r % 6 ? 0 : 1}` },
    completeness: { overall: { filled: 28 + (r % 3), total: 56, pct: 50 }, required: { filled: 7, total: 7, missing: [] },
      optional: { filled: 21, total: 49, missing: missing.slice(r % 3) }, byGroup: r % 3 === 1 ? groups.slice(1) : groups },
  }))
  return {
    scope: { kind: 'channel', channel: 'EBAY', marketplace: 'IT', connectionId: 'account-0000000000000000' },
    family: { id: 'product-0-0000000000000000', sku: 'FAMILY-A', productType: 'JACKET', variationAxes: ['Colore', 'Taglia'] },
    columns, groups: Array.from({ length: 11 }, (_, g) => ({ key: `EBAY:group_${g}`, label: `Group ${g}`, channelLabel: null, order: g })),
    aliases: [], rows, counts: { rows: ROWS }, schema: { marketplace: 'IT', locale: 'it' },
    meta: { schemaMissing: [], schemaAge: [], droppedKeys: Array.from({ length: 28 }, (_, i) => `dropped_${i}`), tookMs: 181 },
  }
}

describe('pooled patches (cells=compact&patches=pooled)', () => {
  it('leaves the default answer exactly as it was (a frozen column-base-v1 answer)', () => {
    const cell = (value: string | null, pinned: boolean) => ({ value, pinned, layer: 'channel', writeField: 'attr_colore', contentAddress: { tier: 'pin', language: 'it' } })
    const small = { scope: { channel: 'EBAY' }, meta: { tookMs: 3 }, rows: [
      { id: 'p0', version: 1, values: { colore: cell('Rosso', true), taglia: cell(null, false) } },
      { id: 'p1', version: 2, values: { colore: cell('Rosso', true), taglia: cell('M', false) } },
      { id: 'p2', version: 1, values: { colore: cell(null, false), taglia: 'plain' } },
    ] }
    // Written by the encoder before pooling existed; an older reader decodes exactly these bytes.
    expect(JSON.stringify(encodeSheetCells(small))).toBe('{"scope":{"channel":"EBAY"},"meta":{"tookMs":3,"cellEncoding":"column-base-v1"},"rows":[{"values":{"colore":{},"taglia":{}}},{"id":"p1","version":2,"values":{"colore":{},"taglia":{"value":"M"}}},{"id":"p2","values":{"colore":{"value":null,"pinned":false},"taglia":{"~":{"v":"plain"}}}}],"cellBase":{"colore":{"value":"Rosso","pinned":true,"layer":"channel","writeField":"attr_colore","contentAddress":{"tier":"pin","language":"it"}},"taglia":{"value":null,"pinned":false,"layer":"channel","writeField":"attr_colore","contentAddress":{"tier":"pin","language":"it"}}},"rowBase":{"id":"p0","version":1,"values":0}}')
    expect(JSON.stringify(encodeSheetCells(realisticSheet()))).not.toContain('patchPool')
  })

  it('brings the realistic 21 × 59 sheet under 200 bytes a cell, where the default form is over it', () => {
    const original = realisticSheet()
    const cells = original.rows.reduce((sum, row) => sum + Object.keys(row.values).length, 0)
    const plain = bytes(original), legacy = bytes(encodeSheetCells(original))
    const pooled = wire(encodePooledSheetCells(original))
    expect(cells).toBe(1239)
    expect(pooled.meta.cellEncoding).toBe(POOLED_SHEET_CELL_ENCODING)
    expect(JSON.stringify(decodeSheetCells(pooled))).toBe(JSON.stringify(original))
    const perCell = { plain: plain / cells, legacy: legacy / cells, pooled: bytes(pooled) / cells }
    console.info(`sheet wire bytes/cell on the realistic synthetic 21x59 sheet: ${JSON.stringify({ cells, plain, legacy, pooled: bytes(pooled), perCell })}`)
    expect(perCell.legacy).toBeGreaterThan(200)
    expect(perCell.pooled).toBeLessThanOrEqual(200)
  })

  it('restores repeated cell and row patches exactly, key order included', () => {
    const original = sheet(21, 52)
    for (const [r, row] of original.rows.entries()) {
      if (r > 0) for (let c = 0; c < 4; c++) row.values[`field_${c}`] = Object.fromEntries(Object.entries(row.values[`field_${c}`]).reverse()) as never
      if (r % 2) row.completeness.required = { filled: 4, total: 12, missing: Array.from({ length: 8 }, (_, i) => ({ key: `required_${i}`, label: `Required field ${i}` })) }
    }
    const legacy = wire(encodeSheetCells(original))
    const pooled = wire(encodePooledSheetCells(original)) as typeof legacy & { patchPool: unknown[] }
    expect(pooled.meta.cellEncoding).toBe(POOLED_SHEET_CELL_ENCODING)
    expect(pooled.patchPool.length).toBeGreaterThan(0)
    expect(JSON.stringify(decodeSheetCells(pooled))).toBe(JSON.stringify(original))
    expect(bytes(pooled)).toBeLessThan(bytes(legacy))
  })

  it('keeps Unicode text and every object\'s key order', () => {
    const original = sheet(12, 6) as ReturnType<typeof sheet> & { rows: Row[] }
    for (const [i, row] of original.rows.entries()) {
      row.axisValues = i % 2 ? { Größe: 'XL', 颜色: '红色 🔴' } : { 颜色: '红色 🔴', Größe: 'XL' }
      for (let c = 0; c < 3; c++) {
        const cell = row.values[`field_${c}`] as Record<string, unknown>
        cell.value = `Giacca «estiva» – ${'ü'.repeat(c)} ✓   ${i % 3}`
        if (i > 0) row.values[`field_${c}`] = Object.fromEntries(Object.entries(cell).reverse())
      }
    }
    const pooled = wire(encodePooledSheetCells(original))
    expect(pooled.meta.cellEncoding).toBe(POOLED_SHEET_CELL_ENCODING)
    const decoded = decodeSheetCells(pooled)
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(original))
    expect(Object.keys(decoded.rows[1].axisValues as object)).toEqual(['Größe', '颜色'])
    expect(Object.keys(decoded.rows[2].axisValues as object)).toEqual(['颜色', 'Größe'])
  })

  it('keeps literal values that look like references or markers as values', () => {
    const original = sheet(16, 4) as ReturnType<typeof sheet> & { rows: Row[] }
    for (const [i, row] of original.rows.entries()) {
      // Cells that are not objects (numbers that look like pool indexes, null, text, a list) and objects holding `~`.
      row.values.field_0 = (i % 4 === 0 ? 0 : i % 4 === 1 ? 1 : i % 4 === 2 ? null : [0, 1]) as never
      row.values.field_1 = { '~': { v: 0 }, value: 'a real key named like the marker' } as never
      ;(row.values.field_2 as Record<string, unknown>).mapped = { '~': { n: { value: 0 } } }
      ;(row.values.field_3 as Record<string, unknown>).value = 2
    }
    const pooled = wire(encodePooledSheetCells(original)) as { meta: { cellEncoding: string }; patchPool: unknown[] }
    expect(pooled.meta.cellEncoding).toBe(POOLED_SHEET_CELL_ENCODING)
    expect(JSON.stringify(decodeSheetCells(pooled))).toBe(JSON.stringify(original))
  })

  it('sends a sheet that holds a field named like the wire\'s own plain, so it stays exact', () => {
    for (const field of ['patchPool', 'cellBase', 'rowBase'] as const) {
      const original = { ...sheet(12, 4), [field]: { kept: field } }
      const answer = wire(encodePooledSheetCells(original))
      expect(answer).toEqual(wire(original))
      expect(decodeSheetCells(answer)).toEqual(wire(original))
    }
    const unknown = { ...sheet(12, 4), meta: { tookMs: 1, schemaMissing: [], schemaAge: [], cellEncoding: 'something-else' } }
    expect(decodeSheetCells(wire(encodePooledSheetCells(unknown)))).toEqual(wire(unknown))
    // A sheet the reader would take for encoded gets exactly what a reader that did not ask gets.
    const lookalike = { ...sheet(12, 4), meta: { tookMs: 1, schemaMissing: [], schemaAge: [], cellEncoding: SHEET_CELL_ENCODING } }
    expect(JSON.stringify(encodePooledSheetCells(lookalike))).toBe(JSON.stringify(encodeSheetCells(lookalike)))
  })

  it('never answers more bytes than the plain sheet or the default form', () => {
    const tiny = { scope: {}, meta: {}, rows: [{ id: 'only', values: { a: { value: 'ü' } } }] }
    const varied = { scope: {}, meta: {}, rows: Array.from({ length: 3 }, (_, r) => ({ id: `r${r}`, values: { [`only_${r}`]: { value: `${r}` } } })) }
    const cases: Array<{ rows?: object[]; meta?: object }> = [tiny, varied, sheet(1, 1), sheet(2, 3), sheet(21, 12), sheet(40, 30), realisticSheet(), { rows: [] }, {}]
    for (const original of cases) {
      const answer = encodePooledSheetCells(original)
      expect(bytes(answer)).toBeLessThanOrEqual(Math.min(bytes(original), bytes(encodeSheetCells(original))))
      expect(decodeSheetCells(wire(answer))).toEqual(wire(original))
    }
    // Nothing repeats and nothing is shared: the plain sheet is the smallest, so it is sent as it is.
    expect(encodePooledSheetCells(tiny)).toBe(tiny)
  })

  it('gives every decoded cell its own objects even when they came from one pooled patch, and leaves the answer as it was', () => {
    const original = sheet(8, 2) as ReturnType<typeof sheet> & { rows: Row[] }
    for (const row of original.rows) row.values.field_1 = { ...(row.values.field_1 as object), extra: { list: [1, 2], nested: { deep: 'yes' } }, order: 'last' }
    const pooled = wire(encodePooledSheetCells(original)) as { rows: Array<{ values: Record<string, unknown> }>; patchPool: unknown[] }
    // Two rows whose cell is the same pooled patch.
    const index = pooled.rows.map(row => row.values.field_1)
    const [first, second] = index.flatMap((reference, row) => typeof reference === 'number' && index.indexOf(reference) !== row ? [index.indexOf(reference), row] : []).slice(0, 2)
    expect(typeof index[first]).toBe('number')
    expect(index[second]).toBe(index[first])
    const before = JSON.stringify(pooled)
    const decoded = decodeSheetCells(pooled)
    const [a, b] = [decoded.rows[first].values.field_1, decoded.rows[second].values.field_1] as Array<{ extra: { list: number[]; nested: { deep: string } } }>
    a.extra.list.push(3)
    a.extra.nested.deep = 'changed'
    expect(b.extra).toEqual({ list: [1, 2], nested: { deep: 'yes' } })
    expect(JSON.stringify(pooled)).toBe(before)
    expect(JSON.stringify(decodeSheetCells(pooled))).toBe(JSON.stringify(original))
  })

  it('refuses an answer whose references do not resolve, instead of reading it as something else', () => {
    const pooled = () => {
      const original = sheet(8, 2) as ReturnType<typeof sheet> & { rows: Row[] }
      for (const row of original.rows) row.values.field_1 = { ...(row.values.field_1 as object), extra: { kept: 'a long enough nested value to pool' } }
      const answer = wire(encodePooledSheetCells(original)) as { meta: { cellEncoding: string }; patchPool: unknown[]; rows: Array<Record<string, unknown> & { values: Record<string, unknown> }> }
      expect(answer.meta.cellEncoding).toBe(POOLED_SHEET_CELL_ENCODING)
      return answer
    }
    const refused = (change: (answer: ReturnType<typeof pooled>) => void) => {
      const answer = pooled()
      change(answer)
      return () => decodeSheetCells(answer)
    }
    expect(refused(() => {})).not.toThrow()
    for (const reference of [-1, 1.5, 999, -0]) expect(refused(answer => { answer.rows[1].values.field_0 = reference })).toThrow(/could not be read/)
    expect(refused(answer => { answer.rows[1].values.field_0 = '0' })).toThrow(/not an object/)
    expect(refused(answer => { answer.rows[1] = 0 as never })).toThrow(/row is a reference/)
    expect(refused(answer => { answer.rows[1].values = 0 as never })).toThrow(/cells are not an object/)
    // A pooled patch may not refer to another one, nor to itself: no reference can loop.
    expect(refused(answer => { answer.patchPool[0] = { '~': { n: { mapped: 0 } } } })).toThrow(/refers to another one/)
    expect(refused(answer => { answer.patchPool.push({ '~': { n: { mapped: answer.patchPool.length } } }) })).toThrow(/refers to another one/)
    expect(refused(answer => { answer.patchPool[0] = 1; answer.patchPool[1] = 0 })).toThrow(/refers to another one/)
    expect(refused(answer => { delete (answer as Partial<typeof answer>).patchPool })).toThrow(/incomplete/)
    expect(refused(answer => { answer.patchPool = {} as never })).toThrow(/incomplete/)
    expect(refused(answer => { answer.rows[1].values.field_0 = { '~': { n: [] } } })).toThrow(/nested patch list/)
    expect(refused(answer => { answer.rows[1].values.field_0 = { '~': { u: [0] } } })).toThrow(/not text/)
    expect(refused(answer => { answer.rows[1].values.field_0 = { '~': 'marker' } })).toThrow(/marker is not an object/)
    // A patch that contains itself (only possible in memory, never in JSON).
    expect(refused(answer => {
      const loop: Record<string, unknown> = { '~': { n: {} } }
      ;(loop['~'] as { n: Record<string, unknown> }).n.mapped = loop
      answer.rows[1].values.field_0 = loop
    })).toThrow(/contains itself/)
  })

  it('a reader still decodes the default form and a plain answer (an API that ignored the request)', () => {
    const original = sheet(6, 3)
    expect(decodeSheetCells(wire(encodeSheetCells(original)))).toEqual(wire(original))
    const plain = wire(original)
    expect(decodeSheetCells(plain)).toBe(plain)
  })
})
