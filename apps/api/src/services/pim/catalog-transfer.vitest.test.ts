import { describe, expect, it, vi } from 'vitest'
vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('./sheet-columns.service.js', () => ({ getSheetColumns: vi.fn() }))
vi.mock('./mapping/field-catalogue.service.js', () => ({ getFieldCatalogue: vi.fn() }))
import ExcelJS from 'exceljs'
import { transferFileRow, transferTargetKey, type TransferRow } from '@nexus/shared/catalog-transfer'
import { readTransferFile, parseTransferRecords, writeTransferWorkbook, TRANSFER_MAX_ROWS } from './catalog-transfer-file.js'
import { buildTransferPlan, type TransferContext, type TransferContracts, type TransferProduct } from './catalog-transfer-plan.js'
import { channelValuePatch, storedChannelState } from './channel-value-mutation.js'
import type { SheetColumn } from './sheet-columns.service.js'
import type { CatalogueField } from './mapping/field-catalogue.service.js'

const row = (patch: Partial<TransferRow> = {}): TransferRow => ({ row: 2, entity: 'Products', sku: '00123', channel: '', accountId: '', marketplace: '', aliasKey: '', locale: '', field: 'name', action: 'SET', value: 'Jacket', ...patch })
const channelRow = (patch: Partial<TransferRow> = {}) => row({ entity: 'Overrides', channel: 'AMAZON', accountId: 'seller-a', marketplace: 'IT', field: 'item_name', ...patch })
const col = (key: string, patch: Partial<SheetColumn> = {}): SheetColumn => ({ key, writeField: key, label: key, group: 'Product', kind: 'text', storage: 'column', scope: 'global', requiredBy: [], editable: true, defaultVisible: true, shape: 'scalar', ...patch })
const nativeCols = [col('name'), col('description'), col('weightValue', { kind: 'number' }), col('basePrice', { kind: 'number' }), col('material', { storage: 'categoryAttributes', familyRules: { f1: { required: true, sortOrder: 0 } } }), col('keywords', { shape: 'list' })]
const titleField = { fieldKey: 'item_name', sheetKey: 'name', label: 'Title', kind: 'text', shape: 'scalar', editable: true, selectionOnly: false, maxLength: 10, channelStore: { kind: 'listingColumn', column: 'title', followFlag: 'followMasterTitle' } } as CatalogueField
const contracts: TransferContracts = { master: async () => nativeCols, channel: async () => ({ fields: [titleField, { ...titleField, fieldKey: 'material', sheetKey: 'material', shape: 'list', cardinality: { min: 0, max: 3 }, channelStore: undefined }] }) }
const product = (patch: Record<string, unknown> = {}): TransferProduct => ({ id: 'p1', sku: '00123', name: 'Jacket', basePrice: '0', version: 4, parentId: null, isParent: false, familyId: 'f1', categoryAttributes: { material: 'Cotton' }, localizedContent: { it: { title: 'Giacca' }, en: { description: 'English description' } }, categories: [], ...patch })
const listing = { id: 'l1', productId: 'p1', channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'seller-a', aliasKey: '', version: 8, followMasterTitle: true, title: 'Old snapshot', titleOverride: 'Old override', overrideData: {}, platformAttributes: { productType: 'OUTERWEAR' } }
const context = (patch: Partial<TransferContext> = {}): TransferContext => ({ products: new Map([['00123', product()]]), listings: new Map([[transferTargetKey(channelRow()), [listing]]]), families: [{ id: 'f1', code: 'jackets', label: 'Jackets' }], categories: [{ id: 'c1', isActive: true }], accounts: [{ id: 'seller-a', channelType: 'AMAZON', marketplace: null }, { id: 'seller-b', channelType: 'AMAZON', marketplace: null }], markets: [{ channel: 'AMAZON', code: 'IT', languages: ['it'] }], ...patch })

describe('Parent SKU import rules', () => {
  const parent = product({ id: 'root', sku: 'PARENT', isParent: true })
  const ctx = () => context({ products: new Map([['00123', product({ parentId: 'root' })], ['PARENT', parent]]) })

  it('preserves an omitted relationship and distinguishes an explicit unlink', async () => {
    const unchanged = await buildTransferPlan([row()], 'update', ctx(), contracts)
    expect(unchanged.targets[0].parentSku).toBeUndefined()
    const unlinked = await buildTransferPlan([row({ field: 'parentSku', action: 'CLEAR', value: undefined })], 'update', ctx(), contracts)
    expect(unlinked.issues).toEqual([])
    expect(unlinked.targets[0].parentSku).toBeNull()
    expect(unlinked.targets[0].cells[0]).toMatchObject({ before: 'PARENT', after: null, verdict: 'changed' })
  })

  it.each([42, ['PARENT'], {}, '', ' PARENT '])('rejects a non-SKU relationship value %j', async value => {
    const result = await buildTransferPlan([row({ field: 'parentSku', value })], 'update', ctx(), contracts)
    expect(result.issues[0].message).toContain('Parent SKU must be')
  })

  it('blocks alias-breaking moves but accepts an unchanged exported parent', async () => {
    const c = ctx(); c.relationshipBlockedProducts = new Set(['p1'])
    expect((await buildTransferPlan([row({ field: 'parentSku', action: 'CLEAR', value: undefined })], 'update', c, contracts)).issues[0].message).toContain('listing aliases')
    expect((await buildTransferPlan([row({ field: 'parentSku', value: 'PARENT' })], 'update', c, contracts)).issues).toEqual([])
  })

  it('refuses independent role writes, unknown parents and archived parents', async () => {
    expect((await buildTransferPlan([row({ field: 'productRole', value: 'Parent' })], 'update', ctx(), contracts)).issues[0].message).toContain('calculated')
    expect((await buildTransferPlan([row({ field: 'parentSku', value: 'MISSING' })], 'update', ctx(), contracts)).issues[0].message).toContain('does not exist')
    const c = ctx(); c.products.set('PARENT', { ...parent, deletedAt: '2026-01-01' })
    expect((await buildTransferPlan([row({ field: 'parentSku', value: 'PARENT' })], 'update', c, contracts)).issues[0].message).toContain('archived')
  })
})

describe('catalog file contract', () => {
  it('preserves carriage returns in listing descriptions instead of creating false changes', async () => {
    const value = 'First paragraph\r\n\r\nSecond paragraph\rThird line\nFourth line'
    const parsed = await readTransferFile(await writeTransferWorkbook([channelRow({ field: 'product_description', value })]), 'description.xlsx')
    expect(parsed.issues).toEqual([])
    expect(parsed.rows[0].value).toBe(value)
  })
  it('refuses an export that would exceed the import row limit', async () => {
    await expect(writeTransferWorkbook(Array.from({ length: TRANSFER_MAX_ROWS + 1 }, () => row()))).rejects.toThrow('50,000 attribute rows')
  })
  it('round trips delimiter-containing lists, structured records, leading-zero text and false without coercion', async () => {
    const input = [row({ field: 'material', value: ['A | B', 'a,b', '"quoted"', ''] }), row({ field: 'protectors', value: [{ zone: 'elbow', level: '2' }] }), row({ field: 'weight', value: { value: 0, unit: 'kg' } }), row({ field: 'waterproof', value: false }), row({ field: 'ean', value: '0012345678901' })]
    const output = await readTransferFile(await writeTransferWorkbook(input), 'roundtrip.xlsx')
    expect(output.issues).toEqual([])
    expect(output.rows.map(r => [r.sku, r.field, r.value])).toEqual(input.map(r => [r.sku, r.field, r.value]))
  })
  it('keeps literal action-like text as text', () => {
    expect(parseTransferRecords([transferFileRow(row({ value: 'INHERIT' }))]).rows[0].value).toBe('INHERIT')
  })
  it('does not infer an action from a populated value', () => {
    expect(parseTransferRecords([{ ...transferFileRow(row()), action: '' }]).issues[0].message).toContain('Choose SET')
  })
  it('treats empty template cells as no-ops', () => {
    expect(parseTransferRecords([{ ...transferFileRow(row()), action: '', value: '' }])).toEqual({ rows: [], issues: [] })
  })
  it.each(['CLEAR', 'INHERIT'])('rejects values accompanying %s', action => {
    expect(parseTransferRecords([{ ...transferFileRow(row()), action }]).issues[0].message).toContain('empty value')
  })
  it('requires exact channel coordinates', () => {
    expect(parseTransferRecords([{ ...transferFileRow(channelRow()), accountId: '' }]).issues).toHaveLength(1)
    expect(parseTransferRecords([{ ...transferFileRow(row()), channel: 'AMAZON' }]).issues).toHaveLength(1)
  })
  it('rejects invalid JSON, null SET, invalid versions and storage path injection', () => {
    for (const patch of [{ format: 'json', value: '[oops' }, { format: 'json', value: 'null' }, { version: '3.5' }, { field: '__proto__.x' }]) expect(parseTransferRecords([{ ...transferFileRow(row()), ...patch }]).issues).toHaveLength(1)
  })
  it('rejects duplicate CSV headers instead of overwriting a column', async () => {
    await expect(readTransferFile(Buffer.from('sku,field,action,value,value\nA,name,SET,One,Two'), 'data.csv')).rejects.toThrow('Duplicate')
  })
  it('refuses spreadsheet formulas', async () => {
    const wb = new ExcelJS.Workbook(), sheet = wb.addWorksheet('Products')
    sheet.addRow(['sku', 'field', 'action', 'value']); sheet.addRow(['A', 'name', 'SET', { formula: '1+1', result: 2 }])
    await expect(readTransferFile(Buffer.from(await wb.xlsx.writeBuffer()), 'formula.xlsx')).rejects.toThrow('replace formulas')
  })
})

describe('channel ownership operations', () => {
  it('clears a non-nullable bullet list while keeping its explicit override state', () => {
    const store = { kind: 'listingColumn' as const, column: 'bulletPointsOverride', followFlag: 'followMasterBulletPoints' }
    const cleared = channelValuePatch({}, store, ['bullet_point'], 'CLEAR')
    expect(cleared).toMatchObject({ bulletPointsOverride: [], followMasterBulletPoints: false })
    expect(storedChannelState(cleared, store, ['bullet_point'])).toEqual({ state: 'stored', value: [] })
    const inherited = channelValuePatch(cleared, store, ['bullet_point'], 'INHERIT')
    expect(storedChannelState(inherited, store, ['bullet_point']).state).toBe('inherited')
  })
  it('ignores synchronized snapshots while following Master', () => {
    expect(storedChannelState(listing, titleField.channelStore, ['item_name'])).toEqual({ state: 'inherited', value: null })
  })
  it('keeps CLEAR distinct from INHERIT across every old storage representation', () => {
    const own = { ...listing, followMasterTitle: false, title: 'custom', titleOverride: 'custom', overrideData: { item_name: 'custom', name: 'old', color: 'red' } }
    const clear = channelValuePatch(own, titleField.channelStore, ['item_name', 'name'], 'CLEAR')
    const inherit = channelValuePatch(own, titleField.channelStore, ['item_name', 'name'], 'INHERIT')
    expect(storedChannelState({ ...own, ...clear }, titleField.channelStore, ['item_name'])).toEqual({ state: 'stored', value: null })
    expect(storedChannelState({ ...own, ...inherit }, titleField.channelStore, ['item_name'])).toEqual({ state: 'inherited', value: null })
    expect(inherit.overrideData).toEqual({ color: 'red' })
  })
  it('preserves adjacent platform fields and measure units', () => {
    const store = { kind: 'platformAttributes' as const, path: ['package', 'weight'], unitPath: ['package', 'unit'] }
    const source = { platformAttributes: { package: { weight: 1, unit: 'kg', length: 5 }, categoryId: '1' }, overrideData: {} }
    const patched = { ...source, ...channelValuePatch(source, store, ['weight'], 'SET', { value: 0, unit: 'lb' }) }
    expect(storedChannelState(patched, store, ['weight']).value).toEqual({ value: 0, unit: 'lb' })
    const inherited = { ...patched, ...channelValuePatch(patched, store, ['weight'], 'INHERIT') }
    expect(inherited.platformAttributes).toEqual({ package: { length: 5 }, categoryId: '1' })
  })
  it('keeps false and zero in override bags', () => {
    expect(channelValuePatch({}, undefined, ['flag'], 'SET', false)).toEqual({ overrideData: { flag: false } })
    expect(channelValuePatch({}, undefined, ['qty'], 'SET', 0)).toEqual({ overrideData: { qty: 0 } })
  })
})

describe('catalog preview', () => {
  it('requires a locale for a custom localized attribute instead of writing a native column', async () => {
    const localizedContracts = { ...contracts, master: async () => [col('careText', { storage: 'localizedContent' })] }
    const invalid = await buildTransferPlan([row({ field: 'careText', value: 'Wash cold' })], 'update', context(), localizedContracts)
    expect(invalid.issues[0].message).toContain('needs a locale')
    const valid = await buildTransferPlan([row({ field: 'careText', locale: 'en', value: 'Wash cold' })], 'update', context(), localizedContracts)
    expect(valid.issues).toEqual([])
    expect(valid.targets[0].patch).toEqual({})
    expect(valid.targets[0].contentWrites).toEqual([{ address: { tier: 'language', language: 'en' }, values: { careText: 'Wash cold' }, reset: [] }])
  })
  it('matches an existing SKU throughout the catalog without an open product ID', async () => {
    const result = await buildTransferPlan([row({ value: 'New name' })], 'update', context(), contracts)
    expect(result.issues).toEqual([])
    expect(result.targets[0].patch).toEqual({})
    expect(result.targets[0].contentWrites).toEqual([{ address: { tier: 'source' }, values: { title: 'New name' }, reset: [] }])
  })
  it('rejects unknown SKU in update and existing SKU in create', async () => {
    expect((await buildTransferPlan([row({ sku: 'unknown' })], 'update', context(), contracts)).issues[0].message).toContain('does not exist')
    expect((await buildTransferPlan([row()], 'create', context(), contracts)).issues[0].message).toContain('already exists')
  })
  it('creates a draft-ready product declaration with a shared family', async () => {
    const result = await buildTransferPlan([row({ sku: 'new' }), row({ sku: 'new', field: 'family', value: 'jackets' })], 'create', context(), contracts)
    expect(result.issues).toEqual([])
    expect(result.targets[0]).toMatchObject({ create: true, patch: { name: 'Jacket', familyId: 'f1' } })
  })
  it('requires a new product name and classification', async () => {
    expect((await buildTransferPlan([row({ sku: 'new' })], 'upsert', context(), contracts)).issues[0].message).toContain('family')
    expect((await buildTransferPlan([row({ sku: 'new', field: 'family', value: 'jackets' })], 'upsert', context(), contracts)).issues[0].message).toContain('name')
  })
  it('resolves new parent and child families together', async () => {
    const result = await buildTransferPlan([row({ sku: 'child' }), row({ sku: 'child', field: 'parentSku', value: 'parent' }), row({ sku: 'parent' }), row({ sku: 'parent', field: 'family', value: 'jackets' })], 'create', context(), contracts)
    expect(result.issues).toEqual([])
    expect(result.targets.find(t => t.identity.sku === 'parent')?.patch.isParent).toBe(true)
    expect(result.targets.find(t => t.identity.sku === 'child')?.parentSku).toBe('parent')
  })
  it('refuses a circular hierarchy', async () => {
    const result = await buildTransferPlan([row({ sku: 'A', field: 'parentSku', value: 'B' }), row({ sku: 'B', field: 'parentSku', value: 'A' })], 'create', context(), contracts)
    expect(result.issues.every(i => i.message.includes('cycle'))).toBe(true)
  })
  it('keeps locale-specific writes separate and preserves other locales', async () => {
    const result = await buildTransferPlan([row({ locale: 'de', value: 'Neue Jacke' })], 'update', context(), contracts)
    expect(result.issues).toEqual([])
    expect(result.targets[0].patch).toEqual({})
    expect(result.targets[0].contentWrites).toEqual([{ address: { tier: 'language', language: 'de' }, values: { title: 'Neue Jacke' }, reset: [] }])
    expect(result.targets[0].before?.localizedContent).toEqual(product().localizedContent)
  })
  it('does not convert an unchanged inherited channel field into a pinned override', async () => {
    const result = await buildTransferPlan([channelRow({ action: 'INHERIT', value: undefined })], 'update', context(), contracts)
    expect(result.issues).toEqual([])
    expect(result.targets[0].cells[0]).toMatchObject({ verdict: 'unchanged', beforeState: 'inherited', afterState: 'inherited' })
    expect(result.targets[0].patch).toEqual({})
  })
  it('lets an explicit SET pin even when its value equals Master', async () => {
    const result = await buildTransferPlan([channelRow({ value: 'Jacket' })], 'update', context(), contracts)
    expect(result.issues).toEqual([])
    expect(result.targets[0].contentWrites).toEqual([{ address: { tier: 'pin', language: 'it', coordinate: { channel: 'AMAZON', market: 'IT', accountId: 'seller-a' } }, values: { title: 'Jacket' }, reset: [] }])
  })
  it('never falls back from a requested account or alias to the primary listing', async () => {
    expect((await buildTransferPlan([channelRow({ accountId: 'seller-b' })], 'update', context(), contracts)).issues[0].message).toContain('does not exist')
    expect((await buildTransferPlan([channelRow({ aliasKey: 'secondary' })], 'update', context(), contracts)).issues[0].message).toContain('does not exist')
  })
  it('rejects ambiguous duplicates instead of picking one listing', async () => {
    const ctx = context({ listings: new Map([[transferTargetKey(channelRow()), [listing, { ...listing, id: 'l2' }]]]) })
    expect((await buildTransferPlan([channelRow()], 'update', ctx, contracts)).issues[0].message).toContain('Multiple listings')
  })
  it('uses current channel constraints and preserves list shapes', async () => {
    expect((await buildTransferPlan([channelRow({ value: 'A title that is too long' })], 'update', context(), contracts)).issues[0].message).toContain('exceeds')
    const result = await buildTransferPlan([channelRow({ field: 'material', value: ['A | B', 'Cotton'] })], 'update', context(), contracts)
    expect(result.issues).toEqual([])
    expect(result.targets[0].patch.overrideData).toEqual({ material: ['A | B', 'Cotton'] })
  })
  it('refuses duplicate actions and stale exported versions', async () => {
    expect((await buildTransferPlan([row(), row({ value: 'Other' })], 'update', context(), contracts)).issues[0].message).toContain('Duplicate')
    expect((await buildTransferPlan([row({ version: 3 })], 'update', context(), contracts)).issues[0].message).toContain('version')
  })
  it('does not bypass the dedicated price writer', async () => {
    expect((await buildTransferPlan([row({ field: 'basePrice', value: 22 })], 'update', context(), contracts)).issues[0].message).toContain('dedicated')
    expect((await buildTransferPlan([row({ field: 'basePrice', value: 0 })], 'update', context(), contracts)).issues).toEqual([])
  })
  it('allows an unchanged export of a native empty field', async () => {
    const result = await buildTransferPlan([row({ field: 'description', action: 'INHERIT', value: undefined })], 'update', context(), contracts)
    expect(result.issues).toEqual([])
    expect(result.targets[0].cells[0].verdict).toBe('unchanged')
  })
})


describe('Shopify and Etsy product information transfer', () => {
  const storeFields = async (channel: string) => {
    const { shopifyProductSpec, etsyProductSpec } = await import('./channel-specs/store.js')
    return (channel === 'SHOPIFY' ? shopifyProductSpec() : etsyProductSpec()).fields.map(f => ({ ...f,
      fieldKey: f.key, sheetKey: f.masterKey ?? f.key, selectionOnly: f.mode === 'strict',
    } as unknown as CatalogueField))
  }
  const storeContext = (r: TransferRow, attributes = {}) => context({
    accounts: [{ id: r.accountId, channelType: r.channel, marketplace: 'GLOBAL', isActive: true }],
    markets: [{ channel: r.channel, code: 'GLOBAL', languages: ['it'] }],
    listings: new Map([[transferTargetKey(r), [{ ...listing, channel: r.channel, marketplace: r.marketplace, followMasterTitle: false, platformAttributes: attributes }]]]),
  })
  it.each(['SHOPIFY', 'ETSY'])('round trips %s draft text, nested attributes and resets without requiring a category', async channel => {
    const r = channelRow({ channel, marketplace: 'GLOBAL', field: 'title', value: 'Store title' })
    const input = [r, { ...r, row: 3, field: channel === 'SHOPIFY' ? 'seo_title' : 'is_supply', value: channel === 'SHOPIFY' ? 'Search title' : false }]
    const parsed = await readTransferFile(await writeTransferWorkbook(input), 'store.xlsx')
    expect(parsed.issues).toEqual([])
    const c = { ...contracts, channel: async () => ({ fields: await storeFields(channel) }) }
    const plan = await buildTransferPlan(parsed.rows, 'update', storeContext(r), c)
    expect(plan.issues).toEqual([])
    expect(plan.targets[0].contentWrites).toEqual([expect.objectContaining({ address: { tier: 'pin', language: 'it', coordinate: { channel, market: 'GLOBAL', accountId: 'seller-a' } }, values: { title: 'Store title' } })])
    expect(plan.targets[0].patch).toMatchObject({ platformAttributes: channel === 'SHOPIFY' ? { seo: { title: 'Search title' } } : { is_supply: false } })
    expect(plan.targets[0].patch).not.toHaveProperty('name')
    const reset = await buildTransferPlan([{ ...r, action: 'INHERIT', value: undefined }], 'update', storeContext(r), c)
    expect(reset.issues).toEqual([])
    expect(reset.targets[0].contentWrites).toEqual([expect.objectContaining({ values: {}, reset: ['title'] })])
  })
  it('preserves numeric Etsy taxonomy IDs and refuses invalid category and tag values', async () => {
    const r = channelRow({ entity: 'Listings', channel: 'ETSY', marketplace: 'GLOBAL', field: 'taxonomy_id', value: 123 })
    const c = { ...contracts, channel: async () => ({ fields: await storeFields('ETSY') }) }
    const same = await buildTransferPlan([r], 'update', storeContext(r, { taxonomy_id: 123 }), c)
    expect(same.issues).toEqual([])
    expect(same.targets[0].cells[0]).toMatchObject({ verdict: 'unchanged', after: 123 })
    const bad = await buildTransferPlan([{ ...r, value: 1.5 }], 'update', storeContext(r), c)
    expect(bad.issues[0].message).toContain('multiple of 1')
    const tags = await buildTransferPlan([{ ...r, entity: 'Overrides', field: 'tags', value: ['invalid & tag'] }], 'update', storeContext(r), c)
    expect(tags.issues[0].message).toContain('configured format')
    const clear = await buildTransferPlan([{ ...r, action: 'CLEAR', value: undefined }], 'update', storeContext(r, { taxonomy_id: 123 }), c)
    expect(clear.issues).toEqual([])
    expect(clear.targets[0].patch).toMatchObject({ platformAttributes: { taxonomy_id: null } })
  })
})

describe('LX.F P1-8 / R-LX-8 — an inherited language value on transfer', () => {
  const parent = product({ id: 'root', sku: 'PARENT', isParent: true })
  const ctx = () => context({ products: new Map([['00123', product({ parentId: 'root' })], ['PARENT', parent]]) })
  const inherited = row({ field: 'name', locale: 'de', action: 'INHERIT', value: 'Deutscher Titel' })

  it('materialises onto the child when the owner is NOT in the transfer set', async () => {
    const plan = await buildTransferPlan([inherited], 'update', ctx(), contracts)
    expect(plan.issues).toEqual([])
    expect(plan.targets[0].cells.at(-1)).toMatchObject({ after: 'Deutscher Titel', afterState: 'stored', verdict: 'changed' })
    expect(plan.targets[0].contentWrites).toMatchObject([{ address: { tier: 'language', language: 'de' }, values: { title: 'Deutscher Titel' } }])
  })

  it('POSITIVE CONTROL — when the owner IS in the transfer set the child keeps inheriting', async () => {
    const plan = await buildTransferPlan([inherited, row({ row: 3, sku: 'PARENT', field: 'name', locale: 'de', action: 'SET', value: 'Deutscher Titel' })], 'update', ctx(), contracts)
    expect(plan.issues).toEqual([])
    const child = plan.targets.find(target => target.identity.sku === '00123')!
    expect(child.cells.at(-1)).toMatchObject({ after: null, afterState: 'inherited' })
  })
})

describe('LX.F F4 — the empty locale on a two-language market says what to do', () => {
  it('names the market and its languages instead of throwing the normaliser sentence', async () => {
    const { transferContentAddress } = await import('./catalog-transfer-content.js')
    const row = { row: 2, entity: 'Overrides' as const, sku: 'X', channel: 'AMAZON', accountId: 'a', marketplace: 'BE', aliasKey: '', locale: '', field: 'product_description', action: 'SET' as const }
    // Before: `normalizeLanguage('')` ran first and threw `Invalid content language: `.
    expect(() => transferContentAddress(row, ['nl', 'fr'])).toThrow('Choose an explicit language available on AMAZON · BE (nl, fr)')
    expect(() => transferContentAddress(row, ['nl', 'fr'])).toThrow(expect.objectContaining({ statusCode: 400 }) as never)
    // POSITIVE CONTROLS: a single-language market needs no explicit locale, and an
    // explicit language on the two-language market resolves to its pin.
    expect(transferContentAddress(row, ['nl'])).toMatchObject({ tier: 'pin', language: 'nl' })
    expect(transferContentAddress({ ...row, locale: 'fr-BE' }, ['nl', 'fr'])).toMatchObject({ tier: 'pin', language: 'fr' })
    // A language the market does not carry still names the market's languages.
    expect(() => transferContentAddress({ ...row, locale: 'de' }, ['nl', 'fr'])).toThrow('(nl, fr)')
  })
})
