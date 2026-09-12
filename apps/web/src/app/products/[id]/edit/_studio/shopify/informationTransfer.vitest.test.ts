import { describe, expect, it } from 'vitest'
import { informationRegistry } from '@nexus/shared/shopify-information'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import { decodeInformationTransfer, encodeInformationTransfer, informationClipboardMatrix } from './informationTransfer'
const schema: ShopifyStoreSchema = { definitions: [{ id: 'dimension', namespace: 'custom', key: 'size', name: 'Size', ownerType: 'PRODUCT', type: 'dimension', validations: [], readOnlyReason: null, description: null, access: { admin: null, storefront: null } }], metaobjectDefinitions: [], types: [], locales: [], revision: 'fixture' }
const fields = informationRegistry(schema), dimension = fields.find(f => f.definition)!, title = fields.find(f => f.id === 'title')!
describe('Shopify typed grid transfer', () => {
  it('preserves structured metadata and permits only the same type and store', () => {
    const raw = '{"value":0,"unit":"centimeters","metadata":{"id":9007199254740993}}'
    const copied = encodeInformationTransfer(dimension, raw, 'store-a')
    expect(decodeInformationTransfer(copied, dimension, 'store-a')).toEqual({ value: raw })
    expect(decodeInformationTransfer(copied, dimension, 'store-b').error).toContain('another store')
    expect(decodeInformationTransfer(copied, title, 'store-a').error).toContain('incompatible')
  })
  it('refuses media and raw reference envelopes in ordinary text cells', () => {
    for (const raw of ['NEXUS_MEDIA_V1:{}', 'gid://shopify/MediaImage/1']) expect(decodeInformationTransfer(raw, title, 'store-a').error).toBeTruthy()
    expect(decodeInformationTransfer('Ordinary text', title, 'store-a')).toEqual({ value: 'Ordinary text' })
  })
  it('keeps clear distinct from an empty text value and preserves quoted TSV cells', () => {
    expect(decodeInformationTransfer(encodeInformationTransfer(title, null, 'store-a'), title, 'store-a')).toEqual({ value: null })
    expect(decodeInformationTransfer('', title, 'store-a')).toEqual({ value: '' })
    expect(informationClipboardMatrix('"line one\nline two"\t"a""b"\t\r\nnext\t0\tfalse')).toEqual([['line one\nline two', 'a"b', ''], ['next', '0', 'false']])
  })
})
