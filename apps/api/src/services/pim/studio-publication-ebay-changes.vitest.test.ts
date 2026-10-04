import { expect, it } from 'vitest'
import type { StudioPublishValue } from '@nexus/shared/studio-publication'
import type { PublicationFacts } from './studio-publication-plan.js'
import type { EbayPublication } from './studio-publication-ebay.js'
import { parseEbayItemDocument, parseEbayPublicationItem } from '../channel-drift/ebay-content-compare.js'
import { compileEbayChanges, ebayPublicationRequest, prepareEbayChanges } from './studio-publication-ebay-changes.js'
import { publicationChangeId } from './studio-publication-changes.js'

const value = (value: unknown): StudioPublishValue => ({ state: 'value', value })
const baseline = () => new Map<string, StudioPublishValue>([
  [publicationChangeId('parent', 'title'), value('Old title')],
  [publicationChangeId('parent', 'aspect:material'), value(['Cotton'])],
])
const specifics = (material: string | null, brand = 'Nexus brand') => `<ItemSpecifics>${material == null ? '' : `<NameValueList><Name>Material</Name><Value>${material}</Value></NameValueList>`}<NameValueList><Name>Brand</Name><Value>${brand}</Value></NameValueList></ItemSpecifics>`
const variation = (sku: string, colour = 'Black', price = 20, quantity = 3) => `<Variation><SKU>${sku}</SKU><StartPrice>${price}</StartPrice><Quantity>${quantity}</Quantity><VariationSpecifics><NameValueList><Name>Colour</Name><Value>${colour}</Value></NameValueList></VariationSpecifics><VariationProductListingDetails><EAN>123</EAN></VariationProductListingDetails></Variation>`
const item = (title: string, material: string | null, brand: string, variants = variation('CHILD')) => `<Item><ItemID>456</ItemID><SKU>PARENT</SKU><Title>${title}</Title><Description><![CDATA[<p>Same description</p>]]></Description>${specifics(material, brand)}<PictureDetails><PictureURL>https://example.test/one.jpg</PictureURL></PictureDetails><PrimaryCategory><CategoryID>123</CategoryID></PrimaryCategory><SellerProfiles><SellerShippingProfile><ShippingProfileID>policy</ShippingProfileID></SellerShippingProfile></SellerProfiles><Variations>${variants}<VariationSpecificsSet><NameValueList><Name>Colour</Name><Value>Black</Value></NameValueList></VariationSpecificsSet></Variations></Item>`
const facts = () => ({
  scope: { channel: 'EBAY', marketplace: 'IT', accountId: 'account' }, destination: { aliasKey: 'alias' }, parent: { id: 'parent' },
  products: [{ id: 'parent', sku: 'PARENT' }, { id: 'child', sku: 'CHILD' }],
  listings: ['parent', 'child'].map(productId => ({ id: `${productId}-listing`, productId, externalListingId: '456', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account', aliasKey: 'alias' })),
  resolved: [{ products: [{ productId: 'parent', cells: {} }, { productId: 'child', cells: {} }], catalogue: { fields: [] } }],
}) as unknown as PublicationFacts
const publication = (xml = item('New title', 'Linen', 'Nexus brand')): EbayPublication => ({
  kind: 'ebay', marketplace: 'IT', itemId: '456', liveRevision: 'live-revision', xml: `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${xml}</ReviseFixedPriceItemRequest>`,
  products: [{ productId: 'parent', sku: 'PARENT' }, { productId: 'child', sku: 'CHILD' }],
  liveContent: parseEbayItemDocument(item('Old title', 'Cotton', 'Channel-only brand', variation('CHILD', 'Black', 99, 8))),
})
const select = (plan: Awaited<ReturnType<typeof prepareEbayChanges>>, ...fields: string[]) => plan.changes.filter(change => fields.includes(change.field)).map(change => change.id)
function authoredAspectClear(input: PublicationFacts, name: string, required = false) {
  const fieldKey = `clear-${name}`
  input.resolved[0].catalogue!.fields.push({ fieldKey, channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', name] } } as any)
  input.resolved[0].products[0].cells[fieldKey] = { value: null, status: 'mapped', provenance: 'override', errors: [], needsTranslation: false, required } as any
}

it('sends one selected title without any unchanged content, price, quantity or Variation', async () => {
  const plan = await prepareEbayChanges(facts(), publication(), baseline())
  const title = plan.changes.find(change => change.field === 'title')!
  expect(title).toMatchObject({ status: 'SEND', selectedByDefault: true, productId: 'parent' })
  const result = compileEbayChanges(JSON.parse(JSON.stringify(plan)), [title.id])
  expect(result.xml).toContain('<Title>New title</Title>')
  expect(result.xml).toContain('<ItemID>456</ItemID>')
  for (const field of ['Description', 'ItemSpecifics', 'PictureDetails', 'StartPrice', 'Quantity', 'Variation', 'PrimaryCategory', 'SellerProfiles']) expect(result.xml).not.toContain(`<${field}>`)
  expect(result.fieldWrites).toEqual({ parent: [{ field: 'title', value: value('New title') }] })
  expect(result.liveRevision).toBe('live-revision')
})

it('preserves a required live SKU identifier without adopting it as an intentional SKU write', async () => {
  const source = publication()
  source.liveContent!.InventoryTrackingMethod = 'SKU'
  source.liveContent!.SKU = 'LIVE-SKU'
  const plan = await prepareEbayChanges(facts(), source, baseline())
  expect(plan.changes.find(change => change.field === 'SKU')).toMatchObject({ selectable: false, status: 'DIFFERS' })
  const result = compileEbayChanges(plan, select(plan, 'title'))
  expect(result.xml).toContain('<SKU>LIVE-SKU</SKU>')
  expect(result.fieldWrites.parent.map(write => write.field)).toEqual(['title'])
})

it('retains GetItem tracking mode in the real stable projection used by preparation and compilation', async () => {
  const raw = `<GetItemResponse><Timestamp>2026-09-25T01:00:00Z</Timestamp><Ack>Success</Ack>${item('Old title', 'Cotton', 'Channel brand')
    .replace('<SKU>PARENT</SKU>', '<SKU>LIVE-SKU</SKU><InventoryTrackingMethod>SKU</InventoryTrackingMethod>')
    .replace('</Item>', '<SellingStatus><ListingStatus>Active</ListingStatus><QuantitySold>1</QuantitySold></SellingStatus></Item>')}</GetItemResponse>`
  const source = publication(); source.liveContent = parseEbayPublicationItem(raw)
  expect(source.liveContent).toMatchObject({ SKU: 'LIVE-SKU', InventoryTrackingMethod: 'SKU' })
  expect(parseEbayPublicationItem(raw.replace('01:00:00Z', '02:00:00Z').replace('<QuantitySold>1</QuantitySold>', '<QuantitySold>2</QuantitySold>'))).toEqual(source.liveContent)
  expect(parseEbayPublicationItem(raw.replace('<InventoryTrackingMethod>SKU</InventoryTrackingMethod>', '<InventoryTrackingMethod>ItemID</InventoryTrackingMethod>'))).not.toEqual(source.liveContent)
  const plan = await prepareEbayChanges(facts(), source, baseline())
  expect(compileEbayChanges(plan, select(plan, 'title')).xml).toContain('<SKU>LIVE-SKU</SKU>')
})

it('uses provider title/aspect normalizers but keeps exact intentional values', async () => {
  const source = publication(item(' Old  title ', '  Cotton ', 'Channel-only brand'))
  const plan = await prepareEbayChanges(facts(), source, new Map())
  expect(plan.changes.find(change => change.field === 'title')).toMatchObject({ status: 'SAME', selectable: false })
  expect(plan.changes.find(change => change.field === 'aspect:material')).toMatchObject({ status: 'SAME', selectable: false })
})

it('merges a selected aspect with live unselected siblings and records only that intent', async () => {
  const plan = await prepareEbayChanges(facts(), publication(), baseline())
  const result = compileEbayChanges(plan, select(plan, 'aspect:material'))
  expect(result.xml).toContain('<Name>Material</Name><Value>Linen</Value>')
  expect(result.xml).toContain('<Name>Brand</Name><Value>Channel-only brand</Value>')
  expect(result.xml).not.toContain('Nexus brand')
  expect(result.xml).not.toContain('<Title>')
  expect(result.fieldWrites).toEqual({ parent: [{ field: 'aspect:material', value: value(['Linen']) }] })
})

it('serializes the same exact XML after JSONB reorders every object while preserving gallery sequence', async () => {
  const reverseKeys = (value: any): any => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, value]) => [key, reverseKeys(value)])) : value
  const source = publication()
  ;(source.liveContent!.ItemSpecifics as any).NameValueList.push({ Name: 'Season', Value: ['Winter', 'Summer'] })
  const plan = await prepareEbayChanges(facts(), source, baseline())
  const ids = select(plan, 'aspect:material')
  expect(compileEbayChanges(reverseKeys(JSON.parse(JSON.stringify(plan))), ids).xml).toBe(compileEbayChanges(plan, ids).xml)
})

it('refuses a required aspect clear even when its previous value is known', async () => {
  const input = facts()
  authoredAspectClear(input, 'Material', true)
  const plan = await prepareEbayChanges(input, publication(item('New title', null, 'Nexus brand')), baseline())
  expect(plan.changes.find(change => change.field === 'aspect:material')).toMatchObject({ operation: 'delete', selectable: false, reason: expect.stringContaining('required') })
})

it('shows unsupported clears and unsupported values absent from the old XML builder as named refusals', async () => {
  const input = facts(), accepted = baseline(), source = publication()
  accepted.set(publicationChangeId('parent', 'SubTitle'), value('Old subtitle'))
  accepted.set(publicationChangeId('parent', 'content:videoId'), value('old-video'))
  source.liveContent!.SubTitle = 'Old subtitle'
  input.resolved[0].products[0].cells = { videoId: { value: null, label: 'Video' }, regulatory: { value: { country: 'IT' }, label: 'Regulatory information' } } as any
  const plan = await prepareEbayChanges(input, source, accepted)
  for (const field of ['SubTitle', 'content:videoId', 'content:regulatory']) {
    const change = plan.changes.find(change => change.field === field)!
    expect(change).toMatchObject({ selectable: false, selectedByDefault: false })
    expect(change.reason).toContain('unsupported')
  }
})

it('deletes one optional aspect without deleting siblings, and uses DeletedField for an empty set', async () => {
  const input = facts(); authoredAspectClear(input, 'Material')
  const source = publication(item('New title', null, 'Nexus brand'))
  const plan = await prepareEbayChanges(input, source, baseline())
  expect(plan.changes.find(change => change.field === 'aspect:material')).toMatchObject({ operation: 'delete', selectable: true })
  const one = compileEbayChanges(plan, select(plan, 'aspect:material'))
  expect(one.xml).not.toContain('<Name>Material</Name>')
  expect(one.xml).toContain('Channel-only brand')
  expect(one.fieldWrites.parent).toEqual([{ field: 'aspect:material', value: { state: 'absent' } }])
  const bothBaseline = baseline(); bothBaseline.set(publicationChangeId('parent', 'aspect:brand'), value(['Channel-only brand']))
  const empty = publication(item('New title', null, 'Nexus brand').replace(/<ItemSpecifics>[\s\S]*?<\/ItemSpecifics>/, ''))
  authoredAspectClear(input, 'Brand')
  const emptyPlan = await prepareEbayChanges(input, empty, bothBaseline)
  const all = compileEbayChanges(emptyPlan, select(emptyPlan, 'aspect:material', 'aspect:brand'))
  expect(all.xml).toContain('<DeletedField>Item.ItemSpecifics</DeletedField>')
  expect(all.xml).not.toContain('<ItemSpecifics>')
})

it('does not infer an aspect deletion from an omitted previously accepted value', async () => {
  const plan = await prepareEbayChanges(facts(), publication(item('New title', null, 'Nexus brand')), baseline())
  expect(plan.changes.find(change => change.field === 'aspect:material')).toMatchObject({ current: { state: 'unknown' }, status: 'CANNOT_COMPARE', operation: null, selectable: false })
  expect(compileEbayChanges(plan, select(plan, 'title')).xml).not.toContain('ItemSpecifics')
})

it('offers a first-publish explicit optional aspect clear, ticked (Nexus wins, Owner 2026-10-04) with its removal warning', async () => {
  const input = facts(); authoredAspectClear(input, 'Material')
  const plan = await prepareEbayChanges(input, publication(item('New title', null, 'Nexus brand')), new Map())
  expect(plan.changes.find(change => change.field === 'aspect:material')).toMatchObject({ current: { state: 'absent' }, status: 'DIFFERS', operation: 'delete', selectable: true, selectedByDefault: true,
    replaces: { kind: 'removes', channel: 'Cotton', nexus: null, sentence: 'eBay has Cotton — Publish removes it.', note: null } })
  expect(compileEbayChanges(plan, select(plan, 'aspect:material')).xml).not.toContain('<Name>Material</Name>')
})

it.each([{ provenance: null }, { provenance: 'default' }, { provenance: 'catalogRule' }, { status: 'unmapped' }, { errors: ['Unresolved mapping'] }, { needsTranslation: true }])('does not treat an unauthored or invalid empty resolver cell as an aspect clear (%j)', async patch => {
  const input = facts(); authoredAspectClear(input, 'Material')
  Object.assign(input.resolved[0].products[0].cells['clear-Material'], patch)
  const plan = await prepareEbayChanges(input, publication(item('New title', null, 'Nexus brand')), baseline())
  expect(plan.changes.find(change => change.field === 'aspect:material')).toMatchObject({ current: { state: 'unknown' }, selectable: false, operation: null })
})

it('does not use a blank field from another store path to authorize an aspect deletion', async () => {
  const input = facts(); authoredAspectClear(input, 'Material')
  input.resolved[0].catalogue!.fields[0].channelStore = { kind: 'platformAttributes', path: ['unrelated', 'Material'] }
  const plan = await prepareEbayChanges(input, publication(item('New title', null, 'Nexus brand')), baseline())
  expect(plan.changes.find(change => change.field === 'aspect:material')).toMatchObject({ current: { state: 'unknown' }, selectable: false })
})

it('refuses blank title, description and an empty gallery rather than hiding a clear', async () => {
  const source = publication(item('', 'Linen', 'Nexus brand').replace('<![CDATA[<p>Same description</p>]]>', '').replace(/<PictureDetails>[\s\S]*?<\/PictureDetails>/, ''))
  const accepted = baseline(); accepted.set(publicationChangeId('parent', 'description'), value('<p>Same description</p>')); accepted.set(publicationChangeId('parent', 'pictures'), value(['https://example.test/one.jpg']))
  const plan = await prepareEbayChanges(facts(), source, accepted)
  for (const field of ['title', 'description', 'pictures']) {
    const change = plan.changes.find(change => change.field === field)!
    expect(change).toMatchObject({ selectable: false, selectedByDefault: false })
    expect(change.reason).toMatch(/clear|empty|required/i)
    expect(() => compileEbayChanges(plan, [change.id])).toThrow()
  }
})

it('replaces a selected gallery without Variation nodes or unrelated content', async () => {
  const plan = await prepareEbayChanges(facts(), publication(item('New title', 'Linen', 'Nexus brand').replace('one.jpg', 'two.jpg')), new Map())
  const result = compileEbayChanges(plan, select(plan, 'pictures'))
  expect(result.xml).toContain('<PictureDetails><PictureURL>https://example.test/two.jpg</PictureURL></PictureDetails>')
  expect(result.xml).not.toContain('<Variations>')
  expect(result.fieldWrites.parent).toEqual([{ field: 'pictures', value: value(['https://example.test/two.jpg']) }])
})

it('names refused existing variation, category, policy and theme changes; stock/price do not enter content choices', async () => {
  const source = publication(item('New title', 'Linen', 'Nexus brand', variation('CHILD', 'Blue')).replace('<CategoryID>123</CategoryID>', '<CategoryID>999</CategoryID>').replace('<ShippingProfileID>policy</ShippingProfileID>', '<ShippingProfileID>new-policy</ShippingProfileID>').replace('<Value>Black</Value></NameValueList></VariationSpecificsSet>', '<Value>Blue</Value></NameValueList></VariationSpecificsSet>'))
  const plan = await prepareEbayChanges(facts(), source, new Map())
  for (const field of ['variation', 'PrimaryCategory', 'SellerProfiles', 'VariationSpecificsSet']) {
    const change = plan.changes.find(change => change.field === field)!
    expect(change).toMatchObject({ selectable: false, selectedByDefault: false, status: 'DIFFERS' })
    expect(change.reason).toMatch(/unsupported|price|quantity|structure/i)
  }
  expect(plan.changes.some(change => /^(price|quantity|StartPrice|Quantity)$/.test(change.field))).toBe(false)
})

it('refuses unsent new children and keeps them out of the returned participants', async () => {
  const input = facts(); input.products.push({ id: 'new-child', sku: 'NEW' } as any)
  const source = publication(item('New title', 'Linen', 'Nexus brand', variation('CHILD') + variation('NEW')))
  source.products!.push({ productId: 'new-child', sku: 'NEW' })
  const plan = await prepareEbayChanges(input, source, baseline())
  expect(plan.changes.find(change => change.productId === 'new-child')).toMatchObject({ selectable: false, selectedByDefault: false })
  expect(compileEbayChanges(plan, select(plan, 'title')).products.map(product => product.productId)).toEqual(['parent', 'child'])
})

it('does not adopt a locally linked child whose SKU is absent from the live item', async () => {
  const input = facts(); input.products.push({ id: 'new-child', sku: 'NEW' } as any)
  input.listings.push({ ...input.listings[0], id: 'new-listing', productId: 'new-child' })
  const source = publication(item('New title', 'Linen', 'Nexus brand', variation('CHILD') + variation('NEW')))
  source.products.push({ productId: 'new-child', sku: 'NEW' })
  const plan = await prepareEbayChanges(input, source, baseline())
  expect(compileEbayChanges(plan, select(plan, 'title')).products.map(product => product.productId)).toEqual(['parent', 'child'])
})

it('sends a selected variation picture collection without modifying any Variation or its stock', async () => {
  const pictureSet = '<Pictures><VariationSpecificName>Colour</VariationSpecificName><VariationSpecificPictureSet><VariationSpecificValue>Black</VariationSpecificValue><PictureURL>https://example.test/black-two.jpg</PictureURL></VariationSpecificPictureSet></Pictures>'
  const source = publication(item('New title', 'Linen', 'Nexus brand').replace('</Variations>', `${pictureSet}</Variations>`))
  const plan = await prepareEbayChanges(facts(), source, baseline())
  const result = compileEbayChanges(plan, select(plan, 'Pictures'))
  expect(result.xml).toContain(`<Variations>${pictureSet}</Variations>`)
  expect(result.xml).not.toContain('<Variation>')
  expect(result.xml).not.toContain('<Quantity>')
  expect(result.xml).not.toContain('<StartPrice>')
  expect(result.fieldWrites.parent.map(write => write.field)).toEqual(['Pictures'])
})

it('keeps failed live reads unknown and refuses to assemble a blind replacement collection', async () => {
  const source = publication(); source.liveContent = null; source.liveRevision = null; source.liveReadError = 'GetItem timed out'
  const plan = await prepareEbayChanges(facts(), source, baseline())
  expect(plan.changes.every(change => change.status === 'CANNOT_COMPARE' && !change.selectable)).toBe(true)
  expect(plan.changes[0].reason).toContain('GetItem timed out')
})

it('treats a new listing as one atomic full create and an empty selection as no send', async () => {
  const source = publication(); source.itemId = null; source.liveContent = null; source.liveRevision = null
  source.xml = source.xml.replace(/ReviseFixedPriceItemRequest/g, 'AddFixedPriceItemRequest')
  const plan = await prepareEbayChanges(facts(), source, new Map())
  expect(plan.changes).toHaveLength(1)
  expect(plan.changes[0]).toMatchObject({ field: '__create__', selectedByDefault: true })
  expect(compileEbayChanges(plan, [plan.changes[0].id]).xml).toBe(source.xml)
  expect(compileEbayChanges(plan, []).products).toEqual([])
  expect(compileEbayChanges(plan, []).xml).toBe('')
})

it('does not claim that an unsupported child field was sent by atomic creation', async () => {
  const input = facts(), source = publication()
  input.resolved[0].products[1].cells = { title: { value: 'A child-only title that is not in the eBay request' } } as any
  source.itemId = null; source.liveContent = null; source.liveRevision = null
  source.xml = source.xml.replace(/ReviseFixedPriceItemRequest/g, 'AddFixedPriceItemRequest')
  const plan = await prepareEbayChanges(input, source, new Map())
  const compiled = compileEbayChanges(plan, select(plan, '__create__'))
  expect(Object.values(compiled.fieldWrites).flat().some(write => write.field.startsWith('content:'))).toBe(false)
})

it('does not record an omitted empty aspect as a deletion sent by atomic creation', async () => {
  const input = facts(); authoredAspectClear(input, 'Material')
  const source = publication(item('New title', null, 'Nexus brand'))
  source.itemId = null; source.liveContent = null; source.liveRevision = null
  source.xml = source.xml.replace(/ReviseFixedPriceItemRequest/g, 'AddFixedPriceItemRequest')
  const plan = await prepareEbayChanges(input, source, new Map())
  const compiled = compileEbayChanges(plan, select(plan, '__create__'))
  expect(Object.values(compiled.fieldWrites).flat().some(write => write.field === 'aspect:material')).toBe(false)
})

it('puts revise InvocationID at request level and create UUID inside Item, using the same final builder', () => {
  const id = '01234567-89ab-cdef-0123-456789abcdef'
  const revise = ebayPublicationRequest(publication(), id)
  expect(revise.operation).toBe('ReviseFixedPriceItem')
  expect(revise.xml).toContain('<InvocationID>0123456789ABCDEF0123456789ABCDEF</InvocationID>')
  expect(revise.xml.match(/<Item>[\s\S]*?<\/Item>/)?.[0]).not.toContain('<InvocationID>')
  const add = publication(); add.itemId = null; add.xml = add.xml.replace(/ReviseFixedPriceItemRequest/g, 'AddFixedPriceItemRequest')
  expect(ebayPublicationRequest(add, id).xml).toContain('<Item><UUID>0123456789ABCDEF0123456789ABCDEF</UUID>')
})
