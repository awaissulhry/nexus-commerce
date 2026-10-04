import { beforeEach, expect, it, vi } from 'vitest'
import type { StudioPublishValue } from '@nexus/shared/studio-publication'
import type { PublicationFacts } from './studio-publication-plan.js'
import type { AmazonPublication } from './studio-publication-amazon.js'
const provider = vi.hoisted(() => ({ read: vi.fn(), spec: vi.fn(), bound: vi.fn() }))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({ AmazonSpApiClient: class { constructor(account: unknown) { provider.bound(account) }; getListingsItem = provider.read } }))
vi.mock('../../lib/amazon-sp-client.js', () => ({ getAmazonRegion: async () => 'eu' }))
vi.mock('./channel-specs/index.js', () => ({ loadAmazonSpec: provider.spec }))
import { amazonImmutableDraftWarning } from './amazon-draft-policy.js'
import { amazonSpecFromDefinition } from './channel-specs/amazon.js'
import { publicationChangeId } from './studio-publication-changes.js'
import { prepareAmazonChanges, compileAmazonChanges } from './studio-publication-amazon-changes.js'

const existing = { channel: 'AMAZON', externalListingId: 'SYNTHETIC-ASIN', editableOnExisting: false }
it.each(['brand', 'condition_type', 'externally_assigned_product_identifier', 'externally_assigned_product_identifier__type'])('allows a %s draft with the exact existing-listing warning', fieldKey => {
  expect(amazonImmutableDraftWarning({ ...existing, fieldKey })).toBe(`${fieldKey.split('__')[0]} cannot be edited on an existing Amazon listing. You can save a draft here, but cannot publish this change.`)
})
it.each(['sku', 'externalListingId', 'externalParentId', 'platformProductId', 'parentId', '__productRole', '__parentSku', 'parentage_level', 'merchant_suggested_asin', 'brand__unknown', 'unknown', 'condition_type__value',
  // Item 12 (2026-10-05): read-only family values, never drafts.
  'child_parent_sku_relationship__child_relationship_type', 'child_parent_sku_relationship__parent_sku'])('does not unlock protected or unclassified %s', fieldKey => {
  expect(amazonImmutableDraftWarning({ ...existing, fieldKey })).toBeNull()
})
it('gives no draft warning for a parent-SKU leaf: it is a read-only family value (Item 12), not a draft', () => {
  expect(amazonImmutableDraftWarning({ ...existing, fieldKey: 'child_parent_sku_relationship__parent_sku', editableOnExisting: true, rootImmutable: true })).toBeNull()
})
it.each([{ externalListingId: null }, { externalListingId: '' }, { editableOnExisting: true }, { editableOnExisting: undefined }, { channel: 'EBAY' }, { channel: undefined }])('does not apply an Amazon update warning outside its scope: %j', change => {
  expect(amazonImmutableDraftWarning({ ...existing, fieldKey: 'brand', ...change })).toBeNull()
})

beforeEach(() => { vi.clearAllMocks() })
it.each([
  ...['brand', 'condition_type', 'externally_assigned_product_identifier', 'child_parent_sku_relationship'].map(field => ({ field, immutable: true })),
  { field: 'child_parent_sku_relationship', immutable: false },
])('offline publish follows the category for $field (immutable root: $immutable)', async ({ field, immutable }) => {
  const leafKeys = field === 'externally_assigned_product_identifier' ? ['value', 'type']
    : field === 'child_parent_sku_relationship' ? ['parent_sku', ...(immutable ? ['child_relationship_type'] : [])] : ['value']
  const productType = immutable ? 'COAT' : 'E2E_RELATION_EDITABLE'
  const entries = (value: string) => [{ ...Object.fromEntries(leafKeys.map(key => [key, key === 'child_relationship_type' ? 'variation' : value])), marketplace_id: 'SYNTHETIC-MARKET' }]
  const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType, schemaDefinition: { properties: {
    [field]: { type: 'array', maxItems: 1, selectors: ['marketplace_id'], items: { type: 'object', properties: {
      marketplace_id: { const: 'SYNTHETIC-MARKET' }, ...Object.fromEntries(leafKeys.map(key => [key, { type: 'string', editable: key === 'parent_sku' || !immutable }])),
    } } },
  } } })
  provider.spec.mockResolvedValue(spec)
  provider.read.mockResolvedValue({ success: true, rawResponse: { sku: 'SELLER-SKU', attributes: { [field]: entries('Before') }, summaries: [{ marketplaceId: 'SYNTHETIC-MARKET', productType }] } })
  const facts = { scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'selected-account' }, destination: { aliasKey: '' },
    parent: { id: 'product', sku: 'LOCAL-SKU' }, products: [{ id: 'product', sku: 'LOCAL-SKU' }], listings: [{ id: 'listing', productId: 'product', externalListingId: 'SYNTHETIC-ASIN' }],
  } as unknown as PublicationFacts
  const pub: AmazonPublication = { kind: 'amazon', sellerId: 'SYNTHETIC-SELLER', marketplaceId: 'SYNTHETIC-MARKET', products: [{ productId: 'product', sku: 'SELLER-SKU' }],
    feed: { header: { sellerId: 'SYNTHETIC-SELLER', version: '2.0' }, messages: [{ messageId: 1, sku: 'SELLER-SKU', operationType: 'PARTIAL_UPDATE', productType, attributes: { [field]: entries('Draft') } }] } }
  const id = publicationChangeId('product', field)
  const baseline = new Map<string, StudioPublishValue>([[id, { state: 'value', value: entries('Before') }]])
  const plan = await prepareAmazonChanges(facts, pub, baseline)
  if (immutable) {
    expect(plan.changes.find(change => change.id === id)).toMatchObject({ selectable: false, selectedByDefault: false, reason: `${field} cannot be edited on an existing Amazon listing.`, current: { state: 'value', value: entries('Draft') } })
    expect(() => compileAmazonChanges(plan, [id])).toThrow(`${field} cannot be edited on an existing Amazon listing.`)
  } else {
    expect(plan.changes.find(change => change.id === id)).toMatchObject({ selectable: true, selectedByDefault: true, current: { state: 'value', value: entries('Draft') } })
    expect(compileAmazonChanges(plan, [id]).feed.messages[0].patches).toEqual([{ op: 'replace', path: `/attributes/${field}`, value: entries('Draft') }])
  }
  expect(compileAmazonChanges(plan, []).feed.messages).toEqual([])
  expect(provider.bound).toHaveBeenCalledWith({ id: 'selected-account', region: 'eu' })
  expect(provider.read).toHaveBeenCalledWith({ sellerId: 'SYNTHETIC-SELLER', sku: 'SELLER-SKU', marketplaceId: 'SYNTHETIC-MARKET', includedData: ['summaries', 'attributes'] })
})
