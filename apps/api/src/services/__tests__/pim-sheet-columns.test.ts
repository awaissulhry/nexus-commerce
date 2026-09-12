/**
 * MS.1 / AM.1 — the sheet's column merge. Pure function, no DB.
 *
 * What these lock down is the honesty of a cell: a counter that shows no cap, a "strict" list that
 * silently blocks, a parent row flagged for a size it cannot have, a channel attribute that never
 * becomes a column, two columns for one concept, ten bullets squashed into one cell. Each test names
 * the defect it would catch.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { amazonSpecFromDefinition } from '../pim/channel-specs/amazon.js'
import { ebaySpecFromCache } from '../pim/channel-specs/ebay.js'
import { resolveWriteRouting } from '../pim/studio-sheet.service.js'
import {
  buildSheetColumns,
  coordinatesFor,
  normaliseKey,
  SLOT_COLUMNS_MAX,
  type SheetCoordinate,
} from '../pim/sheet-columns.service.js'
import type { FieldDefinition } from '../pim/field-registry.service.js'
import type { ChannelFieldSpec, ChannelSpec } from '../pim/channel-specs/types.js'

const AMAZON_IT: SheetCoordinate = { channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT', inMarket: true }
const EBAY_IT: SheetCoordinate = { channel: 'EBAY', marketplace: 'IT', label: 'eBay · IT', inMarket: true }
const SHOPIFY: SheetCoordinate = { channel: 'SHOPIFY', marketplace: 'GLOBAL', label: 'Shopify · GLOBAL', inMarket: false }

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'id'>): FieldDefinition => ({
  label: over.label ?? over.id,
  type: 'text',
  category: 'category',
  editable: true,
  ...over,
})

/** A channel field spec with sensible defaults — override what the test is about. */
const sf = (over: Partial<ChannelFieldSpec> & Pick<ChannelFieldSpec, 'key'>): ChannelFieldSpec => ({
  attribute: over.key,
  path: [],
  label: over.key,
  shape: 'scalar',
  kind: 'text',
  cardinality: { min: 1, max: 1 },
  requirement: 'optional',
  requiredInParent: true,
  editable: true,
  hidden: false,
  variantEligible: false,
  group: null,
  ...over,
})

const amazon = (fields: ChannelFieldSpec[], productType = 'COAT'): { coordinate: SheetCoordinate; spec: ChannelSpec } => ({
  coordinate: AMAZON_IT,
  spec: { channel: 'AMAZON', marketplace: 'IT', category: productType, fields, groups: [], fetchedAt: null, schemaVersion: null, coverage: {}, unrecognised: [], absent: false },
})
const ebay = (fields: ChannelFieldSpec[]): { coordinate: SheetCoordinate; spec: ChannelSpec } => ({
  coordinate: EBAY_IT,
  spec: { channel: 'EBAY', marketplace: 'IT', category: '177104', fields, groups: [], fetchedAt: null, schemaVersion: null, coverage: {}, unrecognised: [], absent: false },
})

const byKey = (columns: Array<{ key: string }>) => Object.fromEntries(columns.map((c) => [c.key, c])) as Record<string, any>

describe('attribute scope audit', () => {
  const masterFields = [
    field({ id: 'sku', category: 'universal' }), field({ id: 'name', category: 'universal' }),
    field({ id: 'brand', category: 'universal' }), field({ id: 'description', category: 'content' }),
    field({ id: 'productType', category: 'universal' }), field({ id: 'amazonAsin', category: 'identifiers' }),
    field({ id: 'ebayItemId', category: 'identifiers' }), field({ id: 'fulfillmentChannel', category: 'inventory' }),
    field({ id: 'costPrice', category: 'pricing' }), field({ id: 'bulletPoints', category: 'content' }),
    field({ id: 'keywords', category: 'content' }), field({ id: 'dimLength', label: 'Length', category: 'physical' }),
    field({ id: 'attr_armorType', productTypes: ['OUTERWEAR'] }),
  ]
  const amazonDef = JSON.parse(readFileSync(new URL('../pim/channel-specs/__tests__/fixtures/amazon-it-outerwear.trimmed.json', import.meta.url), 'utf8'))
  const ebayDef = JSON.parse(readFileSync(new URL('../pim/channel-specs/__tests__/fixtures/ebay-it-177104.json', import.meta.url), 'utf8'))
  const specs = [
    { coordinate: AMAZON_IT, spec: amazonSpecFromDefinition({ marketplace: 'IT', productType: 'OUTERWEAR', schemaDefinition: amazonDef }) },
    { coordinate: EBAY_IT, spec: ebaySpecFromCache({ marketplace: 'IT', categoryId: '177104', ...ebayDef }) },
  ]

  it.each(specs)('preserves every $coordinate.channel schema field while removing unrelated master controls', ({ coordinate, spec }) => {
    const result = buildSheetColumns({ fields: masterFields, specs: [{ coordinate, spec }], coordinates: [coordinate], scopeKind: 'channel' })
    const covered = new Set(result.columns.flatMap((c) => Object.values(c.channels ?? {}).map((f) => f.attribute)))
    expect([...covered].sort()).toEqual(Object.keys(spec.coverage).sort())
    expect(result.columns.filter((c) => !c.channels).map((c) => c.key)).toEqual(['sku'])
    for (const column of result.columns.filter((c) => c.key !== 'sku')) {
      expect(resolveWriteRouting(column, coordinate, null).affectsAllChannels, column.key).toBe(false)
    }
    expect(new Set(result.columns.map((c) => c.key)).size).toBe(result.columns.length)
    expect(result.groups.every((g) => result.columns.some((c) => c.groupKey === g.key))).toBe(true)
    if (coordinate.channel === 'EBAY') {
      expect(result.columns.some((c) => c.slot?.of === 'bulletPoints')).toBe(false)
      expect(result.columns.find((c) => c.key === 'name')?.label).toBe('Title')
      expect(result.groups.map((g) => g.label)).toEqual(['Identity', 'Classification', 'Content', 'Item specifics', 'Variations', 'Images and media', 'Offer', 'Shipping', 'Policies'])
    }
  })

  it('preserves master-only product facts and their applicability even without a marketplace schema', () => {
    const result = buildSheetColumns({ fields: masterFields, coordinates: [], scopeKind: 'master' })
    expect(byKey(result.columns).armorType).toMatchObject({ writeField: 'attr_armorType', applicableProductTypes: ['OUTERWEAR'] })
    expect(byKey(result.columns).productType).toMatchObject({ label: 'Amazon product type (default)', group: 'Classification' })
    expect(result.droppedKeys).toEqual([])
  })

  it('distinguishes every numbered image location without changing its write address', () => {
    const images = [1, 2, 10].map((n) => sf({ key: `other_product_image_locator_${n}`, englishLabel: 'Other image URL' }))
    const result = buildSheetColumns({ fields: [], specs: [amazon(images)], coordinates: [AMAZON_IT], scopeKind: 'channel' })
    expect(result.columns.map((c) => c.label)).toEqual(['Other image URL 1', 'Other image URL 2', 'Other image URL 10'])
    expect(result.columns.map((c) => c.writeField)).toEqual(images.map((f) => `attr_${f.key}`))
  })
})

describe('normaliseKey', () => {
  it('joins an Amazon snake_case name to an eBay English aspect name', () => {
    expect(normaliseKey('attr_outer_material')).toBe('outer_material')
    expect(normaliseKey('aspect_Outer Material')).toBe('outer_material')
    expect(normaliseKey('Outer-Material ')).toBe('outer_material')
  })
})

describe('coordinatesFor', () => {
  const marketplaces = [
    { channel: 'AMAZON', code: 'IT', isActive: true },
    { channel: 'EBAY', code: 'IT', isActive: true },
    { channel: 'AMAZON', code: 'DE', isActive: true },
    { channel: 'EBAY', code: 'DE', isActive: false },
    { channel: 'SHOPIFY', code: 'GLOBAL', isActive: true },
  ]
  it('names channels the way the brands are written', () => {
    const labels = coordinatesFor('IT', marketplaces).map((c) => c.label)
    expect(labels).toEqual(['Amazon · IT', 'eBay · IT', 'Shopify · GLOBAL'])
  })
  it('leaves out a channel with no presence in this market, unless it is forced in', () => {
    const present = new Set(['AMAZON:IT'])
    expect(coordinatesFor('IT', marketplaces, { present }).map((c) => c.channel)).toEqual(['AMAZON'])
    expect(coordinatesFor('IT', marketplaces, { present, channels: ['EBAY'] }).map((c) => c.channel)).toEqual(['AMAZON', 'EBAY'])
  })
  it('reports every active channel when presence is not supplied', () => {
    expect(coordinatesFor('IT', marketplaces).map((c) => c.channel)).toEqual(['AMAZON', 'EBAY', 'SHOPIFY'])
  })
  it('resolves a market to a coordinate LIST and keeps the webstore out of the country market', () => {
    const it = coordinatesFor('IT', marketplaces)
    expect(it.find((c) => c.channel === 'SHOPIFY')!.inMarket).toBe(false)
    expect(it.find((c) => c.channel === 'AMAZON')!.inMarket).toBe(true)
  })
  it('never leaks another country and skips inactive marketplaces', () => {
    const de = coordinatesFor('DE', marketplaces)
    expect(de.map((c) => `${c.channel}:${c.marketplace}`)).toEqual(['AMAZON:DE', 'SHOPIFY:GLOBAL'])
  })
  it('TRUE narrowing keeps only the channels named', () => {
    expect(coordinatesFor('IT', marketplaces, { only: ['EBAY'] }).map((c) => c.channel)).toEqual(['EBAY'])
  })
})

describe('buildSheetColumns — caps, requirement, lists (MS.1 rules kept)', () => {
  it('takes the TIGHTEST cap across coordinates and records who set it', () => {
    // The defect: showing Amazon's 200 when eBay refuses at 80 — the operator writes a title the
    // counter calls fine and the push is rejected.
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'attr_outer_material', label: 'Outer material' })],
      specs: [
        amazon([sf({ key: 'outer_material', maxLength: 200 })]),
        ebay([sf({ key: 'outer_material', maxLength: 80, label: 'Materiale esterno', englishLabel: 'Outer Material' })]),
      ],
      coordinates: [AMAZON_IT, EBAY_IT],
    })
    expect(columns).toHaveLength(1)
    expect(columns[0].maxLength).toBe(80)
    expect(columns[0].capFrom).toBe('eBay · IT')
    expect(columns[0].channels!['Amazon · IT'].maxLength).toBe(200)
    expect(columns[0].channels!['eBay · IT'].label).toBe('Materiale esterno')
  })

  it('keeps a cap of 0/null from wiping a real cap', () => {
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'attr_material' })],
      specs: [amazon([sf({ key: 'material', maxLength: 100 })]), ebay([sf({ key: 'material' })])],
      coordinates: [AMAZON_IT, EBAY_IT],
    })
    expect(columns[0].maxLength).toBe(100)
    expect(columns[0].capFrom).toBe('Amazon · IT')
  })

  it('carries the byte cap separately from the character cap and names its source', () => {
    const { columns } = buildSheetColumns({
      fields: [],
      specs: [amazon([sf({ key: 'product_description', maxBytes: 20000, masterKey: 'description' })])],
      coordinates: [AMAZON_IT],
    })
    const col = columns.find((c) => c.key === 'description')!
    expect(col.maxBytes).toBe(20000)
    expect(col.maxLength).toBeUndefined()
    expect(col.capFrom).toBe('Amazon · IT')
  })

  it('records requiredBy per coordinate, not as a boolean', () => {
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'brand', category: 'universal' })],
      specs: [
        amazon([sf({ key: 'brand', requirement: 'required' }), sf({ key: 'season' })]),
        ebay([sf({ key: 'brand', requirement: 'required', masterKey: 'brand' })]),
      ],
      coordinates: [AMAZON_IT, EBAY_IT],
    })
    const c = byKey(columns)
    expect(c.brand.requiredBy).toEqual(['Amazon · IT', 'eBay · IT'])
    expect(c.season.requiredBy).toEqual([])
    expect(c.brand.channels['eBay · IT'].requirement).toBe('required')
  })

  it('only calls a list strict when EVERY declaring channel closes it', () => {
    const { columns } = buildSheetColumns({
      fields: [],
      specs: [
        amazon([sf({ key: 'gender', kind: 'select', options: ['male', 'female'], mode: 'strict' }), sf({ key: 'season', kind: 'select', options: ['summer'], mode: 'open' })]),
      ],
      coordinates: [AMAZON_IT],
    })
    const c = byKey(columns)
    expect(c.gender.mode).toBe('strict')
    expect(c.gender.options).toEqual(['male', 'female'])
    expect(c.season.mode).toBe('open')
  })

  it('unions options across channels and carries deprecated ones as a warning, never a block', () => {
    const { columns } = buildSheetColumns({
      fields: [],
      specs: [
        amazon([sf({ key: 'material', kind: 'select', options: ['Cotone', 'Nylon'], mode: 'open', deprecatedOptions: ['Nylon'] })]),
        ebay([sf({ key: 'material', kind: 'select', options: ['Poliestere'], mode: 'open' })]),
      ],
      coordinates: [AMAZON_IT, EBAY_IT],
    })
    expect(columns[0].options).toEqual(['Cotone', 'Nylon', 'Poliestere'])
    expect(columns[0].deprecatedOptions).toEqual(['Nylon'])
  })
})

describe('buildSheetColumns — the channel spec is the SOURCE (AM.1)', () => {
  it('a channel field with no master twin becomes a column (46 Amazon properties were missing for lack of one)', () => {
    const { columns, droppedKeys } = buildSheetColumns({
      fields: [field({ id: 'name', category: 'universal' })],
      specs: [amazon([sf({ key: 'gpsr_manufacturer_reference', label: 'Riferimento del fabbricante' })])],
      coordinates: [AMAZON_IT],
      englishLabels: new Map([['gpsr_manufacturer_reference', 'GPSR manufacturer reference']]),
    })
    const c = byKey(columns)
    expect(c.gpsr_manufacturer_reference).toBeDefined()
    expect(c.gpsr_manufacturer_reference.label).toBe('GPSR manufacturer reference')
    expect(c.gpsr_manufacturer_reference.channelLabel).toBe('Riferimento del fabbricante')
    expect(c.gpsr_manufacturer_reference.storage).toBe('categoryAttributes')
    expect(c.gpsr_manufacturer_reference.writeField).toBe('attr_gpsr_manufacturer_reference')
    expect(droppedKeys).toEqual([])
  })

  it('eBay aspects become columns on the eBay scope — 0 of 20 did before', () => {
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'sku', category: 'universal', editable: false })],
      specs: [ebay([
        sf({ key: 'protection', attribute: 'aspect_Protection', label: 'Protezione', englishLabel: 'Protection', shape: 'list', cardinality: { min: 1, max: null }, channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Protezione'] } }),
        sf({ key: 'conditionId', label: 'Condizione', englishLabel: 'Condition', kind: 'select', options: ['NEW'], mode: 'strict', requirement: 'required', channelStore: { kind: 'platformAttributes', path: ['conditionId'] } }),
      ])],
      coordinates: [EBAY_IT],
      scopeKind: 'channel',
    })
    const c = byKey(columns)
    expect(c.protection.label).toBe('Protection')
    expect(c.protection.shape).toBe('list')
    expect(c.protection.cardinality).toEqual({ min: 1, max: null })
    expect(c.protection.storage).toBe('listing')
    expect(c.conditionId.requiredBy).toEqual(['eBay · IT'])
    expect(c.conditionId.channels['eBay · IT'].store).toEqual({ kind: 'platformAttributes', path: ['conditionId'] })
  })

  it('a field that lives ONLY on the listing is a channel-scope column, never a master one', () => {
    const specs = [ebay([sf({ key: 'conditionId', channelStore: { kind: 'platformAttributes', path: ['conditionId'] } })])]
    const master = buildSheetColumns({ fields: [], specs, coordinates: [EBAY_IT], scopeKind: 'master' })
    const channel = buildSheetColumns({ fields: [], specs, coordinates: [EBAY_IT], scopeKind: 'channel' })
    expect(master.columns.map((c) => c.key)).toEqual([])
    expect(channel.columns.map((c) => c.key)).toEqual(['conditionId'])
    // Writable: the bulk PATCH reads the store from this contract and sets the platformAttributes path.
    expect(channel.columns[0].editable).toBe(true)
    expect(channel.columns[0].storage).toBe('listing')
  })

  it('one concept, one column: item_name folds onto name and carries Amazon\'s label, cap and requirement', () => {
    // The Owner's complaint: "item name along with another column for the name, so it contradicts".
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'name', label: 'Name', category: 'universal' })],
      specs: [amazon([sf({ key: 'item_name', label: "Nome dell'articolo", maxLength: 200, requirement: 'required', masterKey: 'name', channelStore: { kind: 'listingColumn', column: 'title', followFlag: 'followMasterTitle' } })])],
      coordinates: [AMAZON_IT],
    })
    expect(columns.filter((c) => c.key === 'item_name')).toHaveLength(0)
    const name = byKey(columns).name
    expect(name.storage).toBe('localizedContent')
    expect(name.writeField).toBe('name')
    // Amazon's 200 caps the LISTING's title (item_name has its own listing store): on master it is a
    // per-coordinate fact, not the column's cap — see the listing-store cap test below.
    expect(name.maxLength).toBeUndefined()
    expect(name.channels['Amazon · IT'].maxLength).toBe(200)
    expect(name.requiredBy).toEqual(['Amazon · IT'])
    expect(name.channelLabel).toBe("Nome dell'articolo")
    expect(name.channels['Amazon · IT'].key).toBe('item_name')
    expect(name.channels['Amazon · IT'].store).toEqual({ kind: 'listingColumn', column: 'title', followFlag: 'followMasterTitle' })
  })

  it('a cap on a channel field with its OWN listing store applies on the channel scope, not on master', () => {
    // Every GALE eBay listing carries a 76-char title beside a 127-char master name: eBay's 80 caps
    // the LISTING's title. Folding it into master's `name` tinted every Name cell "over" for a value
    // eBay never receives (b0's reading, 2026-09-05). The fact still rides per coordinate.
    const specs = [
      amazon([sf({ key: 'item_name', maxLength: 200, masterKey: 'name', channelStore: { kind: 'listingColumn', column: 'title', followFlag: 'followMasterTitle' } })]),
      ebay([sf({ key: 'title', maxLength: 80, masterKey: 'name', channelStore: { kind: 'listingColumn', column: 'title', followFlag: 'followMasterTitle' } })]),
    ]
    const fields = [field({ id: 'name', category: 'universal' })]
    const master = byKey(buildSheetColumns({ fields, specs, coordinates: [AMAZON_IT, EBAY_IT], scopeKind: 'master' }).columns).name
    expect(master.maxLength).toBeUndefined()
    expect(master.capFrom).toBeUndefined()
    expect(master.channels['Amazon · IT'].maxLength).toBe(200)
    expect(master.channels['eBay · IT'].maxLength).toBe(80)
    const onEbay = byKey(buildSheetColumns({ fields, specs: [specs[1]], coordinates: [EBAY_IT], scopeKind: 'channel' }).columns).name
    expect(onEbay.maxLength).toBe(80)
    expect(onEbay.capFrom).toBe('eBay · IT')
    // A bag attribute has no listing store of its own: its cap reaches master as before.
    const bag = byKey(buildSheetColumns({ fields: [], specs: [amazon([sf({ key: 'fabric_type', maxLength: 500 })])], coordinates: [AMAZON_IT], scopeKind: 'master' }).columns).fabric_type
    expect(bag.maxLength).toBe(500)
  })

  it('the static amazon_*/ebay_* registry placeholders are gone — no dead "no backing column yet" columns', () => {
    const { columns } = buildSheetColumns({
      fields: [
        field({ id: 'amazon_bullets', category: 'amazon', editable: false }),
        field({ id: 'amazon_title', category: 'amazon' }),
        field({ id: 'ebay_format', category: 'ebay', editable: false }),
        field({ id: 'name', category: 'universal' }),
      ],
      coordinates: [AMAZON_IT, EBAY_IT],
    })
    expect(columns.map((c) => c.key)).toEqual(['name'])
  })

  it('joins the same attribute across channels by normalised key (Amazon material ≡ eBay Materiale)', () => {
    const { columns } = buildSheetColumns({
      fields: [],
      specs: [
        amazon([sf({ key: 'material', label: 'Materiale', maxLength: 500 })]),
        ebay([sf({ key: 'material', attribute: 'aspect_Material', label: 'Materiale', englishLabel: 'Material', maxLength: 65 })]),
      ],
      coordinates: [AMAZON_IT, EBAY_IT],
    })
    expect(columns).toHaveLength(1)
    expect(columns[0].label).toBe('Material')
    expect(columns[0].maxLength).toBe(65)
    expect(Object.keys(columns[0].channels!).sort()).toEqual(['Amazon · IT', 'eBay · IT'])
    // Defined by an untyped channel too, so no product-type gate.
    expect(columns[0].applicableProductTypes).toBeUndefined()
  })

  it('an Amazon-only attribute carries the product types that define and require it', () => {
    const { columns } = buildSheetColumns({
      fields: [],
      specs: [amazon([sf({ key: 'fabric_type', requirement: 'required' })], 'OUTERWEAR'), amazon([sf({ key: 'fabric_type' })], 'GLOVES')],
      coordinates: [AMAZON_IT],
    })
    expect(columns[0].applicableProductTypes).toEqual(['OUTERWEAR', 'GLOVES'])
    expect(columns[0].requiredForProductTypes).toEqual(['OUTERWEAR'])
    expect(columns[0].channels!['Amazon · IT'].categories).toEqual(['OUTERWEAR', 'GLOVES'])
  })

  it('retains internal product attributes on Master even when no channel declares them', () => {
    const { columns, droppedKeys } = buildSheetColumns({
      fields: [field({ id: 'attr_armorType' }), field({ id: 'attr_material' })],
      specs: [amazon([sf({ key: 'material' })])],
      coordinates: [AMAZON_IT],
    })
    expect(columns.map((c) => c.key).sort()).toEqual(['armorType', 'material'])
    expect(droppedKeys).toEqual([])
  })

  it('never drops the master\'s own shape (columns, content, price) for lack of a channel schema', () => {
    const { columns, droppedKeys } = buildSheetColumns({
      fields: [
        field({ id: 'description', category: 'universal' }),
        field({ id: 'basePrice', category: 'pricing', type: 'number' }),
        field({ id: 'sku', category: 'universal' }),
      ],
      coordinates: [SHOPIFY],
    })
    expect(columns.map((c) => c.key).sort()).toEqual(['basePrice', 'description', 'sku'])
    expect(droppedKeys).toEqual([])
  })
})

describe('buildSheetColumns — shapes (AM.1)', () => {
  const bullets = sf({ key: 'bullet_point', label: 'Punto elenco', shape: 'list', kind: 'longtext', cardinality: { min: 1, max: 10 }, maxLength: 700, requirement: 'required', masterKey: 'bulletPoints', channelStore: { kind: 'listingColumn', column: 'bulletPointsOverride', followFlag: 'followMasterBulletPoints' } })

  it('a bounded list becomes numbered SLOT columns behind one array store — ten bullets, not one cell', () => {
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'bulletPoints', label: 'Bullet points', category: 'content' })],
      specs: [amazon([bullets])],
      coordinates: [AMAZON_IT],
    })
    const slots = columns.filter((c) => c.slot)
    expect(slots).toHaveLength(10)
    expect(slots.map((c) => c.key)).toEqual(Array.from({ length: 10 }, (_, i) => `bulletPoints_${i + 1}`))
    expect(columns.some((c) => c.key === 'bulletPoints')).toBe(false)
    expect(columns.some((c) => c.key === 'bullet_point')).toBe(false)
    const first = slots[0]
    expect(first.label).toBe('Bullet 1')
    expect(first.slot).toEqual({ of: 'bulletPoints', index: 1, max: 10, label: 'Bullet points' })
    expect(first.writeField).toBe('bulletPoints[1]')
    expect(first.storage).toBe('localizedContent')
    expect(first.kind).toBe('longtext')
    // The 700 caps the LISTING's bullets (bullet_point has its own listing store); on master it rides
    // per coordinate, on the Amazon scope it is the column's cap.
    expect(first.maxLength).toBeUndefined()
    expect(first.channels['Amazon · IT'].maxLength).toBe(700)
    const onAmazon = buildSheetColumns({ fields: [field({ id: 'bulletPoints', label: 'Bullet points', category: 'content' })], specs: [amazon([bullets])], coordinates: [AMAZON_IT], scopeKind: 'channel' }).columns
    expect(onAmazon.find((c) => c.key === 'bulletPoints_1')!.maxLength).toBe(700)
    expect(first.shape).toBe('scalar')
    // Amazon needs ≥ 1 bullet, not ten: only slot 1 carries the requirement.
    expect(first.requiredBy).toEqual(['Amazon · IT'])
    expect(slots[1].requiredBy).toEqual([])
    expect(slots[9].channels!['Amazon · IT'].cardinality).toEqual({ min: 1, max: 10 })
  })

  it('the slot count is the channel\'s max, capped by SLOT_COLUMNS_MAX; a longer or unbounded list is ONE chip column', () => {
    const { columns } = buildSheetColumns({
      fields: [],
      specs: [amazon([
        sf({ key: 'material', shape: 'list', cardinality: { min: 1, max: 3 } }),
        sf({ key: 'recommended_browse_nodes', shape: 'list', cardinality: { min: 1, max: 232 } }),
        sf({ key: 'supplier_declared_dg_hz_regulation', shape: 'list', cardinality: { min: 1, max: null } }),
      ])],
      coordinates: [AMAZON_IT],
    })
    expect(columns.filter((c) => c.slot?.of === 'material').map((c) => c.key)).toEqual(['material_1', 'material_2', 'material_3'])
    const c = byKey(columns)
    expect(c.recommended_browse_nodes.shape).toBe('list')
    expect(c.recommended_browse_nodes.cardinality).toEqual({ min: 1, max: 232 })
    expect(c.supplier_declared_dg_hz_regulation.cardinality).toEqual({ min: 1, max: null })
    expect(232 > SLOT_COLUMNS_MAX).toBe(true)
  })

  it('a list the channel caps at ONE item is a scalar for the sheet; the channel fact keeps the truth', () => {
    const { columns } = buildSheetColumns({
      fields: [],
      specs: [amazon([sf({ key: 'color', shape: 'list', cardinality: { min: 1, max: 1 } })])],
      coordinates: [AMAZON_IT],
    })
    expect(columns[0].shape).toBe('scalar')
    expect(columns[0].slot).toBeUndefined()
  })

  it('the master\'s shape wins over a channel\'s cardinality: keywords stays a list although Amazon takes one string', () => {
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'keywords', label: 'Search keywords', category: 'content' })],
      specs: [amazon([sf({ key: 'generic_keyword', shape: 'scalar', cardinality: { min: 1, max: 1 }, maxLength: 500, maxBytes: 2000, masterKey: 'keywords' })])],
      coordinates: [AMAZON_IT],
    })
    const kw = byKey(columns).keywords
    expect(kw.shape).toBe('list')
    expect(kw.cardinality).toEqual({ min: 1, max: null })
    expect(kw.channels['Amazon · IT'].cardinality).toEqual({ min: 1, max: 1 })
    expect(kw.maxLength).toBe(500)
  })

  it('a measure is ONE column carrying its unit list', () => {
    const { columns } = buildSheetColumns({
      fields: [],
      specs: [amazon([sf({ key: 'item_weight', shape: 'measure', kind: 'number', unitOptions: ['kilograms', 'grams'] })])],
      coordinates: [AMAZON_IT],
    })
    expect(columns[0].shape).toBe('measure')
    expect(columns[0].kind).toBe('number')
    expect(columns[0].unitOptions).toEqual(['kilograms', 'grams'])
  })

  it('a compound leaf keeps its `parent__leaf` key and reads "Parent · Leaf" in English', () => {
    const { columns } = buildSheetColumns({
      fields: [],
      specs: [amazon([sf({ key: 'fulfillment_availability__quantity', attribute: 'fulfillment_availability', path: ['quantity'], kind: 'number', label: 'Quantità' })])],
      coordinates: [AMAZON_IT],
      englishLabels: new Map([['fulfillment_availability', 'Fulfillment availability']]),
    })
    expect(columns[0].key).toBe('fulfillment_availability__quantity')
    expect(columns[0].label).toBe('Fulfillment availability · Quantity')
    expect(columns[0].channels!['Amazon · IT'].path).toEqual(['quantity'])
  })
})

describe('buildSheetColumns — scope, kind, groups, order', () => {
  it('marks a variation axis per_variant so a parent cell locks instead of flagging', () => {
    const { columns } = buildSheetColumns({
      fields: [],
      specs: [amazon([sf({ key: 'size' }), sf({ key: 'material' })])],
      coordinates: [AMAZON_IT],
      variationAxes: ['Size'],
    })
    const c = byKey(columns)
    expect(c.size.scope).toBe('per_variant')
    expect(c.material.scope).toBe('global')
  })

  it('matches a variation axis against the LOCALISED channel label, not only the key', () => {
    // Measured on the real IT catalogue: `variationAxes` is ["Colore","Taglia"] while the attributes
    // are `color` and `size`. Key-only matching marked every axis global.
    const { columns } = buildSheetColumns({
      fields: [],
      specs: [amazon([sf({ key: 'color', label: 'Colore' }), sf({ key: 'size', label: 'Taglia' }), sf({ key: 'material', label: 'Materiale' })])],
      coordinates: [AMAZON_IT],
      variationAxes: ['Colore', 'Taglia'],
    })
    const c = byKey(columns)
    expect(c.color.scope).toBe('per_variant')
    expect(c.size.scope).toBe('per_variant')
    expect(c.material.scope).toBe('global')
  })

  it('treats identifiers as per_variant whatever the schema says', () => {
    const { columns } = buildSheetColumns({ fields: [field({ id: 'ean', category: 'identifiers' })], coordinates: [AMAZON_IT] })
    expect(columns[0].scope).toBe('per_variant')
  })

  it('routes each key to the storage a write must address', () => {
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'description', category: 'universal' }), field({ id: 'basePrice', category: 'pricing', type: 'number' })],
      specs: [amazon([sf({ key: 'material' })])],
      coordinates: [AMAZON_IT],
    })
    const c = byKey(columns)
    expect(c.description.storage).toBe('localizedContent')
    expect(c.description.group).toBe('Content')
    expect(c.material.storage).toBe('categoryAttributes')
    expect(c.material.writeField).toBe('attr_material')
    expect(c.basePrice.storage).toBe('column')
  })

  it('decides longtext by the KEY, never by how generous the cap is', () => {
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'description', category: 'universal' })],
      specs: [amazon([
        sf({ key: 'care_instructions', kind: 'longtext', maxLength: 500 }),
        sf({ key: 'color', kind: 'text', maxLength: 1000 }),
        sf({ key: 'product_tax_code', kind: 'text', maxLength: 949 }),
      ])],
      coordinates: [AMAZON_IT],
    })
    const c = byKey(columns)
    expect(c.description.kind).toBe('longtext')
    expect(c.care_instructions.kind).toBe('longtext')
    expect(c.color.kind).toBe('text')
    expect(c.product_tax_code.kind).toBe('text')
  })

  it('a text field with options becomes a select', () => {
    const { columns } = buildSheetColumns({ fields: [], specs: [amazon([sf({ key: 'gender', options: ['male'], mode: 'strict' })])], coordinates: [AMAZON_IT] })
    expect(columns[0].kind).toBe('select')
  })

  it('opens (Essentials) on the master\'s own shape plus what a channel requires', () => {
    const { columns } = buildSheetColumns({
      fields: [field({ id: 'name', category: 'universal' })],
      specs: [amazon([sf({ key: 'brand', requirement: 'required' }), sf({ key: 'athlete' })])],
      coordinates: [AMAZON_IT],
    })
    const c = byKey(columns)
    expect(c.name.defaultVisible).toBe(true)
    expect(c.brand.defaultVisible).toBe(true)
    expect(c.athlete.defaultVisible).toBe(false)
  })

  it('orders product details before offers regardless of schema order; required fields and slots stay together', () => {
    const grpA = { key: 'product_details', label: 'Product details', channelLabel: 'Dettagli', order: 1 }
    const grpB = { key: 'offer', label: 'Offer', channelLabel: 'Offerta', order: 0 }
    const spec = amazon([
      sf({ key: 'zeta', requirement: 'required', group: grpA }),
      sf({ key: 'alpha', group: grpA }),
      sf({ key: 'seasons', shape: 'list', cardinality: { min: 1, max: 2 }, group: grpA }),
      sf({ key: 'list_price', kind: 'number', group: grpB }),
    ])
    spec.spec.groups = [grpB, grpA]
    const { columns, groups } = buildSheetColumns({
      fields: [field({ id: 'name', category: 'universal' }), field({ id: 'basePrice', category: 'pricing', type: 'number' })],
      specs: [spec],
      coordinates: [AMAZON_IT],
    })
    expect(columns.map((c) => c.key)).toEqual(['name', 'zeta', 'alpha', 'seasons_1', 'seasons_2', 'basePrice', 'list_price'])
    expect(groups.map((g) => g.label)).toEqual(['Identity', 'Product details', 'Pricing', 'Offer'])
    expect(groups.find((g) => g.label === 'Offer')!.channelLabel).toBe('Offerta')
  })

  it('keeps canonical master IDs distinct from identically labelled channel groups', () => {
    const channelGroup = { key: 'product_details', label: 'Identity', channelLabel: 'Identità', order: 0 }
    const spec = amazon([sf({ key: 'color', group: channelGroup })])
    spec.spec.groups = [channelGroup]
    const result = buildSheetColumns({
      fields: [field({ id: 'brand', category: 'universal' }), field({ id: 'description', category: 'universal' })],
      specs: [spec], coordinates: [AMAZON_IT],
    })
    expect(byKey(result.columns).brand.groupKey).toBe('master:identity')
    expect(byKey(result.columns).description.groupKey).toBe('master:content')
    expect(byKey(result.columns).color.groupKey).toBe('AMAZON:product_details')
    expect(result.groups.filter((g) => g.label === 'Identity').map((g) => g.key)).toEqual(['master:identity', 'AMAZON:product_details'])
    expect(new Set(result.groups.map((g) => g.key)).size).toBe(result.groups.length)
  })

  it('group labels can change without altering slot identity, storage, requirements or channel mapping', () => {
    const build = (label: string) => {
      const group = { key: 'details', label, channelLabel: label, order: 0 }
      const spec = amazon([sf({ key: 'seasons', shape: 'list', cardinality: { min: 1, max: 2 }, requirement: 'required', group })])
      spec.spec.groups = [group]
      return buildSheetColumns({ fields: [], specs: [spec], coordinates: [AMAZON_IT] })
    }
    const before = build('Details')
    const after = build('Translated details')
    expect(before.columns.map((c) => c.groupKey)).toEqual(['AMAZON:details', 'AMAZON:details'])
    expect(after.columns.map(({ group, ...c }) => c)).toEqual(before.columns.map(({ group, ...c }) => c))
    expect(after.groups.find((g) => g.key === 'AMAZON:details')?.label).toBe('Translated details')
    expect(before.columns.map((c) => c.writeField)).toEqual(['attr_seasons[1]', 'attr_seasons[2]'])
  })

  it('namespaces equal Amazon and eBay group keys and supplies groups for ungrouped fields', () => {
    const group = { key: 'details', label: 'Details', channelLabel: null, order: 0 }
    const am = amazon([sf({ key: 'color', group }), sf({ key: 'ungrouped_amazon' })])
    const eb = ebay([sf({ key: 'material', group })])
    am.spec.groups = [group]
    eb.spec.groups = [group]
    const { columns, groups } = buildSheetColumns({ fields: [], specs: [am, eb], coordinates: [AMAZON_IT, EBAY_IT] })
    expect(byKey(columns).color.groupKey).toBe('AMAZON:details')
    expect(byKey(columns).material.groupKey).toBe('EBAY:details')
    expect(byKey(columns).ungrouped_amazon.groupKey).toBe('AMAZON')
    const groupKeys = new Set(groups.map((g) => g.key))
    expect(columns.every((c) => groupKeys.has(c.groupKey!))).toBe(true)
  })
})
