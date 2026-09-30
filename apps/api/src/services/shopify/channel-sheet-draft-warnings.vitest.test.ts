import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyInformationCells } from '@nexus/shared/shopify-information-editing'
import { informationRegistry, type InformationRow } from '@nexus/shared/shopify-information'
import { emptyShopifyLinkedDraft, type ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import type { ShopifyGraphql } from './admin-client.js'

const state = vi.hoisted(() => ({ schema: null as unknown as ShopifyStoreSchema, baseline: 'old' }))
vi.mock('./linked-products-gateway.js', async original => ({
  ...await original<object>(),
  readLinkedStoreSchema: async () => state.schema,
  readLinkedProducts: async () => [],
  readLinkedFields: async (_gql: unknown, addresses: Array<{ ownerId: string; namespace: string; key: string }>) =>
    addresses.map(address => ({ ...address, type: state.schema.definitions[0].type, value: state.baseline, compareDigest: 'baseline' })),
}))
import { buildLinkedPlan } from './linked-products.service.js'

const productId = 'gid://shopify/Product/10'
const resourceId = 'gid://shopify/Metafield/12'
const fieldId = 'metafield:PRODUCT:custom.label'
const definition = { id: 'gid://shopify/MetafieldDefinition/1', namespace: 'custom', key: 'label', name: 'Label',
  ownerType: 'PRODUCT', type: 'single_line_text_field', required: true, validations: [{ name: 'max', value: '3' }],
  description: null, access: { admin: null, storefront: null } }
const row = (): InformationRow => ({ id: productId, productId, kind: 'PRODUCT', title: 'Rain jacket', handle: 'rain-jacket',
  image: null, media: [], values: {}, fields: [{ id: resourceId, ownerId: productId, namespace: 'custom', key: 'label',
    type: state.schema.definitions[0].type, value: state.baseline, compareDigest: 'baseline' }] })

beforeEach(() => {
  state.baseline = 'old'
  state.schema = { revision: 'synthetic-store-1', definitions: [definition], metaobjectDefinitions: [], types: [{ name: definition.type, category: 'TEXT' }],
    locales: [{ locale: 'en', primary: true, published: true }, { locale: 'it', primary: false, published: true }],
    native: { scopes: ['read_products', 'write_products', 'read_translations', 'write_translations'], inputs: {}, enums: {} } }
})

describe('draft warnings keep the real offline publish gate strict', () => {
  it.each(['', '   ', null])('refuses blank native title %j at the actual offline publish gate', async value => {
    state.schema.native!.inputs.product = ['title']
    const draft = { ...emptyShopifyLinkedDraft(), informationOnly: true as const,
      members: [{ id: productId, title: 'Rain jacket', handle: 'rain-jacket', image: null }],
      nativeEdits: [{ ownerId: productId, productId, ownerLabel: 'Rain jacket', field: 'title' as const, value: 'Rain jacket', nextValue: value }],
    }
    const gql = vi.fn(async () => { throw new Error('Unexpected provider request') })
    await expect(buildLinkedPlan(gql, draft)).rejects.toThrow(value === null ? 'Enter a value for this field.' : 'Product title is required.')
    expect(gql).not.toHaveBeenCalled()
  })
  it.each([
    ['single_line_text_field', 'choices', '["ahead","only manual"]', 'old', 'maybe', 'Choose one of these values: ahead, only manual.'],
    ['list.single_line_text_field', 'list.max', '10', '["old"]', JSON.stringify(Array.from({ length: 11 }, (_, i) => `w${i}`)), 'Use 10 values or fewer. Remove 1.'],
    ['number_integer', 'min', '0', '0', '-1', 'Enter 0 or more.'],
  ])('keeps the strict %s publish refusal after saving its warning', async (type, rule, limit, baseline, value, sentence) => {
    state.baseline = baseline
    state.schema.definitions = [{ ...definition, type, validations: [{ name: rule, value: limit }] }]
    state.schema.types = [{ name: type, category: 'SYNTHETIC' }]
    const owner = row(), field = informationRegistry(state.schema).find(f => f.id === fieldId)!
    const draft = applyInformationCells(emptyShopifyLinkedDraft(), [{ row: owner, field, value }], [owner], false)
    expect(draft.edits[0]).toMatchObject({ type, value: baseline, nextValue: value })
    const gql = vi.fn(async () => { throw new Error('Unexpected provider request') })
    const refusal = await buildLinkedPlan(gql, draft).then(() => null, error => error as Error)
    expect(refusal?.message).toBe(`Rain jacket / Label: ${sentence}`)
    expect(gql).not.toHaveBeenCalled()
  })
  it.each(['four', '', null])('stores %j unchanged but refuses its publish plan', async value => {
    const owner = row(), field = informationRegistry(state.schema).find(f => f.id === fieldId)!
    const draft = applyInformationCells(emptyShopifyLinkedDraft(), [{ row: owner, field, value }], [owner], false)
    expect(draft.edits[0]).toMatchObject({ value: 'old', nextValue: value })
    const gql = vi.fn(async () => { throw new Error('Unexpected provider request') })
    await expect(buildLinkedPlan(gql, draft)).rejects.toThrow(value === null ? 'Shopify needs this field' : value === '' ? 'Enter one line of text, or clear the field.' : 'Use 3 characters or fewer')
    expect(gql).not.toHaveBeenCalled()
    expect(draft.edits[0].nextValue).toBe(value)
  })

  it('stores an overlength translation but the complete publish plan refuses it before a mutation', async () => {
    const owner: InformationRow = { ...row(), locale: 'it', translations: { [fieldId]: {
      resourceId, fieldId, key: 'value', locale: 'it', digest: 'source-1', value: 'old', sourceValue: 'old', outdated: false,
    } } }
    const field = informationRegistry(state.schema).find(f => f.id === fieldId)!
    const draft = applyInformationCells(emptyShopifyLinkedDraft(), [{ row: owner, field, value: 'four' }], [owner], false)
    expect(draft.nativeEdits?.[0]).toMatchObject({ nextValue: 'four', translation: { locale: 'it', resourceId } })
    const gql = vi.fn(async (query: string) => {
      if (query.includes('NexusInformationTranslations(')) return { translatableResourcesByIds: { nodes: [{ resourceId,
        translatableContent: [{ key: 'value', value: 'old', digest: 'source-1', locale: 'en' }],
        translations: [{ key: 'value', value: 'old', locale: 'it', market: null }],
      }], pageInfo: { hasNextPage: false } } }
      if (query.includes('NexusInformationTranslationOwners')) return { nodes: [{ id: resourceId, namespace: 'custom', key: 'label',
        type: definition.type, owner: { id: productId } }] }
      throw new Error('Unexpected provider request')
    })
    await expect(buildLinkedPlan(gql as ShopifyGraphql, draft)).rejects.toThrow('Use 3 characters or fewer')
    expect(gql.mock.calls.length).toBeGreaterThan(0)
    expect(gql.mock.calls.every(([query]) => !query.includes('mutation'))).toBe(true)
    expect(draft.nativeEdits?.[0].nextValue).toBe('four')
  })
})
