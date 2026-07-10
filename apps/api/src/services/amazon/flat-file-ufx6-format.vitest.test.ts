/**
 * UFX Phase 6 (batch 1) — Amazon official-format adoption, API side.
 *
 * Locks the four units:
 *   P6a  meta-schema `hidden` / `editable` flags → manifest column tags
 *        (+ union merge semantics + response-side hidden filtering)
 *   P6b  non-editable change warning (diff vs last-saved snapshot)
 *   P6c  manifest schemaVersion fingerprint (server half of cache-bust)
 *   P6d  blank product_type: parent-row inheritance → default → skip-with-error
 *        (never productType:'' into the feed)
 *
 * Flag spelling/placement verified against REAL cached IT/DE/UK/FR/ES schemas:
 * `hidden`/`editable` sit on the LEAF value node (items.properties.value or
 * the sub-property node itself), e.g. brand.items.properties.value.editable=false,
 * list_price.items.properties.currency.hidden=true.
 */
import { describe, it, expect } from 'vitest'
import {
  AmazonFlatFileService,
  extractMetaFlags,
  filterHiddenManifestColumns,
  mergeManifestsIntoUnion,
  type FlatFileColumn,
  type FlatFileManifest,
} from './flat-file.service.js'
import {
  buildPerTypeValidation,
  checkNonEditableChanges,
} from '../listing-preflight.service.js'

// ── Shared schema fixture (shapes mirror real SP-API product-type schemas) ──

const wrappedString = (extra: Record<string, any> = {}) => ({
  type: 'array',
  items: { type: 'object', properties: { value: { type: 'string', ...extra }, language_tag: {}, marketplace_id: {} } },
})

const schemaDef: Record<string, any> = {
  required: ['item_name'],
  properties: {
    item_name: wrappedString({ maxLength: 200 }),
    // Real-world case: brand is locked on existing listings (leaf editable:false)
    brand: wrappedString({ editable: false }),
    // Pattern D hidden attribute (leaf hidden:true)
    secret_attr: wrappedString({ hidden: true }),
    // Pattern C: one HIDDEN + LOCKED sub-property (the list_price.currency shape)
    list_price_like: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          currency: { type: 'string', enum: ['EUR', 'GBP'], hidden: true, editable: false },
          marketplace_id: {},
        },
      },
    },
    // Pattern B dimension pair with a hidden unit
    stealth_weight: {
      type: 'array',
      items: {
        type: 'object',
        properties: { value: { type: 'number' }, unit: { type: 'string', enum: ['grams'], hidden: true }, marketplace_id: {} },
      },
    },
    // Pattern A multi-instance carrying the base flags into every instance
    hidden_keyword: {
      type: 'array',
      maxUniqueItems: 3,
      items: { type: 'object', properties: { value: { type: 'string', hidden: true }, marketplace_id: {} } },
    },
  },
  __propertyGroups: {
    details: {
      title: 'Details',
      propertyNames: ['item_name', 'brand', 'secret_attr', 'list_price_like', 'stealth_weight', 'hidden_keyword'],
    },
  },
}

const schemasStub = {
  getSchema: async () => ({ schemaDefinition: schemaDef, schemaVersion: 'REL_1' }),
  refreshSchema: async () => ({ schemaDefinition: schemaDef, schemaVersion: 'REL_1' }),
} as any
const svc = new AmazonFlatFileService({} as any, schemasStub)

const manifestCols = async (): Promise<Map<string, FlatFileColumn>> => {
  const m = await svc.generateManifest('IT', 'SHIRT')
  return new Map(m.groups.flatMap((g) => g.columns).map((c) => [c.id, c]))
}

// ── P6a — extractMetaFlags ───────────────────────────────────────────────────

describe('UFX P6a — extractMetaFlags reads leaf-level hidden/editable', () => {
  it('wrapped leaf (items.properties.value) placement — the real-schema shape', () => {
    expect(extractMetaFlags({ items: { properties: { value: { hidden: true } } } })).toEqual({ hidden: true })
    expect(extractMetaFlags({ items: { properties: { value: { editable: false } } } })).toEqual({ editableForListing: false })
  })
  it('direct node placement (sub-property nodes like list_price.currency)', () => {
    expect(extractMetaFlags({ hidden: true, editable: false })).toEqual({ hidden: true, editableForListing: false })
  })
  it('defaults (visible/editable/absent) stay untagged', () => {
    expect(extractMetaFlags({ items: { properties: { value: { hidden: false, editable: true } } } })).toEqual({})
    expect(extractMetaFlags({})).toEqual({})
    expect(extractMetaFlags(undefined)).toEqual({})
  })
})

// ── P6a — manifest column tagging across expansion patterns ─────────────────

describe('UFX P6a — manifest columns carry hidden/editableForListing', () => {
  it('Pattern D: brand editable:false → editableForListing:false; visible attrs untagged', async () => {
    const cols = await manifestCols()
    expect(cols.get('brand')!.editableForListing).toBe(false)
    expect(cols.get('brand')!.hidden).toBeUndefined()
    expect(cols.get('item_name')!.editableForListing).toBeUndefined()
    expect(cols.get('item_name')!.hidden).toBeUndefined()
  })
  it('Pattern D: hidden attribute tagged hidden:true', async () => {
    const cols = await manifestCols()
    expect(cols.get('secret_attr')!.hidden).toBe(true)
  })
  it('Pattern C: only the flagged sub-column is tagged (list_price.currency shape)', async () => {
    const cols = await manifestCols()
    const currency = cols.get('list_price_like__currency')!
    expect(currency.hidden).toBe(true)
    expect(currency.editableForListing).toBe(false)
    const amount = cols.get('list_price_like__amount')!
    expect(amount.hidden).toBeUndefined()
    expect(amount.editableForListing).toBeUndefined()
  })
  it('Pattern B: hidden unit column tagged; value column untagged', async () => {
    const cols = await manifestCols()
    expect(cols.get('stealth_weight__unit')!.hidden).toBe(true)
    expect(cols.get('stealth_weight__value')!.hidden).toBeUndefined()
  })
  it('Pattern A: base flags propagate to every numbered instance', async () => {
    const cols = await manifestCols()
    expect(cols.get('hidden_keyword_1')!.hidden).toBe(true)
    expect(cols.get('hidden_keyword_3')!.hidden).toBe(true)
  })
})

// ── P6a — union merge semantics ──────────────────────────────────────────────

const mkManifest = (productType: string, cols: Partial<FlatFileColumn>[]): FlatFileManifest => ({
  marketplace: 'IT',
  productType,
  variationThemes: [],
  fetchedAt: new Date().toISOString(),
  groups: [{
    id: 'g', labelEn: 'G', labelLocal: 'G', color: 'blue',
    columns: cols.map((c) => ({
      id: 'col', fieldRef: 'col#1.value', labelEn: 'Col', labelLocal: 'Col',
      required: false, kind: 'text' as const, width: 100, ...c,
    })),
  }],
  expandedFields: {},
})

describe('UFX P6a — union merge: hidden ANDs, non-editable ORs with per-type list', () => {
  it('hidden in one type but visible in the other → union shows it', () => {
    const u = mergeManifestsIntoUnion(
      [mkManifest('A', [{ hidden: true }]), mkManifest('B', [{}])],
      ['A', 'B'],
    )
    expect(u.groups[0].columns[0].hidden).toBeUndefined()
  })
  it('hidden in EVERY defining type → union hides it', () => {
    const u = mergeManifestsIntoUnion(
      [mkManifest('A', [{ hidden: true }]), mkManifest('B', [{ hidden: true }])],
      ['A', 'B'],
    )
    expect(u.groups[0].columns[0].hidden).toBe(true)
  })
  it('editableForListing:false in ONE type tags the union + only that type listed', () => {
    const u = mergeManifestsIntoUnion(
      [mkManifest('A', [{ editableForListing: false }]), mkManifest('B', [{}])],
      ['A', 'B'],
    )
    const col = u.groups[0].columns[0]
    expect(col.editableForListing).toBe(false)
    expect(col.nonEditableForProductTypes).toEqual(['A'])
  })
  it('fully editable everywhere → no flags (first manifest cannot leak)', () => {
    const u = mergeManifestsIntoUnion(
      [mkManifest('A', [{}]), mkManifest('B', [{}])],
      ['A', 'B'],
    )
    const col = u.groups[0].columns[0]
    expect(col.editableForListing).toBeUndefined()
    expect(col.nonEditableForProductTypes).toBeUndefined()
    expect(col.hidden).toBeUndefined()
  })
})

// ── P6a — response-side hidden filtering ─────────────────────────────────────

describe('UFX P6a — filterHiddenManifestColumns', () => {
  const manifest = mkManifest('A', [
    { id: 'visible' },
    { id: 'ghost', hidden: true },
    { id: 'ghost_required', hidden: true, required: true },
    { id: 'ghost_rwp', hidden: true, requiredWithParent: true },
  ])
  it('drops hidden columns but keeps required / required-if-present ones', () => {
    const ids = filterHiddenManifestColumns(manifest).groups[0].columns.map((c) => c.id)
    expect(ids).toEqual(['visible', 'ghost_required', 'ghost_rwp'])
  })
  it('never mutates the input (the cached manifest stays complete)', () => {
    filterHiddenManifestColumns(manifest)
    expect(manifest.groups[0].columns).toHaveLength(4)
  })
  it('drops a group left empty by the filter', () => {
    const m = mkManifest('A', [{ id: 'ghost', hidden: true }])
    expect(filterHiddenManifestColumns(m).groups).toHaveLength(0)
  })
})

// ── P6b — non-editable change warning ────────────────────────────────────────

describe('UFX P6b — buildPerTypeValidation.nonEditableByType', () => {
  const union = mergeManifestsIntoUnion(
    [
      mkManifest('A', [{ id: 'brand', labelEn: 'Brand', editableForListing: false }]),
      mkManifest('B', [{ id: 'brand', labelEn: 'Brand' }]),
    ],
    ['A', 'B'],
  )
  it('per-type: locked for A, free for B', () => {
    const { nonEditableByType } = buildPerTypeValidation(union)
    expect(nonEditableByType.get('A')).toEqual([{ id: 'brand', label: 'Brand' }])
    expect(nonEditableByType.get('B')).toEqual([])
  })
})

describe('UFX P6b — checkNonEditableChanges (diff vs last-saved snapshot)', () => {
  const cols = [{ id: 'brand', label: 'Brand' }]
  const snapshot = { brand: 'Xavia', item_name: 'Jacket' }

  it('fires a WARNING only on a detected change', () => {
    const issues = checkNonEditableChanges({ item_sku: 'S1', brand: 'NewBrand' }, cols, snapshot)
    expect(issues).toHaveLength(1)
    expect(issues[0].field).toBe('brand')
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].message).toContain('Xavia')
  })
  it('unchanged value (full UPDATE resubmits everything) → silent', () => {
    expect(checkNonEditableChanges({ item_sku: 'S1', brand: 'Xavia' }, cols, snapshot)).toEqual([])
    expect(checkNonEditableChanges({ item_sku: 'S1', brand: ' Xavia ' }, cols, snapshot)).toEqual([])
  })
  it('new rows are exempt — everything is settable at creation', () => {
    expect(checkNonEditableChanges({ item_sku: 'S1', _isNew: true, brand: 'New' }, cols, snapshot)).toEqual([])
  })
  it('no snapshot → no diff possible → tag-only, no warning', () => {
    expect(checkNonEditableChanges({ item_sku: 'S1', brand: 'New' }, cols, null)).toEqual([])
    expect(checkNonEditableChanges({ item_sku: 'S1', brand: 'New' }, cols, undefined)).toEqual([])
  })
  it('first-time fill (snapshot blank) and cleared cell are skipped', () => {
    expect(checkNonEditableChanges({ item_sku: 'S1', brand: 'New' }, cols, { brand: '' })).toEqual([])
    expect(checkNonEditableChanges({ item_sku: 'S1', brand: '' }, cols, snapshot)).toEqual([])
  })
  it('DELETE rows are never flagged', () => {
    expect(checkNonEditableChanges({ item_sku: 'S1', record_action: 'delete', brand: 'New' }, cols, snapshot)).toEqual([])
  })
})

// ── P6c — schemaVersion fingerprint ──────────────────────────────────────────

describe('UFX P6c — manifest schemaVersion (server half of cache-bust)', () => {
  it('single-type: provider version + content hash, stable across calls', async () => {
    const m1 = await svc.generateManifest('IT', 'SHIRT')
    const m2 = await svc.generateManifest('IT', 'SHIRT')
    expect(m1.schemaVersion).toBeDefined()
    expect(m1.schemaVersion!.startsWith('REL_1.')).toBe(true)
    expect(m2.schemaVersion).toBe(m1.schemaVersion)
  })
  it('changes when the schema content changes', async () => {
    const changed = { ...schemaDef, properties: { ...schemaDef.properties, extra_attr: wrappedString() } }
    const svc2 = new AmazonFlatFileService({} as any, {
      getSchema: async () => ({ schemaDefinition: changed, schemaVersion: 'REL_1' }),
      refreshSchema: async () => ({ schemaDefinition: changed, schemaVersion: 'REL_1' }),
    } as any)
    const m1 = await svc.generateManifest('IT', 'SHIRT')
    const m2 = await svc2.generateManifest('IT', 'SHIRT')
    expect(m2.schemaVersion).not.toBe(m1.schemaVersion)
  })
  it('union: fingerprint derived from member versions; absent when members carry none', () => {
    const a = { ...mkManifest('A', [{}]), schemaVersion: 'REL_1.abc' }
    const b = { ...mkManifest('B', [{}]), schemaVersion: 'REL_9.def' }
    const u1 = mergeManifestsIntoUnion([a, b], ['A', 'B'])
    expect(u1.schemaVersion).toBeDefined()
    const b2 = { ...mkManifest('B', [{}]), schemaVersion: 'REL_10.zzz' }
    const u2 = mergeManifestsIntoUnion([a, b2], ['A', 'B'])
    expect(u2.schemaVersion).not.toBe(u1.schemaVersion)
    const plain = mergeManifestsIntoUnion([mkManifest('A', [{}])], ['A'])
    expect(plain.schemaVersion).toBeUndefined()
  })
})

// ── P6d — blank product_type resolution + skip report ────────────────────────

describe('UFX P6d — buildJsonFeedBodyWithReport product-type resolution', () => {
  const feedSvc = new AmazonFlatFileService({} as any, {} as any)
  const build = (rows: any[], feedSchema: any = {}) =>
    feedSvc.buildJsonFeedBodyWithReport(rows, 'IT', 'SELLER', {}, feedSchema)

  it('blank-type child inherits ITS parent row type (by parent_sku), not the batch default', () => {
    const r = build(
      [
        { item_sku: 'PARENT-1', product_type: 'JACKET', parentage_level: 'parent' },
        { item_sku: 'CHILD-1', parent_sku: 'PARENT-1', parentage_level: 'child' },
      ],
      { defaultProductType: 'PANTS' },
    )
    const messages = JSON.parse(r.body).messages
    expect(messages[1].productType).toBe('JACKET')
    expect(r.skippedRows).toEqual([])
  })
  it('no parent match → defaultProductType fallback (FFP.3 behavior preserved)', () => {
    const r = build([{ item_sku: 'S1' }], { defaultProductType: 'PANTS' })
    expect(JSON.parse(r.body).messages[0].productType).toBe('PANTS')
  })
  it('unresolvable type → row SKIPPED with per-row error; never productType:""', () => {
    const r = build([
      { item_sku: 'OK-1', product_type: 'JACKET' },
      { item_sku: 'BAD-1' },
      { item_sku: 'OK-2', product_type: 'PANTS' },
    ])
    const messages = JSON.parse(r.body).messages
    expect(messages.map((m: any) => m.sku)).toEqual(['OK-1', 'OK-2'])
    expect(messages.every((m: any) => m.productType !== '')).toBe(true)
    // messageIds stay contiguous after the skip
    expect(messages.map((m: any) => m.messageId)).toEqual([1, 2])
    expect(r.messageCount).toBe(2)
    expect(r.skippedRows).toEqual([
      { sku: 'BAD-1', error: expect.stringContaining('no product type') },
    ])
  })
  it('DELETE rows never need a type and are never skipped', () => {
    const r = build([{ item_sku: 'DEL-1', record_action: 'delete' }])
    const messages = JSON.parse(r.body).messages
    expect(messages).toEqual([{ messageId: 1, sku: 'DEL-1', operationType: 'DELETE' }])
    expect(r.skippedRows).toEqual([])
  })
  it('buildJsonFeedBody wrapper stays byte-identical to the report body', () => {
    const rows = [{ item_sku: 'S1', product_type: 'JACKET', item_name: 'X' }]
    expect(feedSvc.buildJsonFeedBody(rows as any, 'IT', 'SELLER', {}, {}))
      .toBe(build(rows).body)
  })
})
