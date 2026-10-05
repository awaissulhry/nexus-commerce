/**
 * Phase 2 (the Owner, 2026-10-01: "import any files to then create new products based on the SKUs … then publish") — the
 * product page's Import plans a NEW product family from an eBay listing workbook instead of refusing "not a Nexus product".
 * Fixtures are built here in memory, in the shape of the Owner's GALE IT file; the Owner's own files are never read by a test.
 */
import { describe, expect, it, vi } from 'vitest'
import { checkEbayLedger, clusterFileParents, ebayAccountFor, ebayFileSpecs, mapEbayWorkbook, planEbayGroups, planFamilyUpdate, varyingColumns, NEW_LISTING_KEY,
  type EbayFamilyContext, type EbayRulesSource, type EbayWorkbookResult, type EbayWorkbookTable, type EbayWorkbookTarget } from './catalog-ebay-workbook.js'
import { ebaySpecFromCache } from './channel-specs/ebay.js'
import type { DictionaryAttribute } from './family-variations-core.js'

const connections = vi.hoisted(() => ({ active: [] as { id: string; channelType: string; isActive: boolean; isPrimary: boolean; workspaceId: string | null }[] }))
vi.mock('../connection-resolver.service.js', async () => {
  const actual = await vi.importActual<typeof import('../connection-resolver.service.js')>('../connection-resolver.service.js')
  return { ...actual, listActiveConnections: async () => connections.active }
})

type P = { id: string; sku: string; parentId: string | null; productType: string | null; deletedAt: Date | null; importSource?: string | null }
const fakeDb = (products: P[] = []) => ({
  product: { findMany: async ({ where }: any) => products.filter(p => (where.OR ? !!p.deletedAt && where.OR.some((o: any) => p.sku.startsWith(o.sku.startsWith)) : where.sku ? where.sku.in.includes(p.sku) : where.id.in.includes(p.id)) && (where.deletedAt === null ? !p.deletedAt : true)) },
  productListingAlias: { findMany: async () => [] },
}) as any
const empty = (): EbayWorkbookResult => ({ rows: [], issues: [], exclusions: [], ledger: [], links: [], warnings: [] })
const option = (code: string, label: string) => ({ id: code, code, label, metadata: null, synonyms: [], sortOrder: 0, archivedAt: null })
const dictionary: DictionaryAttribute[] = [
  { id: 'a1', code: 'color', label: 'Color', semanticKey: null, archivedAt: null, options: [option('black', 'Nero')] },
  { id: 'a2', code: 'size', label: 'Size', semanticKey: null, archivedAt: null, options: [] },
]
const HEADERS = ['SKU', 'Parent/Child', 'Parent SKU', 'Title', 'Category ID', 'Variation Theme', 'Taglia (Size) ○ ↕', 'Colore (Color) ↕', 'Colore specifico', 'Price (€)']
type Kid = [sku: string, colour: string, size: string]
const KIDS: Kid[] = [['GALE-BLACK-M', 'Nero', 'M'], ['GALE-BLACK-L', 'Nero', 'L'], ['GALE-YELLOW-M', 'Giallo', 'M']]
/** The Owner's shape: several parent rows, each followed by the same variation SKUs; the Category ID on every row. */
function galeTable(parents: string[], kids: Kid[] = KIDS, theme = 'Colore,Taglia'): EbayWorkbookTable {
  const records: EbayWorkbookTable['records'] = []
  for (const parent of parents) {
    records.push({ row: records.length + 2, values: { SKU: parent, 'Parent/Child': 'parent', 'Parent SKU': '', Title: `Giacca ${parent}`, 'Category ID': '177104', 'Variation Theme': theme } })
    for (const [sku, colour, size] of kids) records.push({ row: records.length + 2, values: { SKU: sku, 'Parent/Child': 'child', 'Parent SKU': parent, Title: `Giacca ${parent}`, 'Category ID': '177104', 'Variation Theme': theme,
      'Taglia (Size) ○ ↕': size, 'Colore (Color) ↕': colour, 'Colore specifico': colour, 'Price (€)': '105' } })
  }
  return { sheet: 'ebay_it', marketplace: 'IT', headers: HEADERS, records }
}
const plan = async (table: EbayWorkbookTable, products: P[] = [], context: EbayFamilyContext = { dictionary }, onlyRootId = 'open', listingPlan = true) => {
  const out = empty(), proposals = new Map()
  const groups = await planEbayGroups(fakeDb(products), table, out, { listingPlan }, onlyRootId, proposals, context)
  return { out, proposals, groups }
}

describe('a new family from the file — grouping', () => {
  it('parents that share variation SKUs are ONE family; the first parent row is the product, the others its listings', async () => {
    const { out, proposals, groups } = await plan(galeTable(['GALE', 'IT-GALE', 'GALE-ALT1']))
    expect(out.issues).toEqual([])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ rootId: '', rootSku: 'GALE' })
    expect(groups[0].records).toHaveLength(12)
    expect(groups[0].family).toMatchObject({ rootSku: 'GALE', name: 'Giacca GALE', theme: 'Colore,Taglia',
      axes: [{ code: 'color', label: 'Colore' }, { code: 'size', label: 'Taglia' }] })
    expect(groups[0].family!.adoptId).toBeUndefined()
    expect(groups[0].family!.children).toEqual([
      { sku: 'GALE-BLACK-M', name: 'Giacca GALE (Nero, M)', values: { color: 'Nero', size: 'M' } },
      { sku: 'GALE-BLACK-L', name: 'Giacca GALE (Nero, L)', values: { color: 'Nero', size: 'L' } },
      { sku: 'GALE-YELLOW-M', name: 'Giacca GALE (Giallo, M)', values: { color: 'Giallo', size: 'M' } },
    ])
    expect([...proposals.entries()]).toEqual([['IT-GALE', { rootId: '', rootSku: 'GALE' }], ['GALE-ALT1', { rootId: '', rootSku: 'GALE' }]])
  })
  it('parents without shared variations are separate families, in file order', () => {
    const children: Record<string, string[]> = { A: ['a1', 'a2'], B: ['b1'], C: ['a2', 'c1'], D: [] }
    expect(clusterFileParents(['A', 'B', 'C', 'D'], p => children[p])).toEqual([['A', 'C'], ['B'], ['D']])
    // A later parent that bridges two families joins them.
    expect(clusterFileParents(['A', 'B', 'X'], p => ({ A: ['1'], B: ['2'], X: ['1', '2'] } as Record<string, string[]>)[p])).toEqual([['A', 'B', 'X']])
  })
  // The Owner, 2026-10-01: every variation the import creates is "<the product's title> (<values>)", whatever its row's Title.
  it('a variation is named after the product and its values, never after its own row’s Title', async () => {
    const table = galeTable(['GALE'])
    table.records[1].values.Title = 'Something else'
    table.records[2].values.Title = ''
    expect((await plan(table)).groups[0].family!.children.slice(0, 2).map(c => c.name)).toEqual(['Giacca GALE (Nero, M)', 'Giacca GALE (Nero, L)'])
  })
})

describe('a new family from the file — the open product', () => {
  const open: P = { id: 'open', sku: 'GALE', parentId: null, productType: null, deletedAt: null }
  it('the open product without variations becomes the parent, even when its row is not the first', async () => {
    const { out, proposals, groups } = await plan(galeTable(['IT-GALE', 'GALE']), [open], { dictionary, open: { id: 'open', sku: 'GALE', children: 0 } })
    expect(out.issues).toEqual([])
    expect(groups.map(g => [g.rootId, g.rootSku, g.family?.adoptId])).toEqual([['open', 'GALE', 'open']])
    expect(proposals.get('IT-GALE')).toEqual({ rootId: 'open', rootSku: 'GALE' })
  })
  it('an open product that already has variations is never adopted: its file listing is matched as before', async () => {
    const { groups } = await plan(galeTable(['GALE']), [open], { dictionary, open: { id: 'open', sku: 'GALE', children: 2 } })
    expect(groups.map(g => [g.rootId, g.family])).toEqual([['open', undefined]])
  })
  it('a file of another product is a named problem on the product page, never a silent skip', async () => {
    const other: P = { id: 'r9', sku: 'AIREON', parentId: null, productType: null, deletedAt: null }
    const table = galeTable(['AIREON'])
    const { out, groups } = await plan(table, [other], { dictionary, open: { id: 'open', sku: 'OTHER-1', children: 0 } })
    expect(groups).toEqual([])
    expect(out.exclusions).toEqual([])
    expect(out.issues).toHaveLength(4)
    expect(out.issues[0].message).toBe('AIREON is another product in this business. Import this file from AIREON.')
    expect(checkEbayLedger(table, out).unaccounted).toEqual([])
  })
  it('the catalog page and the drawer still refuse a file parent Nexus does not hold, by name', async () => {
    const { out, groups } = await plan(galeTable(['GALE']), [], { dictionary }, undefined, false)
    expect(groups).toEqual([])
    expect(out.issues[0].message).toBe('eBay parent GALE is not a Nexus product, and none of its variation SKUs is. Create the product first, or link the parent.')
  })
})

describe('a new family from the file — what it never does', () => {
  it('never moves a variation of another family: that SKU is a named problem, the rest is created', async () => {
    const products: P[] = [{ id: 'r9', sku: 'AIREON', parentId: null, productType: null, deletedAt: null }, { id: 'c9', sku: 'GALE-BLACK-L', parentId: 'r9', productType: null, deletedAt: null }]
    const { out, groups } = await plan(galeTable(['GALE', 'IT-GALE']), products)
    expect(groups[0].family!.children.map(c => c.sku)).toEqual(['GALE-BLACK-M', 'GALE-YELLOW-M'])
    expect(out.issues.map(i => [i.row, i.message])).toEqual([4, 8].map(row => [row, 'GALE-BLACK-L is already a variation of AIREON. Nexus never moves a product to another family; nothing is imported for it.']))
  })
  it('a listing of another product’s variations is sent to that product, not linked', async () => {
    const products: P[] = [{ id: 'r9', sku: 'AIREON', parentId: null, productType: null, deletedAt: null },
      ...KIDS.map(([sku], i) => ({ id: `c${i}`, sku, parentId: 'r9', productType: null, deletedAt: null }))]
    const { out, groups } = await plan(galeTable(['IT-AIREON']), products)
    expect(groups).toEqual([])
    expect(out.links).toEqual([])
    expect(out.issues[0].message).toBe('IT-AIREON lists the variations of AIREON, another product in this business. Import this file from AIREON.')
  })
  it('an axis the dictionary does not know refuses the family by name; nothing is created', async () => {
    const table = galeTable(['GALE'], KIDS, 'Colore,Scollatura')
    table.headers = [...HEADERS, 'Scollatura ↕']
    table.records.forEach(r => { r.values['Scollatura ↕'] = 'Coreana' })
    const { out, groups } = await plan(table)
    expect(groups).toEqual([])
    expect(new Set(out.issues.map(i => i.message))).toEqual(new Set(['Nexus has no attribute for the axis Scollatura. Add it in Settings → Attributes, then import again.']))
    expect(out.issues).toHaveLength(4)
  })
  it('two variations with the same values are both refused, by name', async () => {
    const { out, groups } = await plan(galeTable(['GALE'], [...KIDS, ['GALE-BLACK-M2', 'nero', 'm']]))
    expect(groups[0].family!.children.map(c => c.sku)).toEqual(['GALE-BLACK-L', 'GALE-YELLOW-M'])
    expect(new Set(out.issues.map(i => i.sku))).toEqual(new Set(['GALE-BLACK-M', 'GALE-BLACK-M2']))
  })
  it('S9: a new variation or family root is refused when another product\'s listing holds or sends its SKU as a channel SKU', async () => {
    const held = (skus: string[]) => Promise.resolve(skus.filter(sku => ['GALE-BLACK-L', 'NEWROOT'].includes(sku))
      .map(sku => ({ sku, sentence: `${sku} is the SKU of OTHER on Amazon · DE. One SKU names one product: choose another SKU.` })))
    const kid = await plan(galeTable(['GALE']), [], { dictionary, heldChannelSkus: held })
    expect(kid.groups[0].family!.children.map(c => c.sku)).toEqual(['GALE-BLACK-M', 'GALE-YELLOW-M'])
    expect(kid.out.issues.map(i => [i.sku, i.message])).toEqual([['GALE-BLACK-L', 'GALE-BLACK-L is the SKU of OTHER on Amazon · DE. One SKU names one product: choose another SKU.']])
    const root = await plan(galeTable(['NEWROOT']), [], { dictionary, heldChannelSkus: held })
    expect(root.groups).toEqual([])
    expect(new Set(root.out.issues.map(i => i.message))).toEqual(new Set(['NEWROOT is the SKU of OTHER on Amazon · DE. One SKU names one product: choose another SKU.']))
  })
  it('a product in the recycle bin comes back only when an import made it; any other is the Owner’s to decide', async () => {
    const gone = new Date()
    const products: P[] = [{ id: 'b1', sku: 'GALE-BLACK-M', parentId: null, productType: null, deletedAt: gone, importSource: 'SHEET_IMPORT' },
      { id: 'b2', sku: 'GALE-BLACK-L', parentId: null, productType: null, deletedAt: gone, importSource: null }]
    const { out, groups } = await plan(galeTable(['GALE']), products)
    expect(groups[0].family!.restore).toEqual({ 'GALE-BLACK-M': 'b1' })
    expect(out.issues.map(i => i.message)).toEqual(['GALE-BLACK-L is in the recycle bin. Restore it, or delete it for good, then import again.'])
  })
})

describe('axes from the file', () => {
  it('without a Variation Theme, the columns whose values differ between the variations — a column that splits them the same way is the same axis', () => {
    const rows = KIDS.map(([, colour, size]) => ({ 'Taglia (Size) ○ ↕': size, 'Colore (Color) ↕': colour, 'Colore specifico': colour, Title: 'same', 'Price (€)': size }))
    expect(varyingColumns(HEADERS, rows)).toEqual(['Taglia (Size) ○ ↕', 'Colore (Color) ↕'])
  })
  it('plans the axes from those columns when the file has no Variation Theme', async () => {
    const { groups } = await plan(galeTable(['GALE'], KIDS, ''))
    expect(groups[0].family!.axes).toEqual([{ code: 'size', label: 'Taglia' }, { code: 'color', label: 'Colore' }])
    expect(groups[0].family!.theme).toBe('Taglia,Colore')
  })
})

describe('the eBay account of a new listing', () => {
  // No workspaceId: the business's own account, whatever business the test runs in.
  const account = (id: string, isPrimary: boolean) => ({ id, channelType: 'EBAY', isActive: true, isPrimary, workspaceId: null })
  const db = (listings: { channelConnectionId: string; aliasKey: string }[] = []) => ({ channelListing: { findMany: async () => listings } }) as any
  it('takes the family’s own eBay listing account first, its main listing before an extra one', async () => {
    connections.active = [account('acc-1', true), account('acc-2', false)]
    expect(await ebayAccountFor(db([{ channelConnectionId: 'acc-2', aliasKey: 'alias-1' }, { channelConnectionId: 'acc-2', aliasKey: '' }]), 'root')).toEqual({ id: 'acc-2' })
  })
  it('else the business’s PRIMARY account — not "the only one"', async () => {
    connections.active = [account('acc-1', false), account('acc-2', true)]
    expect(await ebayAccountFor(db(), '')).toEqual({ id: 'acc-2' })
    connections.active = [account('acc-1', false)]
    expect(await ebayAccountFor(db(), '')).toEqual({ id: 'acc-1' })
  })
  it('names the problem with several accounts and no primary, and with none', async () => {
    connections.active = [account('acc-1', false), account('acc-2', false)]
    expect(await ebayAccountFor(db(), '')).toEqual({ problem: 'Several eBay accounts are connected and none is the primary one. Make one primary in Settings → Channels, then import again.' })
    connections.active = []
    expect(await ebayAccountFor(db(), '')).toEqual({ problem: expect.stringContaining('Connect an eBay account') })
  })
})

describe('a listing this import creates', () => {
  const spec = ebaySpecFromCache({ marketplace: 'IT', categoryId: '177104', aspects: [] })
  it('every variation row takes the parent row’s category (P7), so publish finds it', () => {
    const table = galeTable(['GALE'])
    for (const r of table.records) if (r.values['Parent/Child'] === 'child') r.values['Category ID'] = ''
    const target = (sku: string, isParent: boolean): EbayWorkbookTarget => ({ id: `${NEW_LISTING_KEY}main:${sku}`, sku, parentSku: 'GALE', sourceParentSku: 'GALE', isParent, itemId: '', accountId: 'acc-1', marketplace: 'IT', aliasKey: '', version: 0 })
    const result = mapEbayWorkbook(table, [target('GALE', true), ...KIDS.map(([sku]) => target(sku, false))], new Map([['177104', spec]]))
    expect(result.rows.filter(r => r.field === 'categoryId').map(r => [r.sku, r.value, r.entity])).toEqual([['GALE', '177104', 'Listings'], ...KIDS.map(([sku]) => [sku, '177104', 'Listings'])])
    expect(checkEbayLedger(table, result)).toEqual({ unaccounted: [], duplicated: [], danglingRows: [], phantom: [] })
  })
})

// 2026-10-01 (live check) — a business that never loaded eBay IT category 177104's rules refused EVERY row with "Refresh this
// marketplace and category schema before importing", and nothing in the import said how. Now the import loads them first.
describe('a category whose eBay rules this business never saved', () => {
  const rules = (aspects: boolean) => { const spec = ebaySpecFromCache({ marketplace: 'IT', categoryId: '177104', aspects: [] }); spec.absent = !aspects; return spec }
  const targets = (table: EbayWorkbookTable): EbayWorkbookTarget[] => [...new Set(table.records.map(r => r.values.SKU))].map(sku =>
    ({ id: `L-${sku}`, sku, parentSku: 'GALE', sourceParentSku: 'GALE', isParent: sku === 'GALE', itemId: '', accountId: 'acc-1', marketplace: 'IT', aliasKey: '', version: 1 }))
  it('loads them from eBay first (the one writer), reads them again, and the rows map', async () => {
    let saved = false
    const source: EbayRulesSource = { load: async () => rules(saved), save: async (marketplace, category) => { expect([marketplace, category]).toEqual(['IT', '177104']); saved = true } }
    const table = galeTable(['GALE'])
    const { specs, unloaded } = await ebayFileSpecs(table, source)
    expect(saved).toBe(true)
    expect(unloaded.size).toBe(0)
    const result = mapEbayWorkbook(table, targets(table), specs, { unloadedCategories: unloaded })
    expect(result.issues).toEqual([])
    expect(result.rows.filter(r => r.field === 'title')).toHaveLength(4)
  })
  it('never asks eBay for rules the business already has', async () => {
    const source: EbayRulesSource = { load: async () => rules(true), save: async () => { throw new Error('no call expected') } }
    expect((await ebayFileSpecs(galeTable(['GALE']), source)).unloaded.size).toBe(0)
  })
  it('says why in plain words: no developer settings in the sentence', async () => {
    const failing = (message: string): EbayRulesSource => ({ load: async () => rules(false), save: async () => { throw new Error(message) } })
    const reason = async (message: string) => (await ebayFileSpecs(galeTable(['GALE']), failing(message))).unloaded.get('177104')
    expect(await reason('auth: No eBay credentials available. Link an eBay account in Settings or configure EBAY_CLIENT_ID + EBAY_CLIENT_SECRET')).toBe('the eBay account is not signed in')
    expect(await reason('network: connect ECONNREFUSED')).toBe('eBay did not answer')
  })
  it('when eBay cannot be reached: ONE plain problem on the parent row, the other rows point to it', async () => {
    const source: EbayRulesSource = { load: async () => rules(false), save: async () => { throw new Error('No active EBAY connection.') } }
    const table = galeTable(['GALE'])
    const { specs, unloaded } = await ebayFileSpecs(table, source)
    expect([...unloaded]).toEqual([['177104', 'no eBay account is connected']])
    const result = mapEbayWorkbook(table, targets(table), specs, { unloadedCategories: unloaded })
    expect(result.issues.map(i => [i.row, i.message])).toEqual([[2, "Nexus could not load eBay IT's rules for category 177104 (no eBay account is connected). Check the eBay account in Settings → Channels, then import again. Nothing in this category is imported (4 rows)."]])
    expect(result.exclusions.map(e => [e.row, e.message])).toEqual([3, 4, 5].map(row => [row, "Not imported: eBay IT's rules for category 177104 are missing (see row 2)."]))
    expect(result.rows).toEqual([])
    expect(checkEbayLedger(table, result).unaccounted).toEqual([])
  })
})

// Phase 2b (the Owner, 2026-10-01) — an EXISTING family gets what the file adds, never loses what it has.
describe('an existing family the file completes', () => {
  const root = { id: 'r1', sku: 'GALE', name: 'Gale jacket', variationAxisCodes: ['color', 'size'], variationAxes: ['Colore', 'Taglia'] }
  const variant = (id: string, sku: string, values: Record<string, string> = {}) => ({ id, sku, categoryAttributes: { variations: values }, variantAttributes: null })
  const variants = [variant('v1', 'GALE-BLACK-M', { color: 'Nero', size: 'M' }), variant('v2', 'GALE-BLACK-L', { color: 'Nero', size: 'L' })]
  const update = (patch: Partial<Parameters<typeof planFamilyUpdate>[0]> = {}) => planFamilyUpdate({ table: galeTable(['GALE']), root, variants, newSkus: ['GALE-YELLOW-M'], restore: {}, dictionary, ...patch })
  it('creates a new variation SKU in the family, with its values for the family’s axes, named after the product', () => {
    const { family, refused, issues } = update()
    expect(refused.size).toBe(0)
    expect(issues).toEqual([])
    expect(family).toMatchObject({ existingId: 'r1', rootSku: 'GALE', axes: [{ code: 'color', label: 'Colore' }, { code: 'size', label: 'Taglia' }], fills: [] })
    expect(family!.setsAxes).toBeUndefined()
    expect(family!.children).toEqual([{ sku: 'GALE-YELLOW-M', name: 'Giacca GALE (Giallo, M)', values: { color: 'Giallo', size: 'M' } }])
  })
  it('refuses, by name, a new variation that collides with a variant, or that the file’s axes do not fit', () => {
    const twin = update({ variants: [...variants, variant('v3', 'GALE-Y', { color: 'giallo', size: 'M' })] })
    expect(twin.family).toBeNull()
    expect(twin.refused.get('GALE-YELLOW-M')).toBe('GALE-Y and GALE-YELLOW-M would have the same Colore and Taglia. Give each variation its own values, then import again.')
    const table = galeTable(['GALE'], KIDS, 'Colore')
    const misfit = update({ table })
    expect(misfit.refused.get('GALE-YELLOW-M')).toBe('The file varies GALE by Colore; the family varies by Colore, Taglia. Nexus does not change a family\'s axes: new variations are not created.')
  })
  it('a family copied without axes or values gets both from the file (the live case)', () => {
    const bare = { ...root, variationAxisCodes: [], variationAxes: [] }
    const { family, issues } = update({ root: bare, variants: [variant('v1', 'GALE-BLACK-M'), variant('v2', 'GALE-BLACK-L')], newSkus: [] })
    expect(issues).toEqual([])
    expect(family).toMatchObject({ setsAxes: true, axes: [{ code: 'color', label: 'Colore' }, { code: 'size', label: 'Taglia' }], children: [],
      fills: [{ productId: 'v1', sku: 'GALE-BLACK-M', values: { color: 'Nero', size: 'M' } }, { productId: 'v2', sku: 'GALE-BLACK-L', values: { color: 'Nero', size: 'L' } }] })
  })
  it('never overwrites a value the family has: a different one in the file is a named problem; a missing one is filled', () => {
    const { family, issues } = update({ variants: [variant('v1', 'GALE-BLACK-M', { color: 'Rosso', size: 'M' }), variant('v2', 'GALE-BLACK-L', { color: 'Nero' })], newSkus: [] })
    expect(family!.fills).toEqual([{ productId: 'v2', sku: 'GALE-BLACK-L', values: { size: 'L' } }])
    expect(issues.map(i => [i.sku, i.message])).toEqual([['GALE-BLACK-M', 'GALE-BLACK-M has Colore "Rosso" in Nexus and "Nero" in the file. Nexus keeps its value; change it on the product if the file is right.']])
  })
  it('nothing to add is no plan', () => {
    expect(update({ newSkus: [] }).family).toBeNull()
  })
  it('a listing next to an existing family’s main listing becomes its extra listing, so its new variations are created there', async () => {
    const products: P[] = [{ id: 'open', sku: 'GALE', parentId: null, productType: null, deletedAt: null }, { id: 'k1', sku: 'GALE-OLD', parentId: 'open', productType: null, deletedAt: null }]
    const { out, proposals, groups } = await plan(galeTable(['GALE', 'IT-GALE']), products, { dictionary, open: { id: 'open', sku: 'GALE', children: 1 } })
    expect(out.issues).toEqual([])
    expect(groups.map(g => [g.rootId, g.records.length, g.family])).toEqual([['open', 8, undefined]])
    expect(proposals.get('IT-GALE')).toEqual({ rootId: 'open', rootSku: 'GALE' })
  })
})
