import { describe, expect, it } from 'vitest'

/**
 * S10 (per-channel SKU) — an eBay TRADING listing renames a live SKU in place (`ReviseFixedPriceItem`): the review lists
 * one line per renamed row ("Seller SKU" for the item's Custom label, "Variation SKU" for a variation), sendable in Partial
 * update; the narrow revise names the new SKU and eBay's OWN values for the variation (never its price or quantity, the
 * proven relabel shape); the journal records the new SKU only for a rename this send carries (so the settle never records
 * a SKU eBay did not take). A move eBay holds no trace of is a warning and is never sent. The real change planner and
 * compiler; nothing reaches eBay. SKUs are fake.
 */
import type { StudioPublishValue } from '@nexus/shared/studio-publication'
import type { PublicationFacts } from './studio-publication-plan.js'
import type { EbayPublication } from './studio-publication-ebay.js'
import { parseEbayItemDocument } from '../channel-drift/ebay-content-compare.js'
import { compileEbayChanges, prepareEbayChanges } from './studio-publication-ebay-changes.js'

const variation = (sku: string, colour: string, price = 20, quantity = 3) => `<Variation><SKU>${sku}</SKU><StartPrice>${price}</StartPrice><Quantity>${quantity}</Quantity><VariationSpecifics><NameValueList><Name>Colour</Name><Value>${colour}</Value></NameValueList></VariationSpecifics></Variation>`
const pictures = '<Pictures><VariationSpecificName>Colour</VariationSpecificName><VariationSpecificPictureSet><VariationSpecificValue>Black</VariationSpecificValue><PictureURL>https://example.test/black.jpg</PictureURL></VariationSpecificPictureSet></Pictures>'
const item = (label: string, variants: string, extra = '') => `<Item><ItemID>456</ItemID><SKU>${label}</SKU><Title>Jacket</Title><Description><![CDATA[<p>Same</p>]]></Description><PictureDetails><PictureURL>https://example.test/one.jpg</PictureURL></PictureDetails><Variations>${variants}${extra}<VariationSpecificsSet><NameValueList><Name>Colour</Name><Value>Black</Value><Value>Red</Value></NameValueList></VariationSpecificsSet></Variations></Item>`
const facts = () => ({
  scope: { channel: 'EBAY', marketplace: 'IT', accountId: 'account' }, destination: { aliasKey: '' }, parent: { id: 'parent' },
  products: [{ id: 'parent', sku: 'PARENT' }, { id: 'black', sku: 'BLACK' }, { id: 'red', sku: 'RED' }],
  listings: ['parent', 'black', 'red'].map(productId => ({ id: `${productId}-listing`, productId, externalListingId: '456', channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account', aliasKey: '' })),
  resolved: [{ products: [{ productId: 'parent', cells: {} }, { productId: 'black', cells: {} }, { productId: 'red', cells: {} }], catalogue: { fields: [] } }],
}) as unknown as PublicationFacts

/** Nexus sends BLACK as BLACK-EB (its own SKU) and the label PARENT as PARENT-EB; eBay holds PARENT, BLACK, RED. */
function publication(options: { label?: string; liveLabel?: string; ours?: string; live?: string; moves?: EbayPublication['moves']; tracked?: boolean } = {}): EbayPublication {
  const ours = options.ours ?? item(options.label ?? 'PARENT', variation('BLACK-EB', 'Black') + variation('RED', 'Red'), pictures.replace('black.jpg', 'black-new.jpg'))
  const live = parseEbayItemDocument(options.live ?? item(options.liveLabel ?? 'PARENT', variation('BLACK', 'Black', 99, 8) + variation('RED', 'Red', 99, 2), pictures))
  if (options.tracked) live.InventoryTrackingMethod = 'SKU'
  return {
    kind: 'ebay', marketplace: 'IT', itemId: '456', liveRevision: 'live-revision', xml: `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${ours}</ReviseFixedPriceItemRequest>`,
    products: [{ productId: 'parent', sku: options.label ?? 'PARENT' }, { productId: 'black', sku: 'BLACK-EB' }, { productId: 'red', sku: 'RED' }],
    liveContent: live,
    moves: options.moves ?? [{ productId: 'black', listingId: 'black-listing', from: 'BLACK', to: 'BLACK-EB' }],
  }
}
const ids = (plan: Awaited<ReturnType<typeof prepareEbayChanges>>, ...fields: string[]) => plan.changes.filter(change => fields.includes(change.field)).map(change => change.id)
const journal = (compiled: { products: Array<{ productId: string; sku: string }> }) => Object.fromEntries(compiled.products.map(product => [product.productId, product.sku]))
const none = new Map<string, StudioPublishValue>()

describe('S10 — a variation renamed in place (Partial update)', () => {
  it('is its own sendable line, matched by the SKU eBay holds', async () => {
    const plan = await prepareEbayChanges(facts(), publication(), none)
    expect(plan.changes.find(change => change.field === 'variationSku')).toMatchObject({ productId: 'black', selectable: true, selectedByDefault: true,
      current: { state: 'value', value: 'BLACK-EB' }, channel: { state: 'value', value: 'BLACK' } })
    expect(plan.renames).toEqual([{ productId: 'black', from: 'BLACK', to: 'BLACK-EB', field: 'variationSku', specifics: [['Colour', 'Black']] }])
    // The renamed row is the live variation's row (linked), never a "New variation".
    expect(plan.changes.filter(change => change.productId === 'black').map(change => change.label)).not.toContain('New variation')
  })

  it('the narrow revise names the new SKU and eBay\'s own values — no price, no quantity — and the journal records the new SKU', async () => {
    const plan = await prepareEbayChanges(facts(), publication(), none)
    const compiled = compileEbayChanges(plan, ids(plan, 'variationSku'))
    expect(compiled.xml).toContain('<Item><ItemID>456</ItemID><Variations><Variation><SKU>BLACK-EB</SKU><VariationSpecifics><NameValueList><Name>Colour</Name><Value>Black</Value></NameValueList></VariationSpecifics></Variation></Variations></Item>')
    for (const tag of ['StartPrice', 'Quantity', 'Title', 'Delete']) expect(compiled.xml).not.toContain(`<${tag}>`)
    expect(journal(compiled)).toMatchObject({ black: 'BLACK-EB', red: 'RED' })
  })

  it('a send without the rename keeps the journal on the SKU eBay holds', async () => {
    const plan = await prepareEbayChanges(facts(), publication({ ours: item('PARENT', variation('BLACK-EB', 'Black') + variation('RED', 'Red'), pictures).replace('<Title>Jacket</Title>', '<Title>Jacket 2</Title>') }), none)
    const compiled = compileEbayChanges(plan, ids(plan, 'title'))
    expect(compiled.xml).toContain('<Title>Jacket 2</Title>')
    expect(compiled.xml).not.toContain('BLACK-EB')
    expect(journal(compiled)).toMatchObject({ black: 'BLACK', red: 'RED' })
  })

  it('a rename and the variation pictures go in ONE <Variations> (Variation first, then Pictures)', async () => {
    const plan = await prepareEbayChanges(facts(), publication(), none)
    const compiled = compileEbayChanges(plan, ids(plan, 'variationSku', 'Pictures'))
    expect(compiled.xml.match(/<Variations>/g)).toHaveLength(1)
    expect(compiled.xml).toMatch(/<Variations><Variation><SKU>BLACK-EB<\/SKU>[\s\S]*<\/Variation><Pictures>[\s\S]*black-new\.jpg[\s\S]*<\/Pictures><\/Variations>/)
  })

  it('a move eBay holds no trace of is a warning, never a line, never sent', async () => {
    const live = item('PARENT', variation('RED', 'Red', 99, 2), pictures)
    const plan = await prepareEbayChanges(facts(), publication({ live }), none)
    expect(plan.renames).toBeUndefined()
    expect(plan.changes.some(change => change.field === 'variationSku')).toBe(false)
    expect(plan.fullIssues).toContainEqual(expect.objectContaining({ productId: 'black', severity: 'warning',
      message: 'eBay does not hold BLACK on this item, so Nexus cannot rename it to BLACK-EB from here. Check the listing on eBay.' }))
  })
})

describe('S10 — the item\'s Custom label renamed in place', () => {
  const ownerMove = [{ productId: 'parent', listingId: 'parent-listing', from: 'PARENT', to: 'PARENT-EB' }]

  it('the main row\'s own SKU makes "Seller SKU" sendable (it was refused before) and the revise carries the new label', async () => {
    const plan = await prepareEbayChanges(facts(), publication({ label: 'PARENT-EB', moves: ownerMove }), none)
    expect(plan.changes.find(change => change.field === 'SKU')).toMatchObject({ selectable: true, current: { state: 'value', value: 'PARENT-EB' } })
    const compiled = compileEbayChanges(plan, ids(plan, 'SKU'))
    expect(compiled.xml).toContain('<Item><ItemID>456</ItemID><SKU>PARENT-EB</SKU></Item>')
    expect(journal(compiled)).toMatchObject({ parent: 'PARENT-EB' })
  })

  it('a listing tracked by SKU: the ItemID names it and <SKU> carries the new label (eBay answers if it refuses)', async () => {
    const plan = await prepareEbayChanges(facts(), publication({ label: 'PARENT-EB', moves: ownerMove, tracked: true }), none)
    const compiled = compileEbayChanges(plan, ids(plan, 'SKU'))
    expect(compiled.xml.match(/<SKU>/g)).toHaveLength(1)
    expect(compiled.xml).toContain('<ItemID>456</ItemID><SKU>PARENT-EB</SKU>')
  })

  it('parity: without a move the Custom label stays refused in Partial update, as before', async () => {
    const plan = await prepareEbayChanges(facts(), publication({ label: 'PARENT-EB', moves: [] }), none)
    expect(plan.changes.find(change => change.field === 'SKU')).toMatchObject({ selectable: false, reason: expect.stringContaining('Changing the seller SKU is unsupported by change-only Publish.') })
  })

  it('eBay holding another label than the one Nexus knows: no rename, a warning', async () => {
    const plan = await prepareEbayChanges(facts(), publication({ label: 'PARENT-EB', liveLabel: 'T1_OLD', moves: ownerMove }), none)
    expect(plan.changes.find(change => change.field === 'SKU')).toMatchObject({ selectable: false })
    expect(plan.fullIssues).toContainEqual(expect.objectContaining({ productId: 'parent', severity: 'warning',
      message: 'eBay does not hold PARENT as this listing\'s Custom label (it holds T1_OLD), so Nexus cannot rename it to PARENT-EB from here. Check the listing on eBay.' }))
  })
})

describe('S10 — Full update', () => {
  it('sends the whole Revise with the renames, and the journal records the new SKUs', async () => {
    const source = publication({ label: 'PARENT-EB', moves: [{ productId: 'parent', listingId: 'parent-listing', from: 'PARENT', to: 'PARENT-EB' }, { productId: 'black', listingId: 'black-listing', from: 'BLACK', to: 'BLACK-EB' }] })
    source.full = { xml: source.xml, stockRevision: 'stock', extras: [], added: [], deletedFields: [], keptRoots: [], blockers: [] }
    const plan = await prepareEbayChanges(facts(), source, none, { full: true })
    expect((plan.fullIssues ?? []).some(issue => /never changes it/.test(issue.message))).toBe(false)
    const locked = plan.changes.filter(change => change.locked).map(change => change.id)
    expect(plan.changes.filter(change => ['SKU', 'variationSku'].includes(change.field)).every(change => change.locked)).toBe(true)
    const compiled = compileEbayChanges(plan, locked)
    expect(compiled.xml).toBe(source.full.xml)
    expect(journal(compiled)).toMatchObject({ parent: 'PARENT-EB', black: 'BLACK-EB', red: 'RED' })
  })
})
