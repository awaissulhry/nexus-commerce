import type { ChannelFieldSpec, ChannelSpec } from '../channel-specs/types.js'
import { humanizeKey } from '../channel-specs/types.js'
import { ALLOWED_MASTER_FIELDS } from '../master-field-gate.js'
import type { FieldMappingRule } from '../schema-mapping.service.js'

export interface MasterSourceDefinition {
  code: string
  label: string
  type: 'text' | 'textarea' | 'number' | 'boolean' | 'date'
  shape: 'scalar' | 'list'
  group: string
  localizable: boolean
  scope: 'global' | 'per_variant'
}
export interface SourceOwner { kind: 'listing' | 'system'; label: string; path: string }
export interface PlannedSource { rule: FieldMappingRule; definitions: MasterSourceDefinition[] }

// These are semantic correspondences, not fuzzy label matches. Distinct product/package
// dimensions, gender/suitability and material/fabric facts deliberately keep distinct sources.
const EBAY_FACT_KEYS: Record<string, string> = {
  closure_fastening: 'closure', cura_dell_indumento: 'care_instructions',
  paese_di_origine: 'countryOfOrigin', scollatura: 'neckline',
  colore_esatto: 'exact_color', colore_specifico: 'specific_color',
  features: 'special_feature', caratteristiche_aggiuntive: 'additional_features',
  season: 'seasons', certificazione_ce: 'ceCertification', armatura: 'armorType',
  adatta: 'fit_type', eta: 'age_range_description', adatto_a: 'suitable_for',
  materiale_specifico: 'specific_material', materiale_esatto: 'exact_material',
  tipo_di_prodotto: 'item_type_name', garanzia_produttore: 'manufacturer_warranty',
  quantita: 'item_specific_quantity', unita_di_misura: 'item_specific_unit',
}
const PACKAGE_SOURCES: Record<string, [string, string?]> = {
  item_package_weight: ['packageWeightValue', 'packageWeightUnit'],
  packageWeight: ['packageWeightValue', 'packageWeightUnit'],
  item_package_dimensions__length: ['packageLength', 'packageDimensionUnit'],
  item_package_dimensions__width: ['packageWidth', 'packageDimensionUnit'],
  item_package_dimensions__height: ['packageHeight', 'packageDimensionUnit'],
  packageLength: ['packageLength'], packageWidth: ['packageWidth'], packageHeight: ['packageHeight'],
  dimensionUnit: ['packageDimensionUnit'], packageType: ['packageType'],
}
const NATIVE_MEASURES: Record<string, [string, string]> = {
  item_weight: ['weightValue', 'weightUnit'],
  item_display_dimensions__length: ['dimLength', 'dimUnit'],
  item_display_dimensions__width: ['dimWidth', 'dimUnit'],
  item_display_dimensions__height: ['dimHeight', 'dimUnit'],
}
const CHANNEL_FACTS = new Set(['merchant_suggested_asin', 'recommended_browse_nodes',
  'supplier_declared_has_product_identifier_exemption', 'product_site_launch_date',
  'gpsr_manufacturer_reference', 'dsa_responsible_party_address', 'ec_medical_device_sales_channel',
  'epr_eco_fee_eubr', 'epr_eco_fee_eubr__currency', 'ships_globally', 'compliance_media'])
const SHARED_FACT_KEYS: Record<string, string> = {
  externally_assigned_product_identifier: 'gtin',
  apparel_size__size: 'size', bottoms_size__size: 'size',
  apparel_size__body_type: 'body_type', bottoms_size__body_type: 'body_type',
}

export function sourceOwner(field: Pick<ChannelFieldSpec, 'key' | 'masterKey' | 'attribute' | 'group' | 'channelStore' | 'defaultRule' | 'shopifyField' | 'sourceOwner' | 'managedBy' | 'readOnlyReason'>): SourceOwner | null {
  if (field.sourceOwner) return field.sourceOwner
  if (field.managedBy === 'productMedia') return { kind: 'listing', label: 'Product media', path: 'listing.platformAttributes._productMediaLocales' }
  const key = field.key
  if (!field.masterKey && (key === 'categoryId' || key === 'productType')) return { kind: 'system', label: 'Category assignments', path: 'category.channelCategoryId' }
  if (field.masterKey || field.defaultRule) return null
  if (PACKAGE_SOURCES[key] || NATIVE_MEASURES[key]) return null
  const group = field.group?.key
  if (['product_details', 'product_identity', 'safety_and_compliance', 'aspects'].includes(group ?? '') && !CHANNEL_FACTS.has(key)) return null
  const path = !field.channelStore ? `listing.overrideData.${key}` : field.channelStore.kind === 'listingColumn' ? `listing.${field.channelStore.column}` : `listing.platformAttributes.${field.channelStore.path.join('.')}`
  if (field.readOnlyReason) return { kind: 'system', label: 'Channel-reported data', path }
  const label = field.shopifyField?.definition ? 'Shopify metafields' : group === 'images' || /image_locator|imageUrls|videoId/.test(key) ? 'Media'
    : group === 'policies' || /PolicyId$/.test(key) ? 'Channel policies'
    : /purchasable_offer|list_price|^price$|bestOffer(Floor|Ceiling)|vatRate/.test(key) ? 'Pricing'
    : /fulfillment_availability|^quantity$/.test(key) ? 'Inventory'
    : group === 'variations' ? 'Variation setup' : 'Listing settings'
  return { kind: 'listing', label, path }
}

function definition(code: string, field: ChannelFieldSpec, override: Partial<MasterSourceDefinition> = {}): MasterSourceDefinition {
  return { code, label: humanizeKey(code.replace(/([a-z0-9])([A-Z])/g, '$1_$2')),
    type: ['number', 'boolean', 'date'].includes(field.kind) ? field.kind as 'number' | 'boolean' | 'date' : field.kind === 'longtext' ? 'textarea' : 'text',
    shape: field.shape === 'list' ? 'list' : 'scalar',
    group: field.group?.key === 'safety_and_compliance' ? 'compliance' : 'specifications',
    localizable: field.selectors?.includes('language_tag') === true,
    scope: field.variantEligible || ['color', 'size'].includes(code) ? 'per_variant' : 'global', ...override }
}

/** Describe every genuine product fact as a typed Master source, even before any SKU has a value.
 * The caller reviews rules, installs definitions, and attaches them to the relevant families. */
export function planProductSource(field: ChannelFieldSpec, channel: ChannelSpec['channel'], locale: string): PlannedSource | null {
  if (sourceOwner(field)) return null
  if (field.defaultRule) return { rule: field.defaultRule, definitions: [] }
  const code = field.masterKey ?? SHARED_FACT_KEYS[field.key] ?? (channel === 'EBAY' ? EBAY_FACT_KEYS[field.key] : undefined)
    ?? (field.key === 'country_of_origin' ? 'countryOfOrigin' : field.key)
  const measure = NATIVE_MEASURES[field.key] ?? PACKAGE_SOURCES[field.key]
  const specs: MasterSourceDefinition[] = []
  let rule: FieldMappingRule
  if (field.shape === 'measure') {
    const [amount, unit] = measure ?? [`${code}Value`, `${code}Unit`]
    specs.push(definition(amount, field, { type: 'number', shape: 'scalar', localizable: false }),
      definition(unit!, field, { type: 'text', shape: 'scalar', localizable: false }))
    rule = { source: amount, transforms: [{ type: 'expr', expr: `measure($${amount}, $${unit}, ${JSON.stringify((field.unitOptions ?? []).join('|'))})` }] }
  } else {
    const source = measure?.[0] ?? (code === 'name' ? 'title' : code)
    specs.push(definition(source === 'title' ? 'name' : source, field))
    rule = { source, ...(source === 'title' ? { fallback: 'name' } : {}) }
    if (field.key === 'generic_keyword') rule.transforms = [{ type: 'expr', expr: 'join($keywords, " ")' }]
    if (channel === 'EBAY' && code === 'countryOfOrigin') rule.transforms = [{ type: 'expr', expr: `countryname($countryOfOrigin, ${JSON.stringify(locale)})` }]
  }
  return { rule: { ...rule, notes: 'Shared Master source. Empty values remain empty; listing overrides keep precedence.' },
    definitions: specs.filter(d => !ALLOWED_MASTER_FIELDS.has(d.code)) }
}

/** Preserve all values where channels disagree about list cardinality; never choose the first item. */
export function adaptSourceShape(rule: FieldMappingRule, field: ChannelFieldSpec, listSources: ReadonlySet<string>): FieldMappingRule {
  return field.shape === 'scalar' && listSources.has(rule.source) && !rule.transforms?.length
    ? { ...rule, transforms: [{ type: 'expr', expr: `join($${rule.source}, ", ")` }] } : rule
}
