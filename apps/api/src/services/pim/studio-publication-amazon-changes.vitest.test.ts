import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StudioPublishValue } from '@nexus/shared/studio-publication'
import type { PublicationFacts } from './studio-publication-plan.js'
import type { AmazonPublication } from './studio-publication-amazon.js'
const m = vi.hoisted(() => ({ read: vi.fn(), spec: vi.fn(), bound: vi.fn() }))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({ AmazonSpApiClient: class { constructor(account: unknown) { m.bound(account) }; getListingsItem = m.read } }))
vi.mock('../../lib/amazon-sp-client.js', () => ({ getAmazonRegion: async () => 'eu' }))
vi.mock('./channel-specs/index.js', async importOriginal => ({ ...(await importOriginal<object>()), loadAmazonSpec: m.spec }))
import { amazonSpecFromDefinition } from './channel-specs/amazon.js'
import { publicationChangeId } from './studio-publication-changes.js'
import { prepareAmazonChanges, compileAmazonChanges } from './studio-publication-amazon-changes.js'
import { compileSelection } from './studio-publication-selection.js'

const entries = (value: string, language_tag?: string) => [{ value, marketplace_id: 'MARKET', ...(language_tag ? { language_tag } : {}) }]
const contentKey = (root: string, tag = 'de_DE') => `${root}:${JSON.stringify(['MARKET', tag])}`
const rootSchema = (language = false) => ({ type: 'array', selectors: ['marketplace_id', ...(language ? ['language_tag'] : [])], items: { type: 'object', properties: {
  marketplace_id: { const: 'MARKET' }, ...(language ? { language_tag: { enum: ['de_DE', 'en_DE', 'en_GB'], default: 'de_DE' } } : {}), value: { type: 'string' },
} } })
const schema = () => amazonSpecFromDefinition({ marketplace: 'DE', productType: 'COAT', schemaDefinition: { properties: {
  item_name: rootSchema(true), product_description: rootSchema(true), brand: rootSchema(), fabric_type: rootSchema(), variation_theme: rootSchema(),
  purchasable_offer: rootSchema(), fulfillment_availability: rootSchema(), list_price: rootSchema(),
} } })
const facts = (ids = ['parent', 'child']) => ({ scope: { channel: 'AMAZON', marketplace: 'DE', accountId: 'selected-account' }, destination: { aliasKey: 'alias-a' },
  parent: { id: 'parent', sku: 'LOCAL-PARENT' }, products: ids.map(id => ({ id, sku: `LOCAL-${id}` })),
  listings: ids.map(id => ({ id: `listing-${id}`, productId: id, externalListingId: `ASIN-${id}` })),
}) as unknown as PublicationFacts
const publication = (ids = ['parent', 'child']): AmazonPublication => ({ kind: 'amazon', sellerId: 'SELLER', marketplaceId: 'MARKET',
  products: ids.map(productId => ({ productId, sku: `SELLER-${productId}` })), feed: { header: { sellerId: 'SELLER', version: '2.0' },
    messages: ids.map((id, index) => ({ messageId: index + 1, sku: `SELLER-${id}`, operationType: 'PARTIAL_UPDATE', productType: 'COAT', attributes: {
      item_name: entries(`${id} title`, 'de_DE'), brand: entries('Brand'), purchasable_offer: entries('29'), fulfillment_availability: entries('5'), list_price: entries('39'),
    } })),
  } })
const baseline = (pub: AmazonPublication) => new Map<string, StudioPublishValue>(pub.products.flatMap((p, index) => Object.entries(pub.feed.messages[index].attributes ?? {}).map(([field, value]) => [publicationChangeId(p.productId, field), { state: 'value', value } as StudioPublishValue])))
const defaults = (plan: Awaited<ReturnType<typeof prepareAmazonChanges>>) => plan.changes.filter(c => c.selectedByDefault).map(c => c.id)
const remote = (attributes: unknown, productType = 'COAT') => ({ success: true, rawResponse: { attributes, summaries: [{ marketplaceId: 'MARKET', productType }] } })
function contentClear(input: PublicationFacts, locale: string, value: unknown, provenance: string | null = 'override') {
  input.languages = ['de', 'en']
  input.resolved = [{ locale, products: [{ productId: 'parent', cells: { product_description: { fieldKey: 'product_description', value, status: provenance ? 'mapped' : 'unmapped', provenance, needsTranslation: false } } }] }] as unknown as PublicationFacts['resolved']
}

beforeEach(() => {
  vi.clearAllMocks(); m.spec.mockResolvedValue(schema())
  m.read.mockImplementation(async ({ sku }) => remote(publication().feed.messages.find(msg => msg.sku === sku)?.attributes ?? {}))
})

it('one changed child/root produces one PATCH and journals only that explicit intent, excluding price and stock', async () => {
  const pub = publication(), accepted = baseline(pub)
  pub.feed.messages[1].attributes!.brand = entries('Changed brand')
  pub.feed.messages[1].attributes!.purchasable_offer = entries('999')
  const plan = await prepareAmazonChanges(facts(), pub, accepted)
  // The two offer roots are the offer lane's (a listing's saved offer draft); RRP is a root line like any other.
  expect(plan.changes.some(c => ['purchasable_offer', 'fulfillment_availability'].includes(c.field))).toBe(false)
  expect(plan.changes.find(c => c.productId === 'child' && c.field === 'list_price')).toMatchObject({ status: 'SAME', selectedByDefault: false })
  expect(defaults(plan)).toEqual([publicationChangeId('child', 'brand')])
  const sent = compileAmazonChanges(JSON.parse(JSON.stringify(plan)), defaults(plan))
  expect(sent.products).toEqual([{ productId: 'child', sku: 'SELLER-child' }])
  expect(sent.feed.messages).toEqual([{ messageId: 1, sku: 'SELLER-child', operationType: 'PATCH', productType: 'COAT', patches: [{ op: 'replace', path: '/attributes/brand', value: entries('Changed brand') }] }])
  expect(sent.fieldWrites).toEqual({ child: [{ field: 'brand', value: { state: 'value', value: entries('Changed brand') } }] })
  expect(m.bound).toHaveBeenCalledWith({ id: 'selected-account', region: 'eu' })
  expect(m.read).toHaveBeenCalledWith({ sellerId: 'SELLER', sku: 'SELLER-child', marketplaceId: 'MARKET', includedData: ['summaries', 'attributes'] })
})

it('🔴 a live listing\'s RRP (list_price) change is a root line against its publish baseline, ticked and sent alone', async () => {
  const pub = publication(['parent']), accepted = baseline(pub)
  pub.feed.messages[0].attributes!.list_price = entries('45')
  // An offer line's field id in the journal (an accepted offer draft) never becomes a content root line.
  accepted.set(publicationChangeId('parent', 'purchasable_offer__our_price'), { state: 'value', value: { pin: 44.9 } })
  const plan = await prepareAmazonChanges(facts(['parent']), pub, accepted)
  expect(plan.changes.some(c => c.field.startsWith('purchasable_offer'))).toBe(false)
  expect(plan.changes.find(c => c.field === 'list_price')).toMatchObject({ status: 'SEND', selectedByDefault: true,
    current: { state: 'value', value: entries('45') }, lastAccepted: { state: 'value', value: entries('39') }, channel: { state: 'value', value: entries('39') } })
  expect(defaults(plan)).toEqual([publicationChangeId('parent', 'list_price')])
  expect(compileAmazonChanges(plan, defaults(plan)).feed.messages[0].patches).toEqual([{ op: 'replace', path: '/attributes/list_price', value: entries('45') }])
})

it('no accepted baseline ticks a difference (Nexus wins, Owner 2026-10-04) with its warning, and no selected IDs submits no messages', async () => {
  const pub = publication(); pub.feed.messages[1].attributes!.brand = entries('Changed')
  const plan = await prepareAmazonChanges(facts(), pub, new Map())
  expect(plan.changes.find(c => c.productId === 'child' && c.field === 'brand')).toMatchObject({ status: 'DIFFERS', selectable: true, selectedByDefault: true,
    replaces: { kind: 'never_published', channel: 'Brand', nexus: 'Changed', sentence: 'Not published from Nexus before. Amazon has Brand — Publish sets Changed.', note: null } })
  expect(compileAmazonChanges(plan, []).feed.messages).toEqual([])
  expect(compileAmazonChanges(plan, []).products).toEqual([])
})

it('uses existing provider normalization without changing exact local or accepted values', async () => {
  const pub = publication(['parent'])
  pub.feed.messages[0].attributes!.brand = entries('  Café  ')
  m.read.mockResolvedValue(remote({ item_name: entries('parent title', 'de_DE'), brand: entries('Cafe\u0301') }))
  const plan = await prepareAmazonChanges(facts(['parent']), pub, new Map())
  expect(plan.changes.find(c => c.field === 'brand')).toMatchObject({ status: 'SAME', current: { state: 'value', value: entries('  Café  ') } })
})

it('preserves another remote language in a root replacement without adopting it into the intent baseline', async () => {
  const pub = publication(['parent']), accepted = baseline(pub)
  pub.feed.messages[0].attributes!.item_name = entries('New German', 'de_DE')
  const old = [...entries('parent title', 'de_DE'), ...entries('Keep this English', 'en_GB')]
  m.read.mockResolvedValue(remote({ ...publication(['parent']).feed.messages[0].attributes, item_name: old }))
  const plan = await prepareAmazonChanges(facts(['parent']), pub, accepted)
  const sent = compileAmazonChanges(plan, defaults(plan))
  expect(sent.feed.messages[0].patches).toEqual([{ op: 'replace', path: '/attributes/item_name', value: [...entries('New German', 'de_DE'), ...entries('Keep this English', 'en_GB')] }])
  expect(sent.fieldWrites?.parent).toEqual([{ field: contentKey('item_name'), value: { state: 'value', value: entries('New German', 'de_DE') } }])
})

it('clears only the accepted language instance using the live selector values', async () => {
  const pub = publication(['parent']), accepted = baseline(pub)
  accepted.set(publicationChangeId('parent', 'item_name'), { state: 'value', value: entries('English before', 'en_GB') })
  delete pub.feed.messages[0].attributes!.item_name
  pub.feed.messages[0].patches = [{ op: 'delete', path: '/attributes/item_name', value: [{ marketplace_id: 'MARKET', language_tag: 'en_GB' }] }]
  m.read.mockResolvedValue(remote({ brand: entries('Brand'), list_price: entries('39'), item_name: [...entries('English before', 'en_GB'), ...entries('German to preserve', 'de_DE')] }))
  const plan = await prepareAmazonChanges(facts(['parent']), pub, accepted)
  const sent = compileAmazonChanges(plan, defaults(plan))
  expect(sent.feed.messages[0].patches).toContainEqual({ op: 'delete', path: '/attributes/item_name', value: [{ marketplace_id: 'MARKET', language_tag: 'en_GB' }] })
  expect(sent.fieldWrites?.parent).toEqual([{ field: contentKey('item_name', 'en_GB'), value: { state: 'absent' } }])
})

it('does not turn omitted gallery/content roots from an accepted create into deletion intents', async () => {
  const pub = publication(['parent']), accepted = baseline(pub)
  accepted.set(publicationChangeId('parent', 'main_product_image_locator'), { state: 'value', value: [{ marketplace_id: 'MARKET', media_location: 'https://example.test/kept.jpg' }] })
  accepted.set(publicationChangeId('parent', 'fabric_type'), { state: 'value', value: entries('Kept material') })
  pub.feed.messages[0].attributes!.brand = entries('Changed brand')
  m.read.mockResolvedValue(remote({ ...publication(['parent']).feed.messages[0].attributes, fabric_type: entries('Kept material'), main_product_image_locator: [{ marketplace_id: 'MARKET', media_location: 'https://example.test/kept.jpg' }] }))
  const plan = await prepareAmazonChanges(facts(['parent']), pub, accepted)
  for (const field of ['main_product_image_locator', 'fabric_type']) expect(plan.changes.find(c => c.field === field)).toMatchObject({ current: { state: 'unknown' }, selectable: false })
  expect(compileAmazonChanges(plan, defaults(plan)).feed.messages[0].patches).toEqual([{ op: 'replace', path: '/attributes/brand', value: entries('Changed brand') }])
})

it('first-publish authored blank content clears only its requested language (ticked: Nexus wins)', async () => {
  const input = facts(['parent']), pub = publication(['parent'])
  contentClear(input, 'de', '')
  m.read.mockResolvedValue(remote({ ...pub.feed.messages[0].attributes, product_description: [...entries('Old German', 'de_DE'), ...entries('Keep English', 'en_GB')] }))
  const plan = await prepareAmazonChanges(input, pub, new Map())
  const change = plan.changes.find(c => c.field === contentKey('product_description'))!
  expect(change).toMatchObject({ current: { state: 'absent' }, status: 'DIFFERS', selectable: true, selectedByDefault: true,
    replaces: { kind: 'removes', channel: 'Old German', nexus: null, sentence: 'Amazon has Old German — Publish removes it.' } })
  expect(compileAmazonChanges(plan, [change.id]).feed.messages[0].patches).toEqual([{ op: 'delete', path: '/attributes/product_description', value: [{ marketplace_id: 'MARKET', language_tag: 'de_DE' }] }])
})

it.each([null, 'default', 'catalogRule'])('does not interpret %s blank resolver values as authored clears', async provenance => {
  const input = facts(['parent']), pub = publication(['parent'])
  contentClear(input, 'de', null, provenance)
  const plan = await prepareAmazonChanges(input, pub, new Map())
  expect(plan.changes.some(c => c.field.startsWith('product_description'))).toBe(false)
})

it('clears one authored language without resending desired or preserved languages', async () => {
  const input = facts(['parent']), pub = publication(['parent'])
  contentClear(input, 'en', [])
  pub.feed.messages[0].attributes!.product_description = entries('German stays', 'de_DE')
  m.read.mockResolvedValue(remote({ ...pub.feed.messages[0].attributes, product_description: [...entries('German stays', 'de_DE'), ...entries('Remove this English', 'en_DE'), ...entries('Foreign English stays', 'en_GB')] }))
  const plan = await prepareAmazonChanges(input, pub, new Map())
  const change = plan.changes.find(c => c.field === contentKey('product_description', 'en_DE'))!
  expect(change).toMatchObject({ status: 'DIFFERS', selectable: true, selectedByDefault: true, replaces: { kind: 'removes' } })
  const compiled = compileAmazonChanges(plan, [change.id])
  expect(compiled.feed.messages[0].patches).toEqual([{ op: 'delete', path: '/attributes/product_description', value: [{ marketplace_id: 'MARKET', language_tag: 'en_DE' }] }])
  expect(compiled.fieldWrites?.parent).toEqual([{ field: contentKey('product_description', 'en_DE'), value: { state: 'absent' } }])
})

it('preserves an omitted previously accepted language when another language changes without explicit clear', async () => {
  const pub = publication(['parent']), accepted = baseline(pub)
  accepted.set(publicationChangeId('parent', 'item_name'), { state: 'value', value: [...entries('parent title', 'de_DE'), ...entries('Old English', 'en_GB')] })
  pub.feed.messages[0].attributes!.item_name = entries('Changed German', 'de_DE')
  m.read.mockResolvedValue(remote({ ...pub.feed.messages[0].attributes, item_name: [...entries('parent title', 'de_DE'), ...entries('Old English', 'en_GB')] }))
  const plan = await prepareAmazonChanges(facts(['parent']), pub, accepted)
  expect(compileAmazonChanges(plan, [publicationChangeId('parent', contentKey('item_name'))]).feed.messages[0].patches).toEqual([{ op: 'replace', path: '/attributes/item_name', value: [...entries('Changed German', 'de_DE'), ...entries('Old English', 'en_GB')] }])
})

it('refuses conflicting provider SKU or marketplace identity in the live response', async () => {
  const pub = publication(['parent'])
  m.read.mockResolvedValue({ ...remote(pub.feed.messages[0].attributes), rawResponse: { sku: 'FOREIGN', attributes: pub.feed.messages[0].attributes, summaries: [{ marketplaceId: 'MARKET', productType: 'COAT' }] } })
  expect((await prepareAmazonChanges(facts(['parent']), pub, baseline(pub))).changes.every(c => !c.selectable && c.status === 'CANNOT_COMPARE')).toBe(true)
  m.read.mockResolvedValue({ ...remote(pub.feed.messages[0].attributes), rawResponse: { sku: 'SELLER-parent', attributes: pub.feed.messages[0].attributes, summaries: [{ marketplaceId: 'OTHER-MARKET', productType: 'COAT' }] } })
  expect((await prepareAmazonChanges(facts(['parent']), pub, baseline(pub))).changes.every(c => !c.selectable && c.status === 'CANNOT_COMPARE')).toBe(true)
})

it.each([remote(undefined), { success: false, error: 'read failed' }, { success: true }])('keeps incomplete/failed live reads unknown and refuses unsafe replacement (%j)', async response => {
  const pub = publication(['parent']), accepted = baseline(pub); pub.feed.messages[0].attributes!.brand = entries('Changed')
  m.read.mockResolvedValue(response)
  const plan = await prepareAmazonChanges(facts(['parent']), pub, accepted)
  expect(plan.changes.every(c => c.status === 'CANNOT_COMPARE' && !c.selectable)).toBe(true)
  expect(() => compileAmazonChanges(plan, [publicationChangeId('parent', 'brand')])).toThrow(/cannot be selected/)
})

it('refuses a product-type mismatch and an ambiguous missing live language selector by name', async () => {
  const pub = publication(['parent']); pub.feed.messages[0].attributes!.item_name = entries('Changed', 'de_DE')
  m.read.mockResolvedValue(remote({ item_name: entries('Previous', 'de_DE') }, 'SHOES'))
  const wrongType = await prepareAmazonChanges(facts(['parent']), pub, new Map())
  expect(wrongType.changes.every(c => !c.selectable && c.reason.includes('product type'))).toBe(true)
  m.read.mockResolvedValue(remote({ item_name: [{ value: 'Ambiguous text', marketplace_id: 'MARKET' }], brand: entries('Brand') }))
  const ambiguous = await prepareAmazonChanges(facts(['parent']), pub, new Map())
  expect(ambiguous.changes.find(c => c.field === contentKey('item_name'))).toMatchObject({ selectable: false, reason: expect.stringContaining('language_tag') })
})

it('creates a new SKU atomically with its complete UPDATE, but never sends an unticked new SKU', async () => {
  const input = facts(['parent']), pub = publication(['parent'])
  input.listings[0].externalListingId = null
  pub.feed.messages[0].operationType = 'UPDATE'
  m.read.mockResolvedValue({ success: true, sku: 'SELLER-parent', asin: null, status: null })
  const plan = await prepareAmazonChanges(input, pub, new Map())
  expect(plan.changes).toHaveLength(1)
  expect(plan.changes[0]).toMatchObject({ field: '$create', selectedByDefault: true })
  expect(m.read).toHaveBeenCalledOnce()
  const sent = compileAmazonChanges(plan, defaults(plan))
  expect(sent.feed.messages).toEqual(pub.feed.messages)
  expect(sent.fieldWrites?.parent).toContainEqual({ field: 'brand', value: { state: 'value', value: entries('Brand') } })
  expect(compileAmazonChanges(plan, []).feed.messages).toEqual([])
})
// The accepted history here is what `readPublicationBaseline` returns: only publishes accepted AFTER the listing's last
// accepted delete (delete and relist, Owner 2026-10-04; studio-publication-baseline.vitest.test.ts pins that rule). A
// listing accepted and still waiting for its ASIN keeps its history; one deleted since has none (the next test).
it('uses accepted history for a new listing awaiting local identity instead of sending another full UPDATE', async () => {
  const pub = publication(['parent']), accepted = baseline(pub), before = structuredClone(pub.feed.messages[0].attributes)
  pub.feed.messages[0].operationType = 'UPDATE'
  pub.feed.messages[0].attributes!.brand = entries('Changed after creation')
  const pendingIdentity = facts(['parent']); pendingIdentity.listings[0].externalListingId = null
  m.read.mockResolvedValue(remote(before))
  const plan = await prepareAmazonChanges(pendingIdentity, pub, accepted)
  expect(defaults(plan)).toEqual([publicationChangeId('parent', 'brand')])
  expect(plan.products[0].newListing).toBe(false)
  expect(compileAmazonChanges(plan, defaults(plan)).feed.messages).toEqual([{ messageId: 1, sku: 'SELLER-parent', operationType: 'PATCH', productType: 'COAT',
    patches: [{ op: 'replace', path: '/attributes/brand', value: entries('Changed after creation') }] }])
  m.read.mockResolvedValue({ success: true, sku: 'SELLER-parent', asin: null, status: null })
  const propagating = await prepareAmazonChanges(pendingIdentity, pub, accepted)
  expect(propagating.changes.every(change => !change.selectable)).toBe(true)
  expect(propagating.changes.some(change => change.field === '$create')).toBe(false)
})

it('after a delete (no accepted publish since) the listing is new again: one complete create, ticked by default', async () => {
  const pub = publication(['parent']), input = facts(['parent'])
  input.listings[0].externalListingId = null; pub.feed.messages[0].operationType = 'UPDATE'
  m.read.mockResolvedValue({ success: true, sku: 'SELLER-parent', asin: null, status: null })
  // The baseline after the delete is empty (the old publishes belong to the deleted listing).
  const plan = await prepareAmazonChanges(input, pub, new Map(), { relist: new Map([['parent', { deletedAt: new Date(Date.now() - 3_600_000).toISOString() }]]) })
  expect(plan.products[0].newListing).toBe(true)
  expect(plan.changes).toEqual([expect.objectContaining({ field: '$create', selectable: true, selectedByDefault: true })])
  expect(compileAmazonChanges(plan, defaults(plan)).feed.messages).toEqual(pub.feed.messages)
})

it('a relist whose SKU Amazon still shows within a day of the delete says Amazon is still removing it; later, the old refusal', async () => {
  const pub = publication(['parent']), input = facts(['parent'])
  input.listings[0].externalListingId = null; pub.feed.messages[0].operationType = 'UPDATE'
  const recent = new Map([['parent', { deletedAt: new Date(Date.now() - 12 * 60_000 - 5_000).toISOString() }]])
  const soon = await prepareAmazonChanges(input, pub, new Map(), { relist: recent })
  expect(soon.changes[0]).toMatchObject({ field: '$create', selectable: false, selectedByDefault: false,
    reason: 'Amazon is still removing this SKU (deleted 12 minutes ago). Try again later; Amazon can take up to 24 hours. (Amazon still shows this SKU here.)' })
  const old = await prepareAmazonChanges(input, pub, new Map(), { relist: new Map([['parent', { deletedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }]]) })
  expect(old.changes[0]).toMatchObject({ selectable: false, reason: expect.stringMatching(/already exists on Amazon/) })
})

it('refuses atomic creation when the supposedly new seller SKU already exists on Amazon', async () => {
  const input = facts(['parent']), pub = publication(['parent'])
  input.listings[0].externalListingId = null; pub.feed.messages[0].operationType = 'UPDATE'
  const plan = await prepareAmazonChanges(input, pub, new Map())
  expect(plan.changes[0]).toMatchObject({ selectable: false, selectedByDefault: false, reason: expect.stringMatching(/exists|link/i) })
  expect(() => compileAmazonChanges(plan, [plan.changes[0].id])).toThrow(/cannot be selected/)
})

it.each([{ success: false, error: 'Read unavailable' }, { success: true }, { success: true, sku: 'FOREIGN', asin: null, status: null }])('does not interpret an unavailable or unidentified new-SKU read as confirmed absence (%j)', async response => {
  const input = facts(['parent']), pub = publication(['parent'])
  input.listings[0].externalListingId = null; pub.feed.messages[0].operationType = 'UPDATE'
  m.read.mockResolvedValue(response)
  const plan = await prepareAmazonChanges(input, pub, new Map())
  expect(plan.changes[0]).toMatchObject({ status: 'CANNOT_COMPARE', selectable: false, selectedByDefault: false })
})

it('binds confirmed new-SKU absence into the remote revision so later creation invalidates review', async () => {
  const input = facts(['parent']), pub = publication(['parent'])
  input.listings[0].externalListingId = null; pub.feed.messages[0].operationType = 'UPDATE'
  m.read.mockResolvedValue({ success: true, sku: 'SELLER-parent', asin: null, status: null })
  const before = await prepareAmazonChanges(input, pub, new Map())
  m.read.mockResolvedValue(remote(pub.feed.messages[0].attributes))
  const after = await prepareAmazonChanges(input, pub, new Map())
  expect(after.remoteRevision).not.toBe(before.remoteRevision)
  expect(defaults(after)).toEqual([])
})

it('compiles identical new-listing intent order after JSONB reverses every object key', async () => {
  const reverse = (value: any): any => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, value]) => [key, reverse(value)])) : value
  const canonical = (value: unknown) => JSON.stringify(value, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)
  const input = facts(['parent']), pub = publication(['parent'])
  input.listings[0].externalListingId = null; pub.feed.messages[0].operationType = 'UPDATE'
  m.read.mockResolvedValue({ success: true, sku: 'SELLER-parent', asin: null, status: null })
  const plan = await prepareAmazonChanges(input, pub, new Map()), ids = defaults(plan)
  const original = compileAmazonChanges(plan, ids), stored = compileAmazonChanges(reverse(JSON.parse(JSON.stringify(plan))), ids)
  expect(stored.fieldWrites).toEqual(original.fieldWrites)
  expect(canonical(stored)).toBe(canonical(original))
})

it('binds revision to live content including preserved language values, but ignores live price/stock', async () => {
  const pub = publication(['parent']), accepted = baseline(pub)
  const first = await prepareAmazonChanges(facts(['parent']), pub, accepted)
  m.read.mockResolvedValue(remote({ ...pub.feed.messages[0].attributes, purchasable_offer: entries('200'), fulfillment_availability: entries('200') }))
  expect((await prepareAmazonChanges(facts(['parent']), pub, accepted)).remoteRevision).toBe(first.remoteRevision)
  m.read.mockResolvedValue(remote({ ...pub.feed.messages[0].attributes, item_name: [...entries('parent title', 'de_DE'), ...entries('New remote English', 'en_GB')] }))
  expect((await prepareAmazonChanges(facts(['parent']), pub, accepted)).remoteRevision).not.toBe(first.remoteRevision)
})

it('bounds concurrent reads for a 21-SKU family and retains original SKU order', async () => {
  const ids = Array.from({ length: 21 }, (_, i) => `p${i}`), pub = publication(ids)
  let active = 0, peak = 0
  m.read.mockImplementation(async ({ sku }) => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active--; return remote(pub.feed.messages.find(m => m.sku === sku)!.attributes) })
  const plan = await prepareAmazonChanges(facts(ids), pub, baseline(pub))
  expect(m.read).toHaveBeenCalledTimes(21)
  expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(5)
  expect([...new Set(plan.changes.map(c => c.sku))]).toEqual(pub.products.map(p => p.sku))
})

it('stops launching reads after the live-read budget and exposes every remaining SKU as unknown', async () => {
  vi.useFakeTimers()
  try {
    const ids = Array.from({ length: 21 }, (_, i) => `p${i}`), pub = publication(ids)
    m.read.mockImplementation(() => new Promise(() => {}))
    const pending = prepareAmazonChanges(facts(ids), pub, baseline(pub))
    await vi.advanceTimersByTimeAsync(9_501)
    const plan = await pending
    expect(m.read).toHaveBeenCalledTimes(5)
    expect(new Set(plan.changes.map(c => c.productId)).size).toBe(21)
    expect(plan.changes.every(c => c.status === 'CANNOT_COMPARE' && !c.selectable && c.reason.includes('9.5-second'))).toBe(true)
  } finally { vi.useRealTimers() }
})
it('lets a healthy 50-SKU family finish all reads without starving its later products', async () => {
  vi.useFakeTimers()
  try {
    const ids = Array.from({ length: 50 }, (_, index) => `item-${index}`), pub = publication(ids)
    let active = 0, maximum = 0
    m.read.mockImplementation(async ({ sku }) => {
      active++; maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 1_500))
      active--
      return remote(pub.feed.messages.find(message => message.sku === sku)!.attributes)
    })
    const pending = prepareAmazonChanges(facts(ids), pub, new Map())
    await vi.advanceTimersByTimeAsync(16_000)
    const plan = await pending
    expect(m.read).toHaveBeenCalledTimes(50)
    expect(maximum).toBeLessThanOrEqual(5)
    expect(new Set(plan.changes.map(change => change.productId)).size).toBe(50)
    expect(plan.changes.every(change => change.status === 'SAME')).toBe(true)
  } finally { vi.useRealTimers() }
})

it('folds accepted DE-only and EN-only intents independently and keeps the EN baseline after a DE clear', async () => {
  const accepted = new Map<string, StudioPublishValue>()
  const fold = (sent: AmazonPublication) => { for (const write of sent.fieldWrites?.parent ?? []) accepted.set(publicationChangeId('parent', write.field), write.value) }
  const initial = publication(['parent']); initial.feed.messages[0].operationType = 'UPDATE'
  initial.feed.messages[0].attributes!.product_description = [...entries('German A', 'de_DE'), ...entries('English B', 'en_DE')]
  const fresh = facts(['parent']); fresh.listings[0].externalListingId = null
  m.read.mockResolvedValue({ success: true, sku: 'SELLER-parent', asin: null, status: null })
  const create = await prepareAmazonChanges(fresh, initial, accepted)
  fold(compileAmazonChanges(create, defaults(create)))
  expect(accepted.has(publicationChangeId('parent', 'product_description'))).toBe(false)
  expect(accepted.get(publicationChangeId('parent', contentKey('product_description', 'en_DE')))).toEqual({ state: 'value', value: entries('English B', 'en_DE') })

  const german = publication(['parent']); german.feed.messages[0].attributes!.product_description = entries('German C', 'de_DE')
  m.read.mockResolvedValue(remote(initial.feed.messages[0].attributes))
  const germanPlan = await prepareAmazonChanges(facts(['parent']), german, accepted)
  expect(defaults(germanPlan)).toEqual([publicationChangeId('parent', contentKey('product_description'))])
  fold(compileAmazonChanges(germanPlan, defaults(germanPlan)))
  expect(accepted.get(publicationChangeId('parent', contentKey('product_description', 'en_DE')))).toEqual({ state: 'value', value: entries('English B', 'en_DE') })

  const english = publication(['parent']); english.feed.messages[0].attributes!.product_description = entries('English D', 'en_DE')
  m.read.mockResolvedValue(remote({ ...initial.feed.messages[0].attributes, product_description: [...entries('German C', 'de_DE'), ...entries('English B', 'en_DE')] }))
  const englishPlan = await prepareAmazonChanges(facts(['parent']), english, accepted)
  expect(defaults(englishPlan)).toEqual([publicationChangeId('parent', contentKey('product_description', 'en_DE'))])
  fold(compileAmazonChanges(englishPlan, defaults(englishPlan)))

  const clear = facts(['parent']); contentClear(clear, 'de', '')
  m.read.mockResolvedValue(remote({ ...initial.feed.messages[0].attributes, product_description: [...entries('German C', 'de_DE'), ...entries('English D', 'en_DE')] }))
  const clearPlan = await prepareAmazonChanges(clear, english, accepted)
  expect(defaults(clearPlan)).toEqual([publicationChangeId('parent', contentKey('product_description'))])
  fold(compileAmazonChanges(clearPlan, defaults(clearPlan)))
  expect(accepted.get(publicationChangeId('parent', contentKey('product_description')))).toEqual({ state: 'absent' })
  expect(accepted.get(publicationChangeId('parent', contentKey('product_description', 'en_DE')))).toEqual({ state: 'value', value: entries('English D', 'en_DE') })
})

it('merges a selected language clear and replacement into one root patch and two scoped intents', async () => {
  const input = facts(['parent']), pub = publication(['parent']), accepted = baseline(pub)
  contentClear(input, 'de', '')
  accepted.set(publicationChangeId('parent', 'product_description'), { state: 'value', value: [...entries('German old', 'de_DE'), ...entries('English old', 'en_DE')] })
  pub.feed.messages[0].attributes!.product_description = entries('English new', 'en_DE')
  m.read.mockResolvedValue(remote({ ...pub.feed.messages[0].attributes, product_description: [...entries('German old', 'de_DE'), ...entries('English old', 'en_DE'), ...entries('Unselected foreign', 'en_GB')] }))
  const plan = await prepareAmazonChanges(input, pub, accepted)
  expect(defaults(plan)).toHaveLength(2)
  const sent = compileAmazonChanges(JSON.parse(JSON.stringify(plan)), defaults(plan))
  expect(sent.feed.messages[0].patches).toEqual([{ op: 'replace', path: '/attributes/product_description', value: [...entries('English new', 'en_DE'), ...entries('Unselected foreign', 'en_GB')] }])
  expect(sent.fieldWrites?.parent).toEqual([
    { field: contentKey('product_description'), value: { state: 'absent' } },
    { field: contentKey('product_description', 'en_DE'), value: { state: 'value', value: entries('English new', 'en_DE') } },
  ])
})

it('refuses a language clear when the category selectors cannot isolate that language', async () => {
  const input = facts(['parent']), pub = publication(['parent']), definition = schema()
  ;(definition.validationSchema as any).properties.product_description.selectors = ['marketplace_id']
  m.spec.mockResolvedValue(definition)
  contentClear(input, 'de', '')
  m.read.mockResolvedValue(remote({ ...pub.feed.messages[0].attributes, product_description: [...entries('Same text', 'de_DE'), ...entries('Same text', 'en_DE')] }))
  const plan = await prepareAmazonChanges(input, pub, new Map())
  expect(plan.changes.find(c => c.field === contentKey('product_description'))).toMatchObject({ selectable: false, reason: expect.stringContaining('language_tag') })
})

// Build shape v2 P4 — Full update: one PATCH per SKU that replaces every root Nexus manages (unchanged ones included),
// deletes the managed roots Amazon holds and Nexus does not ("Will be removed"), and never touches price, offer or stock.
describe('Full update', () => {
  const full = (ids: string[]) => ({ fullProductIds: new Set(ids) })
  const withManaged = (pub: AmazonPublication, roots: Record<string, string[]>) =>
    Object.assign(pub, { full: Object.fromEntries(Object.entries(roots).map(([id, managedRoots]) => [id, { managedRoots }])) })
  const childRemote = (extra: Record<string, unknown> = {}) => m.read.mockImplementation(async ({ sku }) => remote({
    ...publication().feed.messages.find(msg => msg.sku === sku)?.attributes, ...(sku === 'SELLER-child' ? extra : {}) }))

  it('replaces every managed root of the Full row (unchanged ones too), removes what only Amazon holds, never the offer — the sibling stays Partial', async () => {
    const pub = withManaged(publication(), { child: ['brand', 'fabric_type'] }), accepted = baseline(pub)
    childRemote({ fabric_type: entries('Old material') })
    const plan = await prepareAmazonChanges(facts(), pub, accepted, full(['child']))
    const child = plan.changes.filter(c => c.productId === 'child')
    // D7 = A — the RRP (`list_price`, a root line since the sheet gaps) keeps its Partial tick on the Full row: not locked,
    // not re-sent while unchanged, never removed.
    expect(child.map(c => [c.field, c.status, !!c.locked, c.selectedByDefault])).toEqual([
      ['brand', 'SAME', true, true], ['fabric_type', 'DIFFERS', true, true], [contentKey('item_name'), 'SAME', true, true], ['list_price', 'SAME', false, false]])
    expect(child.find(c => c.field === 'fabric_type')?.reason).toBe('Full update removes it: Nexus holds no value here.')
    // The Partial sibling keeps today's ticks: an unchanged field is not sent.
    expect(plan.changes.filter(c => c.productId === 'parent').every(c => !c.locked && !c.selectedByDefault)).toBe(true)
    expect(plan.changes.some(c => ['purchasable_offer', 'fulfillment_availability'].includes(c.field))).toBe(false)
    expect(plan.removals).toEqual([{ productId: 'child', sku: 'SELLER-child', field: 'fabric_type', label: 'fabric_type', value: entries('Old material') }])
    const sent = compileSelection(JSON.parse(JSON.stringify(plan)), defaults(plan), 'review').prepared as AmazonPublication
    expect(sent.feed.messages).toEqual([{ messageId: 1, sku: 'SELLER-child', operationType: 'PATCH', productType: 'COAT', patches: [
      { op: 'replace', path: '/attributes/brand', value: entries('Brand') },
      { op: 'delete', path: '/attributes/fabric_type', value: [{ marketplace_id: 'MARKET' }] },
      { op: 'replace', path: '/attributes/item_name', value: entries('child title', 'de_DE') },
    ] }])
    expect(sent.fieldWrites?.child.map(w => [w.field, w.value.state])).toEqual([['brand', 'value'], ['fabric_type', 'absent'], [contentKey('item_name'), 'value']])
    expect(JSON.stringify(sent)).not.toMatch(/purchasable_offer|fulfillment_availability|list_price/)
  })

  it('🔴 never removes the RRP or the offer Amazon holds, even when Nexus holds none and the managed list names them', async () => {
    const pub = withManaged(publication(['child']), { child: ['brand', 'list_price', 'purchasable_offer', 'fulfillment_availability'] })
    for (const root of ['list_price', 'purchasable_offer', 'fulfillment_availability']) delete pub.feed.messages[0].attributes![root]
    childRemote({ list_price: entries('39'), purchasable_offer: entries('29'), fulfillment_availability: entries('5') })
    const plan = await prepareAmazonChanges(facts(['child']), pub, new Map(), full(['child']))
    expect(plan.removals).toBeUndefined()
    // No removal line is even offered (a tickable delete of the RRP would be one click from sending).
    expect(plan.changes.some(c => ['list_price', 'purchasable_offer', 'fulfillment_availability'].includes(c.field))).toBe(false)
    expect(plan.changes.filter(c => c.locked).map(c => c.field)).toEqual(['brand', contentKey('item_name')])
    const sent = compileSelection(JSON.parse(JSON.stringify(plan)), defaults(plan), 'review').prepared as AmazonPublication
    expect(JSON.stringify(sent)).not.toMatch(/purchasable_offer|fulfillment_availability|list_price/)
  })

  it('leaves a root Nexus does not manage exactly as Amazon holds it', async () => {
    const pub = withManaged(publication(), { child: ['brand'] })
    childRemote({ fabric_type: entries('Amazon only') })
    const plan = await prepareAmazonChanges(facts(), pub, baseline(pub), full(['child']))
    expect(plan.changes.some(c => c.field === 'fabric_type')).toBe(false)
    expect(plan.removals).toBeUndefined()
  })

  it('clears a language Nexus manages for this market and keeps other markets\' and unmanaged languages', async () => {
    const input = facts(); input.languages = ['de', 'en']
    const pub = withManaged(publication(), { child: [] })
    childRemote({ item_name: [...entries('child title', 'de_DE'), ...entries('English to remove', 'en_DE'), ...entries('UK English stays', 'en_GB'),
      { value: 'Other market', marketplace_id: 'OTHER', language_tag: 'de_DE' }] })
    const plan = await prepareAmazonChanges(input, pub, baseline(pub), full(['child']))
    expect(plan.removals).toEqual([{ productId: 'child', sku: 'SELLER-child', field: contentKey('item_name', 'en_DE'), label: 'item_name · en_DE', value: entries('English to remove', 'en_DE') }])
    const sent = compileSelection(plan, defaults(plan), 'review').prepared as AmazonPublication
    expect(sent.feed.messages[0].patches).toContainEqual({ op: 'replace', path: '/attributes/item_name', value: [
      ...entries('child title', 'de_DE'), ...entries('UK English stays', 'en_GB'), { value: 'Other market', marketplace_id: 'OTHER', language_tag: 'de_DE' }] })
  })

  it('a required root Amazon holds is never removed: the row says which fields stay as on Amazon', async () => {
    m.spec.mockResolvedValue(amazonSpecFromDefinition({ marketplace: 'DE', productType: 'COAT', schemaDefinition: { required: ['fabric_type'], properties: {
      item_name: rootSchema(true), brand: rootSchema(), fabric_type: rootSchema(), purchasable_offer: rootSchema() } } }))
    const pub = withManaged(publication(['child']), { child: ['brand', 'fabric_type'] })
    childRemote({ fabric_type: entries('Required on Amazon') })
    const plan = await prepareAmazonChanges(facts(['child']), pub, baseline(pub), full(['child']))
    expect(plan.changes.find(c => c.field === 'fabric_type')).toMatchObject({ selectable: false, reason: expect.stringContaining('required on Amazon') })
    expect(plan.removals).toBeUndefined()
    expect(plan.fullIssues).toEqual([expect.objectContaining({ sku: 'SELLER-child', severity: 'warning', message: expect.stringContaining('as Amazon holds it: fabric_type') })])
  })

  it.each([
    ['another product type', () => m.read.mockResolvedValue(remote(publication(['child']).feed.messages[0].attributes, 'SHOES')), 'Product type differs on Amazon — use Delete, then Publish.'],
    ['no live read', () => m.read.mockResolvedValue({ success: false, error: 'throttled' }), 'Amazon could not be read just now, so a Full update cannot be checked (throttled).'],
  ])('%s blocks the Full row by name; nothing of it can be ticked', async (_, arrange, sentence) => {
    arrange()
    const pub = withManaged(publication(['child']), { child: ['brand'] })
    const plan = await prepareAmazonChanges(facts(['child']), pub, baseline(pub), full(['child']))
    expect(plan.fullIssues).toEqual([{ productId: 'child', sku: 'SELLER-child', severity: 'error', message: expect.stringContaining(sentence) }])
    expect(plan.changes.every(c => !c.selectable && !c.locked)).toBe(true)
  })

  it('a Full row is sent whole or not at all: a partial tick is refused, no tick leaves it out', async () => {
    const pub = withManaged(publication(), { child: ['brand'] })
    const plan = await prepareAmazonChanges(facts(), pub, baseline(pub), full(['child']))
    const locked = plan.changes.filter(c => c.locked).map(c => c.id)
    expect(locked.length).toBeGreaterThan(1)
    expect(() => compileSelection(plan, locked.slice(1), 'review')).toThrow('SELLER-child: a Full update sends every field of this row. Tick all of them, or leave the row out.')
    expect(compileSelection(plan, [], 'review').prepared).toBeNull()
  })

  it('a NEW listing asked for Full is created whole, exactly as before', async () => {
    const input = facts(['parent']), pub = publication(['parent'])
    input.listings[0].externalListingId = null
    pub.feed.messages[0].operationType = 'UPDATE'
    m.read.mockResolvedValue({ success: true, sku: 'SELLER-parent', asin: null, status: null })
    const asked = await prepareAmazonChanges(input, JSON.parse(JSON.stringify(pub)), new Map(), full(['parent']))
    const plain = await prepareAmazonChanges(input, JSON.parse(JSON.stringify(pub)), new Map())
    expect(asked.changes).toEqual(plain.changes)
    expect(asked.products[0].full).toBeUndefined()
  })
})
