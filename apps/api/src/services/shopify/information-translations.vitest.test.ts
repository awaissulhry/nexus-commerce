import { describe, expect, it } from 'vitest'
import { applyInformationTranslation, verifyTranslationEdits } from './information-translations.js'
import type { NativeEdit } from '@nexus/shared/shopify-information'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
const productId = 'gid://shopify/Product/1'
const schema: ShopifyStoreSchema = { definitions: [], metaobjectDefinitions: [], types: [], locales: [{ locale: 'en', primary: true, published: true }, { locale: 'it', primary: false, published: true }], revision: '1' }
function setup() {
  const translations = [{ key: 'title', value: 'Giacca', locale: 'it', market: null }, { key: 'title', value: 'Mercato', locale: 'it', market: { id: 'gid://shopify/Market/1' } }, { key: 'title', value: 'Jacke', locale: 'de', market: null }]
  let digest = 'source-1'; const writes: any[] = []
  const gql = async (query: string, vars: any) => {
    if (query.includes('NexusInformationTranslations(')) return { translatableResourcesByIds: { nodes: [{ resourceId: productId, translatableContent: [{ key: 'title', value: 'Jacket', digest, locale: 'en' }], translations: translations.filter(t => t.locale === vars.locale) }], pageInfo: { hasNextPage: false } } }
    if (query.includes('NexusInformationTranslationOwners')) return { nodes: [{ id: productId }] }
    writes.push({ query, vars })
    if (query.includes('NexusInformationTranslationSet')) { for (const value of vars.translations) translations.find(t => t.key === value.key && t.locale === value.locale && t.market === null)!.value = value.value; return { translationsRegister: { userErrors: [] } } }
    if (query.includes('NexusInformationTranslationRemove')) { const i = translations.findIndex(t => t.key === vars.keys[0] && t.locale === vars.locales[0] && t.market === null); translations.splice(i, 1); return { translationsRemove: { userErrors: [] } } }
    throw new Error(query)
  }
  const edit: NativeEdit = { ownerId: productId, productId, ownerLabel: 'Jacket', field: 'translation', value: 'Giacca', nextValue: 'Giacca nuova', translation: { resourceId: productId, fieldId: 'title', key: 'title', locale: 'it', digest } }
  return { gql: gql as any, translations, writes, edit, sourceChanged: () => { digest = 'source-2' } }
}
describe('Exact Shopify translation destination', () => {
  it('writes only the requested key and locale with its current source digest', async () => {
    const s = setup(); await applyInformationTranslation(s.gql, s.edit, schema)
    expect(s.writes[0].vars).toEqual({ id: productId, translations: [{ key: 'title', locale: 'it', value: 'Giacca nuova', translatableContentDigest: 'source-1' }] })
    expect(s.translations.map(t => t.value)).toEqual(['Giacca nuova', 'Mercato', 'Jacke'])
  })
  it('clears through translationsRemove, preserving other locale and market records in the simulated API', async () => {
    const s = setup(); await applyInformationTranslation(s.gql, { ...s.edit, nextValue: null }, schema)
    expect(s.writes[0].vars).toEqual({ id: productId, keys: ['title'], locales: ['it'] }); expect(s.translations.map(t => t.value)).toEqual(['Mercato', 'Jacke'])
  })
  it('rejects a changed source digest or another owner before mutation', async () => {
    const s = setup(); await expect(verifyTranslationEdits(s.gql, [{ ...s.edit, productId: 'gid://shopify/Product/2' }], schema)).rejects.toThrow('another product')
    s.sourceChanged(); await expect(applyInformationTranslation(s.gql, s.edit, schema)).rejects.toThrow('source content changed'); expect(s.writes).toEqual([])
  })
  it('reconciles an already-applied translation without another mutation', async () => {
    const s = setup(); s.translations[0].value = s.edit.nextValue!; await applyInformationTranslation(s.gql, s.edit, schema); expect(s.writes).toEqual([])
  })
  it('retains intended text after a conflicting translated value', async () => {
    const s = setup(); s.translations[0].value = 'Another editor'; await expect(applyInformationTranslation(s.gql, s.edit, schema)).rejects.toThrow('retained'); expect(s.edit.nextValue).toBe('Giacca nuova'); expect(s.writes).toEqual([])
  })
})
