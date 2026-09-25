import { beforeEach, expect, it, vi } from 'vitest'
import type { StudioPublishValue } from '@nexus/shared/studio-publication'
import type { PublicationFacts } from './studio-publication-plan.js'
import type { AmazonPublication } from './studio-publication-amazon.js'
const m = vi.hoisted(() => ({ read: vi.fn(), spec: vi.fn(), bound: vi.fn() }))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({ AmazonSpApiClient: class { constructor(account: unknown) { m.bound(account) }; getListingsItem = m.read } }))
vi.mock('../../lib/amazon-sp-client.js', () => ({ getAmazonRegion: async () => 'eu' }))
vi.mock('./channel-specs/index.js', () => ({ loadAmazonSpec: m.spec }))
import { amazonSpecFromDefinition } from './channel-specs/amazon.js'
import { publicationChangeId } from './studio-publication-changes.js'
import { prepareAmazonChanges, compileAmazonChanges } from './studio-publication-amazon-changes.js'

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
  expect(plan.changes.some(c => ['purchasable_offer', 'fulfillment_availability', 'list_price'].includes(c.field))).toBe(false)
  expect(defaults(plan)).toEqual([publicationChangeId('child', 'brand')])
  const sent = compileAmazonChanges(JSON.parse(JSON.stringify(plan)), defaults(plan))
  expect(sent.products).toEqual([{ productId: 'child', sku: 'SELLER-child' }])
  expect(sent.feed.messages).toEqual([{ messageId: 1, sku: 'SELLER-child', operationType: 'PATCH', productType: 'COAT', patches: [{ op: 'replace', path: '/attributes/brand', value: entries('Changed brand') }] }])
  expect(sent.fieldWrites).toEqual({ child: [{ field: 'brand', value: { state: 'value', value: entries('Changed brand') } }] })
  expect(m.bound).toHaveBeenCalledWith({ id: 'selected-account', region: 'eu' })
  expect(m.read).toHaveBeenCalledWith({ sellerId: 'SELLER', sku: 'SELLER-child', marketplaceId: 'MARKET', includedData: ['summaries', 'attributes'] })
})

it('no accepted baseline shows differences unticked, and no selected IDs submits no messages', async () => {
  const pub = publication(); pub.feed.messages[1].attributes!.brand = entries('Changed')
  const plan = await prepareAmazonChanges(facts(), pub, new Map())
  expect(plan.changes.find(c => c.productId === 'child' && c.field === 'brand')).toMatchObject({ status: 'DIFFERS', selectable: true, selectedByDefault: false })
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
  m.read.mockResolvedValue(remote({ brand: entries('Brand'), item_name: [...entries('English before', 'en_GB'), ...entries('German to preserve', 'de_DE')] }))
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

it('first-publish authored blank content clears only its requested language after an explicit tick', async () => {
  const input = facts(['parent']), pub = publication(['parent'])
  contentClear(input, 'de', '')
  m.read.mockResolvedValue(remote({ ...pub.feed.messages[0].attributes, product_description: [...entries('Old German', 'de_DE'), ...entries('Keep English', 'en_GB')] }))
  const plan = await prepareAmazonChanges(input, pub, new Map())
  const change = plan.changes.find(c => c.field === contentKey('product_description'))!
  expect(change).toMatchObject({ current: { state: 'absent' }, status: 'DIFFERS', selectable: true, selectedByDefault: false })
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
  expect(change).toMatchObject({ status: 'DIFFERS', selectable: true, selectedByDefault: false })
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
