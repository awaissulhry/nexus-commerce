import { etsyListingSchema } from './etsy-listing-schema.js'
import { humanizeKey, type ChannelFieldSpec, type ChannelGroup, type ChannelSpec, type ChannelStore } from './types.js'

const groups: ChannelGroup[] = ['Content', 'Classification', 'Search', 'Offer', 'Shipping', 'Policies', 'Listing status', 'Category attributes']
  .map((label, order) => ({ key: label.toLowerCase().replace(/ /g, '_'), label, channelLabel: null, order }))
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
const idRules = { minimum: 1, multipleOf: 1 }
const positive = { exclusiveMinimum: 0 }
const words = '^[\\p{L}\\p{Nd}\\p{Zs}]+$'

function coreFields(): ChannelFieldSpec[] {
  return [
    field('title', 'Title', 'content', { masterKey: 'name', kind: 'longtext', requirement: 'required', maxLength: 140, channelStore: titleStore,
      validation: { pattern: '^(?!.*%.*%)(?!.*:.*:)(?!.*&.*&)(?!.*\\+.*\\+)[\\p{L}\\p{Nd}\\p{P}\\p{Sm}\\p{Zs}™©®]+$' },
      helpText: 'Up to 140 characters. %, :, & and + may each appear only once.' }),
    field('description', 'Description', 'content', { masterKey: 'description', kind: 'longtext', requirement: 'required', channelStore: descriptionStore,
      helpText: 'Plain text description for this Etsy listing.' }),
    field('tags', 'Tags', 'search', { masterKey: 'keywords', shape: 'list', cardinality: { min: 0, max: 13 }, maxLength: 20,
      validation: { uniqueItems: true, pattern: "^[\\p{L}\\p{Nd}\\p{Zs}™©®][\\p{L}\\p{Nd}\\p{Zs}\\-'™©®]*$" }, helpText: 'Up to 13 tags, with up to 20 characters in each.' }),
    field('materials', 'Materials', 'content', { masterKey: 'material', shape: 'list', cardinality: { min: 0, max: null }, validation: { pattern: words },
      helpText: 'Materials used to make this item. Use letters, numbers and spaces.' }),
    field('taxonomy_id', 'Category', 'classification', { kind: 'number', requirement: 'required', validation: idRules,
      sourceOwner: { kind: 'listing', label: 'Etsy category selection', path: 'listing.platformAttributes.taxonomy_id' },
      helpText: 'Etsy seller taxonomy category ID. Refresh requirements after changing this category.' }),
    field('who_made', 'Who made it', 'classification', { kind: 'select', mode: 'strict', requirement: 'required',
      options: ['i_did', 'someone_else', 'collective'], optionLabels: { i_did: 'I did', someone_else: 'Someone else', collective: 'A member of my shop' } }),
    field('when_made', 'When made', 'classification', { kind: 'select', mode: 'strict', requirement: 'required',
      options: ['made_to_order', '2020_2026', '2010_2019', '2007_2009', 'before_2007', '2000_2006', '1990s', '1980s', '1970s', '1960s', '1950s', '1940s', '1930s', '1920s', '1910s', '1900s', '1800s', '1700s', 'before_1700'],
      optionLabels: { made_to_order: 'Made to order', '2020_2026': '2020–2026', '2010_2019': '2010–2019', '2007_2009': '2007–2009', before_2007: 'Before 2007', '2000_2006': '2000–2006', before_1700: 'Before 1700' } }),
    field('is_supply', 'Craft supply', 'classification', { kind: 'boolean', requirement: 'required' }),
    field('type', 'Listing type', 'classification', { kind: 'select', mode: 'strict', options: ['physical', 'download', 'both'],
      optionLabels: { physical: 'Physical item', download: 'Digital download', both: 'Physical and digital' } }),
    field('production_partner_ids', 'Production partner IDs', 'classification', { kind: 'number', shape: 'list', cardinality: { min: 0, max: null }, validation: { ...idRules, uniqueItems: true } }),
    field('shop_section_id', 'Shop section', 'classification', { kind: 'number', validation: idRules }),
    field('price', 'Price', 'offer', { kind: 'number', requirement: 'required', validation: positive, channelStore: column('price', 'followMasterPrice') }),
    field('quantity', 'Quantity', 'offer', { kind: 'number', requirement: 'required', validation: { minimum: 0, multipleOf: 1 }, channelStore: column('quantity', 'followMasterQuantity') }),
    field('item_weight', 'Item weight', 'shipping', { masterKey: 'weightValue', kind: 'number', validation: positive }),
    field('item_weight_unit', 'Weight unit', 'shipping', { masterKey: 'weightUnit', kind: 'select', mode: 'strict', options: ['oz', 'lb', 'g', 'kg'] }),
    field('item_length', 'Item length', 'shipping', { masterKey: 'dimLength', kind: 'number', validation: positive }),
    field('item_width', 'Item width', 'shipping', { masterKey: 'dimWidth', kind: 'number', validation: positive }),
    field('item_height', 'Item height', 'shipping', { masterKey: 'dimHeight', kind: 'number', validation: positive }),
    field('item_dimensions_unit', 'Dimension unit', 'shipping', { masterKey: 'dimUnit', kind: 'select', mode: 'strict', options: ['in', 'ft', 'mm', 'cm', 'm', 'yd', 'inches'] }),
    field('shipping_profile_id', 'Shipping profile', 'shipping', { kind: 'number', validation: idRules }),
    field('return_policy_id', 'Return policy', 'policies', { kind: 'number', validation: idRules }),
    field('is_taxable', 'Taxable', 'policies', { kind: 'boolean' }),
    field('should_auto_renew', 'Automatic renewal', 'policies', { kind: 'boolean', helpText: 'Renewal preference saved in Nexus. Publishing and renewal are separate channel actions.' }),
  ]
}

export interface EtsyTaxonomyValue { value_id: number | null; name: string; scale_id?: number | null; equal_to?: number[] }
export interface EtsyTaxonomyProperty {
  property_id: number; name: string; display_name: string
  is_required: boolean; supports_attributes: boolean; supports_variations: boolean
  is_multivalued: boolean; max_values_allowed: number | null
  scales: Array<{ scale_id: number; display_name: string; description?: string }>
  possible_values: EtsyTaxonomyValue[]; selected_values: EtsyTaxonomyValue[]
}

type NativeSchema = { type?: string; enum?: readonly string[]; items?: NativeSchema; minimum?: number; maximum?: number }
const native = etsyListingSchema.listing.properties as Record<string, NativeSchema>
const create = etsyListingSchema.create.properties as Record<string, NativeSchema>
const update = etsyListingSchema.update.properties as Record<string, NativeSchema>
const aliases: Record<string, string> = { listing_type: 'type', style: 'styles', creation_timestamp: 'created_timestamp', last_modified_timestamp: 'updated_timestamp' }
const shipping = new Set(['processing_min', 'processing_max', 'readiness_state_id'])

/** Every API field is represented by a sheet column or shared workspace; remote metadata stays read-only. */
export function etsyProductSpec(locale?: string): ChannelSpec {
  const fields = coreFields()
  const byKey = new Map(fields.map(f => [f.key, f]))
  const coverage: Record<string, string[]> = {}
  const all = { ...native, ...create, ...update }
  for (const [attribute, raw] of Object.entries(all)) {
    const key = aliases[attribute] ?? attribute
    const definition = update[key] ?? create[key] ?? raw
    const writable = !!(create[key] || update[key]) && key !== 'state'
    if (definition.type === 'money') {
      coverage[attribute] = []
      for (const leaf of ['amount', 'divisor', 'currency_code']) {
        const f = field(`${key}__${leaf}`, `Converted price ${leaf === 'currency_code' ? 'currency' : leaf}`, 'offer', {
          attribute, path: [leaf], kind: leaf === 'currency_code' ? 'text' : 'number',
          channelStore: pa(key, leaf), editable: false, readOnlyReason: 'Converted price reported by Etsy.',
          helpText: 'Reported by Etsy. Divide amount by divisor for the price in this currency.',
        })
        fields.push(f); byKey.set(f.key, f); coverage[attribute].push(f.key)
      }
      continue
    }
    if (!byKey.has(key)) {
      const scalar = definition.type === 'array' ? definition.items! : definition
      const f = field(key, humanizeKey(key), shipping.has(key) ? 'shipping' : writable ? 'content' : 'listing_status', {
        kind: scalar.type === 'boolean' ? 'boolean' : ['number', 'integer', 'money'].includes(scalar.type ?? '') ? 'number' : scalar.enum ? 'select' : key.endsWith('description') ? 'longtext' : 'text',
        shape: definition.type === 'array' ? 'list' : 'scalar',
        cardinality: { min: 0, max: definition.type === 'array' ? null : 1 },
        ...(scalar.enum ? { options: [...scalar.enum], mode: 'strict' } : {}),
        validation: { ...(scalar.type === 'integer' ? { multipleOf: 1 } : {}), ...(scalar.minimum !== undefined ? { minimum: scalar.minimum } : {}) },
        ...(writable ? {} : { editable: false, readOnlyReason: 'Reported by Etsy. This field cannot be edited in the information sheet.', helpText: 'Reported by Etsy. This field cannot be edited in the information sheet.' }),
      })
      fields.push(f); byKey.set(key, f)
    }
    coverage[attribute] = [key]
  }
  Object.assign(byKey.get('type')!, { channelStore: { kind: 'platformAttributes', path: ['type'], legacyPaths: [['listing_type']] } })
  Object.assign(byKey.get('styles')!, { masterKey: 'style', label: 'Styles', englishLabel: 'Styles', cardinality: { min: 0, max: 2 }, maxLength: 45, validation: { pattern: words, uniqueItems: true }, channelStore: { kind: 'platformAttributes', path: ['styles'], legacyPaths: [['style']] }, helpText: 'Inherits Master Style. Up to two styles, 45 characters each. Etsy accepts styles when creating a listing.' })
  Object.assign(byKey.get('image_ids')!, { managedBy: 'productMedia', label: 'Product media', englishLabel: 'Product media', editable: false,
    readOnlyReason: 'Manage images and their order in Product media. Etsy image IDs are remote references, not Nexus asset IDs.',
    cardinality: { min: 0, max: 20 }, validation: { ...idRules, uniqueItems: true },
    helpText: 'Uses the shared Product media gallery for this Etsy account, listing and language. Etsy image IDs are assigned by Etsy after upload; saving the gallery does not publish images.' })
  for (const [alias, key] of Object.entries(aliases).filter(([alias]) => alias.endsWith('_timestamp'))) {
    Object.assign(byKey.get(key)!, { channelStore: { kind: 'platformAttributes', path: [key], legacyPaths: [[alias]] },
      label: key === 'created_timestamp' ? 'Created on Etsy' : 'Updated on Etsy', englishLabel: key === 'created_timestamp' ? 'Created on Etsy' : 'Updated on Etsy' })
  }
  Object.assign(byKey.get('readiness_state_id')!, { label: 'Processing profile', englishLabel: 'Processing profile', helpText: 'Etsy processing profile. Existing variation offerings use the inventory endpoint.' })
  Object.assign(byKey.get('rich_description')!, { helpText: 'HTML description reported by Etsy, displayed as text. The listing API accepts plain-text description updates.' })
  Object.assign(byKey.get('state')!, { label: 'Listing status', englishLabel: 'Listing status', options: [...native.state.enum!], helpText: 'Reported by Etsy. Publishing, renewing and deactivating are separate channel actions.' })
  const currency = field('price_currency_code', 'Currency', 'offer', { channelStore: pa('price', 'currency_code'), editable: false, readOnlyReason: 'Currency reported by Etsy.', helpText: 'Currency reported by Etsy.' })
  fields.push(currency); coverage.price.push(currency.key)
  if (locale) for (const key of ['title', 'description', 'tags']) {
    const f = byKey.get(key)
    if (f) { f.channelStore = pa('_etsyInformationLocales', locale, key); f.helpText = `${f.helpText ?? ''} Saved as a Nexus draft for ${locale}. Etsy translation delivery is not connected to this save.`.trim() }
  }
  Object.assign(byKey.get('language')!, { editable: false, readOnlyReason: 'Original listing language reported by Etsy. Use the content language selector for translations.', helpText: 'Original listing language reported by Etsy.' })
  return makeSpec('*', fields, coverage)
}

/** Stable property IDs, all seller-category properties, exact multiplicity, scales and choices. */
export function etsyTaxonomySpec(category: string, properties: EtsyTaxonomyProperty[], fetchedAt: Date | null = null): ChannelSpec {
  const fields: ChannelFieldSpec[] = [], coverage: Record<string, string[]> = {}
  for (const property of properties) {
    const key = `property_${property.property_id}`
    const selected = property.selected_values ?? []
    const knownValues = [...selected, ...property.possible_values]
    const codeFor = (value: EtsyTaxonomyValue) => value.value_id == null ? value.name : String(value.value_id)
    const choices = [...new Set(knownValues.map(codeFor))]
    const fixed = selected.length > 0
    const editable = property.supports_attributes && !fixed
    const reason = fixed ? 'Etsy selects this value automatically for the category.' : !property.supports_attributes ? 'This property belongs to Etsy variation inventory.' : undefined
    const label = property.display_name || property.name
    const values = field(key, property.supports_attributes ? label : `${label} (${property.property_id})`, 'category_attributes', {
      shape: property.is_multivalued ? 'list' : 'scalar', kind: choices.length ? 'select' : 'text',
      cardinality: { min: 0, max: property.is_multivalued ? property.max_values_allowed && property.max_values_allowed > 0 ? property.max_values_allowed : null : 1 },
      requirement: property.is_required && property.supports_attributes && !fixed ? 'required' : 'optional',
      variantEligible: property.supports_variations, editable, readOnlyReason: reason,
      options: choices.length ? choices : undefined, mode: choices.length ? 'strict' : 'open',
      optionLabels: Object.fromEntries(knownValues.map(value => [codeFor(value), value.name])),
      validation: { pattern: '^[^()]+$', uniqueItems: true,
        etsyValues: knownValues.map(value => ({ code: codeFor(value), label: value.name, scaleId: value.scale_id == null ? null : String(value.scale_id) })) },
      channelStore: pa('etsyProperties', String(property.property_id), property.is_multivalued ? 'values' : 'value'),
      helpText: [reason, `Etsy property ${property.property_id}.`, property.supports_variations ? 'Available for variations.' : 'Listing attribute.'].filter(Boolean).join(' '),
      ...(fixed ? { defaultRule: { source: '', transforms: [{ type: 'default', value: property.is_multivalued ? selected.map(codeFor) : codeFor(selected[0]) }] } } : {}),
    })
    // Stable semantic names only. Keep property IDs as the destination so a category's
    // scale/choices remain independent of Master and of other Etsy properties.
    const source = ({ color: 'color', primary_color: 'color', material: 'material', materials: 'material', style: 'style', size: 'size' } as Record<string, string>)[property.name]
    if (editable && source && !property.scales.length) values.defaultRule = { source,
      notes: `Inherits Master ${source}. Etsy choices and limits are validated; values are never guessed or truncated.` }
    fields.push(values); coverage[String(property.property_id)] = [key]
    if (property.scales.length) {
      const scale = field(`${key}__scale_id`, `${values.label} scale`, 'category_attributes', {
        kind: 'select', options: property.scales.map(s => String(s.scale_id)), mode: 'strict',
        optionLabels: Object.fromEntries(property.scales.map(s => [String(s.scale_id), s.display_name])),
        editable, readOnlyReason: reason, channelStore: pa('etsyProperties', String(property.property_id), 'scale_id'),
        helpText: reason ?? `Measurement scale for ${values.label}. Select the scale that matches its value.`,
      })
      fields.push(scale); coverage[String(property.property_id)].push(scale.key)
    }
  }
  return { ...makeSpec(category, fields, coverage), fetchedAt }
}

function makeSpec(category: string, fields: ChannelFieldSpec[], coverage: Record<string, string[]>): ChannelSpec {
  const properties = Object.fromEntries(fields.filter(f => f.editable).map(f => {
    const scalar = { type: f.kind === 'number' ? 'number' : f.kind === 'boolean' ? 'boolean' : 'string',
      ...(f.options ? { enum: f.options } : {}), ...(f.maxLength ? { maxLength: f.maxLength } : {}),
      ...Object.fromEntries(Object.entries(f.validation ?? {}).filter(([key]) => !['uniqueItems', 'etsyValues'].includes(key))) }
    return [f.attribute, f.shape === 'list' ? { type: 'array', items: scalar,
      ...(f.cardinality.max !== null ? { maxItems: f.cardinality.max } : {}), ...(f.validation?.uniqueItems ? { uniqueItems: true } : {}) } : scalar]
  }))
  const allOf: Record<string, unknown>[] = []
  for (const field of fields) {
    const scale = fields.find(candidate => candidate.key === `${field.key}__scale_id`)
    if (!field.editable || !scale) continue
    allOf.push({ if: { required: [field.attribute] }, then: { required: [scale.attribute] } })
    const values = field.validation?.etsyValues as Array<{ code: string; scaleId: string | null }> | undefined
    for (const scaleId of scale.options ?? []) {
      const allowed = values?.filter(value => value.scaleId == null || value.scaleId === scaleId).map(value => value.code) ?? []
      if (!values?.length) continue
      allOf.push({ if: { required: [scale.attribute], properties: { [scale.attribute]: { const: scaleId } } },
        then: { properties: { [field.attribute]: field.shape === 'list' ? { items: { enum: allowed } } : { enum: allowed } } } })
    }
  }
  return { channel: 'ETSY', marketplace: 'GLOBAL', category, fields, coverage,
    validationSchema: { type: 'object', properties, required: fields.filter(f => f.requirement === 'required').map(f => f.attribute), ...(allOf.length ? { allOf } : {}) },
    groups: groups.filter(g => fields.some(f => f.group?.key === g.key)),
    fetchedAt: null, schemaVersion: `etsy-listing-${etsyListingSchema.verifiedAt}`, unrecognised: [], absent: false }
}
