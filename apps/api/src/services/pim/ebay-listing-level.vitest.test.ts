import { describe, expect, it } from 'vitest'
import { ebayAxisIdentities, ebayFamilySupplier, holdEbayItemLevelOnVariations, isEbayListingLevel, projectionAxisNames, sameEbayValue, showEbayListingLevel } from './ebay-listing-level.js'

/**
 * P1 of fix/product-sheet-editing (report 5 I-1) — eBay takes one value per listing for an item specific that is not a
 * variation axis: parent first, then the first variation in SKU order (`buildSharedListingInput`). The sheet shows that
 * value on every row, and says which rows hold another one.
 */
const store = (name: string) => ({ kind: 'platformAttributes', path: ['itemSpecifics', name] })
const axes = ebayAxisIdentities(['Colore', 'Taglia'])

describe('the rule', () => {
  it('an item specific is listing-level unless it is an axis (by its eBay name, key or label, any spelling)', () => {
    expect(isEbayListingLevel({ store: store('Paese di origine') }, axes)).toBe(true)
    expect(isEbayListingLevel({ store: store('Colore') }, axes)).toBe(false)
    expect(isEbayListingLevel({ store: store('Color'), names: ['color'] }, axes)).toBe(false)
    expect(isEbayListingLevel({ store: { kind: 'platformAttributes', path: ['subtitle'] } }, axes)).toBe(false)
  })
  it('the axes are the projection\'s INCLUDED ones', () => {
    expect(projectionAxisNames([{ included: true, channelName: 'Colore', familyKey: 'color' }, { included: false, channelName: 'Scollatura' }])).toEqual(['Colore', 'color'])
  })
  it('the supplier is the parent when it holds one, else the first variation in SKU order', () => {
    const rows = [{ productId: 'b', sku: 'F-B', isParent: false, value: 'Albania' }, { productId: 'a', sku: 'F-A', isParent: false, value: 'Cina' }, { productId: 'p', sku: 'F', isParent: true, value: '' }]
    expect(ebayFamilySupplier(rows)?.productId).toBe('a')
    expect(ebayFamilySupplier([...rows, { productId: 'p2', sku: 'F', isParent: true, value: 'Pakistan' }])?.productId).toBe('p2')
  })
  it('a legacy "x" and ["x"] are the same value', () => expect(sameEbayValue('x', ['x'])).toBe(true))
})

describe('showEbayListingLevel — what the eBay sheet shows', () => {
  const cell = (value: unknown) => ({ value, pinned: true, inherited: false, inheritedFrom: null, mapped: { value, warnings: [], errors: [] as string[] } })
  const rows = () => [
    { id: 'p', sku: 'F', parentId: null, aliasId: null, values: { origin: cell('Pakistan'), color: cell(null), fit: cell(null) } },
    { id: 'a', sku: 'F-A', parentId: 'p', aliasId: null, values: { origin: cell('Cina'), color: cell('Rosso'), fit: cell('Slim') } },
    { id: 'b', sku: 'F-B', parentId: 'p', aliasId: null, values: { origin: cell(null), color: cell('Giallo'), fit: cell('Regular') } },
    { id: 'x', sku: 'F-X', parentId: 'p', aliasId: null, values: { origin: cell('Albania'), color: cell('Blu'), fit: cell(null) } },
  ]
  const columns = [{ key: 'origin', label: 'Country of origin', channels: { 'eBay · IT': { store: store('Paese di origine') } } },
    { key: 'color', label: 'Color', channelLabel: 'Colore', channels: { 'eBay · IT': { store: store('Colore') } } },
    { key: 'fit', label: 'Fit', channels: { 'eBay · IT': { store: store('Vestibilità') } } }]
  const show = (input = rows(), included = ['a', 'b']) => {
    showEbayListingLevel({ rows: input as never, columns, label: 'eBay · IT', groups: [{ aliasKey: '', axes: [{ included: true, channelName: 'Colore', familyKey: 'color' }], includedIds: new Set(included) }] })
    return Object.fromEntries(input.map(row => [row.id, row.values]))
  }
  it('every row shows the parent\'s value; a row with its own different value says so; the parent is marked as the source', () => {
    const out = show()
    expect([out.p.origin.value, out.a.origin.value, out.b.origin.value, out.x.origin.value]).toEqual(['Pakistan', 'Pakistan', 'Pakistan', 'Pakistan'])
    expect(out.a.origin).toMatchObject({ inherited: true, inheritedFrom: 'p', pinned: false, mapped: { value: 'Pakistan', listingLevel: { productId: 'p', sku: 'F', variation: true, ownValue: 'Cina' } } })
    // The row's own value is named once, by the source (`ownValue`), not again in the mapping's warnings.
    expect(out.a.origin.mapped.warnings).toEqual([])
    expect(out.b.origin.mapped.listingLevel).toEqual({ productId: 'p', sku: 'F', variation: true })
    expect(out.p.origin.mapped.listingLevel).toEqual({ productId: 'p', sku: 'F' })
  })
  it('P1 review 4 — on a variation row the value is the LISTING\'s: inherited from the listing row, and no reset of its own', () => {
    const out = show()
    for (const id of ['a', 'b', 'x']) expect(out[id].origin).toMatchObject({ layer: 'alias', inherited: true, pinned: false, resettable: false })
    // The listing's own row keeps its reset (it resets the listing's value).
    expect(out.p.origin.resettable).toBeUndefined()
    expect(out.p.origin.layer).toBeUndefined()
    // An axis is the row's own: untouched.
    expect(out.a.color).not.toHaveProperty('resettable')
  })
  it('control: an axis stays per row', () => {
    const out = show()
    expect([out.a.color.value, out.b.color.value]).toEqual(['Rosso', 'Giallo'])
  })
  it('no parent value: the first INCLUDED variation in SKU order supplies it (an excluded row is not sent, so it never does)', () => {
    const out = show(rows(), ['b', 'a'])
    expect([out.p.fit.value, out.b.fit.value, out.x.fit.value]).toEqual(['Slim', 'Slim', 'Slim'])
    expect(out.b.fit.mapped.listingLevel).toMatchObject({ productId: 'a', variation: true, ownValue: 'Regular' })
    // The variation that supplies the listing's value is a variation too: its cell is the listing's, with no reset.
    expect(out.a.fit).toMatchObject({ value: 'Slim', layer: 'alias', resettable: false, mapped: { listingLevel: { productId: 'a', variation: true } } })
    expect(out.p.fit).toMatchObject({ value: 'Slim', inherited: true, inheritedFrom: 'a' })
    const excludedFirst = rows(); excludedFirst[0].values.origin = cell(null)
    expect(show(excludedFirst, ['a']).b.origin.value).toBe('Cina')
  })
})

/**
 * Wave 2 (C6) — eBay Trading takes condition, category, policies, location, VAT, Best Offer, max per buyer and the package
 * once per listing, from the main row. A variation row showed its own value, editable, and eBay never got it. It now shows
 * the main row's value, read-only, and says why. Fake SKUs only.
 */
describe('holdEbayItemLevelOnVariations — variation rows show the listing\'s value', () => {
  const LABEL = 'eBay · IT'
  const pa = (path: string) => ({ kind: 'platformAttributes', path: [path] })
  const columns = [
    { key: 'conditionId', label: 'Condition', channels: { [LABEL]: { store: pa('conditionId') } } },
    { key: 'fulfillmentPolicyId', label: 'Shipping policy', channels: { [LABEL]: { store: pa('fulfillmentPolicyId') } } },
    { key: 'packageWeight', label: 'Package weight', channels: { [LABEL]: { store: { kind: 'platformAttributes', path: ['packageWeight'], unitPath: ['weightUnit'] } } } },
    { key: 'bestOffer', label: 'Best offer', channels: { [LABEL]: { store: pa('bestOffer') } } },
    { key: 'listingDuration', label: 'Duration', channels: { [LABEL]: { store: pa('listingDuration') } } },
    // Not held: a listing column (title), an item specific, a per-variation field (price).
    { key: 'title', label: 'Title', channels: { [LABEL]: { store: { kind: 'listingColumn', column: 'title' } } } },
    { key: 'origin', label: 'Country of origin', channels: { [LABEL]: { store: store('Paese di origine') } } },
    { key: 'price', label: 'Price', channels: { [LABEL]: { store: { kind: 'listingColumn', column: 'price' } } } },
  ]
  const cell = (value: unknown, extra: Record<string, unknown> = {}) => ({ value, source: 'channelExplicit', layer: 'channel', inherited: false, inheritedFrom: null, pinned: true, follows: false,
    editable: true, writable: true, writeBlockedReason: null as string | null, mapped: { value, warnings: [] as string[], errors: [] as string[], requiredByRule: true }, ...extra })
  const values = (over: Record<string, unknown>) => Object.fromEntries(['conditionId', 'fulfillmentPolicyId', 'packageWeight', 'bestOffer', 'listingDuration', 'title', 'origin', 'price']
    .map(key => [key, cell(over[key] ?? null)]))
  const family = (aliasId: string | null = null, main: Record<string, unknown> = {}, kids: Array<Record<string, unknown>> = [{}, {}]) => [
    { id: `p${aliasId ?? ''}`, sku: 'FAKE-FAM', parentId: null, aliasId, values: values({ conditionId: 'NEW', fulfillmentPolicyId: 'ship-main', packageWeight: { value: 2, unit: 'KILOGRAM' },
      bestOffer: false, listingDuration: 'GTC', title: 'Main title', origin: 'Italia', price: 10, ...main }) },
    ...kids.map((own, i) => ({ id: `c${i}${aliasId ?? ''}`, sku: `FAKE-FAM-${i}`, parentId: `p${aliasId ?? ''}`, aliasId, values: values({ title: `Kid ${i}`, origin: 'Cina', price: 20 + i, ...own }) })),
  ]
  type Rows = ReturnType<typeof family>
  const hold = (rows: Rows, inventoryAliases?: Set<string>) => {
    holdEbayItemLevelOnVariations({ rows: rows as never, columns, label: LABEL, ...(inventoryAliases ? { inventoryAliases } : {}) })
    return rows
  }
  const REASON = 'eBay takes this once per listing, from the main row FAKE-FAM. Change it there.'

  it('a variation row shows the main row\'s value, read-only, with the reason; its problems are named on the main row only', () => {
    const rows = family(); rows[1].values.conditionId.mapped.errors = ['Field \'Condition\' is required.']
    rows[0].values.conditionId.mapped.errors = ['eBay does not know this condition.']
    const [main, kid] = hold(rows)
    expect(kid.values.conditionId).toMatchObject({ value: 'NEW', editable: false, writable: false, resettable: false, writeBlockedReason: REASON,
      mapped: { value: 'NEW', errors: [], requiredByRule: false } })
    expect(kid.values.fulfillmentPolicyId).toMatchObject({ value: 'ship-main', writeBlockedReason: REASON })
    expect(kid.values.packageWeight.value).toEqual({ value: 2, unit: 'KILOGRAM' })
    expect(kid.values.bestOffer).toMatchObject({ value: false, writeBlockedReason: REASON })
    // The main row is judged as before: its own cell, its own problem, still editable.
    expect(main.values.conditionId).toMatchObject({ value: 'NEW', editable: true, writable: true, mapped: { errors: ['eBay does not know this condition.'] } })
  })

  it('a row\'s own different value is named in the reason, never sent', () => {
    const [, kid, same] = hold(family(null, {}, [{ conditionId: 'USED_EXCELLENT', packageWeight: { value: 3, unit: 'KILOGRAM' }, bestOffer: true }, { conditionId: 'NEW', packageWeight: { value: '2', unit: 'KILOGRAM' } }]))
    expect(kid.values.conditionId.writeBlockedReason).toBe(`${REASON} This row also has "USED_EXCELLENT", which eBay does not get.`)
    expect(kid.values.packageWeight.writeBlockedReason).toBe(`${REASON} This row also has "3 KILOGRAM", which eBay does not get.`)
    expect(kid.values.bestOffer.writeBlockedReason).toBe(`${REASON} This row also has "Yes", which eBay does not get.`)
    // The same value (a number stored as text too) names nothing more.
    expect(same.values.conditionId.writeBlockedReason).toBe(REASON)
    expect(same.values.packageWeight.writeBlockedReason).toBe(REASON)
  })

  it('a blank main row: the variation shows blank (what eBay gets from the main row), and names its own value', () => {
    const [, kid, blank] = hold(family(null, { conditionId: null, fulfillmentPolicyId: '' }, [{ conditionId: 'NEW', fulfillmentPolicyId: 'ship-own' }, {}]))
    expect(kid.values.conditionId).toMatchObject({ value: null, editable: false, writeBlockedReason: `${REASON} This row also has "NEW", which eBay does not get.` })
    expect(kid.values.fulfillmentPolicyId).toMatchObject({ value: '', writeBlockedReason: `${REASON} This row also has "ship-own", which eBay does not get.` })
    expect(blank.values.conditionId).toMatchObject({ value: null, writeBlockedReason: REASON })
  })

  it('not held: title, item specifics and per-variation fields keep the row\'s own value and stay editable', () => {
    const [, kid] = hold(family())
    for (const key of ['title', 'origin', 'price']) expect(kid.values[key]).toMatchObject({ editable: true, writable: true, writeBlockedReason: null })
    expect([kid.values.title.value, kid.values.origin.value, kid.values.price.value]).toEqual(['Kid 0', 'Cina', 20])
  })

  it('a single product (a listing of one row) is left alone', () => {
    const [lone] = family(null, {}, [])
    const before = JSON.parse(JSON.stringify(lone))
    hold([lone])
    expect(lone).toEqual(before)
  })

  it('each listing is held to its OWN main row: a primary and an alias are kept apart', () => {
    const rows = [...family(null), ...family('alias-1', { conditionId: 'USED_GOOD', fulfillmentPolicyId: 'ship-alias' })]
    hold(rows)
    const by = (id: string) => rows.find(row => row.id === id)!
    expect([by('c0').values.conditionId.value, by('c0').values.fulfillmentPolicyId.value]).toEqual(['NEW', 'ship-main'])
    expect([by('c0alias-1').values.conditionId.value, by('c0alias-1').values.fulfillmentPolicyId.value]).toEqual(['USED_GOOD', 'ship-alias'])
    expect(by('palias-1').values.conditionId.mapped.listingLevel).toEqual({ productId: 'palias-1', sku: 'FAKE-FAM' })
  })

  it('an Inventory-model listing keeps condition and package per variation (Owner decision 3); the rest is held', () => {
    const rows = [...family(null, {}, [{ conditionId: 'USED_EXCELLENT', packageWeight: { value: 3, unit: 'KILOGRAM' } }]), ...family('alias-1', {}, [{ conditionId: 'USED_EXCELLENT' }])]
    hold(rows, new Set(['']))
    const kid = rows.find(row => row.id === 'c0')!
    expect(kid.values.conditionId).toMatchObject({ value: 'USED_EXCELLENT', editable: true, writeBlockedReason: null })
    expect(kid.values.packageWeight).toMatchObject({ value: { value: 3, unit: 'KILOGRAM' }, editable: true })
    expect(kid.values.fulfillmentPolicyId).toMatchObject({ value: 'ship-main', editable: false, writeBlockedReason: REASON })
    // The main row's own condition is not the listing's value there: no mark, so a save on it repaints nothing.
    expect(rows[0].values.conditionId.mapped).not.toHaveProperty('listingLevel')
    expect(rows[0].values.fulfillmentPolicyId.mapped).toHaveProperty('listingLevel')
    // The alias (a Trading listing) is held as usual.
    expect(rows.find(row => row.id === 'c0alias-1')!.values.conditionId).toMatchObject({ value: 'NEW', editable: false })
  })

  it('the main row is marked as the listing\'s value (so a save there repaints the variations); variation cells carry no mark', () => {
    const [main, kid] = hold(family())
    for (const key of ['conditionId', 'fulfillmentPolicyId', 'packageWeight', 'bestOffer', 'listingDuration']) {
      expect(main.values[key].mapped.listingLevel).toEqual({ productId: 'p', sku: 'FAKE-FAM' })
      expect(kid.values[key].mapped).not.toHaveProperty('listingLevel')
    }
    expect(main.values.title.mapped).not.toHaveProperty('listingLevel')
  })

  it('a field the main row cannot change either gives the main row\'s reason, never "change it there"', () => {
    const rows = family()
    Object.assign(rows[0].values.listingDuration, { editable: false, writable: false, writeBlockedReason: 'eBay fixed-price listings run until cancelled.' })
    const [, kid] = hold(rows)
    expect(kid.values.listingDuration.writeBlockedReason).toBe('eBay takes this once per listing, from the main row FAKE-FAM. eBay fixed-price listings run until cancelled.')
  })

  it('a variation\'s own formula is not shown over the listing\'s value', () => {
    const rows = family(); Object.assign(rows[1].values.conditionId, { formula: 'UPPER(x)', formulaError: 'nope', dependsOn: ['x'] })
    const [, kid] = hold(rows)
    expect(kid.values.conditionId).not.toHaveProperty('formula')
    expect(kid.values.conditionId).not.toHaveProperty('formulaError')
    expect(kid.values.conditionId).not.toHaveProperty('dependsOn')
  })
})
