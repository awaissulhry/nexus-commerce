/**
 * One-click "Nexus wins" (Owner 2026-10-04) — every selectable DIFFERS line now starts ticked, so a value that never
 * stops differing would be resent on every Publish. 🔴 THE GOLDEN SAFETY TEST: a listing that is the same on both sides
 * (text, item specifics, Amazon images, eBay pictures) gives ZERO DIFFERS lines and ZERO default ticks — with an accepted
 * publish record and without one (an imported listing never published from Nexus) — so its Publish sends nothing.
 * Pure: Amazon's and eBay's reads are fixtures; nothing is sent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StudioPublishChange, StudioPublishValue } from '@nexus/shared/studio-publication'
import type { PublicationFacts } from './studio-publication-plan.js'
import type { AmazonPublication } from './studio-publication-amazon.js'
import type { EbayPublication } from './studio-publication-ebay.js'
const m = vi.hoisted(() => ({ read: vi.fn(), spec: vi.fn() }))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({ AmazonSpApiClient: class { getListingsItem = m.read } }))
vi.mock('../../lib/amazon-sp-client.js', () => ({ getAmazonRegion: async () => 'eu' }))
vi.mock('./channel-specs/index.js', async importOriginal => ({ ...(await importOriginal<object>()), loadAmazonSpec: m.spec }))
import { amazonSpecFromDefinition } from './channel-specs/amazon.js'
import { planPublicationChanges, publicationChangeId } from './studio-publication-changes.js'
import { AMAZON_PHOTO_COPY, compileAmazonChanges, prepareAmazonChanges } from './studio-publication-amazon-changes.js'
import { EBAY_PHOTO_COPY, prepareEbayChanges } from './studio-publication-ebay-changes.js'
import { prepareEbayInventoryChanges, type EbayInventoryOurs } from './studio-publication-ebay-inventory-changes.js'
import { blockRowChanges, compileSelection } from './studio-publication-selection.js'
import { parseEbayItemDocument } from '../channel-drift/ebay-content-compare.js'
import type { ServerLiveRead } from '../live-read/types.js'
import type { EbayInventoryRaw } from '../live-read/ebay-inventory.js'

const differs = (changes: StudioPublishChange[]) => changes.filter(c => c.status === 'DIFFERS').map(c => c.field)
const ticked = (changes: StudioPublishChange[]) => changes.filter(c => c.selectedByDefault).map(c => c.field)

// ── Amazon ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const textSchema = (language = false) => ({ type: 'array', selectors: ['marketplace_id', ...(language ? ['language_tag'] : [])], items: { type: 'object', properties: {
  marketplace_id: { const: 'MARKET' }, ...(language ? { language_tag: { enum: ['de_DE', 'en_GB'], default: 'de_DE' } } : {}), value: { type: 'string' } } } })
const imageSchema = () => ({ type: 'array', selectors: ['marketplace_id'], items: { type: 'object', properties: { marketplace_id: { const: 'MARKET' }, media_location: { type: 'string' } } } })
const priceSchema = () => ({ type: 'array', selectors: ['marketplace_id'], items: { type: 'object', properties: { marketplace_id: { const: 'MARKET' }, currency: { type: 'string' }, value_with_tax: { type: 'number' } } } })
const schema = () => amazonSpecFromDefinition({ marketplace: 'DE', productType: 'COAT', schemaDefinition: { properties: {
  item_name: textSchema(true), product_description: textSchema(true), bullet_point: textSchema(true), brand: textSchema(), color: textSchema(),
  main_product_image_locator: imageSchema(), other_product_image_locator_1: imageSchema(), other_product_image_locator_2: imageSchema(), image_locator_ps01: imageSchema(),
  list_price: priceSchema(),
} } })
const text = (value: string, language_tag?: string) => [{ value, marketplace_id: 'MARKET', ...(language_tag ? { language_tag } : {}) }]
const image = (url: string) => [{ marketplace_id: 'MARKET', media_location: url }]
/** What Nexus sends for an unchanged coat: text in one language, three Amazon images, the RRP. */
const nexusAttributes = () => ({
  item_name: text('Giacca in pelle', 'de_DE'), product_description: text('<p>Morbida, <b>calda</b></p>', 'de_DE'),
  bullet_point: [...text('Pelle vera', 'de_DE'), ...text('Fodera in cotone', 'de_DE')], brand: text('Xavia'), color: text('Nero'),
  main_product_image_locator: image('https://images.example.test/coat-main.jpg'), other_product_image_locator_1: image('https://images.example.test/coat-2.jpg'),
  other_product_image_locator_2: image('https://images.example.test/coat-3.jpg'), list_price: [{ marketplace_id: 'MARKET', currency: 'EUR', value_with_tax: 199 }],
})
/** Amazon's read of the same listing: the same values, its own key order, spacing and a decomposed accent. */
const amazonAttributes = () => ({
  list_price: [{ value_with_tax: 199, currency: 'EUR', marketplace_id: 'MARKET' }],
  other_product_image_locator_2: [{ media_location: 'https://images.example.test/coat-3.jpg', marketplace_id: 'MARKET' }],
  main_product_image_locator: [{ media_location: 'https://images.example.test/coat-main.jpg', marketplace_id: 'MARKET' }],
  other_product_image_locator_1: [{ media_location: 'https://images.example.test/coat-2.jpg', marketplace_id: 'MARKET' }],
  item_name: [{ language_tag: 'de_DE', marketplace_id: 'MARKET', value: 'Giacca  in pelle ' }], product_description: text('<p>Morbida, <b>calda</b></p>', 'de_DE'),
  bullet_point: [...text('Pelle vera', 'de_DE'), ...text('Fodera in cotone', 'de_DE')], brand: text('Xavia'), color: text('Nero'),
})
const amazonFacts = () => ({ scope: { channel: 'AMAZON', marketplace: 'DE', accountId: 'account' }, destination: { aliasKey: '' },
  parent: { id: 'coat', sku: 'COAT' }, products: [{ id: 'coat', sku: 'COAT' }], languages: ['de'],
  listings: [{ id: 'listing-coat', productId: 'coat', externalListingId: 'ASIN-COAT' }] }) as unknown as PublicationFacts
const amazonPublication = (): AmazonPublication => ({ kind: 'amazon', sellerId: 'SELLER', marketplaceId: 'MARKET', products: [{ productId: 'coat', sku: 'SELLER-COAT' }],
  feed: { header: { sellerId: 'SELLER', version: '2.0' }, messages: [{ messageId: 1, sku: 'SELLER-COAT', operationType: 'PARTIAL_UPDATE', productType: 'COAT', attributes: nexusAttributes() }] } })
/** The accepted record of the last publish: exactly what Nexus sent (content per language, other roots whole). */
const acceptedAmazon = () => new Map<string, StudioPublishValue>(Object.entries(nexusAttributes()).map(([root, value]) => [
  publicationChangeId('coat', ['item_name', 'product_description', 'bullet_point'].includes(root) ? `${root}:${JSON.stringify(['MARKET', 'de_DE'])}` : root),
  { state: 'value', value }]))

beforeEach(() => {
  vi.clearAllMocks(); m.spec.mockResolvedValue(schema())
  m.read.mockResolvedValue({ success: true, rawResponse: { attributes: amazonAttributes(), summaries: [{ marketplaceId: 'MARKET', productType: 'COAT' }] } })
})

describe('🔴 golden safety: an unchanged listing gives zero DIFFERS lines, so nothing is resent on every Publish', () => {
  it.each([['with an accepted publish record', acceptedAmazon], ['never published from Nexus (imported)', () => new Map<string, StudioPublishValue>()]])(
    'Amazon, images and RRP included (%s)', async (_name, accepted) => {
      const plan = await prepareAmazonChanges(amazonFacts(), amazonPublication(), accepted())
      expect(plan.changes.length).toBeGreaterThanOrEqual(9)
      expect(plan.changes.map(c => c.field)).toEqual(expect.arrayContaining(['main_product_image_locator', 'other_product_image_locator_1', 'other_product_image_locator_2', 'list_price']))
      expect(differs(plan.changes)).toEqual([])
      expect(ticked(plan.changes)).toEqual([])
      expect(plan.changes.every(c => c.status === 'SAME' && c.replaces === undefined)).toBe(true)
      expect(compileAmazonChanges(plan, []).feed.messages).toEqual([])
    })

  it('Amazon: the control — one image changed on Amazon to an address that is not Amazon\'s own copy is the ONE ticked DIFFERS line', async () => {
    m.read.mockResolvedValue({ success: true, rawResponse: { attributes: { ...amazonAttributes(), other_product_image_locator_1: image('https://m.media.example.test/other.jpg') },
      summaries: [{ marketplaceId: 'MARKET', productType: 'COAT' }] } })
    const plan = await prepareAmazonChanges(amazonFacts(), amazonPublication(), acceptedAmazon())
    expect(differs(plan.changes)).toEqual(['other_product_image_locator_1'])
    expect(ticked(plan.changes)).toEqual(['other_product_image_locator_1'])
    expect(plan.changes.find(c => c.field === 'other_product_image_locator_1')!.replaces).toEqual({ kind: 'channel_changed', channel: '1 photo', nexus: '1 photo',
      sentence: 'Changed on Amazon since the last publish. Amazon has 1 photo — Publish sets Nexus\'s version.', note: null })
  })

  // ── eBay (Trading): title, description, item specifics, gallery pictures, variation pictures ──────────────────────
  const pictures = '<PictureDetails><PictureURL>https://images.example.test/coat-main.jpg</PictureURL><PictureURL>https://images.example.test/coat-2.jpg</PictureURL></PictureDetails>'
  const variationPictures = '<Pictures><VariationSpecificName>Colore</VariationSpecificName><VariationSpecificPictureSet><VariationSpecificValue>Nero</VariationSpecificValue><PictureURL>https://images.example.test/coat-black.jpg</PictureURL></VariationSpecificPictureSet></Pictures>'
  const variation = (price: number, quantity: number) => `<Variation><SKU>COAT-M</SKU><StartPrice>${price}</StartPrice><Quantity>${quantity}</Quantity><VariationSpecifics><NameValueList><Name>Colore</Name><Value>Nero</Value></NameValueList></VariationSpecifics></Variation>`
  // Price and stock differ on eBay: they are never review lines (their own doors send them), so they never differ here.
  const ebayItem = (price = 199, quantity = 3, gallery = pictures, setPictures = variationPictures) => `<Item><ItemID>456</ItemID><SKU>COAT</SKU><Title>Giacca in pelle</Title><Description><![CDATA[<p>Morbida</p>]]></Description><ItemSpecifics><NameValueList><Name>Marca</Name><Value>Xavia</Value></NameValueList><NameValueList><Name>Materiale</Name><Value>Pelle</Value><Value>Cotone</Value></NameValueList></ItemSpecifics>${gallery}<PrimaryCategory><CategoryID>123</CategoryID></PrimaryCategory><Variations>${variation(price, quantity)}<VariationSpecificsSet><NameValueList><Name>Colore</Name><Value>Nero</Value></NameValueList></VariationSpecificsSet>${setPictures}</Variations></Item>`
  const ebayFacts = () => ({ scope: { channel: 'EBAY', marketplace: 'IT', accountId: 'account' }, destination: { aliasKey: '' }, parent: { id: 'coat' },
    products: [{ id: 'coat', sku: 'COAT' }, { id: 'coat-m', sku: 'COAT-M' }],
    listings: ['coat', 'coat-m'].map(productId => ({ id: `${productId}-listing`, productId, externalListingId: '456', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '' })),
    resolved: [{ products: [{ productId: 'coat', cells: {} }, { productId: 'coat-m', cells: {} }], catalogue: { fields: [] } }] }) as unknown as PublicationFacts
  const ebayPublication = (liveItem = ebayItem(149, 8), ours = ebayItem()): EbayPublication => ({ kind: 'ebay', marketplace: 'IT', itemId: '456', liveRevision: 'rev',
    xml: `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${ours}</ReviseFixedPriceItemRequest>`,
    products: [{ productId: 'coat', sku: 'COAT' }, { productId: 'coat-m', sku: 'COAT-M' }], liveContent: parseEbayItemDocument(liveItem) } as EbayPublication)
  const acceptedEbay = () => new Map<string, StudioPublishValue>([
    [publicationChangeId('coat', 'title'), { state: 'value', value: 'Giacca in pelle' }], [publicationChangeId('coat', 'description'), { state: 'value', value: '<p>Morbida</p>' }],
    [publicationChangeId('coat', 'pictures'), { state: 'value', value: ['https://images.example.test/coat-main.jpg', 'https://images.example.test/coat-2.jpg'] }],
    [publicationChangeId('coat', 'aspect:marca'), { state: 'value', value: ['Xavia'] }], [publicationChangeId('coat', 'aspect:materiale'), { state: 'value', value: ['Pelle', 'Cotone'] }],
  ])

  it.each([['with an accepted publish record', acceptedEbay], ['never published from Nexus (imported)', () => new Map<string, StudioPublishValue>()]])(
    'eBay, gallery and variation pictures included (%s)', async (_name, accepted) => {
      const plan = await prepareEbayChanges(ebayFacts(), ebayPublication(), accepted())
      expect(plan.changes.map(c => c.field)).toEqual(expect.arrayContaining(['title', 'description', 'pictures', 'Pictures', 'aspect:marca', 'aspect:materiale']))
      expect(differs(plan.changes)).toEqual([])
      expect(ticked(plan.changes)).toEqual([])
      const { prepared } = compileSelection(plan, [], 'review-golden')
      expect(prepared).toBeNull()
    })

  it('eBay: the control — the gallery reordered on eBay is the ONE ticked DIFFERS line', async () => {
    const publication = ebayPublication()
    publication.liveContent = parseEbayItemDocument(ebayItem(149, 8).replace(pictures,
      '<PictureDetails><PictureURL>https://images.example.test/coat-2.jpg</PictureURL><PictureURL>https://images.example.test/coat-main.jpg</PictureURL></PictureDetails>'))
    const plan = await prepareEbayChanges(ebayFacts(), publication, acceptedEbay())
    expect(differs(plan.changes)).toEqual(['pictures'])
    expect(ticked(plan.changes)).toEqual(['pictures'])
    expect(plan.changes.find(c => c.field === 'pictures')!.replaces!.sentence).toBe('Changed on eBay since the last publish. eBay has 2 photos — Publish sets Nexus\'s version.')
  })

  // ── Real-shaped photo addresses: Nexus sends its own (Cloudinary); the channels show their own re-hosted copies ─────
  const cloud = (name: string) => `https://res.cloudinary.com/nexus-demo/image/upload/v1727700000/products/coat/${name}.jpg`
  const NEXUS_PHOTOS = { main_product_image_locator: cloud('main'), other_product_image_locator_1: cloud('side'), image_locator_ps01: cloud('detail') }
  const AMAZON_COPIES = { main_product_image_locator: 'https://m.media-amazon.com/images/I/71AbCdEfGhL.jpg',
    other_product_image_locator_1: 'https://m.media-amazon.com/images/I/81XyZaBcDeL._AC_SL1500_.jpg', image_locator_ps01: 'https://images-na.ssl-images-amazon.com/images/I/61QwErTyUiL.jpg' }
  /** The review lists roots alphabetically. */
  const photoRoots = Object.keys(NEXUS_PHOTOS).sort()
  const withPhotos = (attributes: Record<string, unknown>, photos: Record<string, string>) => {
    const { other_product_image_locator_2: _dropped, ...rest } = attributes
    return { ...rest, ...Object.fromEntries(Object.entries(photos).map(([root, url]) => [root, image(url)])) }
  }
  const rehosted = (copies: Record<string, string> = AMAZON_COPIES) => m.read.mockResolvedValue({ success: true,
    rawResponse: { attributes: withPhotos(amazonAttributes(), copies), summaries: [{ marketplaceId: 'MARKET', productType: 'COAT' }] } })
  const cloudPublication = (photos: Record<string, string> = NEXUS_PHOTOS): AmazonPublication => {
    const pub = amazonPublication(); pub.feed.messages[0].attributes = withPhotos(nexusAttributes(), photos); return pub
  }
  const cloudAccepted = () => {
    const accepted = new Map([...acceptedAmazon()].filter(([key]) => !key.includes('other_product_image_locator_2')))
    for (const [root, url] of Object.entries(NEXUS_PHOTOS)) accepted.set(publicationChangeId('coat', root), { state: 'value', value: image(url) })
    return accepted
  }
  const lines = (changes: StudioPublishChange[]) => changes.filter(c => photoRoots.includes(c.field))

  it('Amazon re-hosted photos, unchanged in Nexus since the last publish: SAME, nothing ticked, nothing sent', async () => {
    rehosted()
    const plan = await prepareAmazonChanges(amazonFacts(), cloudPublication(), cloudAccepted())
    expect(lines(plan.changes).map(c => [c.field, c.status, c.selectedByDefault])).toEqual(photoRoots.map(root => [root, 'SAME', false]))
    expect(differs(plan.changes)).toEqual([])
    expect(ticked(plan.changes)).toEqual([])
    expect(compileAmazonChanges(plan, []).feed.messages).toEqual([])
  })

  it('Amazon re-hosted photos, never published from Nexus: cannot be compared — selectable, never ticked, said plainly; never in `replaces`', async () => {
    rehosted()
    const plan = await prepareAmazonChanges(amazonFacts(), cloudPublication(), new Map())
    for (const line of lines(plan.changes)) expect(line).toMatchObject({ status: 'CANNOT_COMPARE', selectable: true, selectedByDefault: false, reason: AMAZON_PHOTO_COPY })
    expect(differs(plan.changes)).toEqual([])
    expect(ticked(plan.changes)).toEqual([])
    expect(JSON.stringify(plan.changes.map(c => c.replaces ?? null))).not.toMatch(/amazon\.com/)
    // Ticked by the person, Nexus's own addresses go out.
    const main = plan.changes.find(c => c.field === 'main_product_image_locator')!
    expect(compileAmazonChanges(plan, [main.id]).feed.messages[0].patches).toEqual([{ op: 'replace', path: '/attributes/main_product_image_locator', value: image(cloud('main')) }])
  })

  it('Amazon re-hosted photos, one changed in Nexus since the last publish: that one is SEND, ticked, and sends Nexus\'s address', async () => {
    rehosted()
    const plan = await prepareAmazonChanges(amazonFacts(), cloudPublication({ ...NEXUS_PHOTOS, other_product_image_locator_1: cloud('side-v2') }), cloudAccepted())
    expect(lines(plan.changes).map(c => [c.field, c.status, c.selectedByDefault])).toEqual([
      ['image_locator_ps01', 'SAME', false], ['main_product_image_locator', 'SAME', false], ['other_product_image_locator_1', 'SEND', true]])
    expect(ticked(plan.changes)).toEqual(['other_product_image_locator_1'])
    expect(plan.changes.every(c => c.replaces === undefined)).toBe(true)
    expect(compileAmazonChanges(plan, plan.changes.filter(c => c.selectedByDefault).map(c => c.id)).feed.messages[0].patches)
      .toEqual([{ op: 'replace', path: '/attributes/other_product_image_locator_1', value: image(cloud('side-v2')) }])
  })

  it('Amazon: a photo Amazon no longer holds is a real difference — DIFFERS, ticked, Nexus resends it', async () => {
    const { image_locator_ps01: _gone, ...left } = AMAZON_COPIES
    rehosted(left)
    const plan = await prepareAmazonChanges(amazonFacts(), cloudPublication(), cloudAccepted())
    expect(differs(plan.changes)).toEqual(['image_locator_ps01'])
    expect(plan.changes.find(c => c.field === 'image_locator_ps01')).toMatchObject({ selectedByDefault: true,
      replaces: { kind: 'channel_changed', channel: null, nexus: '1 photo', sentence: 'Changed on Amazon since the last publish. Amazon has no value — Publish sets 1 photo.' } })
  })

  // eBay Trading GetItem: eBay's picture service addresses in PictureURL, the seller's own in ExternalPictureURL (when kept).
  const eps = (id: string) => `https://i.ebayimg.com/00/s/MTYwMFgxMjAw/z/${id}/$_57.JPG?set_id=8800005007`
  const ebayGallery = (urls: string[], external: string[] = []) => `<PictureDetails><GalleryType>Gallery</GalleryType>${urls.map(u => `<PictureURL>${u}</PictureURL>`).join('')}<PictureSource>EPS</PictureSource>${external.map(u => `<ExternalPictureURL>${u}</ExternalPictureURL>`).join('')}</PictureDetails>`
  const ebaySets = (url: string, external?: string) => `<Pictures><VariationSpecificName>Colore</VariationSpecificName><VariationSpecificPictureSet><VariationSpecificValue>Nero</VariationSpecificValue><PictureURL>${url}</PictureURL>${external ? `<ExternalPictureURL>${external}</ExternalPictureURL>` : ''}</VariationSpecificPictureSet></Pictures>`
  const ourGallery = ebayGallery([cloud('main'), cloud('side')]), ourSets = ebaySets(cloud('black'))
  const ours = ebayItem(199, 3, ourGallery, ourSets)
  const acceptedCloud = () => { const accepted = acceptedEbay(); accepted.set(publicationChangeId('coat', 'pictures'), { state: 'value', value: [cloud('main'), cloud('side')] }); return accepted }
  const pictureLines = (changes: StudioPublishChange[]) => changes.filter(c => ['pictures', 'Pictures'].includes(c.field)).map(c => [c.field, c.status, c.selectable, c.selectedByDefault])

  it.each([['with an accepted publish record', acceptedCloud], ['never published from Nexus (imported)', () => new Map<string, StudioPublishValue>()]])(
    'eBay GetItem with ExternalPictureURL: compared on the seller\'s addresses — zero DIFFERS (%s)', async (_name, accepted) => {
      const live = ebayItem(149, 8, ebayGallery([eps('a1'), eps('b2')], [cloud('main'), cloud('side')]), ebaySets(eps('c3'), cloud('black')))
      const plan = await prepareEbayChanges(ebayFacts(), ebayPublication(live, ours), accepted())
      expect(pictureLines(plan.changes)).toEqual([['pictures', 'SAME', false, false], ['Pictures', 'SAME', false, false]])
      expect(differs(plan.changes)).toEqual([])
      expect(ticked(plan.changes)).toEqual([])
    })

  it('eBay GetItem with eBay\'s addresses only: unchanged → SAME, nothing ticked; never published → cannot compare, never ticked; changed in Nexus → SEND, ticked', async () => {
    const live = ebayItem(149, 8, ebayGallery([eps('a1'), eps('b2')]), ebaySets(eps('c3')))
    const unchanged = await prepareEbayChanges(ebayFacts(), ebayPublication(live, ours), acceptedCloud())
    expect(pictureLines(unchanged.changes)[0]).toEqual(['pictures', 'SAME', false, false])
    expect(differs(unchanged.changes)).toEqual([])
    expect(ticked(unchanged.changes)).toEqual([])

    const imported = await prepareEbayChanges(ebayFacts(), ebayPublication(live, ours), new Map())
    expect(pictureLines(imported.changes)).toEqual([['pictures', 'CANNOT_COMPARE', true, false], ['Pictures', 'CANNOT_COMPARE', true, false]])
    expect(imported.changes.find(c => c.field === 'pictures')!.reason).toBe(EBAY_PHOTO_COPY)
    expect(differs(imported.changes)).toEqual([])
    expect(ticked(imported.changes)).toEqual([])
    expect(JSON.stringify(imported.changes.map(c => c.replaces ?? null))).not.toMatch(/ebayimg/)

    const changed = await prepareEbayChanges(ebayFacts(), ebayPublication(live, ebayItem(199, 3, ebayGallery([cloud('main-v2'), cloud('side')]), ourSets)), acceptedCloud())
    expect(pictureLines(changed.changes)[0]).toEqual(['pictures', 'SEND', true, true])
    expect(ticked(changed.changes)).toEqual(['pictures'])
    expect(compileSelection(changed, ticked(changed.changes).map(field => publicationChangeId('coat', field)), 'review-eps').selection.payload.content)
      .toContain(`<PictureDetails><PictureURL>${cloud('main-v2')}</PictureURL><PictureURL>${cloud('side')}</PictureURL></PictureDetails>`)
  })

  it('eBay Inventory, pictures included (never published from Nexus)', () => {
    const group = { title: 'Giacca', description: '<p>Morbida</p>', imageUrls: ['https://images.example.test/coat-main.jpg', 'https://images.example.test/coat-2.jpg'],
      aspects: { Marca: ['Xavia'] }, variantSKUs: ['COAT-M'], variesBy: { specifications: [{ name: 'Taglia', values: ['M'] }] } }
    const live: ServerLiveRead<EbayInventoryRaw> = { readAt: '2026-10-04T10:00:00.000Z', source: 'ebay-inventory-group', revision: 'rev',
      destination: { productId: 'coat', channel: 'EBAY', marketplace: 'IT', accountId: 'account', aliasKey: '' },
      content: { title: { state: 'value', value: group.title }, description: { state: 'value', value: group.description }, pictures: { state: 'value', value: group.imageUrls },
        'aspect:marca': { state: 'value', value: ['Xavia'] } },
      variations: { axes: ['Taglia'], order: { Taglia: ['M'] }, variants: [{ sku: 'COAT-M', values: { Taglia: 'M' }, price: { state: 'absent' }, stock: { state: 'value', value: 3 }, state: 'live' }] },
      errors: [], raw: { groupKey: 'COAT', group, items: {}, item: null } } as unknown as ServerLiveRead<EbayInventoryRaw>
    const ours: EbayInventoryOurs = { title: 'Giacca', description: '<p>Morbida</p>', pictures: [...group.imageUrls], aspects: { Marca: ['Xavia'] },
      axes: ['Taglia'], order: { Taglia: ['M'] }, variants: [{ productId: 'coat-m', sku: 'COAT-M', values: { Taglia: 'M' } }] }
    const plan = prepareEbayInventoryChanges({ owner: { productId: 'coat', sku: 'COAT' }, ours, live, baselineValues: new Map(),
      destination: { productId: 'coat', channel: 'EBAY', marketplace: 'IT', accountId: 'account', aliasKey: '', expectedSkus: ['COAT-M'], itemId: '9', parentSku: 'COAT' } as never })
    expect(plan.changes.map(c => c.field)).toEqual(['title', 'description', 'pictures', 'aspect:marca'])
    expect(differs(plan.changes)).toEqual([])
    expect(ticked(plan.changes)).toEqual([])
  })
})

describe('held / blocked rows are never ticked and never warn', () => {
  it('blockRowChanges drops the tick and the "replaces" words of every line of the row', () => {
    const changes = planPublicationChanges([
      { productId: 'held', sku: 'HELD', field: 'title', label: 'Title', current: { state: 'value', value: 'N' }, lastAccepted: { state: 'unknown', reason: 'none' }, channel: { state: 'value', value: 'C' } },
      { productId: 'other', sku: 'OTHER', field: 'title', label: 'Title', current: { state: 'value', value: 'N' }, lastAccepted: { state: 'unknown', reason: 'none' }, channel: { state: 'value', value: 'C' } },
    ], { channel: 'Amazon' })
    expect(changes.every(c => c.selectedByDefault && c.replaces)).toBe(true)
    const [held, other] = blockRowChanges(changes, new Map([['held', 'Status is Not listed: nothing of this row is sent.']]))
    expect(held).toMatchObject({ selectable: false, selectedByDefault: false, reason: 'Status is Not listed: nothing of this row is sent.' })
    expect(held.replaces).toBeUndefined()
    expect(JSON.parse(JSON.stringify(held))).not.toHaveProperty('replaces')
    expect(other).toMatchObject({ selectedByDefault: true, replaces: { kind: 'never_published' } })
  })
})
