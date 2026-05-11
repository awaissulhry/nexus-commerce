/**
 * Amazon Flat-File Spreadsheet Service — 100% schema-driven
 *
 * generateManifest() derives ALL columns from the live Amazon JSON Schema
 * for the requested marketplace + productType. No field lists are
 * hardcoded beyond the 6 structural columns that fall outside Amazon's
 * schema itself.
 *
 * Groups:
 *   Offer Identity  — item_sku · product_type · record_action (fixed)
 *   Variations      — parentage_level · parent_sku · variation_theme (fixed + schema enums)
 *   Required Fields — schema.required fields     (schema-derived)
 *   Images          — *_image_locator fields      (schema-derived)
 *   Optional Fields — all remaining schema fields (schema-derived)
 */

import type { PrismaClient } from '@nexus/database'
import { CategorySchemaService } from '../categories/schema-sync.service.js'

// ── Constants ──────────────────────────────────────────────────────────

export const MARKETPLACE_ID_MAP: Record<string, string> = {
  IT: 'APJ6JRA9NG5V4',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYZZH',
  ES: 'A1RKKUPIHCS9HS',
  UK: 'A1F83G8C2ARO7P',
}

export const LANGUAGE_TAG_MAP: Record<string, string> = {
  IT: 'it_IT',
  DE: 'de_DE',
  FR: 'fr_FR',
  ES: 'es_ES',
  UK: 'en_GB',
}

export const CURRENCY_MAP: Record<string, string> = {
  IT: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', UK: 'GBP',
}

// ── Types ──────────────────────────────────────────────────────────────

export type FlatFileColumnKind = 'text' | 'longtext' | 'number' | 'enum' | 'boolean'

export interface FlatFileColumn {
  id: string
  fieldRef: string
  labelEn: string
  labelLocal: string
  description?: string
  required: boolean
  kind: FlatFileColumnKind
  options?: string[]
  maxLength?: number
  width: number
}

export interface FlatFileColumnGroup {
  id: string
  labelEn: string
  labelLocal: string
  color: string
  columns: FlatFileColumn[]
}

export interface FlatFileManifest {
  marketplace: string
  productType: string
  variationThemes: string[]
  fetchedAt: string
  groups: FlatFileColumnGroup[]
  /**
   * Maps expanded column IDs back to their base schema field ID.
   * e.g. { "bullet_point_1": "bullet_point", "material_2": "material" }
   * Used by buildJsonFeedBody to reassemble multi-instance columns into arrays.
   */
  expandedFields: Record<string, string>
  /**
   * Schema field IDs that exist only in LISTING_PRODUCT_ONLY (parent rows).
   * Columns for these fields are grayed out on child/variant rows.
   */
  productExclusiveFields: string[]
  /**
   * Schema field IDs that exist only in LISTING_OFFER_ONLY (child/offer rows).
   * Columns for these fields are grayed out on parent rows.
   */
  offerExclusiveFields: string[]
}

export interface FlatFileRow {
  _rowId: string
  _isNew?: boolean
  _productId?: string
  _dirty?: boolean
  _status?: 'idle' | 'pending' | 'success' | 'error'
  _feedMessage?: string
  [key: string]: unknown
}

// ── Language types ─────────────────────────────────────────────────────

type LangTag = 'it_IT' | 'de_DE' | 'fr_FR' | 'es_ES' | 'en_GB'

// Translations for the 6 fixed structural columns (not in Amazon's schema)
const FIXED_FIELD_LABELS: Record<string, Partial<Record<LangTag, string>>> = {
  item_sku:        { it_IT: 'SKU', de_DE: 'SKU', fr_FR: 'SKU', es_ES: 'SKU', en_GB: 'SKU' },
  product_type:    { it_IT: 'Tipo di prodotto', de_DE: 'Produkttyp', fr_FR: 'Type de produit', es_ES: 'Tipo de producto', en_GB: 'Product Type' },
  record_action:   { it_IT: "Azione sull'offerta", de_DE: 'Angebotsaktion', fr_FR: "Action sur l'offre", es_ES: 'Acción de la oferta', en_GB: 'Offer Action' },
  parentage_level: { it_IT: 'Livello di parentela', de_DE: 'Hierarchieebene', fr_FR: 'Niveau de parenté', es_ES: 'Nivel de parentesco', en_GB: 'Parentage Level' },
  parent_sku:      { it_IT: 'SKU articolo Parent', de_DE: 'Übergeordnete SKU', fr_FR: 'SKU parent', es_ES: 'SKU del padre', en_GB: 'Parent SKU' },
  variation_theme: { it_IT: 'Variazione Tema', de_DE: 'Variationsthema', fr_FR: 'Thème de variation', es_ES: 'Tema de variación', en_GB: 'Variation Theme' },
}

const GROUP_LOCAL_LABELS: Record<string, Partial<Record<LangTag, string>>> = {
  offer_identity:  { it_IT: "Identità dell'offerta", de_DE: 'Angebotsidentität', fr_FR: "Identité de l'offre", es_ES: 'Identidad de la oferta', en_GB: 'Offer Identity' },
  variations:      { it_IT: 'Variazioni', de_DE: 'Variationen', fr_FR: 'Variations', es_ES: 'Variaciones', en_GB: 'Variations' },
  required_fields: { it_IT: 'Campi obbligatori', de_DE: 'Pflichtfelder', fr_FR: 'Champs obligatoires', es_ES: 'Campos obligatorios', en_GB: 'Required Fields' },
  images:          { it_IT: 'Immagini', de_DE: 'Bilder', fr_FR: 'Images', es_ES: 'Imágenes', en_GB: 'Images' },
  optional_fields: { it_IT: 'Campi facoltativi', de_DE: 'Optionale Felder', fr_FR: 'Champs facultatifs', es_ES: 'Campos opcionales', en_GB: 'Optional Fields' },
}

// Group color palette — assigned by position so Amazon's group order
// always gets a consistent colour regardless of group ID/title.
const GROUP_COLOR_PALETTE = [
  'blue', 'purple', 'emerald', 'orange', 'teal',
  'amber', 'yellow', 'sky', 'red', 'violet', 'slate',
]

// English names for Amazon's well-known group IDs.
// Amazon's API returns localised titles; we keep English separately so
// the spreadsheet can show both (e.g. "Immagini (Images)").
const KNOWN_GROUP_EN: Record<string, string> = {
  offer_identity:    'Offer Identity',
  variations:        'Variations',
  product_identity:  'Product Identity',
  images:            'Images',
  product_details:   'Product Details',
  offer:             'Offer',
  shipping:          'Shipping',
  compliance:        'Compliance & Safety',
  fulfillment:       'Fulfillment',
  schema_fields:     'Schema Fields',
  other_attributes:  'Other Attributes',
}

function groupIdToEnglish(groupId: string): string {
  if (KNOWN_GROUP_EN[groupId]) return KNOWN_GROUP_EN[groupId]
  // Handle market-specific offer groups like "offer_APJ6JRA9NG5V4"
  if (/^offer_/.test(groupId)) return 'Offer — Selling on Amazon'
  if (/^selling_/.test(groupId)) return 'Selling on Amazon'
  // Convert snake_case to Title Case
  return groupId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// ── Schema enum extraction ─────────────────────────────────────────────

/**
 * Extract enum options from a single schema value node.
 * Prefers enumNames (display labels) over raw enum codes.
 */
function extractEnumOptions(inner: Record<string, any>): string[] {
  const enumNames: string[] = inner?.enumNames ?? []
  if (enumNames.length > 0) return enumNames.map(String).filter(Boolean)
  const validValues: string[] = inner?.['x-amazon-attributes']?.validValues ?? []
  if (validValues.length > 0) return validValues.map(String).filter(Boolean)
  const enumValues: string[] = inner?.enum ?? []
  return enumValues.map(String).filter(Boolean)
}

/**
 * Recursively find enum values anywhere in a schema subtree.
 *
 * Amazon schema patterns:
 *   A) Direct:        { enumNames: [...] }
 *   B) Wrapped value: items.properties.value.enumNames
 *   C) anyOf branch:  items.properties.value.anyOf[n].enumNames
 *   D/E/F) Other sub: items.properties.class/unit/type.enumNames
 */
function findEnumNode(node: Record<string, any>, depth = 0): string[] {
  if (!node || typeof node !== 'object' || depth > 5) return []

  const direct = extractEnumOptions(node)
  if (direct.length) return direct

  for (const key of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(node[key])) {
      for (const branch of node[key]) {
        const v = findEnumNode(branch as Record<string, any>, depth + 1)
        if (v.length) return v
      }
    }
  }

  const itemProps: Record<string, any> = node?.items?.properties ?? {}

  const valueNode = itemProps.value
  if (valueNode) {
    const v = findEnumNode(valueNode, depth + 1)
    if (v.length) return v
  }

  const SKIP_PROPS = new Set(['value', 'marketplace_id', 'language_tag'])
  for (const [subId, subNode] of Object.entries(itemProps)) {
    if (SKIP_PROPS.has(subId)) continue
    const v = findEnumNode(subNode as Record<string, any>, depth + 1)
    if (v.length) return v
  }

  return []
}

/**
 * Walk all top-level schema properties and build a flat enum map.
 *   fieldId → string[]            e.g. "target_gender" → ["Female","Male","Unisex"]
 *   fieldId.subProp → string[]    e.g. "closure.type" → ["Button","Drawstring",...]
 */
function buildSchemaEnums(properties: Record<string, any>): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  const SKIP_SUB = new Set(['marketplace_id', 'language_tag', 'value'])

  for (const [fieldId, prop] of Object.entries(properties)) {
    const p = prop as Record<string, any>
    const valueNode = p?.items?.properties?.value ?? p
    const topOpts = findEnumNode(valueNode)
    if (topOpts.length) result[fieldId] = topOpts

    const subProps: Record<string, any> = p?.items?.properties ?? {}
    for (const [subId, subProp] of Object.entries(subProps)) {
      if (SKIP_SUB.has(subId)) continue
      const subOpts = findEnumNode(subProp as Record<string, any>)
      if (subOpts.length) result[`${fieldId}.${subId}`] = subOpts
    }
  }

  return result
}

/** Extract localised titles from schema properties into a flat map. */
function buildSchemaLabels(properties: Record<string, any>): Record<string, string> {
  const map: Record<string, string> = {}
  for (const [fieldId, prop] of Object.entries(properties)) {
    const title: string | undefined =
      prop?.title ?? prop?.items?.properties?.value?.title
    if (title) map[fieldId] = title
  }
  return map
}

// ── Schema → column conversion ─────────────────────────────────────────

/**
 * Convert a single Amazon schema property into a FlatFileColumn.
 * Returns a column for every field — defaults to 'text' kind for
 * complex/unknown types so no schema field is silently dropped.
 */
function schemaFieldToColumn(
  fieldId: string,
  prop: Record<string, any>,
  isRequired: boolean,
  schemaLabels: Record<string, string>,
  schemaEnums: Record<string, string[]>,
  lang: LangTag,
): FlatFileColumn {
  const inner = prop?.items?.properties?.value ?? prop
  const topType = prop?.type
  const t = inner?.type

  let kind: FlatFileColumnKind = 'text'
  let options: string[] | undefined

  const enumOpts = schemaEnums[fieldId]
  if (enumOpts && enumOpts.length > 0) {
    kind = 'enum'
    options = ['', ...enumOpts]
  } else if (t === 'number' || t === 'integer' || topType === 'number' || topType === 'integer') {
    kind = 'number'
  } else if (t === 'boolean') {
    kind = 'enum'
    options = ['', 'true', 'false']
  } else if (t === 'string') {
    kind = (inner?.maxLength ?? 0) > 500 ? 'longtext' : 'text'
  } else if (topType === 'array' || topType === 'object') {
    kind = 'text'
  }

  const labelEn =
    fieldId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  const labelLocal =
    schemaLabels[fieldId] ?? FIXED_FIELD_LABELS[fieldId]?.[lang] ?? labelEn

  return {
    id: fieldId,
    fieldRef: buildFieldRef(fieldId),
    labelEn,
    labelLocal,
    required: isRequired,
    kind,
    options,
    maxLength: typeof inner?.maxLength === 'number' ? inner.maxLength : undefined,
    width:
      kind === 'longtext' ? 260 :
      kind === 'enum' && (options?.length ?? 0) < 8 ? 140 :
      kind === 'number' ? 110 : 180,
  }
}

/** Best-effort Amazon attribute path for TSV export. */
function buildFieldRef(fieldId: string, index = 1): string {
  const LOCALIZED = new Set([
    'item_name', 'brand', 'product_description', 'bullet_point',
    'generic_keyword', 'special_feature', 'item_type_name',
    'lifestyle', 'style', 'fabric_type', 'care_instructions',
    'lining_description', 'material',
  ])
  if (LOCALIZED.has(fieldId))
    return `${fieldId}[marketplace_id][language_tag]#${index}.value`
  if (fieldId.includes('image_locator'))
    return `${fieldId}[marketplace_id]#${index}.media_location`
  return `${fieldId}[marketplace_id]#${index}.value`
}

/**
 * Expand one schema property into 1 or more FlatFileColumns, handling all
 * Amazon schema patterns without leaking fields:
 *
 *   A) Multi-instance arrays (bullet_point, special_feature, material…)
 *      maxUniqueItems 2–20 → N numbered columns capped at 5.
 *
 *   B) Dimension pairs at the item level (item_package_weight, item_weight…)
 *      items.properties = {value, unit} → two columns: value (number) + unit (enum).
 *
 *   C) Named sub-properties (apparel_size, item_package_dimensions,
 *      fulfillment_availability, list_price, num_batteries…)
 *      items.properties has ≥2 meaningful named keys → one column per sub-prop.
 *      Where a sub-prop itself is a dimension pair ({value, unit}), it generates
 *      two columns (e.g. item_package_dimensions__length + __length_unit).
 *
 *   D) Single column — everything else.
 *
 * Column IDs for expanded fields:
 *   - Multi-instance: `{fieldId}_{n}` e.g. bullet_point_1
 *   - Sub-property:   `{fieldId}__{subId}` e.g. apparel_size__size_system
 *   - Unit of sub:    `{fieldId}__{subId}_unit` e.g. item_package_dimensions__length_unit
 *   - Dimension val:  `{fieldId}__value` / `{fieldId}__unit`
 *
 * expandedFields is populated so buildJsonFeedBody can reassemble them.
 */
function expandSchemaField(
  fieldId: string,
  prop: Record<string, any>,
  isRequired: boolean,
  schemaLabels: Record<string, string>,
  schemaEnums: Record<string, string[]>,
  lang: LangTag,
  expandedFields: Record<string, string>,
): FlatFileColumn[] {
  // Fields whose sub-properties are too complex to auto-expand meaningfully.
  const SKIP_SUB_EXPAND = new Set([
    'purchasable_offer',         // deeply-nested price schedules
    'sleeve',                    // sub-props are complex arrays
    'compliance_media',
    'supplemental_condition_information',
    'child_parent_sku_relationship',  // handled in Variations group
    'epr_product_packaging',
  ])

  const INFRA = new Set(['marketplace_id', 'language_tag', 'audience'])
  const subProps: Record<string, any> = prop?.items?.properties ?? {}
  const meaningfulKeys = Object.keys(subProps).filter((k) => !INFRA.has(k))

  // ── Pattern A: multi-instance ─────────────────────────────────────────
  const max: number = prop?.maxUniqueItems ?? 0
  if (max >= 2 && max <= 20 && meaningfulKeys.length <= 2) {
    const count = Math.min(max, 5)
    const base = schemaFieldToColumn(fieldId, prop, isRequired, schemaLabels, schemaEnums, lang)
    return Array.from({ length: count }, (_, i) => {
      const idx = i + 1
      const id = `${fieldId}_${idx}`
      expandedFields[id] = fieldId
      return {
        ...base, id,
        fieldRef: buildFieldRef(fieldId, idx),
        labelEn: `${base.labelEn} ${idx}`,
        labelLocal: `${base.labelLocal} ${idx}`,
        required: isRequired && idx === 1,
      }
    })
  }

  // ── Pattern B: top-level dimension pair {value, unit} ─────────────────
  const isDimPair =
    meaningfulKeys.length === 2 &&
    meaningfulKeys.includes('value') &&
    meaningfulKeys.includes('unit')

  if (isDimPair && !SKIP_SUB_EXPAND.has(fieldId)) {
    const unitProp = subProps.unit as Record<string, any>
    const unitEnums: string[] = unitProp?.enum ?? unitProp?.enumNames ?? []
    const fieldLabel = schemaLabels[fieldId] ?? FIXED_FIELD_LABELS[fieldId]?.[lang]
      ?? fieldId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    const unitLabel = (unitProp?.title as string | undefined) ?? `${fieldLabel} Unit`

    const vId = `${fieldId}__value`
    const uId = `${fieldId}__unit`
    expandedFields[vId] = `${fieldId}.value`
    expandedFields[uId] = `${fieldId}.unit`

    return [
      { id: vId, fieldRef: `${fieldId}[marketplace_id]#1.value`, labelEn: fieldId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), labelLocal: fieldLabel, required: isRequired, kind: 'number', width: 100 },
      { id: uId, fieldRef: `${fieldId}[marketplace_id]#1.unit`,  labelEn: `${fieldId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} Unit`, labelLocal: unitLabel, required: false, kind: unitEnums.length > 0 ? 'enum' : 'text', options: unitEnums.length > 0 ? ['', ...unitEnums.map(String)] : undefined, width: 140 },
    ]
  }

  // ── Pattern C: named sub-properties ──────────────────────────────────
  // At least 2 named keys, none of which is just "value" (standard wrapped).
  const namedKeys = meaningfulKeys.filter((k) => k !== 'value')
  if (namedKeys.length >= 2 && !SKIP_SUB_EXPAND.has(fieldId)) {
    const columns: FlatFileColumn[] = []

    for (const subId of namedKeys) {
      const subProp = subProps[subId] as Record<string, any>
      const subTitle = (subProp?.title as string | undefined) ??
        (subProp?.items?.properties?.value?.title as string | undefined)
      const subEnLabel = `${subId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`
      const subLoLabel = subTitle ?? subEnLabel

      // Check if the sub-prop itself is a dimension pair {value, unit}
      const subSubProps: Record<string, any> =
        subProp?.items?.properties ?? subProp?.properties ?? {}
      const subSubKeys = Object.keys(subSubProps).filter((k) => !INFRA.has(k))
      const subIsDim = subSubKeys.includes('value') && subSubKeys.includes('unit')

      if (subIsDim) {
        const unitProp = subSubProps.unit as Record<string, any>
        const unitEnums: string[] = unitProp?.enum ?? unitProp?.enumNames ?? []
        const unitTitle = (unitProp?.title as string | undefined) ?? `${subLoLabel} Unit`

        const vId = `${fieldId}__${subId}`
        const uId = `${fieldId}__${subId}_unit`
        expandedFields[vId] = `${fieldId}.${subId}.value`
        expandedFields[uId] = `${fieldId}.${subId}.unit`

        columns.push({
          id: vId, fieldRef: `${fieldId}[marketplace_id]#1.${subId}.value`,
          labelEn: subEnLabel, labelLocal: subLoLabel,
          required: false, kind: 'number', width: 100,
        })
        columns.push({
          id: uId, fieldRef: `${fieldId}[marketplace_id]#1.${subId}.unit`,
          labelEn: `${subEnLabel} Unit`, labelLocal: unitTitle,
          required: false, kind: unitEnums.length > 0 ? 'enum' : 'text',
          options: unitEnums.length > 0 ? ['', ...unitEnums.map(String)] : undefined,
          width: 140,
        })
        continue
      }

      // Simple or array-with-enum sub-property
      const subType = subProp?.type as string | undefined
      // Skip deeply complex sub-props (unenumerated arrays, objects)
      if (subType === 'object') continue
      if (subType === 'array') {
        const subEnums = schemaEnums[`${fieldId}.${subId}`] ?? []
        if (subEnums.length === 0) continue
      }

      const colId = `${fieldId}__${subId}`
      expandedFields[colId] = `${fieldId}.${subId}`

      const opts = schemaEnums[`${fieldId}.${subId}`] ?? []
      let kind: FlatFileColumnKind = 'text'
      let options: string[] | undefined
      if (opts.length > 0) { kind = 'enum'; options = ['', ...opts] }
      else if (subType === 'integer' || subType === 'number') kind = 'number'
      else if (subType === 'boolean') { kind = 'enum'; options = ['', 'true', 'false'] }

      columns.push({
        id: colId, fieldRef: `${fieldId}[marketplace_id]#1.${subId}`,
        labelEn: subEnLabel, labelLocal: subLoLabel,
        required: false, kind, options,
        width: kind === 'enum' && (options?.length ?? 0) < 8 ? 140 : 180,
      })
    }

    if (columns.length >= 1) return columns
    // Fall through to single-column if we couldn't resolve any sub-props
  }

  // ── Pattern D: single column ──────────────────────────────────────────
  return [schemaFieldToColumn(fieldId, prop, isRequired, schemaLabels, schemaEnums, lang)]
}

// ── Main service ───────────────────────────────────────────────────────

export class AmazonFlatFileService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly schemas: CategorySchemaService,
  ) {}

  async generateManifest(
    marketplace: string,
    productType: string,
    forceRefresh = false,
  ): Promise<FlatFileManifest> {
    const mp = marketplace.toUpperCase()
    const pt = productType.toUpperCase()

    let cached = forceRefresh
      ? await this.schemas.refreshSchema({ channel: 'AMAZON', marketplace: mp, productType: pt })
      : await this.schemas.getSchema({ channel: 'AMAZON', marketplace: mp, productType: pt })

    let def = (cached.schemaDefinition ?? {}) as Record<string, any>

    // Auto-refresh schemas cached before FF.10 that lack __propertyGroups.
    // This is a one-time backfill — subsequent calls use the cached version.
    if (!def.__propertyGroups && !forceRefresh) {
      cached = await this.schemas.refreshSchema({ channel: 'AMAZON', marketplace: mp, productType: pt })
      def = (cached.schemaDefinition ?? {}) as Record<string, any>
    }
    const properties = (def.properties ?? {}) as Record<string, any>
    const requiredSet = new Set<string>(Array.isArray(def.required) ? def.required : [])

    // Parent/child field graying — compute exclusive field sets.
    // productOnlyFields: present only in LISTING_PRODUCT_ONLY → gray for child rows.
    // offerOnlyFields: present only in LISTING_OFFER_ONLY → gray for parent rows.
    const rawProductOnly = new Set<string>((def.__productOnlyFields as string[] | undefined) ?? [])
    const rawOfferOnly   = new Set<string>((def.__offerOnlyFields  as string[] | undefined) ?? [])
    const productExclusiveFields = [...rawProductOnly].filter((f) => !rawOfferOnly.has(f))
    const offerExclusiveFields   = [...rawOfferOnly].filter((f) => !rawProductOnly.has(f))

    const lang = (LANGUAGE_TAG_MAP[mp] ?? 'en_GB') as LangTag
    const schemaLabels = buildSchemaLabels(properties)
    const schemaEnums = buildSchemaEnums(properties)

    const ll = (id: string, fallbackEn: string): string =>
      schemaLabels[id] ?? FIXED_FIELD_LABELS[id]?.[lang] ?? fallbackEn

    // Variation themes come from the schema enum — same source as every other
    // enum field. The separately-stored variationThemes column is redundant now.
    const variationThemes: string[] = schemaEnums['variation_theme'] ?? []

    // ── Group 1: Infrastructure (fixed — not in Amazon's schema) ─────────
    const infraGroup: FlatFileColumnGroup = {
      id: 'offer_identity',
      labelEn: 'Offer Identity',
      labelLocal: GROUP_LOCAL_LABELS.offer_identity[lang] ?? 'Offer Identity',
      color: 'blue',
      columns: [
        {
          id: 'item_sku', fieldRef: 'contribution_sku#1.value',
          labelEn: 'Seller SKU', labelLocal: ll('item_sku', 'SKU'),
          required: true, kind: 'text', width: 180,
        },
        {
          id: 'product_type', fieldRef: 'product_type#1.value',
          labelEn: 'Product Type', labelLocal: ll('product_type', 'Product Type'),
          required: true, kind: 'text', width: 140,
        },
        {
          id: 'record_action', fieldRef: '::record_action',
          labelEn: 'Operation', labelLocal: ll('record_action', 'Offer Action'),
          required: true, kind: 'enum', width: 140,
          options: ['full_update', 'partial_update', 'delete'],
          description: 'full_update = create/replace · partial_update = merge fields · delete = remove',
        },
      ],
    }

    // ── Group 2: Variations — all three columns are schema-derived ────────
    // parentage_level enum, variation_theme enum, and parent_sku (sub-prop of
    // child_parent_sku_relationship) all come from schemaEnums, so they
    // automatically reflect the correct values for any marketplace + product type.
    const parentageOpts = schemaEnums['parentage_level'] ?? ['Child', 'Parent']
    const variationsGroup: FlatFileColumnGroup = {
      id: 'variations',
      labelEn: 'Variations',
      labelLocal: GROUP_LOCAL_LABELS.variations[lang] ?? 'Variations',
      color: 'purple',
      columns: [
        {
          id: 'parentage_level',
          fieldRef: 'parentage_level[marketplace_id]#1.value',
          labelEn: 'Parent/Child',
          labelLocal: schemaLabels['parentage_level'] ?? ll('parentage_level', 'Parentage Level'),
          required: false, kind: 'enum', width: 130,
          options: ['', ...parentageOpts],
          description: 'Blank = standalone; Parent = non-buyable variation parent; Child = variant',
        },
        {
          id: 'parent_sku',
          fieldRef: 'child_parent_sku_relationship[marketplace_id]#1.parent_sku',
          labelEn: 'Parent SKU',
          labelLocal: schemaLabels['child_parent_sku_relationship'] ?? ll('parent_sku', 'Parent SKU'),
          required: false, kind: 'text', width: 180,
          description: 'Required when parentage_level = Child',
        },
        {
          id: 'variation_theme',
          fieldRef: 'variation_theme[marketplace_id]#1.name',
          labelEn: 'Variation Theme',
          labelLocal: schemaLabels['variation_theme'] ?? ll('variation_theme', 'Variation Theme'),
          required: false,
          kind: variationThemes.length > 0 ? 'enum' : 'text',
          options: variationThemes.length > 0 ? ['', ...variationThemes] : undefined,
          width: 200,
          description: 'Required on Parent rows. Values from live schema for this product type.',
        },
      ],
    }

    // ── Groups 3+: Amazon's exact grouping when available ────────────────
    //
    // After the first "Refresh schema" hit, the schema-sync service embeds
    // Amazon's propertyGroups metadata (from the API envelope) into the
    // stored schemaDefinition as __propertyGroups. Each group has:
    //   { title: string (already localised), propertyNames: string[] }
    //
    // When __propertyGroups is present we reproduce Amazon's exact group
    // order and names for the selected marketplace. When it isn't (old
    // cached schemas), we fall back to Required / Images / Optional.

    const SKIP_FIXED = new Set([
      'parentage_level', 'child_parent_sku_relationship', 'variation_theme',
    ])

    // expandedFields maps each numbered col ID back to its base schema field ID.
    // e.g. { "bullet_point_1": "bullet_point", "material_2": "material" }
    // Needed by buildJsonFeedBody to reassemble them into SP-API arrays.
    const expandedFields: Record<string, string> = {}

    // Helper: expand one schema property into 1 or N columns
    const expand = (fieldId: string, prop: Record<string, any>, isReq: boolean) =>
      expandSchemaField(fieldId, prop, isReq, schemaLabels, schemaEnums, lang, expandedFields)

    const amazonGroups = def.__propertyGroups as
      | Record<string, { title: string; propertyNames: string[] }>
      | undefined

    let schemaGroups: FlatFileColumnGroup[]

    if (amazonGroups && Object.keys(amazonGroups).length > 0) {
      // ── Path A: exact Amazon grouping ──────────────────────────────────
      const coveredFields = new Set<string>()
      schemaGroups = Object.entries(amazonGroups).map(([groupId, groupMeta], idx) => {
        const color = GROUP_COLOR_PALETTE[idx + 2] ?? 'slate'
        const columns: FlatFileColumn[] = []
        for (const fieldId of groupMeta.propertyNames) {
          if (SKIP_FIXED.has(fieldId)) continue
          const prop = properties[fieldId]
          if (!prop) continue
          coveredFields.add(fieldId)
          columns.push(...expand(fieldId, prop, requiredSet.has(fieldId)))
        }
        const labelLocal = typeof groupMeta.title === 'string'
          ? groupMeta.title
          : (groupMeta.title as any)?.value ?? groupIdToEnglish(groupId)
        return { id: groupId, labelEn: groupIdToEnglish(groupId), labelLocal, color, columns }
      }).filter((g) => g.columns.length > 0)

      // Any schema properties not assigned to an Amazon group
      const uncoveredCols: FlatFileColumn[] = []
      for (const [fieldId, prop] of Object.entries(properties)) {
        if (SKIP_FIXED.has(fieldId) || coveredFields.has(fieldId)) continue
        uncoveredCols.push(...expand(fieldId, prop as Record<string, any>, requiredSet.has(fieldId)))
      }
      if (uncoveredCols.length > 0) {
        schemaGroups.push({
          id: 'other_attributes',
          labelEn: 'Other Attributes',
          labelLocal: lang === 'it_IT' ? 'Altri attributi'
            : lang === 'de_DE' ? 'Weitere Attribute'
            : lang === 'fr_FR' ? 'Autres attributs'
            : lang === 'es_ES' ? 'Otros atributos' : 'Other Attributes',
          color: 'violet',
          columns: uncoveredCols.sort((a, b) => a.labelEn.localeCompare(b.labelEn)),
        })
      }
    } else {
      // ── Path B: fallback grouping (refresh schema to get exact Amazon groups)
      const imageCols: FlatFileColumn[] = []
      const otherCols: FlatFileColumn[] = []
      for (const [fieldId, prop] of Object.entries(properties)) {
        if (SKIP_FIXED.has(fieldId)) continue
        const cols = expand(fieldId, prop as Record<string, any>, requiredSet.has(fieldId))
        if (fieldId.includes('image_locator')) imageCols.push(...cols)
        else otherCols.push(...cols)
      }
      otherCols.sort((a, b) => {
        if (a.required !== b.required) return a.required ? -1 : 1
        return a.labelEn.localeCompare(b.labelEn)
      })
      imageCols.sort((a, b) => a.id.localeCompare(b.id))

      schemaGroups = []
      if (otherCols.length > 0) schemaGroups.push({
        id: 'schema_fields', labelEn: 'Schema Fields',
        labelLocal: lang === 'it_IT' ? 'Campi schema'
          : lang === 'de_DE' ? 'Schema-Felder'
          : lang === 'fr_FR' ? 'Champs de schéma'
          : lang === 'es_ES' ? 'Campos de esquema' : 'Schema Fields',
        color: 'emerald', columns: otherCols,
      })
      if (imageCols.length > 0) schemaGroups.push({
        id: 'images', labelEn: 'Images',
        labelLocal: GROUP_LOCAL_LABELS.images[lang] ?? 'Images',
        color: 'orange', columns: imageCols,
      })
    }

    return {
      marketplace: mp,
      productType: pt,
      variationThemes,
      fetchedAt: new Date().toISOString(),
      groups: [infraGroup, variationsGroup, ...schemaGroups],
      expandedFields,
      productExclusiveFields,
      offerExclusiveFields,
    }
  }

  async getExistingRows(
    marketplace: string,
    productType?: string,
    productId?: string,
  ): Promise<FlatFileRow[]> {
    const mp = marketplace.toUpperCase()
    let products: any[]

    if (productId) {
      const anchor = await this.prisma.product.findUnique({
        where: { id: productId },
        include: { channelListings: { where: { channel: 'AMAZON', marketplace: mp } } },
      })
      if (!anchor) return []

      if (anchor.isParent) {
        const children = await this.prisma.product.findMany({
          where: { parentId: productId, deletedAt: null },
          include: { channelListings: { where: { channel: 'AMAZON', marketplace: mp } } },
          orderBy: { sku: 'asc' },
        })
        products = [anchor, ...children]
      } else if ((anchor as any).parentId) {
        const parentId = (anchor as any).parentId as string
        const [parent, siblings] = await Promise.all([
          this.prisma.product.findUnique({
            where: { id: parentId },
            include: { channelListings: { where: { channel: 'AMAZON', marketplace: mp } } },
          }),
          this.prisma.product.findMany({
            where: { parentId, deletedAt: null },
            include: { channelListings: { where: { channel: 'AMAZON', marketplace: mp } } },
            orderBy: { sku: 'asc' },
          }),
        ])
        products = parent ? [parent, ...siblings] : siblings
      } else {
        products = [anchor]
      }
    } else {
      const where: Record<string, any> = { deletedAt: null }
      if (productType) where.productType = productType.toUpperCase()
      products = await this.prisma.product.findMany({
        where,
        include: { channelListings: { where: { channel: 'AMAZON', marketplace: mp } } },
        orderBy: [{ parentId: 'asc' }, { sku: 'asc' }],
        take: 2000,
      })
    }

    return products.map((p) => {
      const listing = (p.channelListings as any[])[0]
      const attrs = ((listing?.platformAttributes as any)?.attributes ?? {}) as Record<string, any>
      const bullets: string[] = Array.isArray(listing?.bulletPointsOverride)
        ? listing.bulletPointsOverride
        : Array.isArray(attrs.bullet_point)
        ? (attrs.bullet_point as any[]).map((b: any) => b?.value ?? String(b))
        : []

      // Start with fixed structural fields
      const row: FlatFileRow = {
        _rowId: p.id, _productId: p.id, _isNew: false, _status: 'idle',
        item_sku:              p.sku,
        product_type:          (p.productType as string | null) ?? productType ?? '',
        record_action:         'full_update',
        parentage_level:       p.isParent ? 'Parent' : (p as any).parentId ? 'Child' : '',
        parent_sku:            (p as any).parentAsin ?? '',
        variation_theme:       String(attrs.variation_theme?.[0]?.value ?? ''),
        // Common schema fields pre-populated from DB
        item_name:             listing?.title ?? attrs.item_name?.[0]?.value ?? p.name ?? '',
        brand:                 String(attrs.brand?.[0]?.value ?? ''),
        product_description:   listing?.description ?? attrs.product_description?.[0]?.value ?? '',
        bullet_point:          bullets[0] ?? '',
        generic_keyword:       String(attrs.generic_keyword?.[0]?.value ?? ''),
        color:                 String(attrs.color?.[0]?.value ?? ''),
        purchasable_offer:     listing?.price != null ? String(listing.price) : '',
        fulfillment_availability: listing?.quantity != null ? String(listing.quantity) : '',
        main_product_image_locator: '',
      }

      // Populate remaining attributes from platformAttributes, expanding
      // complex fields to match the column IDs generated by expandSchemaField.
      const INFRA = new Set(['marketplace_id', 'language_tag', 'audience'])
      for (const [k, v] of Object.entries(attrs)) {
        if (k in row) continue

        if (!Array.isArray(v)) {
          if (v != null) row[k] = String(v)
          continue
        }
        if (v.length === 0) continue

        const first = v[0]
        if (typeof first !== 'object' || first === null) {
          // Primitive array: expand into numbered fields
          v.forEach((item, i) => { if (item != null) row[`${k}_${i + 1}`] = String(item) })
          continue
        }

        const keys = Object.keys(first).filter((fk) => !INFRA.has(fk))
        if (keys.length === 0) continue

        if (keys.length === 1 && keys[0] === 'value') {
          // Standard wrapped {value: "..."}
          if (v.length > 1) {
            v.forEach((item, i) => { const val = item?.value; if (val != null) row[`${k}_${i + 1}`] = String(val) })
          } else {
            const val = first.value; if (val != null) row[k] = String(val)
          }
        } else if (keys.length === 2 && keys.includes('value') && keys.includes('unit')) {
          // Top-level dimension {value, unit}
          if (first.value != null) row[`${k}__value`] = String(first.value)
          if (first.unit) row[`${k}__unit`] = String(first.unit)
        } else if (v.length > 1 && keys.includes('value')) {
          // Multi-instance {value: "..."}
          v.forEach((item, i) => { const val = item?.value; if (val != null) row[`${k}_${i + 1}`] = String(val) })
        } else {
          // Sub-property object — extract each named key
          for (const subKey of keys) {
            if (subKey === 'value') continue
            const subVal = first[subKey]
            if (typeof subVal === 'object' && subVal !== null) {
              // Dimension sub-prop {value, unit}
              if (subVal.value != null) row[`${k}__${subKey}`] = String(subVal.value)
              if (subVal.unit) row[`${k}__${subKey}_unit`] = String(subVal.unit)
            } else if (subVal != null && subVal !== '') {
              row[`${k}__${subKey}`] = String(subVal)
            }
          }
        }
      }

      return row
    })
  }

  buildJsonFeedBody(
    rows: FlatFileRow[],
    marketplace: string,
    sellerId: string,
    expandedFields: Record<string, string> = {},
  ): string {
    const mp = marketplace.toUpperCase()
    const marketplaceId = MARKETPLACE_ID_MAP[mp] ?? MARKETPLACE_ID_MAP.IT
    const languageTag = LANGUAGE_TAG_MAP[mp] ?? 'it_IT'

    // Fields with complex/explicit SP-API structure — handled case-by-case below
    const EXPLICIT_KEYS = new Set([
      'item_sku', 'product_type', 'record_action',
      'parentage_level', 'parent_sku', 'variation_theme',
      'item_name', 'brand', 'product_description',
      'bullet_point', 'generic_keyword', 'color',
      'purchasable_offer', 'fulfillment_availability',
      'main_product_image_locator',
    ])

    const messages = rows
      .filter((r) => r.item_sku)
      .map((row, i) => {
        const opRaw = String(row.record_action ?? 'full_update')
        const operationType = opRaw === 'delete' ? 'DELETE' : 'UPDATE'
        const productType = String(row.product_type ?? '').toUpperCase()

        if (operationType === 'DELETE') {
          return { messageId: i + 1, sku: String(row.item_sku), operationType, productType, attributes: {} }
        }

        const attrs: Record<string, any> = {}
        const wrap  = (v: string) => [{ value: v, marketplace_id: marketplaceId }]
        const wrapL = (v: string) => [{ value: v, language_tag: languageTag, marketplace_id: marketplaceId }]

        if (row.item_name)           attrs.item_name           = wrapL(String(row.item_name))
        if (row.brand)               attrs.brand               = wrapL(String(row.brand))
        if (row.product_description) attrs.product_description = wrapL(String(row.product_description))
        if (row.bullet_point)        attrs.bullet_point        = [{ value: String(row.bullet_point), language_tag: languageTag, marketplace_id: marketplaceId }]
        if (row.generic_keyword)     attrs.generic_keyword     = wrapL(String(row.generic_keyword))
        if (row.color)               attrs.color               = wrapL(String(row.color))
        if (row.main_product_image_locator) attrs.main_product_image_locator = wrap(String(row.main_product_image_locator))

        if (row.purchasable_offer) {
          attrs.purchasable_offer = [{
            currency: CURRENCY_MAP[mp] ?? 'EUR',
            our_price: [{ schedule: [{ value_with_tax: parseFloat(String(row.purchasable_offer)) }] }],
            marketplace_id: marketplaceId,
          }]
        }
        if (row.fulfillment_availability) {
          attrs.fulfillment_availability = [{
            fulfillment_channel_code: 'DEFAULT',
            quantity: parseInt(String(row.fulfillment_availability), 10),
            marketplace_id: marketplaceId,
          }]
        }

        if (String(row.parentage_level).toLowerCase() === 'parent' && row.variation_theme) {
          attrs.variation_theme = wrap(String(row.variation_theme))
        }
        if (String(row.parentage_level).toLowerCase() === 'child' && row.parent_sku) {
          attrs.parentage_level              = [{ value: 'child', marketplace_id: marketplaceId }]
          attrs.child_parent_sku_relationship = [{ parent_sku: String(row.parent_sku), marketplace_id: marketplaceId }]
        }

        // Generic handler: reassemble expanded columns into SP-API arrays.
        //   - expandedFields[colId] = fieldId            → multi-instance (bullet_point_1)
        //   - expandedFields[colId] = "field.sub"        → sub-property   (apparel_size__size_system)
        //   - expandedFields[colId] = "field.sub.value"  → dimension value (item_package_dimensions__length)
        //   - expandedFields[colId] = "field.sub.unit"   → dimension unit  (item_package_dimensions__length_unit)
        const pendingArrays: Record<string, Array<{ idx: number; value: string }>> = {}
        const subPropMap: Record<string, Record<string, any>> = {}

        for (const [k, v] of Object.entries(row)) {
          if (k.startsWith('_') || !v || EXPLICIT_KEYS.has(k)) continue
          const path = expandedFields[k]
          if (path) {
            if (!path.includes('.')) {
              // Multi-instance: path = "bullet_point", key = "bullet_point_1"
              const idx = parseInt(k.slice(path.length + 1), 10)
              if (!isNaN(idx)) (pendingArrays[path] ??= []).push({ idx, value: String(v) })
            } else {
              // Sub-property path: "field.sub" or "field.sub.value" or "field.sub.unit"
              const parts = path.split('.')
              const base = parts[0]
              const obj = (subPropMap[base] ??= {})
              const numV = Number(String(v))
              const typedV = !isNaN(numV) && String(v).trim() !== '' ? numV : String(v)
              if (parts.length === 2) {
                obj[parts[1]] = typedV
              } else if (parts.length === 3) {
                obj[parts[1]] = { ...(obj[parts[1]] as Record<string, any> ?? {}), [parts[2]]: typedV }
              }
            }
            continue
          }
          if (k.includes('image_locator')) {
            attrs[k] = [{ media_location: String(v), marketplace_id: marketplaceId }]
          } else {
            attrs[k] = [{ value: String(v), marketplace_id: marketplaceId, language_tag: languageTag }]
          }
        }
        // Emit multi-instance arrays
        for (const [base, items] of Object.entries(pendingArrays)) {
          items.sort((a, b) => a.idx - b.idx)
          attrs[base] = items.map((item) => ({
            value: item.value, marketplace_id: marketplaceId, language_tag: languageTag,
          }))
        }
        // Emit sub-property objects
        for (const [base, val] of Object.entries(subPropMap)) {
          attrs[base] = [{ ...val, marketplace_id: marketplaceId }]
        }

        return {
          messageId: i + 1,
          sku: String(row.item_sku),
          operationType,
          productType,
          requirements: String(row.parentage_level).toLowerCase() === 'parent' ? 'LISTING_PRODUCT_ONLY' : 'LISTING',
          attributes: attrs,
        }
      })

    return JSON.stringify({
      header: { sellerId, version: '2.0', issueLocale: languageTag.replace('_', '-') },
      messages,
    })
  }

  buildTsvExport(manifest: FlatFileManifest, rows: FlatFileRow[]): string {
    const allCols = manifest.groups.flatMap((g) => g.columns)
    const colIds  = allCols.map((c) => c.id)
    const meta    = `TemplateType=customizable\tVersion=2025.0\tProductType=${manifest.productType}\tMarketplace=${manifest.marketplace}`
    const hdrEn   = allCols.map((c) => c.labelEn).join('\t')
    const hdrIt   = allCols.map((c) => c.labelLocal).join('\t')
    const hdrRef  = allCols.map((c) => c.fieldRef).join('\t')
    const hdrReq  = allCols.map((c) => (c.required ? 'Required' : 'Optional')).join('\t')
    const data    = rows.map((row) =>
      colIds.map((id) => {
        const v = row[id]
        return v == null ? '' : String(v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ')
      }).join('\t'),
    )
    return [meta, hdrEn, hdrIt, hdrRef, hdrReq, ...data].join('\r\n')
  }

  parseTsv(content: string, productType: string): FlatFileRow[] {
    const lines = content.split(/\r?\n/).filter((l) => l.trim())
    if (lines.length < 2) return []

    let headerLine = 0
    while (headerLine < lines.length && lines[headerLine].startsWith('TemplateType')) headerLine++
    if (headerLine >= lines.length) return []

    const cols = lines[headerLine].split('\t').map((c) => c.trim().toLowerCase().replace(/ /g, '_'))
    const dataStart = headerLine + 1
    const firstData = lines[dataStart] ?? ''
    const isAnnotation = /^required|^optional|^conditional/i.test(firstData.split('\t')[0] ?? '')
    const rowStart = isAnnotation ? dataStart + 1 : dataStart

    return lines
      .slice(rowStart)
      .map((line, idx) => {
        const cells = line.split('\t')
        const row: FlatFileRow = {
          _rowId: `import-${idx}`, _isNew: false, _status: 'idle',
          product_type: productType, record_action: 'full_update',
          item_sku: '', parentage_level: '', parent_sku: '', variation_theme: '',
        }
        cols.forEach((col, i) => {
          const val = cells[i]?.trim() ?? ''
          if (val) row[col] = val
        })
        return row
      })
      .filter((r) => String(r.item_sku).length > 0)
  }
}
