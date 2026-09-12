import { shopifyFieldTypes, type ShopifyContent, type ContentField, type ContentValue } from '@nexus/shared/shopify-content'
import { contentDestination, type ContentScope } from './content-workspace.service.js'
import { shopifyAdmin } from './admin-client.js'
import { toGid, shortId } from './content-publisher.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'

/** Read-only migration source. The operator assigns each old colour-product to an explicit Nexus scope. */
export async function importContentSource(productId: string, scope: ContentScope, sourceProductId: string) {
  const destination = await contentDestination(productId, scope)
  if (!/^(gid:\/\/shopify\/Product\/)?\d+$/.test(sourceProductId)) throw new WorkspaceScopeError('Enter the numeric Shopify source product ID.', 400)
  const { graphql: gql } = await shopifyAdmin(destination.accountId)
  const { product, shopLocales } = await gql(`query NexusImportSource($id:ID!) { product(id:$id) { id title media(first:250) { nodes { id alt mediaContentType ... on MediaImage { image { url } } } pageInfo { hasNextPage endCursor } } metafields(first:100) { nodes { id namespace key type value definition { name validations { name value } } } pageInfo { hasNextPage endCursor } } variants(first:50) { nodes { id sku selectedOptions { name value } } pageInfo { hasNextPage endCursor } } } shopLocales { locale primary published } }`, { id: toGid('Product', sourceProductId) })
  if (!product) throw new WorkspaceScopeError('This source product is not available in the selected Shopify account.', 404)
  for (const kind of ['metafields', 'variants']) {
    while (product[kind].pageInfo.hasNextPage && product[kind].nodes.length <= 250) {
      const selection = kind === 'metafields' ? 'id namespace key type value definition { name validations { name value } }' : 'id sku selectedOptions { name value }'
      const next = await gql(`query NexusImportPage($id:ID!,$after:String!) { product(id:$id) { ${kind}(first:100,after:$after) { nodes { ${selection} } pageInfo { hasNextPage endCursor } } } }`, { id: product.id, after: product[kind].pageInfo.endCursor })
      if (!next.product) throw new WorkspaceScopeError('The source changed while importing. No partial import was returned.', 422)
      product[kind].nodes.push(...next.product[kind].nodes); product[kind].pageInfo = next.product[kind].pageInfo
    }
    if (product[kind].nodes.length > 250) throw new WorkspaceScopeError('The source exceeds 250 variants or fields. No partial import was returned.', 422)
  }
  if ([product.media, product.metafields, product.variants].some(c => c.pageInfo.hasNextPage)) throw new WorkspaceScopeError('The source product exceeds the import limit. No partial import was returned.', 422)
  const warnings: string[] = [], fields: ContentField[] = [], values: Record<string, ContentValue> = {}, metaobjects: ShopifyContent['metaobjects'] = [], metaobjectDefinitions: ShopifyContent['metaobjectDefinitions'] = []
  const locales = shopLocales.filter((l: any) => l.published).map((l: any) => l.locale), defaultLocale = shopLocales.find((l: any) => l.primary)?.locale ?? 'it'
  const seen = new Set<string>(), types = new Map<string, string>()
  const fieldType = (type: string) => shopifyFieldTypes.includes(type as ContentField['type'])
  async function resolveDefinition(id: string, supplied?: any): Promise<string> {
    const cached = types.get(id)
    if (cached) return cached
    if (types.size >= 40) throw new WorkspaceScopeError('The source references more than 40 reusable entry types. No partial import was returned.', 422)
    const remote = supplied ?? (await gql(`query NexusReferenceType($id:ID!) { node(id:$id) { ... on MetaobjectDefinition { id name type fieldDefinitions { key name type { name } validations { name value } } } } }`, { id })).node
    if (!remote?.type || !remote.fieldDefinitions) throw new WorkspaceScopeError('A referenced metaobject definition is unavailable. No partial import was returned.', 422)
    types.set(id, remote.type)
    const definition: ShopifyContent['metaobjectDefinitions'][number] = { type: remote.type, name: remote.name, fields: [] }
    metaobjectDefinitions.push(definition)
    for (const f of remote.fieldDefinitions) {
      if (!fieldType(f.type.name)) { warnings.push(`${remote.type}.${f.key}: unsupported ${f.type.name}; preserved on Shopify but not editable here.`); continue }
      const validation = f.validations.find((v: any) => v.name === 'metaobject_definition_id')
      const metaobjectType = validation ? await resolveDefinition(validation.value) : undefined
      definition.fields.push({ key: f.key, label: f.name, type: f.type.name, ...(metaobjectType ? { metaobjectType } : {}) })
    }
    return remote.type
  }
  async function translations(id: string, key: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const locale of locales.filter((l: string) => l !== defaultLocale)) {
      const data = await gql(`query NexusImportTranslation($id:ID!,$locale:String!) { translatableResource(resourceId:$id) { translations(locale:$locale) { key value outdated } } }`, { id, locale })
      const found = data.translatableResource?.translations.find((t: any) => t.key === key && !t.outdated)
      if (found) out[locale] = found.value
    }
    return out
  }
  async function resolveMetaobject(id: string): Promise<string> {
    const localId = `shopify-${shortId(id)}`
    if (seen.has(id)) return localId
    if (seen.size >= 250) throw new WorkspaceScopeError('The source references more than 250 reusable entries. No partial import was returned.', 422)
    seen.add(id)
    const { metaobject: entry } = await gql(`query NexusImportEntry($id:ID!) { metaobject(id:$id) { id type handle fields { key type value } definition { id name type fieldDefinitions { key name type { name } validations { name value } } } } }`, { id })
    if (!entry) throw new WorkspaceScopeError('A referenced metaobject is unavailable. No partial import was returned.', 422)
    await resolveDefinition(entry.definition.id, entry.definition)
    const stored = { id: localId, type: entry.type, handle: entry.handle, fields: {} as Record<string, ContentValue> }
    metaobjects.push(stored)
    for (const f of entry.fields) {
      if (!fieldType(f.type)) continue
      stored.fields[f.key] = { value: await convertReferences(f.type, f.value), translations: ['single_line_text_field', 'multi_line_text_field', 'rich_text_field'].includes(f.type) ? await translations(id, f.key) : {} }
    }
    return localId
  }
  async function convertReferences(type: string, value: string): Promise<string> {
    if (type === 'metaobject_reference') return `@metaobject:${await resolveMetaobject(value)}`
    if (type === 'list.metaobject_reference') return JSON.stringify(await Promise.all((JSON.parse(value) as string[]).map(async id => `@metaobject:${await resolveMetaobject(id)}`)))
    return value
  }
  for (const f of product.metafields.nodes) {
    if (f.namespace === 'nexus' || f.namespace.startsWith('shopify') || ['variation_products', 'variation_value'].includes(f.key)) continue
    if (!fieldType(f.type)) { warnings.push(`${f.namespace}.${f.key}: unsupported ${f.type}; preserved on Shopify.`); continue }
    let metaobjectType: string | undefined
    const validation = f.definition?.validations.find((v: any) => v.name === 'metaobject_definition_id')
    if (validation) metaobjectType = await resolveDefinition(validation.value)
    const value = await convertReferences(f.type, f.value)
    fields.push({ namespace: f.namespace, key: f.key, label: f.definition?.name ?? f.key, type: f.type, ...(metaobjectType ? { metaobjectType } : {}) })
    values[`${f.namespace}.${f.key}`] = { value, translations: ['single_line_text_field', 'multi_line_text_field', 'rich_text_field'].includes(f.type) ? await translations(f.id, 'value') : {} }
  }
  return { sourceProductId: product.id, title: product.title, defaultLocale, locales, fields, values, metaobjectDefinitions, metaobjects, warnings,
    assets: product.media.nodes.filter((m: any) => m.mediaContentType === 'IMAGE' && m.image?.url).map((m: any) => ({ id: `shopify-image-${shortId(m.id)}`, url: m.image.url, alt: m.alt ?? '', translations: {} })),
    sourceVariants: product.variants.nodes,
  }
}
