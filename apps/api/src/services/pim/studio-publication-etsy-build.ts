/**
 * E1 (Etsy publisher, 2026-10-05) — the Etsy listing Nexus would send, built from the main row's resolved cells and each
 * row's price, stock and variation values. PURE: no database, no Etsy, no clock. `prepareEtsyPublication` gathers the
 * facts; this file turns them into Etsy's own shapes (R1 §1–4, every key as Etsy names it) and names every problem it
 * finds to the collector (`studio-publication-etsy-problems.ts`), so one review lists them all.
 *
 * The listing values have ONE shape for both sides (`EtsyListingValues`): Nexus's here, Etsy's from the live read. Both
 * keep the same rules — strings trimmed, '' read as nothing, ids and measures as numbers — so a field compares equal
 * when the listing is the same, and `etsyValue` decides "has a value" the same way for both.
 */
import type { StudioPublishValue } from '@nexus/shared/studio-publication'
import type { EtsyInventoryWrite, EtsyWriteOffering, EtsyWriteProduct } from '../etsy/inventory.js'
import { etsyListingContentFields } from '../etsy/listing-content.js'
import { etsyListingSchema } from './channel-specs/etsy-listing-schema.js'
import { etsyFieldLabel, type EtsyProblems } from './studio-publication-etsy-problems.js'
import type { EtsyCreateState, EtsyFormKey, EtsyInventoryStructure, EtsyListingForm, EtsyListingValues, EtsyPropertyValue, EtsyTranslation } from './studio-publication-etsy-types.js'

type Cells = Record<string, { value?: unknown; status?: string } | undefined>
type Identity = { productId: string; sku: string }

/** One row as the builder reads it: the main row, or an Etsy product (a family's variation, or the single product). */
export interface EtsyBuildRow {
  productId: string
  /** The SKU Etsy is sent (the listing's own channel SKU when it has one). */
  sku: string
  cells: Cells
  price: number | null
  /** Why `price` is null, in the price rule's words. */
  priceReason?: string
  quantity: number
  /** The row's variation value per axis (`familyKey`), as the channel shows it. */
  axisValues: Record<string, string>
  /** The SKU the sheet shows for this row; a problem names the row by it. Defaults to `sku`. */
  sheetSku?: string
  /** The row is on Etsy already: its price and stock go through the price and stock pushes (D3), so neither is judged here. */
  onEtsy?: boolean
  /** A variation new on a listing already on Etsy, set Inactive: Etsy holds it switched off (`is_enabled: false`). */
  inactive?: boolean
}
export interface EtsyBuildAxis { familyKey: string; label: string; channelName: string; target: string | null; custom: boolean }
export interface EtsyBuildInput {
  owner: EtsyBuildRow
  /** The Etsy inventory rows: a family's variations, or the single product. */
  rows: EtsyBuildRow[]
  axes: EtsyBuildAxis[]
  /** `facts.resolved[0].catalogue.fields`. */
  fields: Array<{ fieldKey: string; label: string; validation?: Record<string, unknown> }>
  /** The main row's cells in each language after the first (`facts.languages[1..]`). */
  translations: Array<{ language: string; cells: Cells }>
  createState: EtsyCreateState | null
  listingId: string | null
  /** The variation check already named a missing value or two variations that look the same: they are not named twice. */
  structureNamed?: boolean
}

/** Etsy's ids for variation properties a seller names (R1 §3: 513, 514, then 516 — E1 takes at most two properties). */
export const ETSY_CUSTOM_PROPERTY_IDS: readonly number[] = [513, 514]
/** Etsy refuses more than 999 for one variation (R1 §3). */
export const ETSY_MAX_QUANTITY = 999
const MAX_PROPERTIES = 2
/** Etsy's product cap per variation property count, with price, stock and SKU on every property (R1 §3: "all" → 400). */
const PRODUCT_CAP: Readonly<Record<number, number>> = { 1: 70, 2: 400 }

const TITLE_MAX = 140, TAGS_MAX = 13, TAG_MAX = 20, STYLES_MAX = 2, STYLE_MAX = 45
const STYLE_WORDS = /^[\p{L}\p{Nd}\p{Zs}]+$/u
/** Today's lists (etsy-listing-schema.ts, read 2026-09-10; `when_made` turns over every year). */
const WHO_MADE: readonly string[] = etsyListingSchema.create.properties.who_made.enum
const WHEN_MADE: readonly string[] = etsyListingSchema.create.properties.when_made.enum

export const ETSY_ZERO_STOCK_NOTE = 'Etsy cannot sell at stock 0: the listing stays a draft; it can go live when you Publish with stock.'
export const ETSY_AUTO_RENEW_NOTE = 'Automatic renewal is on: Etsy renews the listing every 4 months and charges a renewal fee.'
/** Etsy refuses an inventory where any offering has no processing profile (R1 §3, "All offerings need readiness state"). */
export const ETSY_NEEDS_READINESS = 'Processing profile is not set. Etsy needs one for every variation: choose it on the main row (or on each row).'

const characters = (text: string) => [...text].length
const where = (row: Identity | undefined, field?: string) => ({ ...(row ? { productId: row.productId, sku: row.sku } : {}), ...(field ? { field } : {}) })
const named = (row: EtsyBuildRow, field?: string) => where({ productId: row.productId, sku: row.sheetSku ?? row.sku }, field)
/** "A", "A and B", "A, B and C". */
export const andList = (items: readonly string[]) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

// ── Cell readers ──────────────────────────────────────────────────────────────────────────────────────────────────

const scalar = (value: unknown) => Array.isArray(value) ? value[0] : value
/** A text cell, trimmed; '' and anything not text, a number or a yes/no is nothing. */
export function etsyText(value: unknown): string | null {
  const v = scalar(value)
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return null
  const text = String(v).trim()
  return text || null
}
/** A list cell: an array of texts, or one text as a one-item list; trimmed, empty items left out. */
export function etsyList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value == null ? [] : [value]
  return items.flatMap(item => typeof item === 'string' || typeof item === 'number' ? [String(item).trim()] : []).filter(Boolean)
}
function numberOf(value: unknown, key: string, problems: EtsyProblems, at: ReturnType<typeof where>): number | null {
  const v = scalar(value)
  if (v == null || (typeof v === 'string' && !v.trim())) return null
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  if (Number.isFinite(n)) return n
  problems.add(`${etsyFieldLabel(key)} is not a number.`, { ...at, field: key })
  return null
}
function booleanOf(value: unknown, key: string, problems: EtsyProblems, at: ReturnType<typeof where>): boolean | null {
  const v = scalar(value)
  if (typeof v === 'boolean') return v
  const word = etsyText(v)?.toLowerCase()
  if (!word) return null
  if (['true', 'yes', '1'].includes(word)) return true
  if (['false', 'no', '0'].includes(word)) return false
  problems.add(`${etsyFieldLabel(key)} must be Yes or No.`, { ...at, field: key })
  return null
}

/** The listing values of the main row's cells (keys = the Etsy sheet's keys, channel-specs/etsy.ts). Reads only; `etsyListingChecks` judges. */
export function etsyListingValues(cells: Cells, problems: EtsyProblems, owner?: Identity): EtsyListingValues {
  const at = where(owner)
  const raw = (key: string) => cells[key]?.value
  const text = (key: string) => etsyText(raw(key))
  const number = (key: string) => numberOf(raw(key), key, problems, at)
  const flag = (key: string) => booleanOf(raw(key), key, problems, at)
  const weight = number('item_weight')
  const size = { length: number('item_length'), width: number('item_width'), height: number('item_height') }
  const partners = etsyList(raw('production_partner_ids')).map(id => numberOf(id, 'production_partner_ids', problems, at)).filter((id): id is number => id !== null)
  return {
    title: text('title'), description: text('description'), tags: etsyList(raw('tags')), materials: etsyList(raw('materials')), taxonomy_id: number('taxonomy_id'),
    classification: { who_made: text('who_made'), when_made: text('when_made'), is_supply: flag('is_supply') },
    type: text('type'), shop_section_id: number('shop_section_id'), shipping_profile_id: number('shipping_profile_id'), return_policy_id: number('return_policy_id'),
    // A unit means nothing without its value(s), so it is read only beside one.
    item_weight: { value: weight, unit: weight === null ? null : text('item_weight_unit') },
    item_dimensions: { ...size, unit: Object.values(size).every(v => v === null) ? null : text('item_dimensions_unit') },
    is_taxable: flag('is_taxable'), should_auto_renew: flag('should_auto_renew'),
    production_partner_ids: [...new Set(partners)].sort((a, b) => a - b), styles: etsyList(raw('styles')),
  }
}

/**
 * Every check Etsy would refuse the listing values for (E1–E12 of the build spec), and the create-only note W10. `create`:
 * a new listing (its required fields must be filled); an existing listing keeps Etsy's value for a field empty in Nexus.
 */
export function etsyListingChecks(values: EtsyListingValues, options: { create: boolean; owner?: Identity }, problems: EtsyProblems): void {
  const { create } = options
  const at = (field: string) => where(options.owner, field)
  const content = (input: Parameters<typeof etsyListingContentFields>[0], field: string) => problems.attempt(() => etsyListingContentFields(input), at(field))
  if (!values.title) { if (create) problems.add('Title is empty. Fill it in on the main row.', at('title')) }
  else {
    const length = characters(values.title)
    if (length > TITLE_MAX) problems.add(`Title has ${length} characters; Etsy takes at most ${TITLE_MAX}.`, at('title'))
    content({ title: values.title }, 'title')
  }
  if (create && !values.description) problems.add('Description is empty. Fill it in on the main row.', at('description'))
  if (create && values.taxonomy_id === null) problems.add('Category is empty. Choose an Etsy category on the main row.', at('taxonomy_id'))
  // Etsy takes Who made it, When made and Craft supply together (R1 §1): a new listing needs all three; a listing that
  // exists sends all three or none.
  const missing = (['who_made', 'when_made', 'is_supply'] as const).filter(key => values.classification[key] === null)
  if (missing.length && (create || missing.length < 3))
    problems.add(`Etsy takes Who made it, When made and Craft supply together: fill in ${andList(missing.map(etsyFieldLabel))}.`, at(missing[0]))
  const { who_made: who, when_made: when } = values.classification
  if (who && !WHO_MADE.includes(who)) problems.add(`Who made it "${who}" is not one of Etsy's values. Choose it again on the main row.`, at('who_made'))
  if (when && !WHEN_MADE.includes(when)) problems.add(`When made "${when}" is not one of Etsy's values today (Etsy changes them every year). Choose it again on the main row.`, at('when_made'))
  if (values.type && values.type !== 'physical') problems.add(`Listing type "${values.type}": Nexus publishes physical Etsy listings only.`, at('type'))
  if (values.tags.length > TAGS_MAX) problems.add(`Tags: Etsy takes at most ${TAGS_MAX}; this listing has ${values.tags.length}.`, at('tags'))
  for (const tag of values.tags) if (characters(tag) > TAG_MAX) problems.add(`Tag "${tag}" has ${characters(tag)} characters; Etsy takes at most ${TAG_MAX}.`, at('tags'))
  if (values.tags.length) content({ tags: values.tags }, 'tags')
  if (values.materials.length) content({ materials: values.materials }, 'materials')
  // Etsy takes styles only when a listing is created (R1 §2): on a listing that exists they are never sent, so never judged.
  if (create) {
    if (values.styles.length > STYLES_MAX) problems.add(`Styles: Etsy takes at most ${STYLES_MAX}.`, at('styles'))
    for (const style of values.styles) {
      if (characters(style) > STYLE_MAX) problems.add(`Style "${style}" is longer than ${STYLE_MAX} characters.`, at('styles'))
      if (!STYLE_WORDS.test(style)) problems.add(`Style "${style}": use letters, numbers and spaces only.`, at('styles'))
    }
  }
  const { value: weight, unit: weightUnit } = values.item_weight
  if (weight !== null && weight <= 0) problems.add(`${etsyFieldLabel('item_weight')} must be above 0.`, at('item_weight'))
  if (weight !== null && !weightUnit) problems.add(`${etsyFieldLabel('item_weight')} needs a unit (${etsyFieldLabel('item_weight_unit')}).`, at('item_weight_unit'))
  const size = values.item_dimensions
  for (const key of ['length', 'width', 'height'] as const) {
    const value = size[key]
    if (value !== null && value <= 0) problems.add(`${etsyFieldLabel(`item_${key}`)} must be above 0.`, at(`item_${key}`))
  }
  if ((size.length ?? size.width ?? size.height) !== null && !size.unit)
    problems.add(`${etsyFieldLabel('item_dimensions')} needs a unit (${etsyFieldLabel('item_dimensions_unit')}).`, at('item_dimensions_unit'))
  if (create && values.should_auto_renew === true) problems.note(ETSY_AUTO_RENEW_NOTE)
}

/** createDraftListing's form, exactly as sent (R1 §1): only keys with a value. `create` adds the POST's own quantity and price. */
export function etsyCreateForm(values: EtsyListingValues, readiness: number | null, create: { price: number; quantity: number } | null): EtsyListingForm {
  const form: EtsyListingForm = {}
  const put = (key: EtsyFormKey, value: string | number | boolean | Array<string | number> | null) => {
    if (value === null || (Array.isArray(value) && !value.length)) return
    form[key] = Array.isArray(value) ? [...value] : value
  }
  const { classification: kind, item_weight: weight, item_dimensions: size } = values
  // Etsy's seven required keys first (R1 §1), then the rest in the sheet's order.
  if (create) put('quantity', create.quantity)
  put('title', values.title); put('description', values.description)
  if (create) put('price', create.price)
  put('who_made', kind.who_made); put('when_made', kind.when_made); put('taxonomy_id', values.taxonomy_id); put('is_supply', kind.is_supply)
  put('type', values.type); put('tags', values.tags); put('materials', values.materials); put('styles', values.styles)
  put('shop_section_id', values.shop_section_id); put('shipping_profile_id', values.shipping_profile_id); put('return_policy_id', values.return_policy_id)
  put('readiness_state_id', readiness)
  put('item_weight', weight.value); put('item_weight_unit', weight.unit)
  put('item_length', size.length); put('item_width', size.width); put('item_height', size.height); put('item_dimensions_unit', size.unit)
  put('is_taxable', values.is_taxable); put('should_auto_renew', values.should_auto_renew); put('production_partner_ids', values.production_partner_ids)
  return form
}

// ── Properties: variation values and listing attributes ───────────────────────────────────────────────────────────

const propertyIdOf = (target: string | null) => {
  const match = /^property_(\d+)$/.exec(target ?? '')
  return match ? Number(match[1]) : null
}
/** The taxonomy spec labels a variation-only property "Size (100)"; Etsy's name for it is "Size". */
const propertyName = (label: string, id: number) => label.replace(new RegExp(` \\(${id}\\)$`), '').trim() || label

type Choice = { code: string; label: string; scaleId: string | null }
const choicesOf = (field?: { validation?: Record<string, unknown> }): Choice[] => {
  const list = field?.validation?.etsyValues
  return Array.isArray(list) ? list.filter((entry): entry is Choice => !!entry && typeof entry === 'object' && typeof (entry as Choice).code === 'string' && typeof (entry as Choice).label === 'string') : []
}

/**
 * One value as Etsy's taxonomy names it (the catalogue field's `validation.etsyValues`, channel-specs/etsy.ts): the value
 * matches a choice by its code or, ignoring case, its label; Etsy is sent the label and, for a numeric code, its value id.
 * A property with no known choices takes the value as written (`value_ids: []`, R1 §3). Null: not one of Etsy's values.
 */
export function etsyPropertyChoice(value: string, field?: { validation?: Record<string, unknown> }): { value_ids: number[]; values: string[]; scaleId: number | null } | null {
  const choices = choicesOf(field)
  if (!choices.length) return { value_ids: [], values: [value], scaleId: null }
  const folded = value.trim().toLocaleLowerCase()
  const choice = choices.find(c => c.code === value) ?? choices.find(c => c.label.trim().toLocaleLowerCase() === folded)
  if (!choice) return null
  const scale = choice.scaleId != null && /^\d+$/.test(String(choice.scaleId)) ? Number(choice.scaleId) : null
  return { value_ids: /^\d+$/.test(choice.code) ? [Number(choice.code)] : [], values: [choice.label], scaleId: scale }
}

/** A mapped, non-empty value of a cell (a pin or a value map on the Etsy sheet). */
const mappedValue = (cell: { value?: unknown; status?: string } | undefined) => cell?.status === 'mapped' ? etsyText(cell.value) : null

/**
 * Each axis's value for one row: the row's own Etsy property cell when the sheet maps one (`property_<id>`), else the
 * value the family's variation projection gives. Applied before the variation check, so both read the same values.
 */
export function etsyAxisValues(stored: Record<string, string>, axes: ReadonlyArray<{ familyKey: string; target: string | null }>, cells: Cells): Record<string, string> {
  const values = { ...stored }
  for (const axis of axes) {
    const id = propertyIdOf(axis.target)
    const own = id === null ? null : mappedValue(cells[`property_${id}`])
    if (own) values[axis.familyKey] = own
  }
  return values
}

/** A scale cell (`property_<id>__scale_id`) as Etsy's number. */
const scaleOf = (cells: Cells, id: number) => {
  const text = etsyText(cells[`property_${id}__scale_id`]?.value)
  return text && /^\d+$/.test(text) ? Number(text) : null
}
const hasScales = (fields: EtsyBuildInput['fields'], id: number) => fields.some(field => field.fieldKey === `property_${id}__scale_id`)
const scaleLabel = (fields: EtsyBuildInput['fields'], id: number, name: string) => fields.find(field => field.fieldKey === `property_${id}__scale_id`)?.label ?? `${name} scale`

/**
 * The `*_on_property` arrays (R1 §3): with variation properties, every product keeps its own SKU, price and stock (the
 * price and stock pushes write per SKU, etsy/inventory.ts), so those three name every property; the processing profile
 * names them only when the rows' profiles differ. One product: all four empty.
 */
export function etsyOnProperty(propertyIds: readonly number[], readiness: ReadonlyArray<number | null>): Required<Pick<EtsyInventoryWrite, 'price_on_property' | 'quantity_on_property' | 'sku_on_property' | 'readiness_state_on_property'>> {
  const ids = [...propertyIds]
  const sameProfile = new Set(readiness).size <= 1
  return { price_on_property: [...ids], quantity_on_property: [...ids], sku_on_property: [...ids], readiness_state_on_property: sameProfile ? [] : [...ids] }
}

const bySku = <T extends { sku: string }>(a: T, b: T) => a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0
/** Etsy refuses `(` and `)` in a property value (R1 §3). Etsy's own choices are sent as Etsy names them. */
const BRACKETS = /[()]/

/**
 * The price and stock of a row Etsy does not hold yet (a new listing, a new variation, or a row Nexus records on the
 * listing whose SKU Etsy does not hold): what the send would give Etsy, so it is judged like a create (E21, W2).
 */
export function etsyNewRowChecks(row: EtsyBuildRow, problems: EtsyProblems): void {
  if (row.price === null) problems.add(row.priceReason ?? `${etsyFieldLabel('price')}: set a price above 0.`, named(row, 'price'))
  else if (!(row.price > 0)) problems.add(`${etsyFieldLabel('price')}: set a price above 0.`, named(row, 'price'))
  if (row.quantity > ETSY_MAX_QUANTITY) problems.note(`stock ${row.quantity} is sent as ${ETSY_MAX_QUANTITY}, the most Etsy takes for one variation.`, { sku: row.sheetSku ?? row.sku })
}

/**
 * What Etsy holds that Nexus does not, in the review's words (the notes and the `inventory` line's refusal say the same):
 * the inventory PUT is a full replace, so sending the variations would delete them on Etsy.
 */
export function etsyVariationsNexusLacks(live: { inventory: EtsyInventoryStructure; unnamedProducts: number }, structure: EtsyInventoryStructure): string[] {
  const ours = new Set(structure.products.map(product => product.sku))
  const extra = [...new Set(live.inventory.products.map(product => product.sku).filter(sku => sku && !ours.has(sku)))]
  const sentences: string[] = []
  if (extra.length === 1) sentences.push(`Etsy holds variation ${extra[0]} that Nexus does not; sending the variations would delete it on Etsy. Add it to the family in Nexus, or remove it on Etsy first.`)
  else if (extra.length) sentences.push(`Etsy holds variations ${andList(extra)} that Nexus does not; sending the variations would delete them on Etsy. Add them to the family in Nexus, or remove them on Etsy first.`)
  const unnamed = live.unnamedProducts
  if (unnamed === 1) sentences.push('Etsy holds 1 variation without a SKU; sending the variations would delete it on Etsy.')
  else if (unnamed > 1) sentences.push(`Etsy holds ${unnamed} variations without a SKU; sending the variations would delete them on Etsy.`)
  return sentences
}

/**
 * The inventory PUT body Nexus would send (R1 §3: a full replace, every key Etsy takes and no other), the structure the
 * `inventory` change compares, and the property ids used as variations (never repeated as listing attributes).
 */
export function etsyInventory(input: EtsyBuildInput, problems: EtsyProblems): { inventory: EtsyInventoryWrite; structure: EtsyInventoryStructure; axisPropertyIds: number[] } {
  const { fields, rows } = input
  type Property = { axis: EtsyBuildAxis; property_id: number; property_name: string; custom: boolean }
  const properties: Property[] = []
  if (input.axes.length > MAX_PROPERTIES)
    problems.add(`Etsy takes at most ${MAX_PROPERTIES} variation properties; this family has ${input.axes.length} (${andList(input.axes.map(a => a.label || a.channelName))}).`, { field: 'variationTheme' })
  let customs = 0
  for (const axis of input.axes.slice(0, MAX_PROPERTIES)) {
    if (axis.custom) { properties.push({ axis, property_id: ETSY_CUSTOM_PROPERTY_IDS[customs++], property_name: axis.channelName, custom: true }); continue }
    const id = propertyIdOf(axis.target)
    if (id === null) { problems.add(`${axis.label || axis.channelName}: choose an Etsy variation property for it in Variations.`, { field: 'variationTheme' }); continue }
    properties.push({ axis, property_id: id, property_name: propertyName(axis.channelName || axis.label, id), custom: false })
  }
  // Each row's values, as Etsy takes them.
  const products = rows.map(row => {
    const values: Array<{ property: Property; value_ids: number[]; values: string[]; scaleId: number | null }> = []
    for (const property of properties) {
      const value = etsyText(etsyAxisValues(row.axisValues, [{ familyKey: property.axis.familyKey, target: property.custom ? null : `property_${property.property_id}` }], row.cells)[property.axis.familyKey])
      if (!value) {
        if (!input.structureNamed) problems.add(`${property.axis.label || property.property_name} is empty. Fill it in on this row.`, named(row, property.axis.familyKey))
        continue
      }
      const choice = property.custom ? { value_ids: [], values: [value], scaleId: null } : etsyPropertyChoice(value, fields.find(f => f.fieldKey === `property_${property.property_id}`))
      if (!choice) { problems.add(`"${value}" is not one of Etsy's ${property.property_name} values. Choose an Etsy value on this row.`, named(row, property.axis.familyKey)); continue }
      if (!choice.value_ids.length && BRACKETS.test(value)) {
        problems.add(`${property.axis.label || property.property_name} value "${value}": Etsy does not take ( or ) in variation values.`, named(row, property.axis.familyKey))
        continue
      }
      values.push({ property, ...choice })
    }
    return { row, values }
  })
  // One scale per property for the whole listing (Etsy refuses mixed scales since 2026-10-02, R1 §3): the main row's
  // scale cell, else the scale of the first value that has one. A value in another scale is named, never sent.
  const scales = new Map<number, number | null>()
  for (const property of properties) {
    if (property.custom) { scales.set(property.property_id, null); continue }
    const chosen = scaleOf(input.owner.cells, property.property_id)
    const scaled = products.flatMap(p => p.values.filter(v => v.property === property && v.scaleId !== null).map(v => ({ row: p.row, scale: v.scaleId! })))
    const scale = chosen ?? scaled[0]?.scale ?? null
    scales.set(property.property_id, scale)
    if (scale === null && hasScales(fields, property.property_id))
      problems.add(`${property.property_name} needs a scale. Choose "${scaleLabel(fields, property.property_id, property.property_name)}" on the main row.`, where(input.owner, `property_${property.property_id}__scale_id`))
    const outside = scaled.filter(entry => entry.scale !== scale).map(entry => entry.row.sheetSku ?? entry.row.sku)
    if (outside.length && chosen !== null)
      problems.add(`${property.property_name}: ${andList(outside)} ${outside.length === 1 ? 'has a value' : 'have values'} outside the scale chosen on the main row. Etsy takes one scale per property: choose values in that scale.`, { field: 'variationTheme' })
    else if (outside.length)
      problems.add(`${property.property_name}: the values of ${andList(scaled.map(entry => entry.row.sheetSku ?? entry.row.sku))} are in different scales. Etsy takes one scale per property: choose values in one scale.`, { field: 'variationTheme' })
  }
  // Two products with the same values are one variation to Etsy.
  if (properties.length && !input.structureNamed) {
    const seen = new Map<string, EtsyBuildRow>()
    for (const { row, values } of products) {
      if (values.length !== properties.length) continue
      const key = JSON.stringify(values.map(v => v.values.map(text => text.toLocaleLowerCase())))
      const first = seen.get(key)
      if (first) problems.add(`${first.sku} and ${row.sku} have the same variation values; each Etsy variation must differ.`, named(row, 'variationTheme'))
      else seen.set(key, row)
    }
  }
  if (!properties.length && rows.length > 1 && input.axes.length === 0)
    problems.add(`This family has ${rows.length} variations but no Etsy variation property. Set one in Variations.`, { field: 'variationTheme' })
  const cap = PRODUCT_CAP[properties.length]
  if (cap !== undefined && rows.length > cap) problems.add(`Etsy takes at most ${cap} variations here; this listing has ${rows.length}.`, { field: 'variationTheme' })
  // The processing profile: the row's own, else the main row's (`readiness_state_id`, "Processing profile").
  const ownerReadiness = numberOf(input.owner.cells.readiness_state_id?.value, 'readiness_state_id', problems, where(input.owner))
  const readinessOf = (row: EtsyBuildRow) => row === input.owner ? ownerReadiness
    : numberOf(row.cells.readiness_state_id?.value, 'readiness_state_id', problems, named(row)) ?? ownerReadiness
  // Price and stock of a row not on Etsy yet (a new listing, a new variation): what the create sends. A row on Etsy is
  // sent with Etsy's own offering (D3); its Nexus offering here is never sent (`etsyPublicationRequest`).
  const sent = products.map(({ row, values }) => {
    if (!row.onEtsy) etsyNewRowChecks(row, problems)
    const offering: EtsyWriteOffering = { price: row.price ?? 0, quantity: Math.min(Math.max(0, Math.trunc(row.quantity) || 0), ETSY_MAX_QUANTITY),
      is_enabled: !row.inactive, readiness_state_id: readinessOf(row) }
    const propertyValues = values.map(v => ({ property_id: v.property.property_id, property_name: v.property.property_name, value_ids: [...v.value_ids], values: [...v.values], scale_id: scales.get(v.property.property_id) ?? null }))
    return { sku: row.sku, offering, propertyValues }
  }).sort(bySku)
  const ids = properties.map(p => p.property_id)
  const inventory: EtsyInventoryWrite = {
    products: sent.map((p): EtsyWriteProduct => ({ sku: p.sku, ...(ids.length ? { property_values: p.propertyValues } : {}), offerings: [p.offering] })),
    ...etsyOnProperty(ids, sent.map(p => p.offering.readiness_state_id ?? null)),
  }
  const structure: EtsyInventoryStructure = {
    properties: properties.map(p => ({ property_id: p.property_id, property_name: p.property_name, scale_id: scales.get(p.property_id) ?? null })),
    products: sent.map(p => ({ sku: p.sku, values: p.propertyValues.map(v => ({ property_id: v.property_id, values: [...v.values] })), readiness_state_id: p.offering.readiness_state_id ?? null })),
  }
  return { inventory, structure, axisPropertyIds: ids }
}

/** The listing attributes (updateListingProperty, R1 §4): every catalogue property with a value on the main row, except those used as variations. */
export function etsyListingProperties(cells: Cells, fields: EtsyBuildInput['fields'], axisPropertyIds: readonly number[], problems: EtsyProblems, owner?: Identity): EtsyPropertyValue[] {
  const properties: EtsyPropertyValue[] = []
  for (const field of fields) {
    const id = propertyIdOf(field.fieldKey)
    if (id === null || axisPropertyIds.includes(id)) continue
    const written = etsyList(cells[field.fieldKey]?.value)
    if (!written.length) continue
    const name = propertyName(field.label, id)
    const value_ids: number[] = [], values: string[] = []
    const chosen = scaleOf(cells, id), valueScales = new Set<number>()
    for (const value of written) {
      const choice = etsyPropertyChoice(value, field)
      if (!choice) { problems.add(`"${value}" is not one of Etsy's ${name} values. Choose an Etsy value on this row.`, where(owner, field.fieldKey)); continue }
      if (!choice.value_ids.length && BRACKETS.test(value)) { problems.add(`${name} value "${value}": Etsy does not take ( or ) in property values.`, where(owner, field.fieldKey)); continue }
      for (const valueId of choice.value_ids) if (!value_ids.includes(valueId)) value_ids.push(valueId)
      for (const text of choice.values) if (!values.includes(text)) values.push(text)
      if (choice.scaleId !== null) valueScales.add(choice.scaleId)
    }
    const scale = chosen ?? [...valueScales][0] ?? null
    if (scale === null && hasScales(fields, id)) problems.add(`${name} needs a scale. Choose "${scaleLabel(fields, id, name)}" on the main row.`, where(owner, `property_${id}__scale_id`))
    if ([...valueScales].some(entry => entry !== scale))
      problems.add(`${name}: the values are in more than one scale${chosen !== null ? ', or outside the scale chosen on the main row' : ''}. Etsy takes one scale per property: choose values in one scale.`, where(owner, field.fieldKey))
    if (values.length) properties.push({ property_id: id, property_name: name, value_ids, values, scale_id: scale })
  }
  return properties.sort((a, b) => a.property_id - b.property_id)
}

/** The translations Etsy is sent (R1 §6: title and description required, tags optional), one per language after the first. */
export function etsyTranslations(input: Pick<EtsyBuildInput, 'translations'>, problems: EtsyProblems): EtsyTranslation[] {
  return input.translations.flatMap(({ language, cells }) => {
    const title = etsyText(cells.title?.value), description = etsyText(cells.description?.value)
    if (!title || !description) { problems.note(`${language} translation: Etsy needs a title and a description, so it is not sent.`); return [] }
    return [{ language, title, description, tags: etsyList(cells.tags?.value) }]
  })
}

/**
 * createDraftListing's own price and quantity (R1 §1: both "positive non-zero"): the lowest row price above 0, and the
 * rows' stock (at least 1, at most 999). The inventory PUT that follows sets each variation's own; at stock 0 the
 * listing waits as a draft (Owner D2), and the review says so.
 */
export function etsyCreateNumbers(rows: readonly EtsyBuildRow[], problems: EtsyProblems): { price: number; quantity: number } {
  const prices = rows.map(row => row.price).filter((price): price is number => price !== null && price > 0)
  const total = rows.reduce((sum, row) => sum + Math.max(0, Math.trunc(row.quantity) || 0), 0)
  if (total === 0) problems.note(ETSY_ZERO_STOCK_NOTE)
  return { price: prices.length ? Math.min(...prices) : 0, quantity: Math.min(ETSY_MAX_QUANTITY, Math.max(1, total)) }
}

/** Keys that name a line rather than hold its value: a translation is empty without its texts, a property without its values. */
const IDENTITY_KEYS: ReadonlyArray<readonly [string, ReadonlySet<string>]> = [
  ['translation:', new Set(['language'])], ['property:', new Set(['property_id', 'property_name', 'value_ids', 'scale_id'])],
]
const empty = (value: unknown) => value == null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length)

/**
 * One change line's value, the same way for Nexus and for Etsy: nothing (null, '', [], or an object whose every value is
 * nothing) is `absent`; anything else is the value. `field` names the line, so a translation or a property counts as
 * empty when only its identity is left.
 */
export function etsyValue(field: string, raw: unknown): StudioPublishValue {
  if (empty(raw)) return { state: 'absent' }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const identity = IDENTITY_KEYS.find(([prefix]) => field.startsWith(prefix))?.[1]
    if (Object.entries(raw).every(([key, value]) => identity?.has(key) || empty(value))) return { state: 'absent' }
  }
  return { state: 'value', value: raw }
}

/** Everything one build produces, in one call (what `prepareEtsyPublication` stores). */
export function buildEtsyListing(input: EtsyBuildInput, problems: EtsyProblems) {
  const owner = { productId: input.owner.productId, sku: input.owner.sheetSku ?? input.owner.sku }
  const create = input.listingId === null
  const values = etsyListingValues(input.owner.cells, problems, owner)
  etsyListingChecks(values, { create, owner }, problems)
  const { inventory, structure, axisPropertyIds } = etsyInventory(input, problems)
  // A create sends the inventory, and Etsy refuses it when any variation has no processing profile (M1). A listing that
  // exists keeps Etsy's profile for a row empty in Nexus; its `inventory` line says what is still missing.
  if (create && structure.products.some(product => product.readiness_state_id === null)) problems.add(ETSY_NEEDS_READINESS, where(owner, 'readiness_state_id'))
  const properties = etsyListingProperties(input.owner.cells, input.fields, axisPropertyIds, problems, owner)
  const translations = etsyTranslations(input, problems)
  const numbers = create ? etsyCreateNumbers(input.rows, problems) : null
  // The draft's own processing profile: the main row's, else the one every row shares (a NaN cell is already named).
  const own = Number(etsyText(input.owner.cells.readiness_state_id?.value) ?? NaN)
  const shared = [...new Set(structure.products.map(product => product.readiness_state_id))]
  const readiness = Number.isFinite(own) ? own : shared.length === 1 ? shared[0] : null
  const state: EtsyCreateState = input.createState ?? 'draft'
  return { values, inventory, structure, properties, translations, form: etsyCreateForm(values, readiness, numbers), create: numbers ? { state, ...numbers } : null }
}
