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

import { createHash } from 'node:crypto'
import type { PrismaClient } from '@nexus/database'
import { CategorySchemaService } from '../categories/schema-sync.service.js'
import { parseLocaleNumber, parseLocaleInt } from '../../lib/parse-locale-number.js'
import { casUpdateChannelListing, isVersionConflict } from '../channel-listing-cas.js'
import { productReadCacheService } from '../product-read-cache.service.js'
import { extractBrowseNodes, browseNodeIdFromRow, resolveBrowseNodeId, buildPlatformAttributes, type BrowseNode } from './browse-nodes.js'
import { extractConditionalFields } from '../listing-wizard/conditional-requirements.js'
import { amazonMarketplaceId } from '../categories/marketplace-ids.js'
import { buildListingScopeWhere, type ListingScope } from '../flat-file/listing-scope.js'

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

// Fields that must be exactly one of the predefined options — free text is invalid.
const STRICT_ENUM_FIELDS = new Set([
  'parentage_level', 'record_action', 'variation_theme',
  'condition_type', 'item_condition', 'country_of_origin',
  'merchant_shipping_group_name',
])

export interface FlatFileColumn {
  id: string
  fieldRef: string
  labelEn: string
  labelLocal: string
  description?: string
  required: boolean
  /**
   * UFX P1 — "required-if-present": this sub-column's parent attribute is
   * OPTIONAL, but the schema's nested `items.required` lists this sub-property
   * (e.g. a value+unit pair where `unit` is required). Once ANY sub-column of
   * the attribute is filled, this one must be too — enforced in preflight,
   * never a hard `required` (an untouched optional attribute stays optional).
   */
  requiredWithParent?: boolean
  /**
   * UFX P1 — the schema can make this attribute required CONDITIONALLY
   * (allOf/if/then or dependentRequired). Tagged for the UI; the per-row
   * evaluation happens in preflight (conditional-requirements evaluator).
   */
  conditional?: boolean
  kind: FlatFileColumnKind
  options?: string[]
  /**
   * UFX P1 — the schema CODES behind `options` (which prefer enumNames display
   * labels). Only present when at least one code differs from its label. Rows
   * can legitimately carry either (grid writes labels; snapshot/attrs
   * read-backs carry codes), so enum validation accepts both.
   */
  optionCodes?: string[]
  /** true → must pick from list (Amazon SELECTION_ONLY); false → combobox (free text allowed) */
  selectionOnly?: boolean
  /**
   * Which parentage levels this field is applicable to.
   * undefined = applicable to all row types.
   * Set from our group structure since Amazon's schema doesn't expose this directly.
   */
  applicableParentage?: ('VARIATION_PARENT' | 'VARIATION_CHILD' | 'STANDALONE')[]
  /**
   * MT.1 — only on a UNION manifest (multiple product types in one sheet):
   * which product types define this column, and which of them REQUIRE it. Lets
   * the grid grey a cell that doesn't apply to a row's product type, and lets
   * validation check required-ness per-row. undefined on a single-type manifest.
   */
  applicableProductTypes?: string[]
  requiredForProductTypes?: string[]
  /** UFX P1 — union manifest only: types for which this column is required-if-present. */
  requiredWithParentForProductTypes?: string[]
  /**
   * UFX P1 — union manifest only: per-product-type enum option labels/codes, so a
   * value valid for JACKET but not PANTS can be validated per row type (the union
   * `options` is the cross-type superset and can't catch that).
   */
  optionsByProductType?: Record<string, string[]>
  optionCodesByProductType?: Record<string, string[]>
  /** Amazon field usage level from x-amazon-attributes.usage */
  guidance?: 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL'
  /**
   * UFX P6a — Amazon meta-schema `hidden: true`: "should be hidden in Amazon
   * user interfaces". The column is still generated (existing row data may
   * carry a value, and the feed keeps emitting present values), but the
   * /template + /union-template responses filter hidden columns by default
   * (?includeHidden=1 keeps them). In real cached schemas the flag lives on
   * the LEAF value node (items.properties.value / the sub-property node).
   */
  hidden?: boolean
  /**
   * UFX P6a — Amazon meta-schema `editable: false`: the attribute cannot be
   * modified on an EXISTING listing (brand, condition_type,
   * externally_assigned_product_identifier…). Tag only — the grid lock is a
   * later phase; preflight warns when it can detect an actual change.
   */
  editableForListing?: boolean
  /** UFX P6a — union manifest only: types for which this column is non-editable. */
  nonEditableForProductTypes?: string[]
  /** Max length in CHARACTERS (JSON Schema maxLength). */
  maxLength?: number
  /**
   * Max length in UTF-8 BYTES (Amazon custom-vocab maxUtf8ByteLength). Amazon
   * enforces byte length, not char length — an accented Italian/German char is
   * 2+ bytes, so a title that's within maxLength chars can still blow the byte
   * limit and be rejected at submit. Captured so validation can count bytes.
   */
  maxUtf8ByteLength?: number
  minUtf8ByteLength?: number
  width: number
  /**
   * For enum fields that use canonical stored values (e.g. 'parent'/'child')
   * but need to display localized labels in the UI. Maps canonical value →
   * localized display label for the current market.
   * e.g. { 'parent': 'Articolo padre', 'child': 'Articolo figlio' } for IT.
   */
  optionLabels?: Record<string, string>
  /**
   * UFX P6g — enum values Amazon marks DEPRECATED via the meta-schema
   * `$lifecycle.enumDeprecated` marker (real exposure in cached schemas:
   * variation_theme themes, vehicle_fitment standards). Contains only values
   * the type STILL offers (codes + differing display labels), so the UI can
   * grey them and preflight can warn — a value dropped from the enum entirely
   * is already caught by the accepted-set check. Union manifests merge by set
   * union (warn-only hint, so cross-type over-reach is acceptable).
   */
  deprecatedOptions?: string[]
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
  /** MT.1 — on a UNION manifest, the product types it covers (productType is a
   *  composite "A+B" label then). undefined/single-element on a single-type one. */
  productTypes?: string[]
  variationThemes: string[]
  fetchedAt: string
  /**
   * UFX P6c — stable version fingerprint of the underlying schema content
   * (provider version + content hash; union = hash over the per-type
   * versions). Changes exactly when the schema content changes, so the
   * client can invalidate its localStorage manifest cache instead of
   * stacking a second 24 h TTL on top of the server's.
   */
  schemaVersion?: string
  /**
   * UFX P6g — Amazon's getDefinitionsProductType `requirementsEnforced`
   * ('ENFORCED' | 'NOT_ENFORCED'), captured by schema-sync as
   * __requirementsEnforced. NOT_ENFORCED means Amazon does not demand the
   * full required-attribute set (relevant for PARTIAL_UPDATE preflight).
   * Absent on schemas cached before the capture → callers must treat as
   * ENFORCED (conservative).
   */
  requirementsEnforced?: string
  /** UFX P6g — union manifest only: requirementsEnforced per member type. */
  requirementsEnforcedByType?: Record<string, string>
  groups: FlatFileColumnGroup[]
  /**
   * Maps expanded column IDs back to their base schema field ID.
   * e.g. { "bullet_point_1": "bullet_point", "material_2": "material" }
   * Used by buildJsonFeedBody to reassemble multi-instance columns into arrays.
   */
  expandedFields: Record<string, string>
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

/** Schema-derived hints for buildJsonFeedBody / buildJsonFeedBodyWithReport. */
export interface FeedSchemaHints {
  enumCodeMap?: Record<string, Record<string, string>>
  localizedFields?: Set<string>
  numericFields?: Set<string>
  booleanFields?: Set<string>
  /** FFP.3 — per product-type APPLICABLE column ids (from the union
   *  manifest). When a row's type has a set, columns outside it are NOT
   *  emitted — this kills the ~50-warnings-per-SKU spray of attributes
   *  that don't belong to the product type (90000900). */
  applicableByType?: Map<string, Set<string>>
  /** FFP.18 — attributes that nest ONE wrapped sub-property (closure→type,
   *  inner/outer→material …); emitted as `[{sub: [{value,…}]}]`. UFX P6e adds
   *  the `flat` variant: ONE PLAIN scalar sub-property (gpsr_manufacturer_reference
   *  → gpsr_manufacturer_email_address), emitted as `[{sub: value, marketplace_id}]`. */
  wrappedSubPropFields?: Record<string, WrappedSubPropField>
  /** UFX P1 (P0-2) — declared schema type per sub-property path; sub-values
   *  are coerced by THIS (a string-typed "38" stays a string) instead of
   *  Number() sniffing. Absent (no schema) → legacy sniff. */
  subPropTypes?: Record<string, SubPropType>
  /** FFP.3 — fallback productType when a row's own cell is blank (a blank
   *  productType malformed the whole feed: 4002010 '#/productType').
   *  UFX P6d — the row's parent (by parent_sku) wins over this fallback. */
  defaultProductType?: string
  /**
   * UFX P6g — the meta-schema `selectors` array per top-level attribute: the
   * item sub-properties that identify unique entries in a multi-value
   * attribute (pairs with maxUniqueItems). Used by the numbered-column
   * reassembly to dedup instances that collide under the attribute's OWN
   * uniqueness rule instead of assuming all-properties uniqueness. Absent
   * (no schema) → legacy behavior (no dedup).
   */
  selectorsByField?: Record<string, string[]>
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
  const enumValues: string[] = inner?.enum ?? []
  // UFX P1 (P4) — enumNames is only trustworthy when it lines up 1:1 with enum.
  // A length mismatch means the labels can't be mapped back to codes (the feed
  // would submit an unconvertible label), so fall back to the codes themselves.
  const namesAligned = enumValues.length === 0 || enumNames.length === enumValues.length
  if (enumNames.length > 0 && namesAligned) return enumNames.map(String).filter(Boolean)
  const validValues: string[] = inner?.['x-amazon-attributes']?.validValues ?? []
  if (validValues.length > 0) return validValues.map(String).filter(Boolean)
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
 * UFX P6g — deprecated enum CODES for a schema subtree, from Amazon's
 * meta-schema `$lifecycle.enumDeprecated` marker. Spelling/placement verified
 * against the live cached schemas (49 distinct defs probed 2026-07-11): the
 * marker sits on the SAME node that carries the enum, e.g.
 * variation_theme.items.properties.name.$lifecycle.enumDeprecated and
 * vehicle_fitment.items.properties.standard.items.properties.value.$lifecycle.
 * No `replacedBy`/`replaces` marker exists in ANY cached schema (enum-value
 * replacements have no vocabulary in Amazon's meta-schema today), so there is
 * no replacement plumbing on the manifest — preflight accepts an optional
 * replacement map for when Amazon ever ships one. Traversal mirrors
 * findEnumNode so the deprecated list is found wherever the enum itself is.
 */
export function findEnumDeprecated(node: Record<string, any>, depth = 0): string[] {
  if (!node || typeof node !== 'object' || depth > 5) return []

  const direct = node?.$lifecycle?.enumDeprecated
  if (Array.isArray(direct) && direct.length) return direct.map(String).filter(Boolean)

  for (const key of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(node[key])) {
      for (const branch of node[key]) {
        const v = findEnumDeprecated(branch as Record<string, any>, depth + 1)
        if (v.length) return v
      }
    }
  }

  const itemProps: Record<string, any> = node?.items?.properties ?? {}

  const valueNode = itemProps.value
  if (valueNode) {
    const v = findEnumDeprecated(valueNode, depth + 1)
    if (v.length) return v
  }

  const SKIP_PROPS = new Set(['value', 'marketplace_id', 'language_tag'])
  for (const [subId, subNode] of Object.entries(itemProps)) {
    if (SKIP_PROPS.has(subId)) continue
    const v = findEnumDeprecated(subNode as Record<string, any>, depth + 1)
    if (v.length) return v
  }

  return []
}

/**
 * UFX P6g — a column's deprecatedOptions: the schema's deprecated CODES kept
 * only where the type STILL offers them (a dropped value is the accepted-set
 * check's job), expressed as the code plus its differing display label (rows
 * legitimately carry either). Shared by the top-level and Pattern C
 * sub-column builders. Returns undefined when nothing applies.
 */
function deriveDeprecatedOptions(
  prop: Record<string, any>,
  enumOpts: string[],
  pairs: Array<{ code: string; label: string }>,
): string[] | undefined {
  const deprecatedCodes = findEnumDeprecated(prop)
  if (deprecatedCodes.length === 0) return undefined
  const codeToLabel = new Map(pairs.map((pr) => [pr.code, pr.label]))
  const dep = deprecatedCodes.flatMap((code) => {
    const label = codeToLabel.get(code)
    if (label !== undefined) return label !== code ? [code, label] : [code]
    return enumOpts.includes(code) ? [code] : []
  })
  return dep.length > 0 ? [...new Set(dep)] : undefined
}

/**
 * Walk all top-level schema properties and build a flat enum map.
 *   fieldId → string[]            e.g. "target_gender" → ["Female","Male","Unisex"]
 *   fieldId.subProp → string[]    e.g. "closure.type" → ["Button","Drawstring",...]
 */
export function buildSchemaEnums(properties: Record<string, any>): Record<string, string[]> {
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

/**
 * Like extractEnumOptions, but returns code↔label PAIRS. Amazon's schema gives
 * `enum` (the codes it accepts, e.g. "PK") parallel to `enumNames` (display
 * labels, e.g. "Pakistan"). The editor shows labels; the JSON feed must send
 * codes. When only codes exist, label === code.
 */
function extractEnumPairs(inner: Record<string, any>): Array<{ code: string; label: string }> {
  const codes: any[] = (inner?.enum ?? inner?.['x-amazon-attributes']?.validValues ?? []) as any[]
  if (!Array.isArray(codes) || codes.length === 0) return []
  // UFX P1 (P4) — the code↔label zip is positional, so it's only meaningful when
  // enumNames lines up 1:1 with enum. On a length mismatch, pairing index i of
  // one with index i of the other MIS-MAPS labels to the wrong codes (a wrong
  // country/size submitted silently) — fall back to codes-as-labels instead.
  const rawNames: any[] = Array.isArray(inner?.enumNames) ? inner.enumNames : []
  const names: any[] = rawNames.length === codes.length ? rawNames : []
  return codes.map((c, i) => ({ code: String(c), label: String(names[i] ?? c) }))
}

/** Mirror of findEnumNode that returns code↔label pairs instead of labels. */
function findEnumPairs(node: Record<string, any>, depth = 0): Array<{ code: string; label: string }> {
  if (!node || typeof node !== 'object' || depth > 5) return []
  const direct = extractEnumPairs(node)
  if (direct.length) return direct
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(node[key])) {
      for (const branch of node[key]) {
        const v = findEnumPairs(branch as Record<string, any>, depth + 1)
        if (v.length) return v
      }
    }
  }
  const itemProps: Record<string, any> = node?.items?.properties ?? {}
  const valueNode = itemProps.value
  if (valueNode) {
    const v = findEnumPairs(valueNode, depth + 1)
    if (v.length) return v
  }
  const SKIP_PROPS = new Set(['value', 'marketplace_id', 'language_tag'])
  for (const [subId, subNode] of Object.entries(itemProps)) {
    if (SKIP_PROPS.has(subId)) continue
    const v = findEnumPairs(subNode as Record<string, any>, depth + 1)
    if (v.length) return v
  }
  return []
}

/**
 * Build a label→code map per enum field (and per "field.sub" sub-property) so
 * the feed builder can convert the display label the editor stored (e.g.
 * "Pakistan") back to Amazon's required code (e.g. "PK"). Only includes fields
 * where at least one label differs from its code (all-equal fields need no
 * conversion). Mirrors buildSchemaEnums' traversal so the keys line up exactly.
 */
export function buildSchemaEnumCodeMap(properties: Record<string, any>): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {}
  const SKIP_SUB = new Set(['marketplace_id', 'language_tag', 'value'])

  const toMap = (pairs: Array<{ code: string; label: string }>): Record<string, string> | null => {
    const m: Record<string, string> = {}
    let differs = false
    for (const { code, label } of pairs) {
      if (!label) continue
      m[label] = code
      if (label !== code) differs = true
    }
    return differs ? m : null
  }

  for (const [fieldId, prop] of Object.entries(properties)) {
    const p = prop as Record<string, any>
    const valueNode = p?.items?.properties?.value ?? p
    const top = toMap(findEnumPairs(valueNode))
    if (top) result[fieldId] = top

    const subProps: Record<string, any> = p?.items?.properties ?? {}
    for (const [subId, subProp] of Object.entries(subProps)) {
      if (SKIP_SUB.has(subId)) continue
      const sub = toMap(findEnumPairs(subProp as Record<string, any>))
      if (sub) result[`${fieldId}.${subId}`] = sub
    }
  }
  return result
}

/**
 * Normalize a parentage_level cell value to canonical lowercase 'parent'/'child'/''
 * regardless of whether it's a localized label ("Articolo padre"), legacy title-case
 * ("Parent"/"Child"), or already canonical ("parent"/"child").
 * Pass the field's enumCodeMap entry (maps localized label → canonical code).
 */
export function normalizeParentage(
  raw: string,
  parentageCodeMap: Record<string, string> = {},
): 'parent' | 'child' | '' {
  if (!raw) return ''
  // Try localized-label → canonical code lookup first
  const mapped = parentageCodeMap[raw] ?? raw
  const lc = mapped.toLowerCase().trim()
  if (lc === 'parent') return 'parent'
  if (lc === 'child') return 'child'
  return ''
}

/**
 * Per-field scalar hints for the feed builder: which top-level fields are
 * localized (their schema carries a `language_tag` property — only those should
 * get a language_tag in the feed) and which are number/boolean typed (so the
 * generic emit can coerce "5"→5 and "true"→true instead of submitting the
 * strings Amazon rejects for typed attributes). Sub-properties are coerced inline
 * in buildJsonFeedBody, so only top-level fields are classified here.
 */
/**
 * FFP.19 — normalize ANY variation-theme spelling to this category's APPROVED
 * enum code. Rows carry themes in every historical dialect — legacy Seller
 * Central "SizeName-ColorName", localized labels ("Taglia/Colore"), wrong case
 * or separators — and Amazon rejects anything outside the enum (90244).
 * Resolution order: manifest label→code map · exact code (case-insensitive) ·
 * axis-set match (Size+Color ≡ COLOR/SIZE ≡ SIZE_NAME/COLOR_NAME, preferring
 * the *_NAME style when the input used Name-suffixed tokens). No confident
 * match → the raw value passes through (Amazon's report then names it).
 */
export function normalizeVariationTheme(raw: string, themeMap: Record<string, string> = {}): string {
  const input = String(raw ?? '').trim()
  if (!input) return input
  const direct = themeMap[input]
  if (direct) return direct
  const codes = [...new Set(Object.values(themeMap))]
  const ci = codes.find((c) => c.toUpperCase() === input.toUpperCase())
  if (ci) return ci

  const AXIS_SYNONYMS: Record<string, string> = {
    size: 'size', taglia: 'size', formato: 'size',
    color: 'color', colour: 'color', colore: 'color',
    material: 'material', materiale: 'material',
    style: 'style', stile: 'style',
  }
  const parse = (s: string): { key: string; ordered: string; sawName: boolean } => {
    const tokens = s.split(/[/_\s,-]+/).map((t) => t.trim().toLowerCase()).filter(Boolean)
    const axes: string[] = []
    let sawName = false
    for (const t of tokens) {
      let tok = t
      if (tok === 'name' || tok === 'nome') { sawName = true; continue }
      if (tok.endsWith('name') || tok.endsWith('nome')) {
        const base = tok.replace(/(name|nome)$/, '')
        if (base) { sawName = true; tok = base }
      }
      axes.push(AXIS_SYNONYMS[tok] ?? tok)
    }
    const uniq = [...new Set(axes)]
    return { key: [...uniq].sort().join('+'), ordered: uniq.join('>'), sawName }
  }
  const inp = parse(input)
  if (!inp.key) return input
  const matches = codes.filter((c) => parse(c).key === inp.key)
  if (matches.length === 0) return input
  if (matches.length === 1) return matches[0]
  // Same axis set in several spellings: prefer the operator's AXIS ORDER
  // (it drives the PDP dropdown order), then the matching Name-style.
  const rank = (c: string) => {
    const p = parse(c)
    return (p.ordered === inp.ordered ? 2 : 0) + (p.sawName === inp.sawName ? 1 : 0)
  }
  return [...matches].sort((a, b) => rank(b) - rank(a))[0]
}

export type SubPropType = 'string' | 'number' | 'boolean'

/** FFP.18 / UFX P6e — one nested sub-property of an attribute. `flat` = the sub
 *  is a PLAIN scalar (`[{sub: value}]`), not an array of wrapped values. */
export type WrappedSubPropField = { sub: string; localized: boolean; flat?: boolean }

export function buildSchemaFieldHints(properties: Record<string, any>): {
  localizedFields: Set<string>; numericFields: Set<string>; booleanFields: Set<string>
  /** FFP.18 — attributes whose payload nests ONE wrapped sub-property
   *  (closure→type, inner→material, outer→material …). Emitting these flat
   *  (`closure: [{value}]`) makes Amazon read them as EMPTY — the classic
   *  "filled in the grid but 'obbligatorio ma mancante'" (90220). UFX P6e adds
   *  `flat` entries for a single PLAIN scalar sub (gpsr_manufacturer_reference →
   *  gpsr_manufacturer_email_address): emitted as `[{sub: value}]`, since the
   *  generic `[{value}]` shape violates the schema (additionalProperties:false). */
  wrappedSubPropFields: Record<string, WrappedSubPropField>
  /** UFX P1 (P0-2) — declared JSON type per SUB-PROPERTY path, keyed exactly like
   *  expandedFields paths ("apparel_size.size", "item_package_dimensions.length.value",
   *  "item_package_weight.value"/".unit"). The feed builder coerces sub-values by
   *  THIS instead of Number() sniffing, so a string-typed all-digits value
   *  (size "38", a leading-zero code) stays a string. */
  subPropTypes: Record<string, SubPropType>
  /** UFX P6g — meta-schema `selectors` per top-level attribute (the item
   *  sub-properties that identify unique entries in a multi-value attribute).
   *  Real cached schemas carry these pervasively — [marketplace_id] or
   *  [marketplace_id, language_tag] on the flat multi-instance attributes
   *  (bullet_point, material, special_feature…). */
  selectorsByField: Record<string, string[]>
} {
  const localizedFields = new Set<string>()
  const numericFields = new Set<string>()
  const booleanFields = new Set<string>()
  const wrappedSubPropFields: Record<string, WrappedSubPropField> = {}
  const subPropTypes: Record<string, SubPropType> = {}
  const selectorsByField: Record<string, string[]> = {}
  const INFRA = new Set(['marketplace_id', 'language_tag', 'audience'])
  const classify = (node: any): SubPropType | undefined => {
    const t = node?.type
    if (t === 'number' || t === 'integer') return 'number'
    if (t === 'boolean') return 'boolean'
    if (t === 'string') return 'string'
    return undefined
  }
  for (const [fieldId, prop] of Object.entries(properties)) {
    const p = prop as Record<string, any>
    const itemProps: Record<string, any> = p?.items?.properties ?? {}
    if (itemProps.language_tag) localizedFields.add(fieldId)
    // UFX P6g — capture the attribute's own uniqueness rule for the feed
    // builder's numbered-column reassembly.
    if (Array.isArray(p?.selectors) && p.selectors.length > 0) {
      selectorsByField[fieldId] = p.selectors.map(String)
    }
    const valueNode = itemProps.value ?? p
    const t = valueNode?.type ?? p?.type
    if (t === 'number' || t === 'integer') numericFields.add(fieldId)
    else if (t === 'boolean') booleanFields.add(fieldId)
    // FFP.18 — single wrapped sub-property shape: items.properties has no
    // `value`, exactly one meaningful sub-key, and that sub-key is itself an
    // array of {value,…} objects.
    if (!itemProps.value) {
      const subKeys = Object.keys(itemProps).filter((k) => k !== 'marketplace_id' && k !== 'language_tag')
      if (subKeys.length === 1) {
        const sub = itemProps[subKeys[0]] as Record<string, any>
        const subItemProps: Record<string, any> = sub?.items?.properties ?? {}
        if (sub?.type === 'array' && subItemProps.value) {
          wrappedSubPropFields[fieldId] = { sub: subKeys[0], localized: Boolean(subItemProps.language_tag) }
        } else if (sub?.type === 'string' || sub?.type === 'number' || sub?.type === 'integer' || sub?.type === 'boolean') {
          // UFX P6e — single PLAIN scalar sub-property (gpsr_manufacturer_reference
          // → gpsr_manufacturer_email_address). The generic `[{value,…}]` emission
          // violates additionalProperties:false, so Amazon drops the attribute;
          // the correct shape is `[{gpsr_manufacturer_email_address: v,…}]`.
          // (variation_theme/parent_sku match too but are EXPLICIT_KEYS-handled;
          // image locators are handled by the image_locator branch first.)
          wrappedSubPropFields[fieldId] = { sub: subKeys[0], localized: false, flat: true }
        }
      }
    }
    // UFX P1 (P0-2) — declared type per sub-property path, mirroring the paths
    // expandSchemaField writes into expandedFields.
    for (const [subId, subNode] of Object.entries(itemProps)) {
      if (INFRA.has(subId)) continue
      const sub = subNode as Record<string, any>
      if (subId === 'value' || subId === 'unit') {
        // top-level dimension pair {value, unit} → "field.value" / "field.unit"
        const st = classify(sub)
        if (st) subPropTypes[`${fieldId}.${subId}`] = st
        continue
      }
      // named sub-property that is itself a {value, unit} pair →
      // "field.sub.value" / "field.sub.unit"
      const subSubProps: Record<string, any> = sub?.items?.properties ?? sub?.properties ?? {}
      if (subSubProps.value && subSubProps.unit) {
        const tv = classify(subSubProps.value)
        if (tv) subPropTypes[`${fieldId}.${subId}.value`] = tv
        const tu = classify(subSubProps.unit)
        if (tu) subPropTypes[`${fieldId}.${subId}.unit`] = tu
        continue
      }
      // simple / array-wrapped sub-property → "field.sub"
      const st = classify(subSubProps.value ?? sub)
      if (st) subPropTypes[`${fieldId}.${subId}`] = st
    }
  }
  return { localizedFields, numericFields, booleanFields, wrappedSubPropFields, subPropTypes, selectorsByField }
}

/**
 * UFX P1 (P0-2) — coerce a sub-property cell by its DECLARED schema type. When a
 * schema type map is available, a string-typed value is NEVER turned into a
 * number (size "38", leading-zero codes stay strings) and unknown paths stay
 * strings too (fail-safe: Amazon accepts a string where it expected one; the
 * sniff corrupted real data). Only with NO schema at all does the legacy
 * Number() sniff run, so schema-less callers behave exactly as before.
 */
export function coerceSubPropValue(
  path: string,
  raw: string,
  subPropTypes?: Record<string, SubPropType>,
): string | number | boolean {
  if (subPropTypes) {
    const t = subPropTypes[path]
    if (t === 'number') {
      const n = Number(raw)
      return !isNaN(n) && raw.trim() !== '' ? n : raw
    }
    if (t === 'boolean') return raw === 'true' || raw === 'TRUE' || raw === '1'
    return raw
  }
  const n = Number(raw)
  return !isNaN(n) && raw.trim() !== '' ? n : raw
}

/**
 * Map of base field id → Amazon `maxUtf8ByteLength` (UTF-8 byte cap) for every
 * top-level property that declares one. Amazon enforces byte length, not char
 * length, so this is what pre-submit validation must count against. Keyed by the
 * BASE field id (bullet_point, item_name…); callers resolve an expanded column id
 * (bullet_point_1) back to its base before lookup. Reads the cap off the unwrapped
 * value node, matching how schemaFieldToColumn reads maxLength.
 */
export function buildByteLimits(properties: Record<string, any>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [fieldId, prop] of Object.entries(properties)) {
    const inner = (prop as Record<string, any>)?.items?.properties?.value ?? prop
    const lim = (inner as Record<string, any>)?.maxUtf8ByteLength
    if (typeof lim === 'number') out[fieldId] = lim
  }
  return out
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
 * UFX P6a — Amazon meta-schema `hidden` / `editable` flags for one schema
 * node. Verified against real cached IT/DE/UK/FR/ES schemas: the flags are
 * spelled exactly `hidden` (boolean) and `editable` (boolean) and live on the
 * LEAF value node — `items.properties.value` for wrapped attributes, or the
 * sub-property node itself (e.g. list_price.items.properties.currency.hidden).
 * Both the node and its wrapped leaf are checked so either placement works.
 * Returns only the exceptional values (hidden: true / editableForListing:
 * false) — the defaults (visible, editable) stay untagged.
 */
export function extractMetaFlags(
  node: Record<string, any> | undefined,
): { hidden?: true; editableForListing?: false } {
  const leaf = node?.items?.properties?.value ?? node
  const out: { hidden?: true; editableForListing?: false } = {}
  if (node?.hidden === true || leaf?.hidden === true) out.hidden = true
  if (node?.editable === false || leaf?.editable === false) out.editableForListing = false
  return out
}

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
  let optionCodes: string[] | undefined
  let deprecatedOptions: string[] | undefined

  const enumOpts = schemaEnums[fieldId]
  if (enumOpts && enumOpts.length > 0) {
    kind = 'enum'
    options = ['', ...enumOpts]
    // UFX P1 — the underlying schema CODES (options prefer enumNames labels).
    // Rows may carry either (grid writes labels; attrs read-backs carry codes),
    // so validation needs both. Only stored when a code differs from its label.
    const pairs = findEnumPairs(inner ?? prop)
    if (pairs.length > 0 && pairs.some((pr) => pr.code !== pr.label)) {
      optionCodes = pairs.map((pr) => pr.code)
    }
    // UFX P6g — $lifecycle.enumDeprecated → still-offered deprecated values.
    deprecatedOptions = deriveDeprecatedOptions(prop, enumOpts, pairs)
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

  // Detect SELECTION_ONLY from Amazon schema attribute or hardcoded strict list
  const amazonAttrs = inner?.['x-amazon-attributes'] ?? {}
  const schemaMode: string | undefined = amazonAttrs.mode
  const selectionOnly = kind === 'enum'
    ? STRICT_ENUM_FIELDS.has(fieldId) || schemaMode === 'SELECTION_ONLY'
    : undefined

  // Extract usage guidance level — tells grid how critical this field is
  const rawUsage: string | undefined = amazonAttrs.usage ?? amazonAttrs.editorialUsage
  const guidance = rawUsage === 'REQUIRED' ? 'REQUIRED'
    : rawUsage === 'RECOMMENDED' ? 'RECOMMENDED'
    : rawUsage === 'OPTIONAL' ? 'OPTIONAL'
    : undefined

  return {
    id: fieldId,
    fieldRef: buildFieldRef(fieldId),
    labelEn,
    labelLocal,
    required: isRequired,
    kind,
    options,
    optionCodes,
    deprecatedOptions,
    selectionOnly,
    guidance,
    // UFX P6a — meta-schema hidden/editable flags (checked on prop AND its leaf).
    ...extractMetaFlags(prop),
    maxLength: typeof inner?.maxLength === 'number' ? inner.maxLength : undefined,
    maxUtf8ByteLength: typeof inner?.maxUtf8ByteLength === 'number' ? inner.maxUtf8ByteLength : undefined,
    minUtf8ByteLength: typeof inner?.minUtf8ByteLength === 'number' ? inner.minUtf8ByteLength : undefined,
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

/** BN.0.2 — if `col` is a recommended_browse_nodes value column, make it an
 *  enum carrying node ids (options) + localized paths (optionLabels) so the
 *  grid renders the existing search-as-you-type EnumDropdown. Free-text still
 *  allowed (selectionOnly=false) since a market may surface a node not in enum. */
export function decorateBrowseNodeColumn(col: FlatFileColumn, nodes: BrowseNode[]): FlatFileColumn {
  if (!/^recommended_browse_nodes\b/.test(col.fieldRef) || nodes.length === 0) return col
  const options = nodes.map((n) => n.id)
  const optionLabels: Record<string, string> = {}
  for (const n of nodes) optionLabels[n.id] = n.path
  return { ...col, kind: 'enum', selectionOnly: false, options, optionLabels }
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
  // Fields handled by Variations group — skip from schema group iteration.
  const SKIP_SUB_EXPAND = new Set([
    'child_parent_sku_relationship',  // handled in Variations group
  ])

  // ── purchasable_offer: hardcoded expansion (nested price schedule) ────
  if (fieldId === 'purchasable_offer') {
    const condOpts: string[] = schemaEnums['purchasable_offer.condition_type']
      ?? schemaEnums['condition_type']
      ?? ['new_new', 'used_good', 'used_very_good', 'used_acceptable', 'collectible_good', 'refurbished_refurbished']
    const curOpts = ['EUR', 'GBP', 'USD', 'CHF', 'SEK', 'PLN', 'CZK', 'DKK', 'NOK', 'HUF']
    const ll = (key: string, fb: Record<LangTag, string>) => schemaLabels[key] ?? fb[lang] ?? fb.en_GB
    expandedFields['purchasable_offer__condition_type'] = 'purchasable_offer.condition_type'
    expandedFields['purchasable_offer__currency']       = 'purchasable_offer.currency'
    expandedFields['purchasable_offer__our_price']      = 'purchasable_offer.our_price'
    expandedFields['purchasable_offer__sale_price']     = 'purchasable_offer.sale_price'
    expandedFields['purchasable_offer__sale_from_date'] = 'purchasable_offer.sale_from_date'
    expandedFields['purchasable_offer__sale_end_date']  = 'purchasable_offer.sale_end_date'
    return [
      { id: 'purchasable_offer__condition_type',  fieldRef: 'purchasable_offer[marketplace_id]#1.condition_type',
        labelEn: 'Condition', labelLocal: ll('purchasable_offer.condition_type', { it_IT: 'Condizione', de_DE: 'Zustand', fr_FR: 'État', es_ES: 'Condición', en_GB: 'Condition' }),
        required: isRequired, kind: 'enum', options: ['', ...condOpts], selectionOnly: true,
        applicableParentage: ['VARIATION_CHILD', 'STANDALONE'], width: 170 },
      { id: 'purchasable_offer__currency',        fieldRef: 'purchasable_offer[marketplace_id]#1.currency',
        labelEn: 'Currency', labelLocal: ll('purchasable_offer.currency', { it_IT: 'Valuta', de_DE: 'Währung', fr_FR: 'Devise', es_ES: 'Divisa', en_GB: 'Currency' }),
        required: false, kind: 'enum', options: curOpts, selectionOnly: true,
        applicableParentage: ['VARIATION_CHILD', 'STANDALONE'], width: 100 },
      { id: 'purchasable_offer__our_price',       fieldRef: 'purchasable_offer[marketplace_id]#1.our_price.schedule.value_with_tax',
        labelEn: 'Price (incl. tax)', labelLocal: ll('purchasable_offer.our_price', { it_IT: 'Prezzo (IVA incl.)', de_DE: 'Preis (inkl. MwSt.)', fr_FR: 'Prix (TVA incl.)', es_ES: 'Precio (IVA incl.)', en_GB: 'Price (incl. tax)' }),
        required: isRequired, kind: 'number',
        applicableParentage: ['VARIATION_CHILD', 'STANDALONE'], width: 130 },
      { id: 'purchasable_offer__sale_price',      fieldRef: 'purchasable_offer[marketplace_id]#1.sale_price.schedule.value_with_tax',
        labelEn: 'Sale Price', labelLocal: ll('purchasable_offer.sale_price', { it_IT: 'Prezzo scontato', de_DE: 'Sonderpreis', fr_FR: 'Prix promo', es_ES: 'Precio oferta', en_GB: 'Sale Price' }),
        required: false, kind: 'number',
        applicableParentage: ['VARIATION_CHILD', 'STANDALONE'], width: 120 },
      { id: 'purchasable_offer__sale_from_date',  fieldRef: 'purchasable_offer[marketplace_id]#1.sale_from_date.value',
        labelEn: 'Sale From Date', labelLocal: ll('purchasable_offer.sale_from_date', { it_IT: 'Inizio svendita', de_DE: 'Aktionsbeginn', fr_FR: 'Début promo', es_ES: 'Inicio oferta', en_GB: 'Sale From Date' }),
        required: false, kind: 'text',
        applicableParentage: ['VARIATION_CHILD', 'STANDALONE'], width: 150 },
      { id: 'purchasable_offer__sale_end_date',   fieldRef: 'purchasable_offer[marketplace_id]#1.sale_end_date.value',
        labelEn: 'Sale End Date', labelLocal: ll('purchasable_offer.sale_end_date', { it_IT: 'Fine svendita', de_DE: 'Aktionsende', fr_FR: 'Fin promo', es_ES: 'Fin oferta', en_GB: 'Sale End Date' }),
        required: false, kind: 'text',
        applicableParentage: ['VARIATION_CHILD', 'STANDALONE'], width: 150 },
    ]
  }

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

    // UFX P1 (P0-1) — nested items.required: a required `unit` on a value+unit
    // pair was hard-coded optional, so the grid said "filled" while Amazon
    // rejected 90220. Required-parent → hard required; optional parent →
    // required-if-present (requiredWithParent, enforced in preflight).
    const itemsRequired = new Set<string>(Array.isArray(prop?.items?.required) ? prop.items.required : [])
    const unitInReq = itemsRequired.has('unit')
    const valueInReq = itemsRequired.has('value')

    const vId = `${fieldId}__value`
    const uId = `${fieldId}__unit`
    expandedFields[vId] = `${fieldId}.value`
    expandedFields[uId] = `${fieldId}.unit`

    return [
      { id: vId, fieldRef: `${fieldId}[marketplace_id]#1.value`, labelEn: fieldId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), labelLocal: fieldLabel, required: isRequired, requiredWithParent: !isRequired && valueInReq ? true : undefined, kind: 'number', width: 100, ...extractMetaFlags(subProps.value) },
      { id: uId, fieldRef: `${fieldId}[marketplace_id]#1.unit`,  labelEn: `${fieldId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} Unit`, labelLocal: unitLabel, required: isRequired && unitInReq, requiredWithParent: !isRequired && unitInReq ? true : undefined, kind: unitEnums.length > 0 ? 'enum' : 'text', options: unitEnums.length > 0 ? ['', ...unitEnums.map(String)] : undefined, width: 140, ...extractMetaFlags(subProps.unit) },
    ]
  }

  // ── Pattern C: named sub-properties ──────────────────────────────────
  // At least 2 named keys, none of which is just "value" (standard wrapped).
  const namedKeys = meaningfulKeys.filter((k) => k !== 'value')
  if (namedKeys.length >= 2 && !SKIP_SUB_EXPAND.has(fieldId)) {
    const columns: FlatFileColumn[] = []

    // UFX P1 (P0-1) — nested items.required lists which named sub-properties the
    // attribute demands (length/width/height on dimensions, size/size_system on
    // apparel_size …). Required-parent → hard required; optional parent →
    // required-if-present (requiredWithParent, enforced in preflight).
    const itemsRequired = new Set<string>(Array.isArray(prop?.items?.required) ? prop.items.required : [])

    for (const subId of namedKeys) {
      const subProp = subProps[subId] as Record<string, any>
      const subTitle = (subProp?.title as string | undefined) ??
        (subProp?.items?.properties?.value?.title as string | undefined)
      const subEnLabel = `${subId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`
      const subLoLabel = subTitle ?? subEnLabel
      const subInReq = itemsRequired.has(subId)

      // Check if the sub-prop itself is a dimension pair {value, unit}
      const subSubProps: Record<string, any> =
        subProp?.items?.properties ?? subProp?.properties ?? {}
      const subSubKeys = Object.keys(subSubProps).filter((k) => !INFRA.has(k))
      const subIsDim = subSubKeys.includes('value') && subSubKeys.includes('unit')

      if (subIsDim) {
        const unitProp = subSubProps.unit as Record<string, any>
        const unitEnums: string[] = unitProp?.enum ?? unitProp?.enumNames ?? []
        const unitTitle = (unitProp?.title as string | undefined) ?? `${subLoLabel} Unit`
        // The sub-dimension's own required list ('value'/'unit').
        const subSubRequired = new Set<string>(
          Array.isArray(subProp?.items?.required) ? subProp.items.required
            : Array.isArray(subProp?.required) ? subProp.required : [],
        )
        const unitInReq = subInReq && subSubRequired.has('unit')

        const vId = `${fieldId}__${subId}`
        const uId = `${fieldId}__${subId}_unit`
        expandedFields[vId] = `${fieldId}.${subId}.value`
        expandedFields[uId] = `${fieldId}.${subId}.unit`

        columns.push({
          id: vId, fieldRef: `${fieldId}[marketplace_id]#1.${subId}.value`,
          labelEn: subEnLabel, labelLocal: subLoLabel,
          required: isRequired && subInReq,
          requiredWithParent: !isRequired && subInReq ? true : undefined,
          kind: 'number', width: 100,
          ...extractMetaFlags(subSubProps.value),
        })
        columns.push({
          id: uId, fieldRef: `${fieldId}[marketplace_id]#1.${subId}.unit`,
          labelEn: `${subEnLabel} Unit`, labelLocal: unitTitle,
          required: isRequired && unitInReq,
          requiredWithParent: !isRequired && unitInReq ? true : undefined,
          kind: unitEnums.length > 0 ? 'enum' : 'text',
          options: unitEnums.length > 0 ? ['', ...unitEnums.map(String)] : undefined,
          width: 140,
          ...extractMetaFlags(subSubProps.unit),
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
      let optionCodes: string[] | undefined
      let deprecatedOptions: string[] | undefined
      if (opts.length > 0) {
        kind = 'enum'
        options = ['', ...opts]
        // UFX P1 — codes behind the sub-prop enum labels (see schemaFieldToColumn).
        const pairs = findEnumPairs(subProp)
        if (pairs.length > 0 && pairs.some((pr) => pr.code !== pr.label)) {
          optionCodes = pairs.map((pr) => pr.code)
        }
        // UFX P6g — sub-prop $lifecycle.enumDeprecated (real case:
        // vehicle_fitment__standard, where "tecdoc" is deprecated in favor of
        // the still-offered "ktype" / "KType (TecDoc)").
        deprecatedOptions = deriveDeprecatedOptions(subProp, opts, pairs)
      }
      else if (subType === 'integer' || subType === 'number') kind = 'number'
      else if (subType === 'boolean') { kind = 'enum'; options = ['', 'true', 'false'] }

      // A free-text sub-property can carry its own byte/char limit (Amazon puts
      // it on the unwrapped value). Capture so byte-length validation applies.
      const subInner = subProp?.items?.properties?.value ?? subProp

      columns.push({
        id: colId, fieldRef: `${fieldId}[marketplace_id]#1.${subId}`,
        labelEn: subEnLabel, labelLocal: subLoLabel,
        required: isRequired && subInReq,
        requiredWithParent: !isRequired && subInReq ? true : undefined,
        kind, options, optionCodes, deprecatedOptions,
        // UFX P6a — hidden/editable live on the sub-prop node (list_price.currency)
        // or its wrapped leaf; extractMetaFlags checks both.
        ...extractMetaFlags(subProp),
        maxLength: typeof subInner?.maxLength === 'number' ? subInner.maxLength : undefined,
        maxUtf8ByteLength: typeof subInner?.maxUtf8ByteLength === 'number' ? subInner.maxUtf8ByteLength : undefined,
        minUtf8ByteLength: typeof subInner?.minUtf8ByteLength === 'number' ? subInner.minUtf8ByteLength : undefined,
        width: kind === 'enum' && (options?.length ?? 0) < 8 ? 140 : 180,
      })
    }

    if (columns.length >= 1) return columns
    // Fall through to single-column if we couldn't resolve any sub-props
  }

  // ── Pattern D: single column ──────────────────────────────────────────
  return [schemaFieldToColumn(fieldId, prop, isRequired, schemaLabels, schemaEnums, lang)]
}

// UFX P6g — sub-properties the numbered-column emit stamps IDENTICALLY on
// every instance of an attribute (same marketplace, same language).
const STAMPED_INFRA_SELECTORS = new Set(['marketplace_id', 'language_tag'])

/**
 * UFX P6g — dedup reassembled multi-instance cells by the attribute's OWN
 * uniqueness rule: the meta-schema `selectors` (pairs with maxUniqueItems —
 * items with equal selector values are the SAME entry to Amazon). Two shapes
 * exist in the live cached schemas (49 defs probed):
 *   - content selectors (ghs_chemical_h_code [marketplace_id, value]): the
 *     selector tuple alone decides — a second instance with the same tuple is
 *     a duplicate under Amazon's rule even where other properties differ;
 *   - infra-only selectors (bullet_point / material / special_feature
 *     [marketplace_id(, language_tag)]): every instance carries the SAME
 *     stamped tuple by construction — Amazon counts them as ONE unique entry
 *     (bullet_point maxUniqueItems=10 vs 5 same-language bullets), so
 *     collapsing on the tuple would eat legitimate bullets. The instance's
 *     `value` joins the key instead, so only true duplicates (the same bullet
 *     typed into two numbered columns) are dropped.
 * First occurrence wins, order preserved. No selectors known → cells returned
 * unchanged (legacy behavior for schema-less callers).
 */
export function dedupCellsBySelectors(
  cells: Array<Record<string, any>>,
  selectors: string[] | undefined,
): Array<Record<string, any>> {
  if (!selectors || selectors.length === 0 || cells.length < 2) return cells
  const infraOnly = selectors.every((s) => STAMPED_INFRA_SELECTORS.has(s))
  const seen = new Set<string>()
  const out: Array<Record<string, any>> = []
  for (const cell of cells) {
    const key = JSON.stringify([
      ...selectors.map((s) => cell[s] ?? null),
      ...(infraOnly ? [cell.value ?? null] : []),
    ])
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cell)
  }
  return out
}

// FFA — Amazon rejects any attribute submitted with an empty value ("Invalid
// empty value provided in patch at index of N") and FAILS THE WHOLE FEED. A
// pulled/edited row can carry a blank or whitespace cell, so we strip blank
// attributes from the feed body before submitting (Amazon wants them omitted).
const FEED_META_KEYS = new Set(['marketplace_id', 'language_tag', 'audience'])
export function isBlankFeedValue(val: unknown): boolean {
  if (val === null || val === undefined) return true
  if (typeof val === 'string') return val.trim() === ''
  if (typeof val === 'number' || typeof val === 'boolean') return false // 0 / false are real values
  if (Array.isArray(val)) return val.length === 0 || val.every(isBlankFeedValue)
  if (typeof val === 'object') {
    const meaningful = Object.entries(val as Record<string, unknown>).filter(([k]) => !FEED_META_KEYS.has(k))
    return meaningful.length === 0 || meaningful.every(([, v]) => isBlankFeedValue(v))
  }
  return false
}

/**
 * FB1 — the quantity/follow patch for a flat-file content save row.
 *
 * The Follow column owns the follow/pin flag. When the row carries a valid enum
 * ('Follow' | 'Pinned'), the follow-apply endpoint (run right after the save)
 * sets followMasterQuantity + quantityOverride coherently and skips FBA, so here
 * we only write the quantity.
 *
 * A TRULY legacy client sends no Follow column at all (`follow` is undefined or
 * null) — that path keeps the historical pin-on-qty behavior
 * (followMasterQuantity:false), which the follow-apply endpoint then corrects.
 *
 * ANY OTHER value (pasted garbage, a typo like 'pinned'/'Following', or an empty
 * string) is NO SIGNAL: write the quantity but NEVER touch followMasterQuantity.
 * Previously such rows fell into the legacy branch and silently force-pinned a
 * Following listing.
 */
export function buildFollowQuantityPatch(
  follow: unknown,
  qty: number | null,
): { quantity?: number; followMasterQuantity?: boolean } {
  if (qty === null || Number.isNaN(qty)) return {}
  // Legacy client: the Follow column is entirely absent.
  if (follow === undefined || follow === null) {
    return { quantity: qty, followMasterQuantity: false }
  }
  // Follow column present. Only the exact enum is a real signal; every other
  // string (including '') is treated as no signal → quantity only, no pin.
  return { quantity: qty }
}

// RR.2 — build a grid row from the verbatim flat-file snapshot: the snapshot
// (lossless content) with the live structured columns overlaid from the DB
// (price/qty/title/desc/bullets, so repricer/stock changes show) + the internal
// row metadata. Everything else comes from the snapshot exactly as saved.
// Flat file is the authoritative source of truth for all content.
// Only operational values legitimately managed outside the flat file
// (live price from repricer, live qty from stock system) overlay the
// snapshot. Content fields (title, description, bullets) must NEVER
// override the snapshot — doing so silently discards flat file edits
// before they reach the editor or Amazon.
const SNAPSHOT_LIVE_OVERLAY = [
  'purchasable_offer__our_price', 'purchasable_offer__sale_price',
  'fulfillment_availability__quantity',
  // ASIN columns: sourced from ChannelListing.externalListingId (authoritative).
  // Live value must always win over a stale snapshot written before the ASIN was known.
  'external_product_id', 'external_product_id_type',
]
export function applySnapshotOverlay(
  snapshot: Record<string, any>,
  liveRow: FlatFileRow,
  /** Optional: maps localized parentage label → canonical code (e.g. 'Articolo padre' → 'parent').
   *  When provided, heals legacy localized values in existing snapshots to canonical on first read. */
  parentageCodeMap?: Record<string, string>,
): FlatFileRow {
  const overlay: Record<string, any> = {}
  for (const k of SNAPSHOT_LIVE_OVERLAY) {
    if (liveRow[k] !== undefined && liveRow[k] !== '') overlay[k] = liveRow[k]
  }
  // Normalize parentage_level in the snapshot to canonical 'parent'/'child'/''
  // Handles: legacy title-case "Parent"/"Child", localized "Articolo padre"/"Articolo figlio",
  // AND empty snapshots for rows published before Phase 1 (SP-API returned no parentage
  // because the old feed builder never emitted it for parent rows). In that case we fall
  // back to liveRow.parentage_level which is derived from Product.isParent/parentId flags
  // — always canonical even when the snapshot is empty.
  const snapParentage = String(snapshot.parentage_level ?? '')
  const liveParentage = String(liveRow.parentage_level ?? '')
  const canonicalParentage = snapParentage ? normalizeParentage(snapParentage, parentageCodeMap ?? {}) : ''
  const effectiveParentage = canonicalParentage || liveParentage
  if (effectiveParentage !== snapParentage) {
    snapshot = { ...snapshot, parentage_level: effectiveParentage }
  }
  // FBA rows: Amazon owns the stock — never surface a merchant quantity (it both
  // shouldn't show, and a merchant qty would flip FBA→FBM). Force-blank for FBA;
  // FBM keeps the normal lossless overlay (live qty if set, else the snapshot).
  const faCodeU = String(
    liveRow['fulfillment_availability__fulfillment_channel_code'] ??
      snapshot['fulfillment_availability__fulfillment_channel_code'] ?? '',
  ).toUpperCase()
  const isFba = faCodeU.startsWith('AMAZON') || faCodeU === 'AFN' || faCodeU === 'FBA'
  return {
    ...snapshot,
    ...overlay,
    // Bullets: slot 1 lives in bullet_point_1; the bare bullet_point is a blank
    // sentinel so the generic loop skips attrs.bullet_point. Snapshot wins for
    // content — the live DB value is only a fallback when no snapshot exists yet.
    bullet_point: '',
    bullet_point_1: snapshot['bullet_point_1'] || snapshot['bullet_point'] || (liveRow as any)['bullet_point_1'] || '',
    ...(isFba ? { fulfillment_availability__quantity: '' } : {}),
    // FM Phase 2b — the Follow control is a LIVE value derived from the DB
    // followMasterQuantity flag, not snapshot content, so it must always come from
    // liveRow (overriding any stale/absent snapshot value). '' for FBA rows.
    follow: (liveRow as any).follow,
    // FM Phase 4 — buffer is also a live DB-derived value (stockBuffer), never snapshot.
    buffer: (liveRow as any).buffer,
    item_sku: liveRow.item_sku ?? snapshot.item_sku,
    _rowId: liveRow._rowId,
    _productId: liveRow._productId,
    _isNew: false,
    _status: 'idle',
    _listingId: liveRow._listingId,
    _version: liveRow._version,
    _asin: liveRow._asin,
    _listingStatus: liveRow._listingStatus,
    _fieldStates: liveRow._fieldStates,
    _masterValues: liveRow._masterValues,
  } as FlatFileRow
}

// ── Main service ───────────────────────────────────────────────────────

/**
 * MT.1 — merge per-product-type manifests (manifests[i] is for types[i]) into a
 * single UNION manifest: groups by id, columns by id, each column tagged with
 * applicableProductTypes + requiredForProductTypes (required at union level if ANY
 * type requires it; enum options unioned). Pure + unit-testable.
 */
export function mergeManifestsIntoUnion(manifests: FlatFileManifest[], types: string[]): FlatFileManifest {
  if (manifests.length === 0) throw new Error('mergeManifestsIntoUnion: no manifests')
  type UnionCol = FlatFileColumn & { applicableProductTypes: string[]; requiredForProductTypes: string[] }
  const groupOrder: string[] = []
  const groupById = new Map<string, FlatFileColumnGroup>()
  const colMaps = new Map<string, Map<string, UnionCol>>()

  manifests.forEach((m, i) => {
    const pt = types[i]
    for (const g of m.groups) {
      if (!groupById.has(g.id)) {
        groupById.set(g.id, { ...g, columns: [] })
        colMaps.set(g.id, new Map())
        groupOrder.push(g.id)
      }
      const outGroup = groupById.get(g.id)!
      const colMap = colMaps.get(g.id)!
      for (const c of g.columns) {
        let mc = colMap.get(c.id)
        if (!mc) {
          mc = {
            ...c, required: false, options: c.options ? [...c.options] : undefined,
            applicableProductTypes: [], requiredForProductTypes: [],
            // UFX P1 — per-manifest flags/lists are re-derived below (the spread
            // above must not leak the FIRST type's view as the union's).
            requiredWithParent: undefined, requiredWithParentForProductTypes: undefined,
            conditional: undefined, optionCodes: undefined,
            optionsByProductType: undefined, optionCodesByProductType: undefined,
            // UFX P6g — re-derived below (set union across types; warn-only hint).
            deprecatedOptions: undefined,
            // UFX P6a — re-derived below: hidden ANDs (visible for any type →
            // shown), editableForListing ORs pessimistically with a per-type list.
            hidden: undefined, editableForListing: undefined, nonEditableForProductTypes: undefined,
          }
          colMap.set(c.id, mc)
          outGroup.columns.push(mc)
        }
        if (!mc.applicableProductTypes!.includes(pt)) mc.applicableProductTypes!.push(pt)
        if (c.required) {
          mc.required = true
          if (!mc.requiredForProductTypes!.includes(pt)) mc.requiredForProductTypes!.push(pt)
        }
        // UFX P1 — required-if-present + conditional flags: OR across types, with
        // the per-type list so validation stays per-row-type.
        if (c.requiredWithParent) {
          mc.requiredWithParent = true
          mc.requiredWithParentForProductTypes = [...new Set([...(mc.requiredWithParentForProductTypes ?? []), pt])]
        }
        if (c.conditional) mc.conditional = true
        // UFX P6a — hidden ANDs across the types that define the column (if any
        // type wants it visible, the union shows it); non-editable ORs (any type
        // locking it tags the union) with the per-type list for per-row precision.
        mc.hidden = (mc.hidden ?? true) && c.hidden === true
        if (c.editableForListing === false) {
          mc.editableForListing = false
          mc.nonEditableForProductTypes = [...new Set([...(mc.nonEditableForProductTypes ?? []), pt])]
        }
        if (c.options && c.options.length) {
          mc.options = [...new Set([...(mc.options ?? []), ...c.options])]
          // UFX P1 (MT.2b) — remember each type's OWN option set: a value valid
          // for JACKET but not PANTS must error on a PANTS row, which the union
          // superset can't express.
          mc.optionsByProductType = { ...(mc.optionsByProductType ?? {}), [pt]: c.options.filter((o) => o !== '') }
        }
        if (c.optionCodes && c.optionCodes.length) {
          mc.optionCodes = [...new Set([...(mc.optionCodes ?? []), ...c.optionCodes])]
          mc.optionCodesByProductType = { ...(mc.optionCodesByProductType ?? {}), [pt]: [...c.optionCodes] }
        }
        // UFX P6g — deprecated options union across types (warn-only hint, so
        // deprecated-anywhere-warns-everywhere is the acceptable trade-off).
        if (c.deprecatedOptions && c.deprecatedOptions.length) {
          mc.deprecatedOptions = [...new Set([...(mc.deprecatedOptions ?? []), ...c.deprecatedOptions])]
        }
      }
    }
  })

  const expandedFields: Record<string, string> = {}
  const variationThemes = new Set<string>()
  for (const m of manifests) {
    Object.assign(expandedFields, m.expandedFields ?? {})
    for (const vt of m.variationThemes ?? []) variationThemes.add(vt)
  }

  // UFX P6a — normalize the hidden AND-accumulator: false (visible somewhere)
  // becomes undefined so the union column looks like a single-type visible one.
  for (const colMap of colMaps.values()) {
    for (const mc of colMap.values()) {
      if (mc.hidden !== true) delete (mc as FlatFileColumn).hidden
    }
  }

  // UFX P6c — union schema fingerprint: hash over the per-type versions so the
  // union manifest changes exactly when any member schema changes.
  const memberVersions = manifests.map((m, i) => `${types[i]}=${m.schemaVersion ?? ''}`).join('|')
  const schemaVersion = manifests.some((m) => m.schemaVersion)
    ? createHash('sha256').update(memberVersions).digest('hex').slice(0, 16)
    : undefined

  // UFX P6g — requirementsEnforced per member type (per-row preflight needs
  // the row's OWN type; a union-level scalar can't express a mixed sheet).
  const requirementsEnforcedByType: Record<string, string> = {}
  manifests.forEach((m, i) => {
    if (typeof m.requirementsEnforced === 'string' && m.requirementsEnforced) {
      requirementsEnforcedByType[types[i]] = m.requirementsEnforced
    }
  })

  return {
    marketplace: manifests[0].marketplace,
    productType: types.join('+'),
    productTypes: [...types],
    variationThemes: [...variationThemes],
    fetchedAt: new Date().toISOString(),
    schemaVersion,
    requirementsEnforcedByType: Object.keys(requirementsEnforcedByType).length > 0 ? requirementsEnforcedByType : undefined,
    groups: groupOrder.map((id) => groupById.get(id)!),
    expandedFields,
  }
}

/**
 * UFX P6a — API-response view of a manifest with `hidden` columns stripped.
 * Safety carve-out: a hidden column that is required (or required-if-present)
 * stays visible — preflight demands a value for it, so hiding it would make a
 * validation error unfixable in the grid. Groups left empty by the filter are
 * dropped. Pure (never mutates the cached manifest); expandedFields is kept
 * intact so feed emission of already-present values is unchanged.
 */
export function filterHiddenManifestColumns(manifest: FlatFileManifest): FlatFileManifest {
  const groups = manifest.groups
    .map((g) => ({
      ...g,
      columns: g.columns.filter((c) => !(c.hidden === true && !c.required && !c.requiredWithParent)),
    }))
    .filter((g) => g.columns.length > 0)
  return { ...manifest, groups }
}

/**
 * FX.1 — flatten a (single-type OR union) manifest into the column spec the
 * generic export renderer wants ({ id, label }). The English label is the
 * human-readable header; the column id is what the FX.3 smart-import maps back
 * to, so an export → edit → re-import round-trip stays lossless. Pure +
 * order-preserving (group order, then column order) so the file's columns match
 * the on-screen grid. Carries `product_type` like any other column, so a
 * multi-category (MT) union sheet exports every row's type.
 */
export function flatFileExportColumns(
  manifest: Pick<FlatFileManifest, 'groups'>,
): Array<{ id: string; label: string }> {
  return manifest.groups
    .flatMap((g) => g.columns)
    .map((c) => ({ id: c.id, label: c.labelEn || c.id }))
}

// ── FFC — flat-file product creation helpers (pure, testable) ──────────

function ffcFirstNonEmpty(...vals: unknown[]): string | null {
  for (const v of vals) { const s = String(v ?? '').trim(); if (s) return s }
  return null
}

/** Bullet points from bullet_point / bullet_point_1..5 (same logic the sync uses). */
export function ffcCollectBullets(row: Record<string, any>): string[] {
  const bullets: string[] = []
  for (let i = 1; i <= 5; i++) {
    const key = i === 1 && !row['bullet_point_1'] ? 'bullet_point' : `bullet_point_${i}`
    const b = String(row[key] ?? '').trim()
    if (b) bullets.push(b)
  }
  const bare = String(row.bullet_point ?? '').trim()
  if (bare && !bullets.includes(bare)) bullets.unshift(bare)
  return bullets
}

/** Variant child axis values → variantAttributes. Covers the dominant
 *  Color × Size apparel/gear themes; extend as new axis columns appear. */
export function ffcExtractVariantAxes(row: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {}
  const color = String(row.color ?? '').trim()
  if (color) out.Color = color
  const size = String(
    row.size ?? row.apparel_size ?? row.shirt_size ?? row.shoe_size ?? row.size_name ?? '',
  ).trim()
  if (size) out.Size = size
  return out
}

/** Amazon variation_theme (e.g. "SIZE_COLOR", "Color/Size") → axis names. */
export function ffcParseThemeAxes(theme: string | null | undefined): string[] {
  if (!theme) return []
  return theme
    .split(/[_/\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const lc = t.toLowerCase()
      if (lc.includes('colour') || lc.includes('color')) return 'Color'
      if (lc.includes('size')) return 'Size'
      return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()
    })
}

/**
 * FFC — map a NEW flat-file row to a Prisma Product.create `data` object. Pure +
 * deterministic (no DB, no Date). The caller resolves `parentId` (parents are
 * created first) and stamps `importedAt`. Produces a FULL master record so every
 * product-edit tab renders accurately: identifiers, content, localizedContent
 * seeded from the market language, parent `variationAxes`, and — for child rows
 * — `variantAttributes` mirrored into `categoryAttributes.variations` for the
 * legacy variant/image readers.
 */
export function buildProductCreateInput(
  row: Record<string, any>,
  opts: { languageTag?: string; parentId?: string | null } = {},
): Record<string, any> {
  const sku = String(row.item_sku ?? '').trim()
  const name = String(row.item_name ?? '').trim() || sku

  const priceRaw = row['purchasable_offer__our_price'] ?? row.purchasable_offer ?? row.standard_price
  const priceParsed = priceRaw !== undefined && priceRaw !== '' ? parseLocaleNumber(priceRaw) : null
  const basePrice = priceParsed !== null && priceParsed >= 0 ? priceParsed : 0

  const qtyRaw = row['fulfillment_availability__quantity'] ?? row.fulfillment_availability ?? row.quantity
  const qtyParsed = qtyRaw !== undefined && qtyRaw !== '' ? parseLocaleInt(qtyRaw) : null
  const totalStock = qtyParsed !== null && qtyParsed >= 0 ? qtyParsed : 0

  const parentage = String(row.parentage_level ?? '').toLowerCase()
  const isParent = parentage === 'parent'
  const isChild = parentage === 'child'

  const productType = String(row.product_type ?? '').toUpperCase() || null
  const variationTheme = String(row.variation_theme ?? '').trim() || null
  const brand = ffcFirstNonEmpty(row.brand)
  const manufacturer = ffcFirstNonEmpty(row.manufacturer)
  const description = ffcFirstNonEmpty(row.product_description)
  const bullets = ffcCollectBullets(row)
  const gtin = ffcFirstNonEmpty(row.gtin, row.externally_assigned_product_identifier, row.barcode)
  const ean = ffcFirstNonEmpty(row.ean)
  const upc = ffcFirstNonEmpty(row.upc)

  const lang = String(opts.languageTag ?? 'it_IT').split(/[-_]/)[0] || 'it'
  const localeBlock: Record<string, any> = { name }
  if (description) localeBlock.description = description
  if (bullets.length) localeBlock.bulletPoints = bullets

  const data: Record<string, any> = {
    sku,
    name,
    basePrice,
    totalStock,
    status: 'ACTIVE',
    syncChannels: ['AMAZON'],
    importSource: 'FLAT_FILE',
    localizedContent: { en: {}, it: {}, [lang]: localeBlock },
  }
  if (productType) data.productType = productType
  if (brand) data.brand = brand
  if (manufacturer) data.manufacturer = manufacturer
  if (description) data.description = description
  if (bullets.length) data.bulletPoints = bullets
  if (gtin) data.gtin = gtin
  if (ean) data.ean = ean
  if (upc) data.upc = upc
  if (variationTheme) data.variationTheme = variationTheme

  if (isParent) {
    data.isParent = true
    const axes = ffcParseThemeAxes(variationTheme)
    if (axes.length) data.variationAxes = axes
  } else if (isChild) {
    data.isParent = false
    data.isMasterProduct = false
    if (opts.parentId) data.parentId = opts.parentId
    const axes = ffcExtractVariantAxes(row)
    if (Object.keys(axes).length) {
      data.variantAttributes = axes
      data.categoryAttributes = { variations: axes } // legacy variant/image reader mirror
    }
  }
  return data
}

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


    const lang = (LANGUAGE_TAG_MAP[mp] ?? 'en_GB') as LangTag
    const schemaLabels = buildSchemaLabels(properties)
    const schemaEnums = buildSchemaEnums(properties)

    const ll = (id: string, fallbackEn: string): string =>
      schemaLabels[id] ?? FIXED_FIELD_LABELS[id]?.[lang] ?? fallbackEn

    // Variation themes come from the schema enum — same source as every other
    // enum field. The separately-stored variationThemes column is redundant now.
    const variationThemes: string[] = schemaEnums['variation_theme'] ?? []
    // UFX P6g — themes Amazon marks deprecated ($lifecycle.enumDeprecated on
    // variation_theme.items.properties.name — the biggest real enum-deprecation
    // carrier in the cached schemas). Only themes still offered are kept.
    const deprecatedThemes = findEnumDeprecated(properties['variation_theme'] ?? {})
      .filter((d) => variationThemes.includes(d))

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
        // Product identifier — the field Amazon's own flat file has and ours
        // dropped. Lets a new SKU attach to an EXISTING Amazon product (its
        // ASIN, or its EAN/GTIN/UPC) so a relist keeps that page's reviews +
        // ranking instead of minting a new ASIN. `::` sentinel fieldRefs:
        // populated from the live listing on read; the feed handler emits the
        // right SP-API attribute (merchant_suggested_asin /
        // externally_assigned_product_identifier) on submit. Sits with the
        // SKU because it IS the offer's catalog identity.
        {
          id: 'external_product_id', fieldRef: '::external_product_id',
          labelEn: 'Product ID (ASIN / EAN / GTIN / UPC)',
          labelLocal: ll('external_product_id', 'Product ID (ASIN / EAN / GTIN / UPC)'),
          required: false, kind: 'text', width: 200,
          description:
            "Attach this SKU to an existing Amazon product — enter its ASIN (or EAN/GTIN/UPC) to keep that page's reviews & ranking instead of creating a new one. Leave blank to behave exactly as before.",
        },
        {
          id: 'external_product_id_type', fieldRef: '::external_product_id_type',
          labelEn: 'Product ID Type',
          labelLocal: ll('external_product_id_type', 'Product ID Type'),
          required: false, kind: 'enum', width: 140, selectionOnly: true,
          options: ['', 'ASIN', 'EAN', 'GTIN', 'UPC'],
          description: 'Which identifier the Product ID column holds.',
        },
        {
          id: 'product_type', fieldRef: 'product_type#1.value',
          labelEn: 'Product Type', labelLocal: ll('product_type', 'Product Type'),
          required: true, kind: 'text', width: 140,
        },
        {
          id: 'record_action', fieldRef: '::record_action',
          labelEn: 'Operation', labelLocal: ll('record_action', 'Offer Action'),
          required: true, kind: 'enum', width: 140, selectionOnly: true,
          options: ['full_update', 'partial_update', 'delete'],
          description: 'partial_update (default) = merge only the fields you send · full_update = create/FULL replace (omitted attributes are dropped on Amazon) · delete = remove the listing (only SKU is needed — no other field is validated)',
        },
      ],
    }

    // ── Group 2: Variations — all three columns are schema-derived ────────
    // parentage_level is a structural field: Amazon always uses 'parent'/'child' as
    // canonical SP-API codes. We store canonical codes internally and provide
    // optionLabels for localized display in the UI (e.g. 'parent' → 'Articolo padre'
    // for IT). This prevents validation mismatches and feed-builder failures caused
    // by localized labels not matching the English comparison strings.
    const parentageLocalized = schemaEnums['parentage_level'] ?? []
    // Build canonical → localized display label map (e.g. { parent: 'Articolo padre' })
    const PARENTAGE_CODES = ['parent', 'child'] as const
    const parentageLabelMap: Record<string, string> = {}
    PARENTAGE_CODES.forEach((code, i) => {
      const label = parentageLocalized[i]
      if (label && label !== code) parentageLabelMap[code] = label
    })
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
          required: false, kind: 'enum', width: 130, selectionOnly: true,
          options: ['', 'parent', 'child'],
          optionLabels: Object.keys(parentageLabelMap).length > 0 ? parentageLabelMap : undefined,
          description: 'Blank = standalone; parent = non-buyable variation parent; child = variant',
        },
        {
          id: 'parent_sku',
          fieldRef: 'child_parent_sku_relationship[marketplace_id]#1.parent_sku',
          labelEn: 'Parent SKU',
          labelLocal: schemaLabels['child_parent_sku_relationship'] ?? ll('parent_sku', 'Parent SKU'),
          required: false, kind: 'text', width: 180,
          applicableParentage: ['VARIATION_CHILD'],
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
          // UFX P6g — deprecated themes stay selectable (warn-only) but tagged.
          deprecatedOptions: deprecatedThemes.length > 0 ? deprecatedThemes : undefined,
          selectionOnly: true,
          applicableParentage: ['VARIATION_PARENT'],
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

    // BN.0.2 — decorate recommended_browse_nodes columns with id→path enum options
    const browseNodes = extractBrowseNodes(def, amazonMarketplaceId(mp))
    const allGroups = [infraGroup, variationsGroup, ...schemaGroups]
    if (browseNodes.length > 0) {
      for (const g of allGroups) {
        g.columns = g.columns.map((c) => decorateBrowseNodeColumn(c, browseNodes))
      }
    }

    // UFX P1 (P0-1b) — tag columns whose attribute the schema can make required
    // CONDITIONALLY (allOf/if/then, dependentRequired), for the UI. The per-row
    // evaluation itself runs in preflight. Expanded columns resolve to their
    // base attribute via expandedFields; parent_sku is the grid's face of
    // child_parent_sku_relationship.
    const conditionalFields = extractConditionalFields(def)
    if (conditionalFields.size > 0) {
      for (const g of allGroups) {
        for (const c of g.columns) {
          const base = (expandedFields[c.id] ?? c.id).split('.')[0]
          if (conditionalFields.has(base)) c.conditional = true
          if (c.id === 'parent_sku' && conditionalFields.has('child_parent_sku_relationship')) c.conditional = true
        }
      }
    }

    // UFX P6c — stable schema fingerprint: the provider version (bumps when
    // Amazon revises the type) + a content hash (catches in-place definition
    // updates, e.g. the __propertyGroups backfill). The client compares this
    // against its cached manifest instead of stacking a second 24 h TTL.
    const contentHash = createHash('sha256').update(JSON.stringify(def)).digest('hex').slice(0, 12)
    const providerVersion = String((cached as any)?.schemaVersion ?? 'unknown')

    return {
      marketplace: mp,
      productType: pt,
      variationThemes,
      fetchedAt: new Date().toISOString(),
      schemaVersion: `${providerVersion}.${contentHash}`,
      // UFX P6g — getDefinitionsProductType requirementsEnforced, captured by
      // schema-sync as __requirementsEnforced. Absent on older cached rows →
      // undefined → downstream treats as ENFORCED (conservative).
      requirementsEnforced: typeof def.__requirementsEnforced === 'string' ? def.__requirementsEnforced : undefined,
      groups: allGroups,
      expandedFields,
    }
  }

  /**
   * MT.1 — UNION manifest across multiple product types for one sheet. Reuses the
   * cached per-type generateManifest, then merges groups (by id) and columns (by
   * id), tagging each column with the product types that define it
   * (applicableProductTypes) and the ones that REQUIRE it (requiredForProductTypes).
   * A column is required at the union level if ANY type requires it; enum options
   * union across types. The feed serializer already keys off each row's own
   * product_type, so only the editor + validation consume this view.
   */
  async generateUnionManifest(
    marketplace: string,
    productTypes: string[],
    forceRefresh = false,
  ): Promise<FlatFileManifest> {
    const types = [...new Set(productTypes.map((t) => String(t).toUpperCase()).filter(Boolean))]
    if (types.length === 0) throw new Error('generateUnionManifest: at least one productType is required')

    const manifests = await Promise.all(
      types.map((t) => this.generateManifest(marketplace, t, forceRefresh)),
    )
    return mergeManifestsIntoUnion(manifests, types)
  }

  async getExistingRows(
    marketplace: string,
    productType?: string,
    productId?: string,
    scope: ListingScope = 'listed',
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
      const where: Record<string, any> = {
        deletedAt: null,
        ...buildListingScopeWhere({ channel: 'AMAZON', marketplace: mp, scope }),
      }
      if (productType) where.productType = productType.toUpperCase()
      products = await this.prisma.product.findMany({
        where,
        include: { channelListings: { where: { channel: 'AMAZON', marketplace: mp } } },
        orderBy: [{ parentId: 'asc' }, { sku: 'asc' }],
        take: 2000,
      })
    }

    // Build id→sku map so child rows can resolve parent SKU without extra queries
    const idToSku = new Map(products.filter(Boolean).map((p: any) => [p.id as string, p.sku as string]))

    // Fetch parentage_level code map for snapshot normalization.
    // parentage_level localization is market-specific (not product-type-specific),
    // so one lookup for any available product type is sufficient. Result is cached.
    let parentageCodeMap: Record<string, string> = {}
    const ptForSchema = productType?.toUpperCase() ?? (products.find((p: any) => p.productType) as any)?.productType
    if (ptForSchema) {
      try {
        const hints = await this.getFeedSchemaHints(mp, ptForSchema)
        parentageCodeMap = hints.enumCodeMap['parentage_level'] ?? {}
      } catch { /* non-critical; snapshot normalization falls back to title-case only */ }
    }

    // P3.1 — Batch-fetch suppression + open listing issues for all listings in
    // scope so the grid can show health chips without a secondary round-trip.
    // Both queries are indexed by listingId; safe to skip when there are no listings.
    const listingIds = products
      .map((p: any) => (p.channelListings as any[])[0]?.id)
      .filter(Boolean) as string[]

    type SuppRow = { listingId: string; reasonCode: string | null; reasonText: string; severity: string }
    type IssueRow = { listingId: string; severity: string; attributeNames: string[] }

    const suppByListing = new Map<string, SuppRow>()
    const issuesByListing = new Map<string, IssueRow[]>()

    if (listingIds.length > 0) {
      const [supps, issues] = await Promise.all([
        this.prisma.amazonSuppression.findMany({
          where: { listingId: { in: listingIds }, resolvedAt: null },
          select: { listingId: true, reasonCode: true, reasonText: true, severity: true },
        }),
        this.prisma.listingIssue.findMany({
          where: { listingId: { in: listingIds }, resolvedAt: null },
          select: { listingId: true, severity: true, attributeNames: true },
        }),
      ]).catch(() => [[], []])  // health data is advisory — never block a grid load
      for (const s of supps as SuppRow[]) suppByListing.set(s.listingId, s)
      for (const i of issues as IssueRow[]) {
        const arr = issuesByListing.get(i.listingId) ?? []
        arr.push(i)
        issuesByListing.set(i.listingId, arr)
      }
    }

    // P5.1 — Cross-market coverage: one query per product set fetches all 5 EU
    // Amazon listings so the grid shows a status dot-strip without extra round-trips.
    // Sequential to avoid using allListings before it resolves.
    const COVERAGE_MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK'] as const
    type MarketCoverageEntry = { status: 'active' | 'inactive' | 'suppressed' | 'missing'; title?: string; price?: string }
    const coverageByProduct = new Map<string, Record<string, MarketCoverageEntry>>()

    const productIds = products.map((p: any) => p.id as string)
    if (productIds.length > 0) {
      const allMktListings = await this.prisma.channelListing.findMany({
        where: { productId: { in: productIds }, channel: 'AMAZON' },
        select: { id: true, productId: true, marketplace: true, listingStatus: true, title: true, price: true },
      }).catch(() => [] as any[])

      // Fetch suppression for all cross-market listings in one indexed query
      const allMktListingIds = (allMktListings as any[]).map((l: any) => l.id as string)
      const crossSuppressed = new Set<string>()
      if (allMktListingIds.length > 0) {
        const xSupps = await this.prisma.amazonSuppression.findMany({
          where: { listingId: { in: allMktListingIds }, resolvedAt: null },
          select: { listingId: true },
        }).catch(() => [] as any[])
        for (const s of xSupps as any[]) crossSuppressed.add(s.listingId as string)
      }

      for (const listing of allMktListings as any[]) {
        const mkt = String(listing.marketplace ?? '').toUpperCase()
        if (!(COVERAGE_MARKETS as readonly string[]).includes(mkt)) continue
        const map = coverageByProduct.get(listing.productId as string) ?? {} as Record<string, MarketCoverageEntry>
        const isSuppressed = crossSuppressed.has(listing.id as string)
        const s = String(listing.listingStatus ?? '')
        const status: MarketCoverageEntry['status'] = isSuppressed ? 'suppressed'
          : (s === 'ACTIVE' || s === 'BUYABLE') ? 'active'
          : s === 'DRAFT' ? 'missing'
          : 'inactive'
        map[mkt] = {
          status,
          ...(listing.title ? { title: String(listing.title) } : {}),
          ...(listing.price != null ? { price: String(listing.price) } : {}),
        }
        coverageByProduct.set(listing.productId as string, map)
      }
    }

    return products.map((p) => {
      const listing = (p.channelListings as any[])[0]
      const attrs = ((listing?.platformAttributes as any)?.attributes ?? {}) as Record<string, any>
      const bullets: string[] = Array.isArray(listing?.bulletPointsOverride)
        ? listing.bulletPointsOverride
        : Array.isArray(attrs.bullet_point)
        ? (attrs.bullet_point as any[]).map((b: any) => b?.value ?? String(b))
        : []

      // Resolve parent SKU from the products-in-scope map (not ASIN)
      const parentSku = (p as any).parentId ? (idToSku.get((p as any).parentId) ?? '') : ''

      // purchasable_offer sub-columns (expanded from nested price schedule)
      const poAttrs = attrs.purchasable_offer?.[0] as Record<string, any> | undefined
      const poCurrency = String(poAttrs?.currency ?? CURRENCY_MAP[mp] ?? 'EUR')
      const poCondition = String(poAttrs?.condition_type ?? '')
      const poSaleAttrs = poAttrs?.sale_price?.[0] as Record<string, any> | undefined
      const poSalePrice = listing?.salePrice != null
        ? String(listing.salePrice)
        : (poSaleAttrs?.schedule?.[0]?.value_with_tax != null ? String(poSaleAttrs.schedule[0].value_with_tax) : '')

      // fulfillment_availability sub-columns
      const faAttrs = attrs.fulfillment_availability?.[0] as Record<string, any> | undefined
      // FFA.3 — fall back to the product's fulfillment method when no channel code
      // was persisted (legacy listings), so FBA shows AMAZON_EU instead of DEFAULT.
      const faCode = faAttrs?.fulfillment_channel_code != null
        ? String(faAttrs.fulfillment_channel_code)
        : ((p as any).fulfillmentMethod === 'FBA' ? 'AMAZON_EU' : 'DEFAULT')
      const faLeadTime = faAttrs?.lead_time_to_ship_max_days != null ? String(faAttrs.lead_time_to_ship_max_days) : ''
      // FBA listings: Amazon owns the stock and a merchant quantity flips the
      // offer to FBM, so the quantity column is left blank (and the UI hides it).
      const faCodeU = faCode.toUpperCase()
      const isFbaChannel = faCodeU.startsWith('AMAZON') || faCodeU === 'AFN' || faCodeU === 'FBA'

      // Start with fixed structural fields
      const row: FlatFileRow = {
        _rowId: p.id, _productId: p.id, _isNew: false, _status: 'idle',
        item_sku:              p.sku,
        // Populate the product-identifier column from the live listing's ASIN
        // (ChannelListing.externalListingId) so operators can SEE which Amazon
        // product each SKU sits on. Editing it to relist onto a different ASIN
        // is wired in the feed handler (next increment).
        external_product_id:      listing?.externalListingId ?? '',
        external_product_id_type: listing?.externalListingId ? 'ASIN' : '',
        product_type:          (p.productType as string | null) ?? productType ?? '',
        // FFP.2 — pulled rows default to partial_update (the safe merge op that
        // matches what the feed builder actually does for existing rows). A row
        // carrying full_update is now an EXPLICIT operator choice → full UPDATE.
        record_action:         'partial_update',
        // SP-API stores canonical 'parent'/'child' codes in attrs; fall back to DB flags
        parentage_level:       String(attrs.parentage_level?.[0]?.value ?? (p.isParent ? 'parent' : (p as any).parentId ? 'child' : '')),
        parent_sku:            parentSku,
        variation_theme:       String(attrs.variation_theme?.[0]?.name ?? attrs.variation_theme?.[0]?.value ?? ''),
        // Common schema fields pre-populated from DB
        item_name:             listing?.title ?? attrs.item_name?.[0]?.value ?? p.name ?? '',
        brand:                 String(attrs.brand?.[0]?.value ?? ''),
        product_description:   listing?.description ?? attrs.product_description?.[0]?.value ?? '',
        // bullet_point: bare key is a blank sentinel so the generic loop below
        // skips attrs.bullet_point; slot 1 lives in bullet_point_1 to match the
        // manifest column (expandSchemaField numbers repeatable fields from _1).
        bullet_point:          '',
        bullet_point_1:        bullets[0] ?? '',
        bullet_point_2:        bullets[1] ?? '',
        bullet_point_3:        bullets[2] ?? '',
        bullet_point_4:        bullets[3] ?? '',
        bullet_point_5:        bullets[4] ?? '',
        generic_keyword:       String(attrs.generic_keyword?.[0]?.value ?? ''),
        color:                 String(attrs.color?.[0]?.value ?? ''),
        // purchasable_offer expanded — bare key kept as sentinel so generic loop skips it
        purchasable_offer:               '',
        purchasable_offer__condition_type:  poCondition,
        purchasable_offer__currency:        poCurrency,
        purchasable_offer__our_price:       listing?.price != null ? String(listing.price) : '',
        purchasable_offer__sale_price:      poSalePrice,
        purchasable_offer__sale_from_date:  String(poSaleAttrs?.start_at?.[0]?.value ?? ''),
        purchasable_offer__sale_end_date:   String(poSaleAttrs?.end_at?.[0]?.value ?? ''),
        // fulfillment_availability expanded — bare key sentinel
        fulfillment_availability:                        '',
        fulfillment_availability__fulfillment_channel_code: faCode,
        fulfillment_availability__quantity:              isFbaChannel ? '' : (listing?.quantity != null ? String(listing.quantity) : ''),
        // Follow-Master (per-market inventory control): 'Follow' = quantity tracks
        // the shared warehouse pool; 'Pinned' = holds the fixed quantity you set.
        // FBA rows leave it blank — Amazon manages FBA stock, so the column reads
        // '—' in the grid and the follow-master endpoint skips FBA fail-closed.
        follow: isFbaChannel ? '' : ((listing as any)?.followMasterQuantity === false ? 'Pinned' : 'Follow'),
        // Follow-Master buffer (Phase 4): units reserved from the pool. Only shapes a
        // FOLLOWING listing's published qty (pool−buffer); blank for FBA (Amazon-managed).
        buffer: isFbaChannel ? '' : String((listing as any)?.stockBuffer ?? 0),
        fulfillment_availability__lead_time_to_ship_max_days: faLeadTime,
        main_product_image_locator: String(attrs.main_product_image_locator?.[0]?.media_location ?? ''),
      }

      // IN.1 — Inheritance state per field. Derived from ChannelListing.followMaster*
      // toggles so the flat file UI can show INHERITED vs OVERRIDE indicators per row.
      if (listing) {
        row._listingId = listing.id
        row._version = (listing as any).version ?? null
        // Expose the DB-persisted ASIN as the private _asin metadata so the
        // frontend can use it for image loading, the "open on Amazon" link, and
        // the local ASIN cache without relying on the visible column value.
        if (listing.externalListingId) row._asin = listing.externalListingId
        // P3.1 — listingStatus from DB (was only available via pull-preview before).
        row._listingStatus = (listing as any).listingStatus ?? null
        row._lastSyncedAt = (listing as any).lastSyncedAt ? (listing as any).lastSyncedAt.toISOString() : null
        row._lastSyncStatus = (listing as any).lastSyncStatus ?? null
        // P3.1 — Suppression + issue health fields for inline health chip.
        const supp = suppByListing.get(listing.id)
        row._suppressed = !!supp
        if (supp) row._suppressionReason = supp.reasonText ?? supp.reasonCode ?? null
        const listIssues = issuesByListing.get(listing.id) ?? []
        row._issueCount = listIssues.length
        if (listIssues.length > 0) {
          row._issueSeverity = listIssues.some((i) => i.severity === 'ERROR') ? 'ERROR'
            : listIssues.some((i) => i.severity === 'WARNING') ? 'WARNING' : 'INFO'
          row._issueFields = [...new Set(listIssues.flatMap((i) => i.attributeNames))]
        }
        row._fieldStates = {
          price:        ((listing as any).followMasterPrice        ?? true) ? 'INHERITED' : 'OVERRIDE',
          title:        ((listing as any).followMasterTitle        ?? true) ? 'INHERITED' : 'OVERRIDE',
          description:  ((listing as any).followMasterDescription  ?? true) ? 'INHERITED' : 'OVERRIDE',
          quantity:     ((listing as any).followMasterQuantity     ?? true) ? 'INHERITED' : 'OVERRIDE',
          bulletPoints: ((listing as any).followMasterBulletPoints ?? true) ? 'INHERITED' : 'OVERRIDE',
        }
        row._masterValues = {
          price:       (listing as any).masterPrice != null ? Number((listing as any).masterPrice) : null,
          title:       (listing as any).masterTitle       ?? null,
          description: (listing as any).masterDescription ?? null,
          quantity:    (listing as any).masterQuantity    ?? null,
        }
        // P5.1 — Cross-market coverage map. Includes all 5 EU markets with their
        // live status so the grid can render a dot-strip without extra fetches.
        const coverage = coverageByProduct.get(p.id as string)
        if (coverage) {
          // Ensure all 5 markets are represented (missing = no listing exists)
          const full: Record<string, MarketCoverageEntry> = {}
          for (const m of COVERAGE_MARKETS) {
            full[m] = coverage[m] ?? { status: 'missing' }
          }
          row._marketCoverage = full
        }
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

      // RR.2 — if a verbatim flat-row snapshot exists, return it LOSSLESSLY rather
      // than the expand-from-platformAttributes above (which dropped gated fields).
      // Overlay only the live structured columns (price/qty/title/desc/bullets) so
      // repricer/stock changes show; everything else comes from the snapshot. The
      // expanded `row` above is the legacy fallback for listings with no snapshot.
      const snapshot = (listing as any)?.flatFileSnapshot as Record<string, any> | null | undefined
      if (snapshot && typeof snapshot === 'object' && Object.keys(snapshot).length > 0) {
        return applySnapshotOverlay(snapshot, row, parentageCodeMap)
      }

      return row
    })
  }

  /**
   * Schema-derived hints for building a correct JSON feed: enum label→code map
   * (convert "Pakistan"→"PK"), the set of localized fields (only these carry a
   * language_tag), and number/boolean typed fields (coerce away string values).
   * Reuses the same cached schema generateManifest reads — free on a warm cache.
   */
  async getFeedSchemaHints(marketplace: string, productType: string): Promise<{
    enumCodeMap: Record<string, Record<string, string>>
    localizedFields: Set<string>
    numericFields: Set<string>
    booleanFields: Set<string>
    /** FFP.18 — single wrapped sub-property attributes (closure→type …). */
    wrappedSubPropFields: Record<string, { sub: string; localized: boolean }>
    /** UFX P1 — declared type per sub-property path ("field.sub[.value|.unit]"). */
    subPropTypes: Record<string, SubPropType>
    /** UFX P6g — meta-schema selectors per attribute (array-item uniqueness). */
    selectorsByField: Record<string, string[]>
    /** base field id → UTF-8 byte cap, for pre-submit byte-length validation. */
    byteLimits: Record<string, number>
  }> {
    const mp = marketplace.toUpperCase()
    const pt = productType.toUpperCase()
    const cached = await this.schemas.getSchema({ channel: 'AMAZON', marketplace: mp, productType: pt })
    const def = (cached.schemaDefinition ?? {}) as Record<string, any>
    const properties = (def.properties ?? {}) as Record<string, any>
    return {
      enumCodeMap: buildSchemaEnumCodeMap(properties),
      ...buildSchemaFieldHints(properties),
      byteLimits: buildByteLimits(properties),
    }
  }

  /**
   * UFX P1 — raw cached schema definitions per product type, for the preflight
   * conditional-requirement evaluation (allOf/if/then, dependentRequired).
   * Best-effort per type: a missing/failed schema is simply absent from the map
   * (conditional checks are skipped for that type — never a false positive).
   */
  async getSchemaDefs(marketplace: string, productTypes: string[]): Promise<Map<string, Record<string, any>>> {
    const mp = marketplace.toUpperCase()
    const out = new Map<string, Record<string, any>>()
    await Promise.all([...new Set(productTypes.map((t) => String(t).toUpperCase()).filter(Boolean))].map(async (pt) => {
      try {
        const cached = await this.schemas.getSchema({ channel: 'AMAZON', marketplace: mp, productType: pt })
        out.set(pt, (cached.schemaDefinition ?? {}) as Record<string, any>)
      } catch { /* conditional checks skip this type */ }
    }))
    return out
  }

  /**
   * FBA-flip guard for the flat-file submit path. Returns the rows that would
   * convert an FBA listing to merchant-fulfilled (FBM): a MERCHANT channel
   * (DEFAULT/MFN) carrying a quantity for a SKU that is actually FBA (FBA stock
   * on hand or Product.fulfillmentMethod==='FBA'). The /submit route REJECTS when
   * this is non-empty, so the operator clears the quantity / sets AMAZON_EU, or
   * deliberately converts in Seller Central — rather than silently flipping the
   * live offer to FBM.
   *
   * NOT violations: blank-channel rows (buildJsonFeedBody already omits
   * fulfillment for them) and AMAZON_EU rows (it drops the merchant qty). Only an
   * explicit merchant channel + quantity for an FBA SKU is blocked. ≤2 queries.
   */
  async findFbaQtyViolations(
    rows: any[],
    _marketplace: string,
  ): Promise<Array<{ sku: string; channel: string }>> {
    const candidates = (rows ?? [])
      .map((r) => {
        const sku = String(r?.item_sku ?? '').trim()
        const ch = String(
          r?.['fulfillment_availability__fulfillment_channel_code'] ?? r?.['fulfillment_channel_code'] ?? '',
        ).toUpperCase()
        const qtyRaw = r?.['fulfillment_availability__quantity'] ?? r?.fulfillment_availability ?? r?.quantity
        const hasQty = qtyRaw !== undefined && String(qtyRaw).trim() !== ''
        return { sku, ch, hasQty }
      })
      .filter((c) => c.sku && c.hasQty && (c.ch === 'DEFAULT' || c.ch === 'MFN'))
    if (candidates.length === 0) return []

    const skus = [...new Set(candidates.map((c) => c.sku))]
    const products = await this.prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { id: true, sku: true, fulfillmentMethod: true },
    })
    const fbaBySku = new Map<string, boolean>()
    const needStock: Array<{ id: string; sku: string }> = []
    for (const p of products) {
      const byMethod = String(p.fulfillmentMethod ?? '').toUpperCase() === 'FBA'
      fbaBySku.set(p.sku, byMethod)
      if (!byMethod) needStock.push({ id: p.id, sku: p.sku })
    }
    if (needStock.length > 0) {
      const stock = await this.prisma.stockLevel.findMany({
        where: { productId: { in: needStock.map((n) => n.id) }, quantity: { gt: 0 }, location: { code: 'AMAZON-EU-FBA' } },
        select: { productId: true },
      })
      const fbaIds = new Set(stock.map((s) => s.productId))
      for (const n of needStock) if (fbaIds.has(n.id)) fbaBySku.set(n.sku, true)
    }

    const seen = new Set<string>()
    const out: Array<{ sku: string; channel: string }> = []
    for (const c of candidates) {
      if (fbaBySku.get(c.sku) === true && !seen.has(c.sku)) {
        seen.add(c.sku)
        out.push({ sku: c.sku, channel: c.ch })
      }
    }
    return out
  }

  /**
   * FFC — every FBA SKU in the batch that carries a quantity (ANY channel). FBA
   * stock is Amazon-managed, so a quantity should not be sent on publish:
   *   - a MERCHANT channel (DEFAULT/MFN) + qty would flip FBA→FBM → severity
   *     'block' (the /submit guard hard-rejects these);
   *   - any other channel just has the qty ignored by Amazon → severity 'warn'
   *     (clear it to be safe).
   * Surfaced in the pre-publish Review modal so the operator sees it BEFORE the
   * hard block. Broader than findFbaQtyViolations (which is merchant-only).
   */
  async findFbaQtyRows(rows: any[]): Promise<Array<{ sku: string; channel: string; severity: 'block' | 'warn' }>> {
    const candidates = (rows ?? [])
      .map((r) => {
        const sku = String(r?.item_sku ?? '').trim()
        const ch = String(r?.['fulfillment_availability__fulfillment_channel_code'] ?? r?.['fulfillment_channel_code'] ?? '').toUpperCase()
        const qtyRaw = r?.['fulfillment_availability__quantity'] ?? r?.fulfillment_availability ?? r?.quantity
        const hasQty = qtyRaw !== undefined && String(qtyRaw).trim() !== ''
        return { sku, ch, hasQty }
      })
      .filter((c) => c.sku && c.hasQty)
    if (candidates.length === 0) return []

    const skus = [...new Set(candidates.map((c) => c.sku))]
    const products = await this.prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { id: true, sku: true, fulfillmentMethod: true },
    })
    const fbaBySku = new Map<string, boolean>()
    const needStock: Array<{ id: string; sku: string }> = []
    for (const p of products) {
      const byMethod = String(p.fulfillmentMethod ?? '').toUpperCase() === 'FBA'
      fbaBySku.set(p.sku, byMethod)
      if (!byMethod) needStock.push({ id: p.id, sku: p.sku })
    }
    if (needStock.length > 0) {
      const stock = await this.prisma.stockLevel.findMany({
        where: { productId: { in: needStock.map((n) => n.id) }, quantity: { gt: 0 }, location: { code: 'AMAZON-EU-FBA' } },
        select: { productId: true },
      })
      const fbaIds = new Set(stock.map((s) => s.productId))
      for (const n of needStock) if (fbaIds.has(n.id)) fbaBySku.set(n.sku, true)
    }

    const seen = new Set<string>()
    const out: Array<{ sku: string; channel: string; severity: 'block' | 'warn' }> = []
    for (const c of candidates) {
      if (fbaBySku.get(c.sku) === true && !seen.has(c.sku)) {
        seen.add(c.sku)
        out.push({ sku: c.sku, channel: c.ch, severity: c.ch === 'DEFAULT' || c.ch === 'MFN' ? 'block' : 'warn' })
      }
    }
    return out
  }

  /**
   * Phase 3 (FBA visibility) — every FBA SKU the batch would DELETE
   * (record_action=delete). Deleting/relisting an FBA listing does NOT touch the
   * units already in Amazon's warehouse: they stay bound to this SKU's FNSKU and
   * become unfulfillable (stranded) unless the operator creates a removal order,
   * sells through, or relabels to a new FNSKU. We never automate any of that —
   * we surface it as a pre-publish WARNING so it's never a silent surprise.
   * FBA detection mirrors findFbaQtyRows (Product.fulfillmentMethod==='FBA' OR
   * positive AMAZON-EU-FBA stock). ≤2 queries.
   */
  async findFbaDeleteRows(rows: any[]): Promise<string[]> {
    const delSkus = [
      ...new Set(
        (rows ?? [])
          .filter((r) => String(r?.record_action ?? '').trim().toLowerCase() === 'delete')
          .map((r) => String(r?.item_sku ?? '').trim())
          .filter(Boolean),
      ),
    ]
    if (delSkus.length === 0) return []

    const products = await this.prisma.product.findMany({
      where: { sku: { in: delSkus } },
      select: { id: true, sku: true, fulfillmentMethod: true },
    })
    const fbaSkus = new Set<string>()
    const needStock: Array<{ id: string; sku: string }> = []
    for (const p of products) {
      if (String(p.fulfillmentMethod ?? '').toUpperCase() === 'FBA') fbaSkus.add(p.sku)
      else needStock.push({ id: p.id, sku: p.sku })
    }
    if (needStock.length > 0) {
      const stock = await this.prisma.stockLevel.findMany({
        where: { productId: { in: needStock.map((n) => n.id) }, quantity: { gt: 0 }, location: { code: 'AMAZON-EU-FBA' } },
        select: { productId: true },
      })
      const fbaIds = new Set(stock.map((s) => s.productId))
      for (const n of needStock) if (fbaIds.has(n.id)) fbaSkus.add(n.sku)
    }

    return delSkus.filter((s) => fbaSkus.has(s))
  }

  /**
   * UFX P6b — last-saved flat-file snapshot per SKU (ChannelListing.
   * flatFileSnapshot, keyed by grid column ids), for the non-editable-change
   * preflight warning: a value differing from the snapshot is a change made
   * since the last save/submit. One batched query; SKUs with no listing or no
   * snapshot are simply absent (the check skips them — a new/never-saved row
   * can't be diffed).
   */
  async getFlatFileSnapshots(
    marketplace: string,
    skus: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>()
    const list = [...new Set(skus.filter(Boolean))]
    if (list.length === 0) return out
    const listings = await this.prisma.channelListing.findMany({
      where: { channel: 'AMAZON', marketplace: marketplace.toUpperCase(), product: { sku: { in: list } } },
      select: { flatFileSnapshot: true, product: { select: { sku: true } } },
    })
    for (const l of listings as any[]) {
      const snap = l.flatFileSnapshot
      if (snap && typeof snap === 'object' && !Array.isArray(snap)) out.set(l.product.sku, snap)
    }
    return out
  }

  /** Backward-compatible wrapper — see buildJsonFeedBodyWithReport for the
   *  per-row skip report (UFX P6d). */
  buildJsonFeedBody(
    rows: FlatFileRow[],
    marketplace: string,
    sellerId: string,
    expandedFields: Record<string, string> = {},
    feedSchema: FeedSchemaHints = {},
  ): string {
    return this.buildJsonFeedBodyWithReport(rows, marketplace, sellerId, expandedFields, feedSchema).body
  }

  /**
   * UFX P6d — feed body + per-row report. A row with no resolvable product
   * type is SKIPPED with a per-row error instead of being emitted with
   * productType:'' (which schema-halts the ENTIRE feed: 4002010
   * '#/productType'). Resolution order for a blank product_type cell:
   *   1. its parent row's product_type (matched by parent_sku within the batch
   *      — a mixed-type sheet must not stamp a child with another family's type),
   *   2. the submission-level defaultProductType,
   *   3. otherwise skip (reported in `skippedRows`, same {sku, error} shape as
   *      syncRowsToPlatform's errors).
   * DELETE rows never need a type and are never skipped.
   */
  buildJsonFeedBodyWithReport(
    rows: FlatFileRow[],
    marketplace: string,
    sellerId: string,
    expandedFields: Record<string, string> = {},
    feedSchema: FeedSchemaHints = {},
  ): { body: string; messageCount: number; skippedRows: Array<{ sku: string; error: string }> } {
    const mp = marketplace.toUpperCase()
    const marketplaceId = MARKETPLACE_ID_MAP[mp] ?? MARKETPLACE_ID_MAP.IT
    const languageTag = LANGUAGE_TAG_MAP[mp] ?? 'it_IT'

    const enumCodeMap = feedSchema.enumCodeMap ?? {}
    const numericFields = feedSchema.numericFields ?? new Set<string>()
    const booleanFields = feedSchema.booleanFields ?? new Set<string>()
    const localizedFields = feedSchema.localizedFields
    const applicableByType = feedSchema.applicableByType
    const defaultProductType = (feedSchema.defaultProductType ?? '').toUpperCase()
    const wrappedSubPropFields = feedSchema.wrappedSubPropFields ?? {}
    const subPropTypes = feedSchema.subPropTypes
    const selectorsByField = feedSchema.selectorsByField ?? {}

    // Enum fields are shown in the editor as display LABELS (e.g. "Pakistan") but
    // Amazon's JSON feed requires the underlying CODE (e.g. "PK"). Convert
    // label→code; a value already a code (or unmapped) passes through. Keyed by
    // field id, or "field.sub" for sub-property enums (e.g. "closure.type").
    const toCode = (fieldKey: string, value: string): string =>
      enumCodeMap[fieldKey]?.[value] ?? value

    // Generic top-level value: enum label→code, else schema-typed number/boolean
    // coercion (Amazon rejects "5"/"true" strings where a number/boolean is
    // required), else the raw string.
    const emitValue = (fieldKey: string, raw: string): unknown => {
      const coded = enumCodeMap[fieldKey]?.[raw]
      // FFP.18 — enum-coded values still need schema typing. A boolean
      // attribute's localized label ("Sì") maps to the STRING "true", which
      // Amazon's boolean schema ignores — that silently voided the GTIN
      // exemption flag (supplier_declared_has_product_identifier_exemption)
      // and kept demanding a product identifier on exempt listings.
      const effective = coded !== undefined ? coded : raw
      if (numericFields.has(fieldKey)) { const n = Number(String(effective)); return Number.isFinite(n) ? n : effective }
      if (booleanFields.has(fieldKey)) {
        if (typeof effective === 'boolean') return effective
        return effective === 'true' || effective === 'TRUE' || effective === '1'
      }
      return effective
    }

    // Only localized fields carry a language_tag. With no schema (localizedFields
    // undefined) keep the legacy behaviour (tag everything) so a missing schema
    // never strips a real localized tag.
    const isLocalized = (fieldKey: string): boolean =>
      localizedFields ? localizedFields.has(fieldKey) : true

    // Fields with complex/explicit SP-API structure — handled case-by-case below
    const EXPLICIT_KEYS = new Set([
      'item_sku', 'product_type', 'record_action',
      // Product-identifier columns are handled explicitly (the block that emits
      // merchant_suggested_asin / externally_assigned_product_identifier), so
      // list them here to keep the generic loop from ALSO emitting them as raw
      // `external_product_id` attributes (which Amazon would reject).
      'external_product_id', 'external_product_id_type',
      'parentage_level', 'parent_sku', 'variation_theme',
      'item_name', 'brand', 'product_description',
      'bullet_point', 'generic_keyword', 'color',
      'main_product_image_locator',
      // purchasable_offer and its expanded sub-columns
      'purchasable_offer',
      'purchasable_offer__condition_type', 'purchasable_offer__currency',
      'purchasable_offer__our_price', 'purchasable_offer__sale_price',
      'purchasable_offer__sale_from_date', 'purchasable_offer__sale_end_date',
      // fulfillment_availability and its expanded sub-columns
      'fulfillment_availability',
      'fulfillment_availability__fulfillment_channel_code',
      'fulfillment_availability__quantity',
      'fulfillment_availability__lead_time_to_ship_max_days',
    ])

    // UFX P6d — parent type lookup (item_sku → product_type) so a blank-type
    // child inherits ITS OWN family's type in a mixed-type sheet, and per-row
    // skip report for rows whose type can't be resolved at all.
    const typeBySku = new Map<string, string>()
    for (const r of rows) {
      const sku = String(r.item_sku ?? '').trim()
      const t = String(r.product_type ?? '').toUpperCase()
      if (sku && t && !typeBySku.has(sku)) typeBySku.set(sku, t)
    }
    const skippedRows: Array<{ sku: string; error: string }> = []

    const built = rows
      .filter((r) => r.item_sku)
      .map((row, i) => {
        // operationType — the flat-file editor overwhelmingly EDITS existing
        // listings, so the default is PARTIAL_UPDATE: it patches only the
        // attributes we actually send and does NOT enforce the product type's
        // full required-attribute set. A full UPDATE (requirements:'LISTING')
        // rejects a partial edit for any required attr we didn't resend — which
        // is exactly what sank the DE feed. FFP.2 — pulled rows now default to
        // record_action 'partial_update', so a row carrying 'full_update' is an
        // EXPLICIT operator choice and maps to a full UPDATE (create/replace:
        // attributes omitted from the row are DROPPED on Amazon).
        const opRaw = String(row.record_action ?? '').toLowerCase()
        const operationType =
          opRaw === 'delete' ? 'DELETE'
          : row._isNew === true ? 'UPDATE'
          : opRaw === 'full_update' ? 'UPDATE'
          : 'PARTIAL_UPDATE'
        if (operationType === 'DELETE') {
          // FFP.3 — minimal DELETE per the v2 message schema: {sku, operationType}.
          // productType/attributes/requirements are "not applicable" for DELETE,
          // so sending them only adds validation surface.
          return { messageId: i + 1, sku: String(row.item_sku), operationType }
        }

        // UFX P6d — blank row productType: prefer the row's OWN parent's type
        // (matched by parent_sku within the batch — a scalar defaultProductType
        // stamps the wrong type on a mixed-type sheet), then the submission's
        // fallback. Still blank → SKIP the row with a per-row error; an empty
        // productType malformed the entire feed (4002010 schema halt).
        const ownType = String(row.product_type ?? '').toUpperCase()
        const parentType = ownType ? '' : (typeBySku.get(String(row.parent_sku ?? '').trim()) ?? '')
        const productType = ownType || parentType || defaultProductType
        if (!productType) {
          skippedRows.push({
            sku: String(row.item_sku),
            error: 'Row skipped: no product type — the cell is blank and neither its parent row (by parent_sku) nor the submission carries one. Fill the Product Type column and resubmit.',
          })
          return null
        }

        // FFP.3 — parentage decides which attribute families a message may carry
        // (a parent has no offer). Normalized early; the parent/child structural
        // attributes themselves are emitted further down.
        const parentageCode = normalizeParentage(String(row.parentage_level ?? ''), enumCodeMap['parentage_level'] ?? {})
        const isParentRow = parentageCode === 'parent'
        // FFP.3 — this row's applicable column set (per its own product type).
        const applicableCols = applicableByType?.get(productType)

        const attrs: Record<string, any> = {}
        const wrap  = (v: string) => [{ value: v, marketplace_id: marketplaceId }]
        const wrapL = (v: string) => [{ value: v, language_tag: languageTag, marketplace_id: marketplaceId }]

        if (row.item_name)           attrs.item_name           = wrapL(String(row.item_name))
        if (row.brand)               attrs.brand               = wrapL(String(row.brand))
        if (row.product_description) attrs.product_description = wrapL(String(row.product_description))
        if (row.bullet_point)        attrs.bullet_point        = [{ value: String(row.bullet_point), language_tag: languageTag, marketplace_id: marketplaceId }]
        if (row.generic_keyword)     attrs.generic_keyword     = wrapL(String(row.generic_keyword))
        if (row.color)               attrs.color               = wrapL(String(row.color))
        if (row.main_product_image_locator) attrs.main_product_image_locator = [{ media_location: String(row.main_product_image_locator), marketplace_id: marketplaceId }]

        // Product identifier — for a NEW SKU (create/relist) ONLY, attach the
        // offer to an EXISTING Amazon catalog entry so it keeps that ASIN's
        // reviews + ranking instead of minting a new one. type=ASIN →
        // merchant_suggested_asin; EAN/GTIN/UPC → externally_assigned_product_
        // identifier (Amazon resolves the ASIN from the barcode).
        // GATED to _isNew on purpose: the column is read-populated with each
        // existing SKU's ASIN, and re-asserting a (possibly stale/duplicate)
        // ASIN on a live listing could re-match it to the wrong product — so we
        // never emit it for an existing-listing update.
        const epId   = String(row.external_product_id ?? '').trim()
        const epType = String(row.external_product_id_type ?? '').trim().toUpperCase()
        if (epId && row._isNew === true) {
          if (epType === 'ASIN') {
            attrs.merchant_suggested_asin = wrap(epId)
          } else if (epType === 'EAN' || epType === 'GTIN' || epType === 'UPC') {
            attrs.externally_assigned_product_identifier = [
              { type: epType.toLowerCase(), value: epId, marketplace_id: marketplaceId },
            ]
          }
        }

        // purchasable_offer — read from expanded sub-columns, fall back to bare value.
        // FFP.3 — NEVER on a parent: a variation parent is not buyable, and offer
        // data on the parent message is a documented cause of parent feed
        // failures ("attribute not valid for parent").
        const poPrice = row['purchasable_offer__our_price'] ?? row.purchasable_offer ?? row.standard_price
        if (!isParentRow && poPrice !== undefined && poPrice !== '') {
          const poCurrency   = String(row['purchasable_offer__currency'] ?? CURRENCY_MAP[mp] ?? 'EUR')
          const poCondition  = String(row['purchasable_offer__condition_type'] ?? '')
          const poSalePrice  = row['purchasable_offer__sale_price']
          const poSaleFrom   = String(row['purchasable_offer__sale_from_date'] ?? '')
          const poSaleTo     = String(row['purchasable_offer__sale_end_date'] ?? '')
          const offer: Record<string, any> = {
            currency: poCurrency,
            our_price: [{ schedule: [{ value_with_tax: Math.max(0, parseLocaleNumber(poPrice) ?? 0) }] }],
            marketplace_id: marketplaceId,
          }
          if (poCondition) offer.condition_type = enumCodeMap['purchasable_offer.condition_type']?.[poCondition] ?? poCondition
          if (poSalePrice !== undefined && poSalePrice !== '') {
            const sp: Record<string, any> = { schedule: [{ value_with_tax: Math.max(0, parseLocaleNumber(poSalePrice) ?? 0) }] }
            if (poSaleFrom) sp.start_at = [{ value: poSaleFrom, marketplace_id: marketplaceId }]
            if (poSaleTo)   sp.end_at   = [{ value: poSaleTo,   marketplace_id: marketplaceId }]
            offer.sale_price = [sp]
          }
          attrs.purchasable_offer = [offer]
        }
        // fulfillment_availability — FFA.3 + FBA-flip fix. A merchant quantity under
        // fulfillment_channel_code:DEFAULT is exactly what flips an FBA offer to FBM, so:
        //   • explicit FBA channel (AMAZON_*/AFN/FBA) → keep the channel, NEVER a
        //     merchant qty (Amazon owns FBA stock) — re-publish stays FBA;
        //   • explicit merchant channel (DEFAULT/MFN) → channel (normalised to DEFAULT) + qty;
        //   • blank/unknown channel → emit NOTHING. The old `faCode || 'DEFAULT'`
        //     fabricated a merchant claim for unknown-fulfillment rows and flipped them.
        const faCode     = String(row['fulfillment_availability__fulfillment_channel_code'] ?? row['fulfillment_channel_code'] ?? '').toUpperCase()
        const faQtyRaw   = row['fulfillment_availability__quantity'] ?? row.fulfillment_availability ?? row.quantity
        const faQtyNum   = faQtyRaw !== undefined && faQtyRaw !== '' ? parseLocaleInt(faQtyRaw) : null
        const faLeadRaw  = row['fulfillment_availability__lead_time_to_ship_max_days']
        const faLeadNum  = faLeadRaw !== undefined && faLeadRaw !== '' ? parseLocaleInt(faLeadRaw) : null
        const isFbaChannel      = faCode.startsWith('AMAZON') || faCode === 'AFN' || faCode === 'FBA'
        const isMerchantChannel = faCode === 'DEFAULT' || faCode === 'MFN'
        // FFP.3 — a parent carries no fulfillment/stock; see purchasable_offer note.
        if (isParentRow) {
          // no fulfillment_availability on parent messages
        } else if (isFbaChannel) {
          const fa: Record<string, any> = { fulfillment_channel_code: faCode, marketplace_id: marketplaceId }
          if (faLeadNum !== null && faLeadNum >= 0) fa.lead_time_to_ship_max_days = faLeadNum
          attrs.fulfillment_availability = [fa]
        } else if (isMerchantChannel) {
          const fa: Record<string, any> = { fulfillment_channel_code: 'DEFAULT', marketplace_id: marketplaceId }
          if (faQtyNum !== null && faQtyNum >= 0) fa.quantity = faQtyNum
          if (faLeadNum !== null && faLeadNum >= 0) fa.lead_time_to_ship_max_days = faLeadNum
          attrs.fulfillment_availability = [fa]
        }
        // blank/unknown faCode → omit fulfillment_availability entirely (fail-closed).

        // (parentageCode normalized above — canonical/'Parent'/localized labels.)
        if (parentageCode === 'parent') {
          // HIGH-5 — a parent must declare its parentage_level, not just the
          // variation theme, or Amazon won't register it as a variation parent.
          attrs.parentage_level = [{ value: 'parent', marketplace_id: marketplaceId }]
          if (row.variation_theme) {
            const vt = String(row.variation_theme)
            // FFP.18 — variation_theme's payload key is `name`, NOT `value`
            // (schema: items.required ['name']). FFP.19 — the value is
            // normalized to the category's approved enum (legacy
            // "SizeName-ColorName" spellings → SIZE_NAME/COLOR_NAME; 90244).
            attrs.variation_theme = [{ name: normalizeVariationTheme(vt, enumCodeMap['variation_theme'] ?? {}), marketplace_id: marketplaceId }]
          }
        }
        if (parentageCode === 'child' && row.parent_sku) {
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
          // FFP.3 — skip columns that don't apply to THIS row's product type
          // (Amazon's own manifest is the truth). Kills the not-applicable
          // attribute spray that buried real errors under ~50 warnings/SKU.
          if (applicableCols && !applicableCols.has(k)) continue
          const path = expandedFields[k]
          if (path) {
            if (!path.includes('.')) {
              // Multi-instance: path = "bullet_point", key = "bullet_point_1"
              const idx = parseInt(k.slice(path.length + 1), 10)
              if (!isNaN(idx)) (pendingArrays[path] ??= []).push({ idx, value: String(v) })
            } else {
              // Sub-property path: "field.sub" or "field.sub.value" or "field.sub.unit"
              // UFX P1 (P0-2) — label→code first (sub-prop enums), then coerce by
              // the DECLARED schema type: Number() sniffing turned string-typed
              // all-digits values (size "38", leading-zero codes) into numbers
              // Amazon rejects. With schema hints, only a declared number/boolean
              // is coerced; unknown/string paths stay strings. No hints → legacy sniff.
              const parts = path.split('.')
              const base = parts[0]
              const obj = (subPropMap[base] ??= {})
              const coded = String(enumCodeMap[path]?.[String(v)] ?? v)
              const typedV = coerceSubPropValue(path, coded, subPropTypes)
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
          } else if (wrappedSubPropFields[k]) {
            const { sub, localized, flat } = wrappedSubPropFields[k]
            if (flat) {
              // UFX P6e — single PLAIN scalar sub-property
              // (gpsr_manufacturer_reference → gpsr_manufacturer_email_address):
              // `[{gpsr_manufacturer_email_address: v, marketplace_id}]`. The
              // generic `[{value,…}]` shape violates additionalProperties:false.
              const coded = String(enumCodeMap[`${k}.${sub}`]?.[String(v)] ?? enumCodeMap[k]?.[String(v)] ?? String(v))
              attrs[k] = [{ [sub]: coerceSubPropValue(`${k}.${sub}`, coded, subPropTypes), marketplace_id: marketplaceId }]
            } else {
              // FFP.18 — nested single-sub-property shape (closure→type,
              // inner/outer→material …): `closure: [{type: [{value,…}]}]`.
              // Flat emission made Amazon read these as EMPTY (90220
              // "obbligatorio ma mancante" on fields the operator HAD filled).
              const subCell: Record<string, any> = {
                value: enumCodeMap[`${k}.${sub}`]?.[String(v)] ?? enumCodeMap[k]?.[String(v)] ?? String(v),
              }
              if (localized) subCell.language_tag = languageTag
              attrs[k] = [{ [sub]: [subCell], marketplace_id: marketplaceId }]
            }
          } else {
            const cell: Record<string, any> = { value: emitValue(k, String(v)), marketplace_id: marketplaceId }
            if (isLocalized(k)) cell.language_tag = languageTag
            attrs[k] = [cell]
          }
        }
        // Emit multi-instance arrays. UFX P1 (P4) — emitValue applies the SAME
        // enum-code + number/boolean schema typing the singleton path gets; the
        // old toCode-only emit sent "5"/"true" strings for typed multi-instance
        // attributes (Amazon ignores/rejects those).
        for (const [base, items] of Object.entries(pendingArrays)) {
          items.sort((a, b) => a.idx - b.idx)
          const cells = items.map((item) => {
            const cell: Record<string, any> = { value: emitValue(base, item.value), marketplace_id: marketplaceId }
            if (isLocalized(base)) cell.language_tag = languageTag
            return cell
          })
          // UFX P6g — drop instances that collide under the attribute's OWN
          // uniqueness rule (meta-schema selectors); no schema hint → no dedup.
          attrs[base] = dedupCellsBySelectors(cells, selectorsByField[base])
        }
        // Emit sub-property objects — convert any enum sub-value (e.g. closure.type,
        // apparel_size.size_system) from its display label to Amazon's code.
        // UFX P1 (P2) — when the attribute's sub-schema declares a language_tag
        // (items.properties.language_tag), the cell carries it like the wrapped /
        // multi-instance paths do. Schema-gated on purpose: with no schema hints
        // we keep the legacy untagged shape (a stray tag on a non-localized
        // object attribute is a feed error, the opposite failure mode).
        for (const [base, val] of Object.entries(subPropMap)) {
          const coded: Record<string, any> = {}
          for (const [sub, sv] of Object.entries(val)) {
            coded[sub] = typeof sv === 'string' ? toCode(`${base}.${sub}`, sv) : sv
          }
          const cell: Record<string, any> = { ...coded, marketplace_id: marketplaceId }
          if (localizedFields?.has(base)) cell.language_tag = languageTag
          attrs[base] = [cell]
        }

        // FFA — drop any blank/whitespace attribute so a single empty pulled cell
        // can't fail the whole feed ("Invalid empty value provided in patch").
        const cleanAttrs: Record<string, any> = {}
        for (const [k, v] of Object.entries(attrs)) {
          if (!isBlankFeedValue(v)) cleanAttrs[k] = v
        }

        const message: Record<string, any> = {
          messageId: i + 1,
          sku: String(row.item_sku),
          operationType,
          productType,
          attributes: cleanAttrs,
        }
        // `requirements` enforces the full required-attribute set, so it's only
        // valid for a full UPDATE (create / full replace). For PARTIAL_UPDATE it
        // must be omitted — otherwise Amazon re-validates every required attribute
        // and rejects the patch for fields we intentionally didn't resend.
        if (operationType === 'UPDATE') {
          message.requirements = normalizeParentage(String(row.parentage_level ?? ''), enumCodeMap['parentage_level'] ?? {}) === 'parent' ? 'LISTING_PRODUCT_ONLY' : 'LISTING'
        }
        return message
      })

    // UFX P6d — drop skipped rows and renumber messageIds sequentially (Amazon
    // wants unique positive ints; identical to before when nothing is skipped).
    const messages = built
      .filter((m): m is Record<string, any> => m !== null)
      .map((m, i) => ({ ...m, messageId: i + 1 }))

    const body = JSON.stringify({
      header: { sellerId, version: '2.0', issueLocale: languageTag.replace('_', '-') },
      messages,
    })
    return { body, messageCount: messages.length, skippedRows }
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

  // ── Platform sync ──────────────────────────────────────────────────

  /**
   * Sync flat-file rows back into the platform DB.
   *
   * For each row (matched by item_sku → Product.sku):
   *   • Upsert ChannelListing (title, description, bullets, price, qty,
   *     platformAttributes, ASIN)
   *   • Update Product hierarchy (isParent, parentId, amazonProductType)
   *   • Adjust StockLevel + write a StockMovement audit row if qty changed
   *
   * Called on Save (isPublished = false) and after a feed is DONE
   * (isPublished = true). Non-blocking on the client — errors are reported
   * but never throw.
   */
  /** FFC — create ProductImage rows for a new product from the flat-file image
   *  columns (main + other_product_image_locator_1..8). Without this, a row's
   *  image URLs only live in platformAttributes and the Images tab gallery is
   *  empty for a flat-file-created product. */
  private async createProductImagesFromRow(productId: string, row: Record<string, any>): Promise<void> {
    const urls: string[] = []
    const main = String(row.main_product_image_locator ?? '').trim()
    if (main) urls.push(main)
    for (let i = 1; i <= 8; i++) {
      const u = String(row[`other_product_image_locator_${i}`] ?? '').trim()
      if (u && !urls.includes(u)) urls.push(u)
    }
    if (!urls.length) return
    await this.prisma.productImage.createMany({
      data: urls.map((url, idx) => ({
        productId,
        url,
        type: idx === 0 ? 'MAIN' : 'ALT',
        isPrimary: idx === 0,
        sortOrder: idx,
      })),
    })
  }

  async syncRowsToPlatform(
    rows: FlatFileRow[],
    marketplace: string,
    expandedFields: Record<string, string> = {},
    opts: { isPublished?: boolean } = {},
  ): Promise<{ synced: number; created: number; skipped: number; errors: Array<{ sku: string; error: string }> }> {
    const mp = marketplace.toUpperCase()
    const marketplaceId = MARKETPLACE_ID_MAP[mp] ?? MARKETPLACE_ID_MAP.IT
    const languageTag   = LANGUAGE_TAG_MAP[mp] ?? 'it_IT'
    const channelMarket = `AMAZON_${mp}`
    const result = { synced: 0, created: 0, skipped: 0, errors: [] as Array<{ sku: string; error: string }>, versions: {} as Record<string, number> }

    const validRows = rows.filter((r) => {
      const sku = String(r.item_sku ?? '').trim()
      return sku && String(r.record_action ?? '').toLowerCase() !== 'delete'
    })

    // Delete-sync — record_action=delete rows are submitted to Amazon as a
    // DELETE feed (the offer is withdrawn). Mirror that locally so Nexus
    // isn't split-brain: soft-delete THIS marketplace's AMAZON listing
    // (listingStatus ENDED + isPublished=false — reversible by re-publishing).
    // The Product row is kept so history/links survive. Optimistic w.r.t. the
    // async feed; the Nexus↔channel reconciliation is the backstop for the
    // rare Amazon reject. Runs before the empty-validRows early-return so an
    // all-delete submit is still mirrored locally.
    const deleteSkus = [
      ...new Set(
        rows
          .filter((r) => String(r.record_action ?? '').toLowerCase() === 'delete')
          .map((r) => String(r.item_sku ?? '').trim())
          .filter(Boolean),
      ),
    ]
    if (deleteSkus.length) {
      const delProducts = await this.prisma.product.findMany({
        where: { sku: { in: deleteSkus }, deletedAt: null },
        select: { id: true, sku: true },
      })
      if (delProducts.length) {
        const delIds = delProducts.map((p) => p.id)
        // FFP.13 — persist the delete-row's snapshot too. Delete rows are
        // excluded from the normal save pass (validRows), so the listing kept
        // the snapshot from the PREVIOUS save — and a reload then showed the
        // old operation (e.g. partial_update) as if the delete never happened.
        // The row must round-trip record_action='delete' (and every other
        // entered value) until the operator changes it.
        const delRowBySku = new Map(
          rows
            .filter((r) => String(r.record_action ?? '').toLowerCase() === 'delete')
            .map((r) => [String(r.item_sku ?? '').trim(), r] as const),
        )
        for (const p of delProducts) {
          const row = delRowBySku.get(p.sku)
          const snapshot = row
            ? Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('_')))
            : undefined
          await this.prisma.channelListing.updateMany({
            where: { productId: p.id, channel: 'AMAZON', marketplace: mp },
            data: {
              listingStatus: 'ENDED',
              isPublished: false,
              ...(snapshot ? { flatFileSnapshot: snapshot as any } : {}),
            },
          })
        }
        // Keep the /products grid honest (it reads ProductReadCache).
        await Promise.all(
          delIds.map((id) => productReadCacheService.refresh(id).catch(() => undefined)),
        )
      }
    }

    if (!validRows.length) return result

    // Bulk SKU → product lookup
    const skus = [...new Set(validRows.map((r) => String(r.item_sku).trim()))]
    const products = await this.prisma.product.findMany({
      where: { sku: { in: skus }, deletedAt: null },
      select: { id: true, sku: true, isParent: true, parentId: true, productType: true },
    })
    const productBySku = new Map(products.map((p) => [p.sku, p]))

    // Fetch enum code maps per unique product type for parentage_level normalization.
    // parentage_level may be stored as a localized label (e.g., 'Articolo padre' for IT)
    // when the operator selected from a schema-derived localized dropdown in an earlier
    // session. This map converts those labels → canonical 'parent'/'child' codes.
    const productTypeSet = new Set(validRows.map((r) => String(r.product_type ?? '').toUpperCase()).filter(Boolean))
    const hintsByProductType = new Map<string, { enumCodeMap: Record<string, Record<string, string>>; subPropTypes: Record<string, SubPropType> }>()
    await Promise.all([...productTypeSet].map(async (pt) => {
      try {
        const h = await this.getFeedSchemaHints(mp, pt)
        hintsByProductType.set(pt, { enumCodeMap: h.enumCodeMap, subPropTypes: h.subPropTypes })
      } catch { /* non-critical; normalizeParentage falls back to direct toLowerCase */ }
    }))
    const getParentageCode = (raw: string, productType: string): 'parent' | 'child' | '' =>
      normalizeParentage(raw, (hintsByProductType.get(String(productType).toUpperCase())?.enumCodeMap ?? {})['parentage_level'] ?? {})

    // Bulk parent-SKU → parentId lookup for child rows
    const parentSkus = [...new Set(
      validRows
        .filter((r) => (getParentageCode(String(r.parentage_level ?? ''), String(r.product_type ?? '')) === 'child' || String(r.parent_sku ?? '').trim().length > 0) && r.parent_sku)
        .map((r) => String(r.parent_sku).trim()),
    )]
    const parentProducts = parentSkus.length
      ? await this.prisma.product.findMany({
          where: { sku: { in: parentSkus }, deletedAt: null },
          select: { id: true, sku: true },
        })
      : []
    const parentIdBySku = new Map(parentProducts.map((p) => [p.sku, p.id]))

    // FM Phase 1 — the Amazon flat-file save no longer writes the shared warehouse
    // pool (StockLevel / Product.totalStock). That per-market write clobbered the
    // pool the same way the eBay save did (AIRMESH class). Stock is owned ONLY by
    // the /stock page + imports. The per-listing ChannelListing write below (qty +
    // followMasterQuantity) is unchanged.

    // FFC — create missing products for _isNew rows BEFORE the sync pass, parents
    // first so a child's parent_sku resolves to a same-batch parent. New products
    // land in productBySku/parentIdBySku so the per-row sync below writes their
    // ChannelListing + StockLevel exactly like an existing product. A non-_isNew
    // unknown SKU is NOT created (it falls through to the "Product not found" error
    // below — catching a typo rather than silently spawning a product).
    const toCreate = validRows.filter(
      (r) => r._isNew === true && !productBySku.has(String(r.item_sku).trim()),
    )
    const parentageRank = (r: FlatFileRow) => {
      const p = getParentageCode(String(r.parentage_level ?? ''), String(r.product_type ?? ''))
      return p === 'parent' ? 0 : p === 'child' ? 2 : 1
    }
    toCreate.sort((a, b) => parentageRank(a) - parentageRank(b))
    for (const row of toCreate) {
      const sku = String(row.item_sku).trim()
      const isChildRow = getParentageCode(String(row.parentage_level ?? ''), String(row.product_type ?? '')) === 'child'
        || String(row.parent_sku ?? '').trim().length > 0

      // Parent / standalone rows need an explicit title; child rows typically omit
      // item_name in Amazon flat-files (it is inherited from the parent). Blocking
      // child creation here caused new variant rows to silently disappear after save.
      if (!String(row.item_name ?? '').trim() && !isChildRow) {
        result.errors.push({ sku, error: 'New product needs a Title (item_name) before it can be created.' })
        continue
      }

      // For child rows without item_name, inject the parent's title from this batch
      // so the DB record gets a meaningful name. buildProductCreateInput falls back
      // to SKU if item_name is still blank, so creation never fails on a missing title.
      let rowForCreate: FlatFileRow = row
      if (isChildRow && !String(row.item_name ?? '').trim()) {
        const parentSkuVal = String(row.parent_sku ?? '').trim()
        const parentRow = parentSkuVal
          ? validRows.find(
              (r) =>
                String(r.item_sku ?? '').trim() === parentSkuVal &&
                getParentageCode(String(r.parentage_level ?? ''), String(r.product_type ?? '')) === 'parent',
            )
          : undefined
        const inheritedName = parentRow ? String(parentRow.item_name ?? '').trim() : ''
        if (inheritedName) rowForCreate = { ...row, item_name: inheritedName }
      }

      try {
        const parentSku = String(rowForCreate.parent_sku ?? '').trim()
        const parentId =
          isChildRow && parentSku ? (parentIdBySku.get(parentSku) ?? null) : null
        // Normalize parentage before passing to buildProductCreateInput (pure fn, no codeMap)
        const createRow = { ...rowForCreate, parentage_level: getParentageCode(String(rowForCreate.parentage_level ?? ''), String(rowForCreate.product_type ?? '')) }
        const created = await this.prisma.product.create({
          data: { ...buildProductCreateInput(createRow, { languageTag, parentId }), importedAt: new Date() } as any,
          select: { id: true, sku: true, isParent: true, parentId: true, productType: true },
        })
        productBySku.set(sku, created)
        if (getParentageCode(String(rowForCreate.parentage_level ?? ''), String(rowForCreate.product_type ?? '')) === 'parent') parentIdBySku.set(sku, created.id)
        await this.createProductImagesFromRow(created.id, rowForCreate)
        result.created++
      } catch (err) {
        result.errors.push({ sku, error: `Create failed: ${err instanceof Error ? err.message : String(err)}` })
      }
    }

    await Promise.allSettled(validRows.map(async (row) => {
      const sku = String(row.item_sku).trim()
      const product = productBySku.get(sku)
      if (!product) {
        result.errors.push({ sku, error: 'Product not found — create it in the platform first.' })
        return
      }

      try {
        const parentageLevel = getParentageCode(String(row.parentage_level ?? ''), String(row.product_type ?? ''))
        const isParentRow = parentageLevel === 'parent'
        const isChildRow  = parentageLevel === 'child' || String(row.parent_sku ?? '').trim().length > 0
        const parentSku   = String(row.parent_sku ?? '').trim()
        const parentId    = isChildRow && parentSku ? (parentIdBySku.get(parentSku) ?? null) : undefined
        const productType = String(row.product_type ?? '').toUpperCase() || undefined

        // Bullet points (bullet_point_1..5 or bare bullet_point)
        const bullets: string[] = []
        for (let i = 1; i <= 5; i++) {
          const key = i === 1 && !row[`bullet_point_1`] ? 'bullet_point' : `bullet_point_${i}`
          const b = String(row[key] ?? '').trim()
          if (b) bullets.push(b)
        }
        // also capture bare bullet_point if not already included
        const bareBullet = String(row.bullet_point ?? '').trim()
        if (bareBullet && !bullets.includes(bareBullet)) bullets.unshift(bareBullet)

        // Price / qty — prefer expanded sub-columns, fall back to bare/legacy keys.
        // FFA.1 — locale-tolerant parse ("19,99"→19.99) + drop negatives.
        const priceRaw    = row['purchasable_offer__our_price'] ?? row.purchasable_offer ?? row.standard_price
        const priceParsed = priceRaw !== undefined && priceRaw !== '' ? parseLocaleNumber(priceRaw) : null
        const price       = priceParsed !== null && priceParsed >= 0 ? priceParsed : null
        const salePriceRaw = row['purchasable_offer__sale_price'] ?? row.sale_price
        const salePriceParsed = salePriceRaw !== undefined && salePriceRaw !== '' ? parseLocaleNumber(salePriceRaw) : null
        const salePrice   = salePriceParsed !== null && salePriceParsed >= 0 ? salePriceParsed : null
        const qtyRaw      = row['fulfillment_availability__quantity'] ?? row.fulfillment_availability ?? row.quantity
        const qtyParsed   = qtyRaw !== undefined && qtyRaw !== '' ? parseLocaleInt(qtyRaw) : null
        const qty         = qtyParsed !== null && qtyParsed >= 0 ? qtyParsed : null

        // Collapsed attributes (same format getExistingRows reads back)
        const rowHints = hintsByProductType.get(String(row.product_type ?? '').toUpperCase())
        const collapsedAttrs = this.buildCollapsedAttrs(row, expandedFields, mp, marketplaceId, languageTag, rowHints?.enumCodeMap ?? {}, rowHints?.subPropTypes)

        // ── Upsert ChannelListing ───────────────────────────────────
        const existing = await this.prisma.channelListing.findFirst({
          where: { productId: product.id, channel: 'AMAZON', marketplace: mp },
          select: { id: true, quantity: true, version: true, offerActive: true, platformAttributes: true },
        })

        // MA.1 — when the operator has paused this market, inject skip_offer=true
        // so Amazon suppresses the buy box without losing the listing data.
        if (existing && existing.offerActive === false) {
          collapsedAttrs.skip_offer = [{ value: true, marketplace_id: marketplaceId }]
        } else if (existing?.offerActive !== false && collapsedAttrs.skip_offer === undefined) {
          // Ensure a previously-paused listing that's now active clears skip_offer.
          collapsedAttrs.skip_offer = [{ value: false, marketplace_id: marketplaceId }]
        }

        const listingPayload: Record<string, any> = {
          channel: 'AMAZON',
          marketplace: mp,
          region: mp,
          channelMarket,
          ...(row.item_name        ? { title: String(row.item_name), followMasterTitle: false }               : {}),
          ...(row.product_description ? { description: String(row.product_description), followMasterDescription: false } : {}),
          ...(bullets.length       ? { bulletPointsOverride: bullets, followMasterBulletPoints: false }       : {}),
          ...(price !== null && !isNaN(price)         ? { price, followMasterPrice: false }      : {}),
          ...(salePrice !== null && !isNaN(salePrice) ? { salePrice }                            : {}),
          // FM Phase 2b — the Follow column owns the follow/pin flag. When the row
          // carries it, write the quantity but DON'T force-pin here: the follow-apply
          // endpoint (POST /api/listings/follow-master-quantity, run right after the
          // save) sets followMasterQuantity + quantityOverride coherently and skips FBA.
          // Legacy rows with no Follow column keep the historical pin-on-qty behavior.
          ...buildFollowQuantityPatch((row as Record<string, unknown>).follow, qty),
          // RR.1 — verbatim flat row (sans internal _ keys) for lossless grid
          // round-trip; structured fields above stay authoritative on read.
          // Normalize parentage_level to canonical 'parent'/'child' before storing
          // so the snapshot is always in a form the feed builder can compare directly.
          flatFileSnapshot: Object.fromEntries(
            Object.entries({ ...row, parentage_level: parentageLevel || String(row.parentage_level ?? '') })
              .filter(([k]) => !k.startsWith('_')),
          ),
          // PA — merge instead of replace: preserve cockpit-only top-level keys
          // (aplus_content, searchTerms, …) while flat-file remains authoritative
          // for `attributes`. resolveBrowseNodeId falls back to the existing node
          // so a node-less sync never wipes it.
          platformAttributes: buildPlatformAttributes(
            (existing as any)?.platformAttributes,
            collapsedAttrs,
            resolveBrowseNodeId(row as Record<string, unknown>, (existing as any)?.platformAttributes),
          ),
          syncStatus: opts.isPublished ? 'SYNCED' : 'PENDING',
          lastSyncedAt: new Date(),
          lastSyncStatus: opts.isPublished ? 'SUCCESS' : null,
          ...(opts.isPublished ? { isPublished: true, listingStatus: 'ACTIVE' } : {}),
          ...((() => {
            // Link the listing to its ASIN: prefer an imported _asin, else the
            // typed Product ID column when it holds an ASIN (a relist). Barcode
            // types (EAN/GTIN/UPC) are left for Amazon/reconciliation to resolve
            // the ASIN from the identifier.
            const asin =
              String(row._asin ?? '').trim() ||
              (String(row.external_product_id_type ?? '').trim().toUpperCase() === 'ASIN'
                ? String(row.external_product_id ?? '').trim()
                : '')
            return asin ? { externalListingId: asin } : {}
          })()),
        }

        if (existing) {
          try {
            // A3 — optimistic concurrency: CAS on the version the grid was pulled
            // at, so a concurrent edit (cockpit / another operator) is rejected
            // here instead of silently clobbering their change.
            const updated = await casUpdateChannelListing(
              this.prisma,
              existing.id,
              row._version != null ? Number(row._version) : undefined,
              listingPayload,
            )
            result.synced++
            // A3 — return the new version so the grid can refresh _version and a
            // legitimate second save (same operator, no re-pull) doesn't conflict.
            if (updated?.version != null) result.versions[sku] = Number(updated.version)
          } catch (e) {
            if (isVersionConflict(e)) {
              result.errors.push({ sku, error: 'Changed elsewhere since you pulled — re-pull this product before saving (version conflict).' })
            } else {
              throw e
            }
          }
        } else {
          await this.prisma.channelListing.create({
            data: { productId: product.id, ...listingPayload } as any,
          })
          result.created++
        }

        // ── Product hierarchy + type + fulfillment method ──────────
        // FBA-flip fix — only (re)derive fulfillment from a row that ACTUALLY carries
        // a fulfillment_channel_code. A BLANK column must NOT be read as 'DEFAULT' →
        // FBM: that silently re-tagged FBA products as merchant-fulfilled, and the
        // stale 'FBM' then flipped the live Amazon offer to FBM on the next quantity
        // push. Blank ⇒ leave Product.fulfillmentMethod untouched.
        const rawFaCode = row['fulfillment_availability__fulfillment_channel_code'] ?? row['fulfillment_channel_code']
        const faCode = String(rawFaCode ?? '').toUpperCase()
        // FFA.3 — any AMAZON_* regional FBA channel (AMAZON_EU/AMAZON_NA/AMAZON_FE)
        // + AFN/FBA = Fulfilled by Amazon; only DEFAULT/MFN is merchant (FBM).
        const derivedMethod = faCode === ''
          ? null
          : (faCode.startsWith('AMAZON') || faCode === 'AFN' || faCode === 'FBA') ? 'FBA' : 'FBM'
        const productUpdates: Record<string, any> = {}
        if (productType && product.productType !== productType) productUpdates.productType = productType
        if (isParentRow && !product.isParent)              productUpdates.isParent = true
        if (isChildRow && parentId && product.parentId !== parentId) productUpdates.parentId = parentId
        if (derivedMethod) productUpdates.fulfillmentMethod = derivedMethod
        if (Object.keys(productUpdates).length) {
          await this.prisma.product.update({ where: { id: product.id }, data: productUpdates })
        }

        // ── ASIN on ProductVariation ────────────────────────────────
        if (row._asin) {
          await this.prisma.productVariation.updateMany({
            where: { productId: product.id },
            data: { amazonAsin: String(row._asin) },
          })
        }

        // FM Phase 1 — StockLevel / Product.totalStock write REMOVED here (see the
        // note above where primaryLocation used to be resolved). A flat-file save
        // must never move the shared warehouse pool; stock is owned by /stock +
        // imports. The per-listing ChannelListing write above is unchanged.
      } catch (err: any) {
        result.errors.push({ sku, error: err?.message ?? 'Sync failed' })
      }
    }))

    return result
  }

  /** Re-collapse expanded flat-file columns into the SP-API attribute structure
   *  that getExistingRows reads back from platformAttributes.attributes. */
  private buildCollapsedAttrs(
    row: FlatFileRow,
    expandedFields: Record<string, string>,
    mp: string,
    marketplaceId: string,
    languageTag: string,
    enumCodeMap: Record<string, Record<string, string>> = {},
    /** UFX P1 (P0-2) — declared type per sub-property path (see buildJsonFeedBody). */
    subPropTypes?: Record<string, SubPropType>,
  ): Record<string, any> {
    const attrs: Record<string, any> = {}
    const wrap  = (v: string) => [{ value: v, marketplace_id: marketplaceId }]
    const wrapL = (v: string) => [{ value: v, language_tag: languageTag, marketplace_id: marketplaceId }]

    if (row.item_name)           attrs.item_name           = wrapL(String(row.item_name))
    if (row.brand)               attrs.brand               = wrapL(String(row.brand))
    if (row.product_description) attrs.product_description = wrapL(String(row.product_description))
    if (row.generic_keyword)     attrs.generic_keyword     = wrapL(String(row.generic_keyword))
    if (row.color)               attrs.color               = wrapL(String(row.color))
    if (row.main_product_image_locator) {
      attrs.main_product_image_locator = [{ media_location: String(row.main_product_image_locator), marketplace_id: marketplaceId }]
    }

    // Bullet points — consolidate numbered variants
    const bulletMap = new Map<number, string>()
    if (row.bullet_point) bulletMap.set(0, String(row.bullet_point))
    for (let i = 1; i <= 5; i++) {
      const b = String(row[`bullet_point_${i}`] ?? '').trim()
      if (b) bulletMap.set(i, b)
    }
    if (bulletMap.size) {
      attrs.bullet_point = [...bulletMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({ value: v, language_tag: languageTag, marketplace_id: marketplaceId }))
    }

    // purchasable_offer — FFA.3: persist when our_price OR sale OR condition is
    // present (was our_price-gated, which dropped condition/currency/sale on a
    // price-less row). our_price/sale only included when actually set.
    const poPrice     = row['purchasable_offer__our_price'] ?? row.purchasable_offer ?? row.standard_price
    const poCondition = String(row['purchasable_offer__condition_type'] ?? '')
    const poSalePrice = row['purchasable_offer__sale_price']
    const poHasPrice  = poPrice !== undefined && poPrice !== ''
    const poHasSale   = poSalePrice !== undefined && poSalePrice !== ''
    if (poHasPrice || poHasSale || poCondition) {
      const poCurrency  = String(row['purchasable_offer__currency'] ?? CURRENCY_MAP[mp] ?? 'EUR')
      const poSaleFrom  = String(row['purchasable_offer__sale_from_date'] ?? '')
      const poSaleTo    = String(row['purchasable_offer__sale_end_date'] ?? '')
      const offer: Record<string, any> = { currency: poCurrency, marketplace_id: marketplaceId }
      if (poHasPrice) offer.our_price = [{ schedule: [{ value_with_tax: Math.max(0, parseLocaleNumber(poPrice) ?? 0) }] }]
      if (poCondition) offer.condition_type = enumCodeMap['purchasable_offer.condition_type']?.[poCondition] ?? poCondition
      if (poHasSale) {
        const sp: Record<string, any> = { schedule: [{ value_with_tax: Math.max(0, parseLocaleNumber(poSalePrice) ?? 0) }] }
        if (poSaleFrom) sp.start_at = [{ value: poSaleFrom, marketplace_id: marketplaceId }]
        if (poSaleTo)   sp.end_at   = [{ value: poSaleTo,   marketplace_id: marketplaceId }]
        offer.sale_price = [sp]
      }
      attrs.purchasable_offer = [offer]
    }

    // fulfillment_availability — FFA.3: persist whenever ANY sub-field is present,
    // not just quantity. FBA listings (channel_code AMAZON_EU/AMAZON_NA) carry no
    // quantity, so the old qty-gate dropped the channel code → it reverted to
    // DEFAULT on every reload. Channel code read from both the expanded + bare key.
    const faCode = String(row['fulfillment_availability__fulfillment_channel_code'] ?? row['fulfillment_channel_code'] ?? '').toUpperCase()
    const faQtyRaw  = row['fulfillment_availability__quantity'] ?? row.fulfillment_availability ?? row.quantity
    const faQtyNum  = faQtyRaw !== undefined && faQtyRaw !== '' ? parseLocaleInt(faQtyRaw) : null
    const faLeadRaw = row['fulfillment_availability__lead_time_to_ship_max_days']
    const faLeadNum = faLeadRaw !== undefined && faLeadRaw !== '' ? parseLocaleInt(faLeadRaw) : null
    if (faCode || faQtyNum !== null || faLeadNum !== null) {
      const fa: Record<string, any> = {
        fulfillment_channel_code: faCode || 'DEFAULT',
        marketplace_id: marketplaceId,
      }
      if (faQtyNum !== null && faQtyNum >= 0) fa.quantity = faQtyNum
      if (faLeadNum !== null && faLeadNum >= 0) fa.lead_time_to_ship_max_days = faLeadNum
      attrs.fulfillment_availability = [fa]
    }

    // Variation structure — normalize via enumCodeMap before comparison
    const parentageLevel = normalizeParentage(String(row.parentage_level ?? ''), enumCodeMap['parentage_level'] ?? {})
    if (parentageLevel === 'parent') {
      attrs.parentage_level = [{ value: 'parent', marketplace_id: marketplaceId }]
      if (row.variation_theme) {
        const vt = String(row.variation_theme)
        // FFP.18 — payload key is `name`, not `value`; FFP.19 — value
        // normalized to the approved enum (see buildJsonFeedBody).
        attrs.variation_theme = [{ name: normalizeVariationTheme(vt, enumCodeMap['variation_theme'] ?? {}), marketplace_id: marketplaceId }]
      }
    }
    if (parentageLevel === 'child' && row.parent_sku) {
      attrs.parentage_level               = [{ value: 'child', marketplace_id: marketplaceId }]
      attrs.child_parent_sku_relationship = [{ parent_sku: String(row.parent_sku), marketplace_id: marketplaceId }]
    }

    // All other expanded columns — same collapse logic as buildJsonFeedBody
    const EXPLICIT = new Set([
      'item_sku', 'product_type', 'record_action',
      'parentage_level', 'parent_sku', 'variation_theme',
      'item_name', 'brand', 'product_description',
      'bullet_point', 'generic_keyword', 'color',
      'main_product_image_locator', 'standard_price',
      'purchasable_offer',
      'purchasable_offer__condition_type', 'purchasable_offer__currency',
      'purchasable_offer__our_price', 'purchasable_offer__sale_price',
      'purchasable_offer__sale_from_date', 'purchasable_offer__sale_end_date',
      'fulfillment_availability',
      'fulfillment_availability__fulfillment_channel_code',
      'fulfillment_availability__quantity',
      'fulfillment_availability__lead_time_to_ship_max_days',
    ])
    const pendingArrays: Record<string, Array<{ idx: number; value: string }>> = {}
    const subPropMap: Record<string, Record<string, any>> = {}

    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith('_') || !v || EXPLICIT.has(k)) continue
      const path = expandedFields[k]
      if (path) {
        if (!path.includes('.')) {
          const idx = parseInt(k.slice(path.length + 1), 10)
          if (!isNaN(idx)) (pendingArrays[path] ??= []).push({ idx, value: String(v) })
        } else {
          // UFX P1 (P0-2) — coerce by DECLARED schema type (twin of the
          // buildJsonFeedBody path): a string-typed all-digits value must
          // round-trip as a string here too, or the persisted attrs diverge
          // from what the feed sends.
          const parts = path.split('.')
          const base  = parts[0]
          const obj   = (subPropMap[base] ??= {})
          const typedV = coerceSubPropValue(path, String(v), subPropTypes)
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

    for (const [base, items] of Object.entries(pendingArrays)) {
      items.sort((a, b) => a.idx - b.idx)
      attrs[base] = items.map((item) => ({ value: item.value, marketplace_id: marketplaceId, language_tag: languageTag }))
    }
    for (const [base, val] of Object.entries(subPropMap)) {
      attrs[base] = [{ ...val, marketplace_id: marketplaceId }]
    }

    return attrs
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
          product_type: productType, record_action: 'partial_update',
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
