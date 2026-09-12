import { describe, expect, it, vi } from 'vitest'
vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('./sheet-columns.service.js', () => ({ getSheetColumns: vi.fn() }))
vi.mock('./mapping/field-catalogue.service.js', () => ({ getFieldCatalogue: vi.fn() }))
import ExcelJS from 'exceljs'
import { mapSourceTable, validateSourceMapping, type SourceMapping } from './catalog-source-mapping.js'
import { readSourceFile } from './catalog-source-file.js'
import { publicSourceAddress } from './catalog-source-fetch.js'
import { buildTransferPlan, managedChannelField, type TransferContext, type TransferContracts } from './catalog-transfer-plan.js'
import { transferTargetKey } from '@nexus/shared/catalog-transfer'

const mapping = (patch: Partial<SourceMapping> = {}): SourceMapping => ({ kind: 'catalog-source-v1', market: 'IT', mode: 'update', skuColumn: 'SKU', policy: { shared: 'replace', overrides: 'replace' }, bindings: [
  { source: 'Name', entity: 'Products', field: 'name', format: 'text' },
  { source: 'Title A', entity: 'Overrides', field: 'item_name', format: 'text', channel: { value: 'AMAZON' }, accountId: { value: 'account-a' }, marketplace: { value: 'IT' } },
  { source: 'Title B', entity: 'Overrides', field: 'item_name', format: 'text', channel: { value: 'AMAZON' }, accountId: { column: 'Account' }, marketplace: { column: 'Market' }, actionColumn: 'Action', versionColumn: 'Listing version' },
], ...patch })
const table = (record: Record<string, string>) => ({ headers: Object.keys(record), records: [record] })
const input = { SKU: '0001', Name: 'Updated shared', 'Title A': 'Italy A', 'Title B': 'France B', Account: 'account-b', Market: 'FR', Action: 'SET', 'Listing version': '8' }
describe('incoming mappings and file boundaries', () => {
  it('maps one wide row to shared and two exact accounts/markets, preserving SKU and independent versions', () => {
    const r = mapSourceTable(table(input), mapping())
    expect(r.issues).toEqual([]); expect(r.exclusions).toEqual([])
    expect(r.rows.map(r => [r.sku, r.entity, r.accountId, r.marketplace, r.version])).toEqual([['0001', 'Products', '', '', undefined], ['0001', 'Overrides', 'account-a', 'IT', undefined], ['0001', 'Overrides', 'account-b', 'FR', 8]])
  })
  it('conservatively excludes omitted and blank fields while preserving literal action words', () => {
    const { ['Title A']: _, ...r } = input
    const result = mapSourceTable(table({ ...r, Name: 'CLEAR', 'Title B': ' ' }), mapping())
    expect(result.rows.map(r => r.value)).toEqual(['CLEAR']); expect(result.exclusions).toHaveLength(2)
  })
  it('keeps explicit CLEAR and INHERIT distinct from a blank SET', () => {
    for (const action of ['CLEAR', 'INHERIT']) {
      const r = mapSourceTable(table({ ...input, 'Title B': '', Action: action }), mapping())
      expect(r.rows[2].action).toBe(action); expect(r.rows[2].value).toBeUndefined()
    }
    expect(mapSourceTable(table({ ...input, Action: 'CLEAR' }), mapping()).issues[0].message).toContain('empty value')
  })
  it('refuses missing coordinate/action/version headers and undeclared ownership', () => {
    expect(() => mapSourceTable(table({ SKU: '0001', Name: 'A' }), mapping())).toThrow('missing coordinate')
    expect(() => validateSourceMapping({ ...mapping(), policy: {} })).toThrow('Declare')
    expect(() => validateSourceMapping({ ...mapping(), bindings: [{ source: 'A', entity: 'Overrides', field: 'name', format: 'text' }] })).toThrow('explicitly select')
  })
  it('preserves JSON false/zero and rejects unsafe destinations, formula values and table exports', async () => {
    const m = mapping({ bindings: [{ source: 'flag', entity: 'Products', field: 'flag', format: 'json' }] })
    expect(mapSourceTable(table({ SKU: '001', flag: 'false' }), m).rows[0].value).toBe(false)
    expect(() => validateSourceMapping({ ...m, bindings: [{ ...m.bindings[0], field: '__proto__.x' }] })).toThrow('valid destination')
    await expect(readSourceFile(Buffer.from('SKU,Title@AMAZON:IT:it\n001,A'), 'table.csv')).rejects.toThrow('no account identity')
    const wb = new ExcelJS.Workbook(); const sheet = wb.addWorksheet('Supplier')
    sheet.addRow(['SKU', 'Name']); sheet.addRow(['001', { formula: '1+1', result: 2 }])
    await expect(readSourceFile(Buffer.from(await wb.xlsx.writeBuffer()), 'source.xlsx')).rejects.toThrow('replace formulas')
  })
  it('reads ordinary CSV and single-sheet XLSX identically', async () => {
    const wb = new ExcelJS.Workbook(); const sheet = wb.addWorksheet('Supplier stock-free catalog')
    sheet.addRow(['SKU', 'Name']); sheet.addRow(['0001', 'a,b']); sheet.addRow(['0002', 'INHERIT'])
    const xlsx = await readSourceFile(Buffer.from(await wb.xlsx.writeBuffer()), 'source.xlsx')
    expect(xlsx).toEqual(await readSourceFile(Buffer.from('SKU,Name\n0001,"a,b"\n0002,INHERIT'), 'source.csv'))
  })
  it('keeps nested Amazon price and availability fields under their dedicated owners', () => {
    for (const key of ['purchasable_offer__our_price__schedule__value_with_tax', 'list_price__value', 'fulfillment_availability__quantity']) expect(managedChannelField({ fieldKey: key, sheetKey: key })).toBe(true)
    expect(managedChannelField({ fieldKey: 'offer', sheetKey: 'offer', channelStore: { kind: 'platformAttributes', path: ['purchasable_offer', 'price'] } })).toBe(true)
    expect(managedChannelField({ fieldKey: 'material', sheetKey: 'material' })).toBe(false)
  })
  it('refuses private and metadata endpoints for source fetching', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '169.254.169.254', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1']) expect(publicSourceAddress(address), address).toBe(false)
    expect(publicSourceAddress('8.8.8.8')).toBe(true)
  })
})

const columns = ['name', 'basePrice', 'totalStock', 'description'].map(key => ({ key, writeField: key, label: key, group: 'Shared', kind: 'text', storage: 'column', scope: 'global', requiredBy: [], editable: true, defaultVisible: true }))
const title = { fieldKey: 'item_name', sheetKey: 'name', label: 'Title', kind: 'text', shape: 'scalar', editable: true, channelStore: { kind: 'listingColumn', column: 'title', followFlag: 'followMasterTitle' } }
const contracts = { master: async () => columns, channel: async () => ({ fields: [title] }) } as TransferContracts
const context = (): TransferContext => ({ products: new Map([['0001', { id: 'p1', sku: '0001', name: 'Existing', version: 1, familyId: 'f1', parentId: null, isParent: false, categories: [{ categoryId: 'c1', isPrimary: true }], basePrice: 10, totalStock: 7 }]]), listings: new Map(), families: [{ id: 'f1', code: 'coats', label: 'Coats' }], accounts: [{ id: 'account-a', channelType: 'AMAZON', marketplace: null, isActive: true }], markets: [{ channel: 'AMAZON', code: 'IT' }], categories: [{ id: 'c1', isActive: true }] })
describe('canonical write validation and source ownership', () => {
  it('refuses conflicting source rows targeting the same shared fact', async () => {
    const result = mapSourceTable({ headers: ['SKU', 'Name'], records: [{ SKU: '0001', Name: 'A' }, { SKU: '0001', Name: 'B' }] }, mapping({ bindings: [mapping().bindings[0]] }))
    expect((await buildTransferPlan(result.rows, 'update', context(), contracts)).issues[0].message).toContain('Duplicate')
  })
  it('blocks pricing and inventory writes even when legacy importers suggested those fields', async () => {
    for (const field of ['basePrice', 'totalStock']) {
      const r = mapSourceTable(table({ SKU: '0001', Name: '99' }), mapping({ bindings: [{ source: 'Name', entity: 'Products', field, format: 'json' }] }))
      expect((await buildTransferPlan(r.rows, 'update', context(), contracts)).issues[0].message).toContain('dedicated pricing')
    }
  })
  it('does not bypass fill-empty ownership through family/category postprocessing', async () => {
    const m = mapping({ bindings: ['family', 'categoryIds', 'primaryCategoryId'].map(field => ({ source: field, entity: 'Products', field, format: field === 'categoryIds' ? 'json' : 'text' })), policy: { shared: 'fill-empty', overrides: 'preserve' } })
    const parsed = mapSourceTable(table({ SKU: '0001', family: 'unknown', categoryIds: '["unknown"]', primaryCategoryId: 'unknown' }), m)
    const plan = await buildTransferPlan(parsed.rows, 'update', context(), contracts, m.policy)
    expect(plan.issues).toEqual([]); expect(plan.targets).toEqual([]); expect(plan.exclusions).toHaveLength(3)
  })
  it('preserves an override and rejects inactive account destinations', async () => {
    const m = mapping({ bindings: [mapping().bindings[1]], policy: { shared: 'replace', overrides: 'preserve' } })
    const parsed = mapSourceTable(table(input), m), c = context()
    c.listings.set(transferTargetKey(parsed.rows[0]), [{ id: 'l1', version: 1, title: 'Custom', followMasterTitle: false, platformAttributes: { productType: 'COAT' } }])
    const plan = await buildTransferPlan(parsed.rows, 'update', c, contracts, m.policy)
    expect(plan.targets[0].patch).toEqual({}); expect(plan.exclusions).toHaveLength(1)
    c.accounts[0].isActive = false
    expect((await buildTransferPlan(parsed.rows, 'update', c, contracts)).issues[0].message).toContain('active account')
  })
})
