import { informationRegistry, nativeTranslationKeys, shopifyMappingFieldKey } from '@nexus/shared/shopify-information'
import type { ShopifyStoreSchema } from '@nexus/shared/shopify-linked-products'
import type { ChannelFieldSpec, ChannelGroup, ChannelSpec, ChannelStore } from './types.js'

/** Store product information. Source references and scope are recorded in the audit. */
const groups: ChannelGroup[] = ['Content', 'Classification', 'Search', 'Offer', 'Shipping', 'Policies']
  .map((label, order) => ({ key: label.toLowerCase(), label, channelLabel: null, order }))
const pa = (...path: string[]): ChannelStore => ({ kind: 'platformAttributes', path })
const column = (column: string, followFlag?: string): ChannelStore => ({ kind: 'listingColumn', column, followFlag })
function field(key: string, label: string, group: string, extra: Partial<ChannelFieldSpec> = {}): ChannelFieldSpec {
  return { key, attribute: key, path: [], label, englishLabel: label, kind: 'text', shape: 'scalar',
    cardinality: { min: 0, max: 1 }, requirement: 'optional', requiredInParent: false,
    editable: true, hidden: false, variantEligible: false, group: groups.find(g => g.key === group)!,
    channelStore: pa(key), ...extra }
}
const titleStore = column('title', 'followMasterTitle')
const descriptionStore = column('description', 'followMasterDescription')

/** The information sheet and mapping catalogue consume the same native/live registry. */
export function shopifyProductSpec(schema: ShopifyStoreSchema | null = null, accountId?: string | null, locale?: string): ChannelSpec {
  if (schema && !accountId) throw new Error('A Shopify definition requires its connected store identity.')
  if (locale) locale = schema?.locales.find(l => l.locale.toLowerCase() === locale!.toLowerCase())?.locale ?? locale.toLowerCase()
  const primaryLocale = schema?.locales.find(l => l.primary)?.locale
  const translationLocale = locale && locale !== 'und' && primaryLocale && locale !== primaryLocale ? locale : null
  if (translationLocale && !schema?.locales.some(l => l.locale === translationLocale)) throw new Error('This language is not enabled in the selected Shopify store.')
  const native: Record<string, Partial<ChannelFieldSpec>> = {
    title: { masterKey: 'name', requirement: 'required', channelStore: titleStore },
    descriptionHtml: { masterKey: 'description', channelStore: descriptionStore },
    vendor: { masterKey: 'brand', channelStore: { kind: 'platformAttributes', path: ['vendor'], legacyPaths: [['shopifyVendor']] } },
    productType: { masterKey: 'shopify_product_type', channelStore: { kind: 'platformAttributes', path: ['productType'], legacyPaths: [['shopifyProductType']] } },
    price: { masterKey: 'basePrice', channelStore: column('price', 'followMasterPrice'), validation: { minimum: 0 } },
    cost: { masterKey: 'costPrice', validation: { minimum: 0 } },
    sku: { defaultRule: { source: 'sku' } },
    countryCodeOfOrigin: { masterKey: 'countryOfOrigin', validation: { pattern: '^[A-Z]{2}$' } },
    harmonizedSystemCode: { masterKey: 'hsCode' },
    weight: { shape: 'measure', kind: 'number', unitOptions: ['g', 'kg', 'oz', 'lb'],
      defaultRule: { source: 'weightValue', transforms: [{ type: 'expr', expr: 'measure($weightValue, $weightUnit, "g|kg|oz|lb")' }] } },
    compareAtPrice: { validation: { minimum: 0 }, channelStore: { kind: 'platformAttributes', path: ['compareAtPrice'], legacyPaths: [['shopifyCompareAtPrice']] } },
    inventoryPolicy: { kind: 'select', mode: 'strict', options: schema?.native?.enums.inventoryPolicy?.map(choice => choice.name) ?? [] },
    category: { validation: { pattern: '^gid://shopify/TaxonomyCategory/[a-zA-Z0-9-]+$' } },
    handle: { validation: { pattern: '^[a-zA-Z0-9-]+$' } },
    tags: { validation: { uniqueItems: true }, maxLength: 255 },
  }
  const fields = informationRegistry(schema).flatMap(info => {
    const key = shopifyMappingFieldKey(info, accountId ?? '')
    const baseType = info.type.replace(/^list\./, '')
    const kind = ['number_integer', 'number_decimal', 'money'].includes(baseType) ? 'number'
      : baseType === 'boolean' ? 'boolean' : ['date', 'date_time'].includes(baseType) ? 'date'
      : ['multi_line_text_field', 'rich_text_field', 'json'].includes(baseType) ? 'longtext' : 'text'
    const group = { key: info.group.toLowerCase().replace(/ /g, '_'), label: info.group, channelLabel: null,
      order: ['General', 'Publishing', 'Pricing', 'Inventory', 'Shipping', 'SEO', 'Metafields', 'Category Metafields'].indexOf(info.group) }
    const entry = field(key, info.label, 'content', {
      attribute: info.id, kind, group, shopifyField: info,
      shape: info.cardinality, cardinality: { min: 0, max: info.cardinality === 'list' ? null : 1 },
      variantEligible: info.owner === 'PRODUCTVARIANT',
      channelStore: info.definition ? pa('metafields', info.owner, info.definition.namespace, info.definition.key, info.type)
        : pa(...info.id.split('.')),
      helpText: info.definition ? `${info.owner === 'PRODUCT' ? 'Product' : 'Variant'} · ${info.source}. ${info.definition.description ?? ''}`.trim()
        : [info.channelLabel !== info.label ? `Shopify: ${info.channelLabel}.` : '', info.reason].filter(Boolean).join(' ') || undefined,
      // Media and stock require a published Shopify resource; their native workspace
      // owns exact file and stocking-location identities after publication.
      readOnlyReason: info.reason ?? (info.id === 'media' ? 'Use the media workspace to manage product media.' : undefined),
      editable: !info.reason,
      ...(native[info.id] ?? {}),
    })
    if (translationLocale) {
      const translatable = info.definition ? ['single_line_text_field', 'multi_line_text_field', 'rich_text_field', 'json', 'url', 'link', 'list.single_line_text_field', 'list.url', 'list.link'].includes(info.type) : !!nativeTranslationKeys[info.id]
      const reason = info.reason ?? (!translatable ? 'Shopify shares this field across languages. Select the store’s primary language to edit its base value.'
        : !schema?.native?.scopes.includes('write_translations') ? 'This Shopify connection needs write_translations permission.' : undefined)
      entry.channelStore = pa('_shopifyInformationLocales', translationLocale, info.id)
      entry.readOnlyReason = reason
      entry.editable = !reason
      entry.shopifyField = { ...info, reason }
      entry.helpText = `${translationLocale} translation. Clearing restores the primary-language value. Shopify translatability is verified against the created resource before synchronization.`
    }
    return info.id === 'inventory'
      ? [{ key: 'availableQuantity', label: 'Available quantity' }, { key: 'onHandQuantity', label: 'On hand quantity' }]
        .map(quantity => ({ ...entry, ...quantity, englishLabel: quantity.label, attribute: quantity.key, kind: 'number' as const, channelStore: pa(quantity.key), editable: false,
          readOnlyReason: 'This draft has no Shopify inventory item or stocking locations. Publish it, then edit inventory by location in Shopify Information.' }))
      : [entry]
  })
  const result = spec('SHOPIFY', fields)
  result.groups = [...new Map(fields.map(f => [f.group!.key, f.group!])).values()]
  result.schemaVersion = schema?.revision ?? 'shopify-native-mapping-2026-09-10'
  // Shopify values have dedicated typed validation; JSON/reference records are not text.
  result.validationSchema = undefined
  return result
}

export { etsyProductSpec } from './etsy.js'

function spec(channel: 'SHOPIFY' | 'ETSY', fields: ChannelFieldSpec[]): ChannelSpec {
  const properties = Object.fromEntries(fields.map(f => {
    const scalar = { type: f.kind === 'number' ? 'number' : f.kind === 'boolean' ? 'boolean' : 'string',
      ...(f.options ? { enum: f.options } : {}), ...(f.maxLength ? { maxLength: f.maxLength } : {}),
      ...Object.fromEntries(Object.entries(f.validation ?? {}).filter(([key]) => key !== 'uniqueItems')) }
    return [f.attribute, f.shape === 'list' ? { type: 'array', items: scalar,
      ...(f.cardinality.max !== null ? { maxItems: f.cardinality.max } : {}),
      ...(f.validation?.uniqueItems ? { uniqueItems: true } : {}) } : scalar]
  }))
  return { channel, marketplace: 'GLOBAL', category: '*', fields,
    validationSchema: { type: 'object', properties, required: fields.filter(f => f.requirement === 'required').map(f => f.attribute) },
    groups: groups.filter(g => fields.some(f => f.group?.key === g.key)),
    fetchedAt: null, schemaVersion: 'product-information-2026-09-08',
    coverage: Object.fromEntries(fields.map(f => [f.attribute, [f.key]])), unrecognised: [], absent: false }
}
