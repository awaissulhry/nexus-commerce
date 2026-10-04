/**
 * Build shape v2 P4 — Full update of an eBay Trading listing: ONE ReviseFixedPriceItem from the full builder, eBay's own
 * available quantities echoed from the live GetItem, the variations Nexus does not hold deleted (or kept at 0 when they
 * have sales), `<DeletedField>` for what Nexus holds empty, and every field ticked and locked in the review.
 */
import { describe, expect, it } from 'vitest'
import { FULL_EBAY_SHAPE_DIFFERS, type StudioPublishValue } from '@nexus/shared/studio-publication'
import type { PublicationFacts } from './studio-publication-plan.js'
import { ebayFullRevision, ebayLiveStock, ebayStockRevision, type EbayFullRevision, type EbayPublication } from './studio-publication-ebay.js'
import { parseEbayItemDocument, parseEbayPublicationItem } from '../channel-drift/ebay-content-compare.js'
import { prepareEbayChanges } from './studio-publication-ebay-changes.js'
import { compileSelection } from './studio-publication-selection.js'
import { publicationChangeId } from './studio-publication-changes.js'

// ── The pure Revise builder ─────────────────────────────────────────────────────────────────────────────────────────
const liveVariation = (sku: string, colour: string, quantity: number, sold: number, price = '19.00') =>
  `<Variation><SKU>${sku}</SKU><StartPrice currencyID="EUR">${price}</StartPrice><Quantity>${quantity}</Quantity><VariationSpecifics><NameValueList><Name>Colour</Name><Value>${colour}</Value></NameValueList></VariationSpecifics><SellingStatus><QuantitySold>${sold}</QuantitySold></SellingStatus></Variation>`
const getItem = (body: string, selling = '<ListingStatus>Active</ListingStatus>') => `<GetItemResponse><Ack>Success</Ack><Item><ItemID>456</ItemID><SKU>LIVE-PARENT</SKU><Title>Old</Title><SubTitle>Old subtitle</SubTitle><VATDetails><VATPercent>22</VATPercent></VATDetails>${body}<SellingStatus>${selling}</SellingStatus></Item></GetItemResponse>`
const read = (raw: string) => ({ live: parseEbayPublicationItem(raw), stock: ebayLiveStock(parseEbayItemDocument(raw)) })
const input = (variations: Array<{ sku: string; colour: string; price: number; quantity: number }>) => ({
  sku: 'PARENT', title: 'Jacket', description: '<p>Text</p>', categoryId: '123', conditionId: '1000', country: 'IT', currency: 'EUR',
  itemSpecifics: { Brand: 'Nexus' }, variationSpecificNames: ['Colour'], pictureUrls: ['https://example.test/one.jpg'],
  variations: variations.map(v => ({ sku: v.sku, price: v.price, quantity: v.quantity, specifics: { Colour: v.colour } })),
})
const multiLive = getItem(`<Variations>${liveVariation('CHILD-B', 'Black', 10, 4)}${liveVariation('CHILD-OLD', 'Red', 2, 0)}${liveVariation('CHILD-SOLD', 'Green', 3, 3, '17.50')}<VariationSpecificsSet><NameValueList><Name>Colour</Name><Value>Black</Value><Value>Red</Value><Value>Green</Value></NameValueList></VariationSpecificsSet></Variations>`)

describe('ebayFullRevision', () => {
  const revise = () => ebayFullRevision({ shared: input([{ sku: 'CHILD-B', colour: 'Black', price: 20, quantity: 7 }, { sku: 'CHILD-NEW', colour: 'Blue', price: 21, quantity: 5 }]) as any,
    settings: { subtitle: '', packageType: 'PACKAGE_THICK_ENVELOPE' }, itemId: '456', single: false, ...read(multiLive) })

  it('sends the engine\'s price and eBay\'s OWN available quantity (lifetime − sold); a new variation is added at 0', () => {
    const full = revise()
    expect(full.blockers).toEqual([])
    expect(full.xml).toMatch(/<SKU>CHILD-B<\/SKU>\s*<StartPrice>20<\/StartPrice>\s*<Quantity>6<\/Quantity>/)
    expect(full.xml).toMatch(/<SKU>CHILD-NEW<\/SKU>\s*<StartPrice>21<\/StartPrice>\s*<Quantity>0<\/Quantity>/)
    expect(full.added).toEqual(['CHILD-NEW'])
    expect(full.stockRevision).toBe(ebayStockRevision(read(multiLive).stock))
  })

  it('deletes a variation Nexus does not hold, and keeps one with sales at quantity 0 (its value stays in the set)', () => {
    const full = revise()
    expect(full.extras.map(e => [e.sku, e.action, e.specifics])).toEqual([['CHILD-OLD', 'delete', { Colour: 'Red' }], ['CHILD-SOLD', 'zero', { Colour: 'Green' }]])
    expect(full.xml).toContain('<Variation><Delete>true</Delete><SKU>CHILD-OLD</SKU><VariationSpecifics><NameValueList><Name>Colour</Name><Value>Red</Value></NameValueList></VariationSpecifics></Variation>')
    expect(full.xml).toContain('<Variation><SKU>CHILD-SOLD</SKU><StartPrice>17.50</StartPrice><Quantity>0</Quantity><VariationSpecifics><NameValueList><Name>Colour</Name><Value>Green</Value></NameValueList></VariationSpecifics></Variation>')
    const set = full.xml.slice(full.xml.indexOf('<VariationSpecificsSet>'))
    expect(set).toContain('<Value>Green</Value>'); expect(set).not.toContain('<Value>Red</Value>')
  })

  it('keeps eBay\'s seller SKU, sends the package, deletes the empty subtitle, and names what eBay keeps', () => {
    const full = revise()
    expect(full.xml).toContain('<Item><ItemID>456</ItemID>\n    <SKU>LIVE-PARENT</SKU>')
    expect(full.xml).not.toContain('<SKU>PARENT</SKU>')
    expect(full.xml).toContain('<ShippingPackageDetails><MeasurementUnit>Metric</MeasurementUnit><ShippingPackage>PackageThickEnvelope</ShippingPackage></ShippingPackageDetails>')
    expect(full.deletedFields).toEqual(['Item.SubTitle'])
    expect(full.xml).toMatch(/<DeletedField>Item\.SubTitle<\/DeletedField><Item>/)
    expect(full.xml).not.toContain('<SubTitle>')
    expect(full.keptRoots).toEqual(['VATDetails'])
    expect(full.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<ReviseFixedPriceItemRequest')).toBe(true)
  })

  it('removes every item specific with <DeletedField> when Nexus holds none', () => {
    const shared = { ...input([{ sku: 'ONE', colour: 'Black', price: 20, quantity: 1 }]), itemSpecifics: {} }
    const raw = getItem('<ItemSpecifics><NameValueList><Name>Brand</Name><Value>Old</Value></NameValueList></ItemSpecifics><Quantity>5</Quantity>', '<ListingStatus>Active</ListingStatus><QuantitySold>2</QuantitySold>')
    const full = ebayFullRevision({ shared: shared as any, settings: { subtitle: 'Kept' }, itemId: '456', single: true, ...read(raw) })
    expect(full.deletedFields).toEqual(['Item.ItemSpecifics'])
    expect(full.xml).toContain('<StartPrice>20</StartPrice><Quantity>3</Quantity>')
    expect(full.xml).toContain('<SubTitle>Kept</SubTitle>')
  })

  it('E1: a blank Condition sends no <ConditionID>; eBay keeps its condition and its Best Offer prices, and the review names both', () => {
    const raw = getItem('<ConditionID>1000</ConditionID><ListingDetails><EndTime>2026-01-01T00:00:00.000Z</EndTime><BestOfferAutoAcceptPrice currencyID="EUR">15.0</BestOfferAutoAcceptPrice></ListingDetails><Quantity>5</Quantity>',
      '<ListingStatus>Active</ListingStatus><QuantitySold>2</QuantitySold>')
    const shared = { ...input([{ sku: 'ONE', colour: 'Black', price: 20, quantity: 1 }]), conditionId: '' }
    const full = ebayFullRevision({ shared: shared as any, settings: { bestOffer: true }, itemId: '456', single: true, ...read(raw) })
    expect(full.xml).not.toContain('<ConditionID>')
    expect(full.xml).not.toContain('<ListingDetails>')
    expect(full.keptRoots).toEqual(['VATDetails', 'ConditionID', 'ListingDetails'])
  })
  it('E1: the Best Offer prices Nexus holds go in the Full update (eBay\'s own ListingDetails fields are never compared)', () => {
    const raw = getItem('<ConditionID>1000</ConditionID><ListingDetails><EndTime>2026-01-01T00:00:00.000Z</EndTime></ListingDetails><Quantity>5</Quantity>',
      '<ListingStatus>Active</ListingStatus><QuantitySold>2</QuantitySold>')
    const full = ebayFullRevision({ shared: input([{ sku: 'ONE', colour: 'Black', price: 20, quantity: 1 }]) as any,
      settings: { bestOffer: true, bestOfferFloor: 10, bestOfferCeiling: 15 }, itemId: '456', single: true, ...read(raw) })
    expect(full.xml).toContain('<ConditionID>1000</ConditionID>')
    expect(full.xml).toContain('<ListingDetails><BestOfferAutoAcceptPrice currencyID="EUR">15.00</BestOfferAutoAcceptPrice><MinimumBestOfferPrice currencyID="EUR">10.00</MinimumBestOfferPrice></ListingDetails>')
    expect(full.keptRoots).toEqual(['VATDetails'])
  })

  it.each([
    ['one product here, variations on eBay', true, multiLive],
    ['variations here, one product on eBay', false, getItem('<Quantity>5</Quantity>')],
    ['the variation names differ', false, multiLive.replace(/<Name>Colour<\/Name>/g, '<Name>Size</Name>')],
  ])('blocks when %s: the listing\'s shape cannot change by a Full update', (_, single, raw) => {
    const full = ebayFullRevision({ shared: input([{ sku: 'CHILD-B', colour: 'Black', price: 20, quantity: 7 }]) as any, settings: {}, itemId: '456', single, ...read(raw) })
    expect(full.blockers).toContain(FULL_EBAY_SHAPE_DIFFERS)
  })

  it('blocks when eBay holds a variation without a seller SKU', () => {
    const raw = multiLive.replace('<SKU>CHILD-OLD</SKU>', '')
    expect(ebayFullRevision({ shared: input([{ sku: 'CHILD-B', colour: 'Black', price: 20, quantity: 7 }]) as any, settings: {}, itemId: '456', single: false, ...read(raw) }).blockers)
      .toContain('eBay holds a variation without a seller SKU, so a Full update cannot tell it apart. Use Partial update, or set its SKU on eBay.')
  })

  it('the stock revision moves with a sale, not with the lifetime quantity alone', () => {
    const before = ebayStockRevision(read(multiLive).stock)
    expect(ebayStockRevision(read(multiLive.replace('<QuantitySold>4</QuantitySold>', '<QuantitySold>5</QuantitySold>')).stock)).not.toBe(before)
    expect(ebayStockRevision(read(multiLive.replace('<Quantity>10</Quantity>', '<Quantity>11</Quantity>').replace('<QuantitySold>4</QuantitySold>', '<QuantitySold>5</QuantitySold>')).stock)).toBe(before)
  })
})

// ── The review: every field ticked and locked, the whole Revise or nothing ──────────────────────────────────────────
const specificsXml = (aspects: Record<string, string>) => `<ItemSpecifics>${Object.entries(aspects).map(([name, value]) => `<NameValueList><Name>${name}</Name><Value>${value}</Value></NameValueList>`).join('')}</ItemSpecifics>`
const variation = (sku: string, colour = 'Black') => `<Variation><SKU>${sku}</SKU><StartPrice>20</StartPrice><Quantity>3</Quantity><VariationSpecifics><NameValueList><Name>Colour</Name><Value>${colour}</Value></NameValueList></VariationSpecifics></Variation>`
const item = (title: string, aspects: Record<string, string>) => `<Item><ItemID>456</ItemID><SKU>PARENT</SKU><Title>${title}</Title><Description><![CDATA[<p>Same description</p>]]></Description>${specificsXml(aspects)}<PictureDetails><PictureURL>https://example.test/one.jpg</PictureURL></PictureDetails><PrimaryCategory><CategoryID>123</CategoryID></PrimaryCategory><Variations>${variation('CHILD')}<VariationSpecificsSet><NameValueList><Name>Colour</Name><Value>Black</Value></NameValueList></VariationSpecificsSet></Variations></Item>`
const request = (body: string) => `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${body}</ReviseFixedPriceItemRequest>`
const facts = () => ({
  scope: { channel: 'EBAY', marketplace: 'IT', accountId: 'account' }, destination: { aliasKey: '' }, parent: { id: 'parent' },
  products: [{ id: 'parent', sku: 'PARENT' }, { id: 'child', sku: 'CHILD' }],
  listings: ['parent', 'child'].map(productId => ({ id: `${productId}-listing`, productId, externalListingId: '456', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '' })),
  resolved: [{ products: [{ productId: 'parent', cells: { conditionId: { label: 'Condition', value: '1000' } } }, { productId: 'child', cells: {} }], catalogue: { fields: [] } }],
}) as unknown as PublicationFacts
const fullRevision = (over: Partial<EbayFullRevision> = {}): EbayFullRevision => ({ xml: request(item('New title', { Brand: 'Nexus' })), stockRevision: 'stock', added: [],
  extras: [{ sku: 'OLD', action: 'delete', specifics: { Colour: 'Red' }, content: parseEbayItemDocument(`<Item>${variation('OLD', 'Red')}</Item>`).Variation }],
  deletedFields: [], keptRoots: ['VATDetails'], blockers: [], ...over })
const publication = (full: EbayFullRevision | undefined = fullRevision(), live = true): EbayPublication => ({
  kind: 'ebay', marketplace: 'IT', itemId: '456', liveRevision: live ? 'live-revision' : null, products: [{ productId: 'parent', sku: 'PARENT' }, { productId: 'child', sku: 'CHILD' }],
  xml: request(item('New title', { Brand: 'Nexus' })), ...(full ? { full } : {}),
  liveContent: live ? parseEbayItemDocument(item('Old title', { Brand: 'Nexus', Fit: 'Slim' })) : null, ...(live ? {} : { liveReadError: 'timeout' }),
})
const baseline = () => new Map<string, StudioPublishValue>([[publicationChangeId('parent', 'title'), { state: 'value', value: 'Old title' }]])

describe('the eBay Full update review', () => {
  it('ticks and locks every field the Revise sends — structure, variations and unchanged fields included', async () => {
    const plan = await prepareEbayChanges(facts(), publication(), baseline(), { full: true })
    expect(plan.full).toBe(true)
    const byField = Object.fromEntries(plan.changes.map(c => [c.field, c]))
    for (const field of ['SKU', 'title', 'description', 'pictures', 'aspect:brand', 'aspect:fit', 'PrimaryCategory', 'VariationSpecificsSet', 'variation', 'variation:OLD'])
      expect(byField[field], field).toMatchObject({ selectable: true, selectedByDefault: true, locked: true })
    expect(byField.description.reason).toBe('Full update sends it again (it already matches the channel).')
    expect(byField['content:conditionId']).toMatchObject({ selectable: false, reason: 'Condition: no eBay field of its own here; a Full update sends the eBay fields above.' })
    expect(plan.products.map(p => p.productId)).toEqual(['parent', 'child'])
  })

  it('lists what eBay holds that Nexus does not: an aspect, and a variation', async () => {
    const plan = await prepareEbayChanges(facts(), publication(), baseline(), { full: true })
    expect(plan.removals).toEqual([
      { productId: 'parent', sku: 'PARENT', field: 'aspect:fit', label: 'Fit', value: ['Slim'] },
      { productId: 'parent', sku: 'OLD', field: 'variation', label: 'Variation removed from the listing', value: { Colour: 'Red' } },
    ])
    expect(plan.fullIssues).toEqual([expect.objectContaining({ severity: 'warning', message: 'PARENT: Full update leaves this field as eBay holds it: VATDetails.' })])
  })

  it('sends the whole Revise for the default ticks, records every field, and refuses a partial tick', async () => {
    const plan = await prepareEbayChanges(facts(), publication(), baseline(), { full: true })
    const ticks = plan.changes.filter(c => c.selectedByDefault).map(c => c.id)
    const { selection, prepared } = compileSelection(JSON.parse(JSON.stringify(plan)), ticks, 'review-full')
    expect(selection.payload.content).toBe(request(item('New title', { Brand: 'Nexus' })).replace('<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">',
      '<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><InvocationID>REVIEWFULL</InvocationID>'))
    expect((prepared as any).fieldWrites.parent).toContainEqual({ field: 'aspect:fit', value: { state: 'absent' } })
    expect((prepared as any).full.stockRevision).toBe('stock')
    expect(() => compileSelection(plan, ticks.slice(1), 'review-full')).toThrow(/Tick all of them/)
    expect(compileSelection(plan, [], 'review-full').prepared).toBeNull()
  })

  it.each([
    ['no live read', publication(undefined, false), 'PARENT: eBay could not be read just now, so a Full update cannot be checked (timeout). Review again, or use Partial update.'],
    ['a shape eBay holds differently', publication(fullRevision({ blockers: [FULL_EBAY_SHAPE_DIFFERS] })), `PARENT: ${FULL_EBAY_SHAPE_DIFFERS}`],
    ['an empty title', publication(fullRevision({ xml: request(item('', { Brand: 'Nexus' })) })), 'PARENT: Full update cannot be sent: A title is required; it cannot be cleared.'],
  ])('%s blocks the Full update by name', async (_, source, message) => {
    const plan = await prepareEbayChanges(facts(), source, baseline(), { full: true })
    expect(plan.fullIssues).toContainEqual(expect.objectContaining({ severity: 'error', message }))
  })

  it('a blocked Revise cannot be compiled even with every tick', async () => {
    const plan = await prepareEbayChanges(facts(), publication(fullRevision({ blockers: ['eBay did not return this listing\'s quantity, so a Full update cannot keep it. Review again.'] })), baseline(), { full: true })
    expect(() => compileSelection(plan, plan.changes.filter(c => c.locked).map(c => c.id), 'review')).toThrow('This Full update cannot be sent. Review again.')
  })
})
