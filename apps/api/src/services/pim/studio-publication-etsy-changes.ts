/**
 * E1/E2 (Etsy publisher, 2026-10-05) — the Etsy change plan: one line per listing field, attribute, translation and the
 * variation set, compared with the live Etsy listing and the last accepted publish (`planPublicationChanges`), and the
 * exact calls a send would make (`etsyPublicationRequest`). PURE: the live listing was read by `prepareEtsyPublication`.
 *
 * A new listing is ONE line: its value is the whole request, so the review shows exactly what Publish would send. A
 * listing that exists is reviewed field by field; a field empty in Nexus is never cleared on Etsy by a tick (Etsy keeps
 * its value), and Nexus never sends a price or a stock number from here (D3: the price and stock pushes do).
 *
 * E2 — a listing Etsy already holds is sent (`studio-publication-etsy-send.ts`): the calls go in task order (the listing
 * PATCH, each attribute, each translation, the inventory PUT last), each naming the change fields it writes. The inventory
 * body is built again at send from Etsy's FRESH inventory (`etsyInventoryReplaceBody`: Etsy's own price, stock and on/off
 * for every variation it holds), and the read-back is judged here too (`etsyReadBackMismatches`). Full update (the main
 * row's Action) sends every line Nexus can send and removes what only Etsy holds where Etsy has a delete for it.
 */
import { FULL_NEEDS_LIVE_READ, fullUpdateChange, type StudioPublishChange, type StudioPublishFieldWrite, type StudioPublishIssue, type StudioPublishRemoval,
  type StudioPublishValue } from '@nexus/shared/studio-publication'
import type { EtsyInventoryWrite, EtsyWriteOffering, EtsyWriteProduct } from '../etsy/inventory.js'
import type { PublicationFacts } from './studio-publication-plan.js'
import { planPublicationChanges, publicationChangeId, publicationReplaces, selectPublicationChanges, type PublicationChangeInput } from './studio-publication-changes.js'
import { andList, etsyFitReadiness, etsyKeptRules, etsyOnProperty, etsyOwnRules, etsyRuleConflicts, etsySameRule, etsyValue, etsyVariationsNexusLacks, ETSY_NEEDS_READINESS,
  ETSY_RULE_KEYS, type EtsyRuleProduct } from './studio-publication-etsy-build.js'
import { etsyFieldLabel } from './studio-publication-etsy-problems.js'
import { ETSY_KEPT_AT_SEND, ETSY_LISTING_FIELDS, type EtsyCall, type EtsyChangePlan, type EtsyCompiled, type EtsyInventoryStructure, type EtsyListingField,
  type EtsyListingValues, type EtsyLiveListing, type EtsyPropertyValue, type EtsyPublication, type EtsyTranslation, type EtsyWireRequest } from './studio-publication-etsy-types.js'

const unknown = (reason: string): StudioPublishValue => ({ state: 'unknown', reason })

export const ETSY_EMPTY_KEPT = 'Empty in Nexus; Etsy keeps its value.'
export const ETSY_STYLES_CREATE_ONLY = 'Etsy takes styles only when a listing is created; Nexus cannot change them on a listing that exists.'
export const ETSY_LIVE_READ_NEEDED = 'A successful live Etsy read is required before sending changes.'
/** A send must read back what it wrote, and Etsy's read never reports production partners (live-read/etsy.ts `unread`). */
export const ETSY_PARTNERS_CREATE_ONLY = 'Etsy does not report production partners, so Nexus could not confirm a change; it sends them only when it creates a listing.'
/** The inventory PUT is a full replace, and on any of them Etsy blanks a domestic price (etsy/inventory.ts, trap 3). */
/** E2 review R2-n1 — why a Full update leaves an unchanged variations line unticked. */
export const ETSY_FULL_KEEPS_VARIATIONS = 'Full update does not send unchanged variations again: each send replaces Etsy\'s whole inventory.'
/** E2 review R2-n3 — the one rule Nexus may change on a listing that exists (no price or stock rides on it). */
export const ETSY_READINESS_RULE_CHANGE = 'The variations\' processing profiles differ, and this Etsy listing shares one: Publish lets the processing profile vary by variation on Etsy. Prices and stock do not change.'
export const ETSY_INVENTORY_REPLACE_NOTE = 'Sending the variations replaces Etsy\'s whole inventory. On a shop that uses Etsy\'s domestic pricing, Etsy then clears the domestic price (an Etsy fault Nexus cannot see); check it on Etsy after the publish.'
const TRANSLATIONS_UNREAD = 'Etsy\'s translations could not be read.'
/** Etsy's ids for variation properties a seller names (R1 §3): their name is the seller's, so it is compared too. */
const CUSTOM_PROPERTY_IDS: ReadonlySet<number> = new Set([513, 514, 516])

// ── Comparing Nexus and Etsy (the provider's own equality; `planPublicationChanges` keeps the raw values) ────────────

const fold = (text: unknown) => String(text ?? '').trim().toLocaleLowerCase()
const foldedSet = (list: unknown) => [...new Set((Array.isArray(list) ? list : []).map(fold))].sort()
const sameSet = (a: unknown, b: unknown) => JSON.stringify(foldedSet(a)) === JSON.stringify(foldedSet(b))
/** Etsy may store a description with Windows line ends and trailing space. */
const plain = (text: unknown) => String(text ?? '').replace(/\r\n/g, '\n').trim()
const propertyKey = (value: Partial<EtsyPropertyValue>) => JSON.stringify([foldedSet(value.values), value.scale_id ?? null])
/**
 * The variation set, by values text (case ignored, sorted) and scale, never by `value_ids` (Etsy renumbers them, R1 §3),
 * and the four `*_on_property` rules (ids ascending; a rule not stated is `[]`, as the live read gives it).
 */
const structureKey = (value: EtsyInventoryStructure) => JSON.stringify({
  properties: [...(value.properties ?? [])].sort((a, b) => a.property_id - b.property_id)
    .map(p => [p.property_id, p.scale_id ?? null, CUSTOM_PROPERTY_IDS.has(p.property_id) ? fold(p.property_name) : null]),
  products: [...(value.products ?? [])].sort((a, b) => a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0)
    .map(p => [p.sku, [...p.values].sort((a, b) => a.property_id - b.property_id).map(v => [v.property_id, foldedSet(v.values)]), p.readiness_state_id ?? null]),
  rules: ETSY_RULE_KEYS.map(key => [...new Set(value[key] ?? [])].sort((a, b) => a - b)),
})
const translationKey = (value: Partial<EtsyTranslation>) => JSON.stringify([String(value.title ?? '').trim(), plain(value.description), foldedSet(value.tags)])
/** JSON with object keys sorted: exact equality whatever order the keys were written in. */
const canonical = (value: unknown) => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)
/** A language by its primary subtag, lower case: "en-US" and "EN" are "en" (the review's own rule, studio-publication-etsy.ts). */
const language = (code: string | null | undefined) => (code ?? '').trim().toLowerCase().split(/[-_]/)[0]
const sameLanguage = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Etsy's own equality for a field, or undefined for exact equality (`planPublicationChanges`). Only two values compare. */
export function etsySame(field: string, a: StudioPublishValue, b: StudioPublishValue): boolean | undefined {
  if (a.state !== 'value' || b.state !== 'value') return undefined
  if (field === 'tags' || field === 'materials' || field === 'styles') return sameSet(a.value, b.value)
  if (field === 'description') return plain(a.value) === plain(b.value)
  if (field.startsWith('property:')) return propertyKey(a.value as EtsyPropertyValue) === propertyKey(b.value as EtsyPropertyValue)
  if (field === 'inventory') return structureKey(a.value as EtsyInventoryStructure) === structureKey(b.value as EtsyInventoryStructure)
  if (field.startsWith('translation:')) return translationKey(a.value as EtsyTranslation) === translationKey(b.value as EtsyTranslation)
  return undefined
}

/** A grouped value in a few words for a DIFFERS warning (the default words would list every id and key). */
function etsyWords(field: string, value: StudioPublishValue): string | null {
  if (value.state !== 'value') return null
  const v = value.value as Record<string, any>
  if (field.startsWith('property:')) return (v.values ?? []).join(', ') || 'empty'
  if (field.startsWith('translation:')) return v.title ?? 'empty'
  if (field === 'item_weight') return [v.value, v.unit].filter(part => part != null).join(' ') || 'empty'
  if (field === 'item_dimensions') return `${[v.length, v.width, v.height].map(part => part ?? '?').join(' × ')}${v.unit ? ` ${v.unit}` : ''}`
  if (field === 'inventory') {
    const products = (v.products ?? []).length, names = (v.properties ?? []).map((p: { property_name: string }) => p.property_name)
    return `${products} ${products === 1 ? 'variation' : 'variations'}${names.length ? ` by ${names.join(' and ')}` : ''}`
  }
  return null
}
const WORDED = (field: string) => field.startsWith('property:') || field.startsWith('translation:') || ['item_weight', 'item_dimensions', 'inventory'].includes(field)

// ── The plan ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every line Nexus holds for this listing, as its change value (the create's field writes, and an update's `current`). */
function nexusLines(publication: EtsyPublication) {
  return [
    ...ETSY_LISTING_FIELDS.map(field => ({ field: field as string, label: etsyFieldLabel(field), value: etsyValue(field, publication.values[field]) })),
    ...publication.properties.map(property => ({ field: `property:${property.property_id}`, label: property.property_name, value: etsyValue(`property:${property.property_id}`, property) })),
    ...publication.translations.map(translation => ({ field: `translation:${translation.language}`, label: `Translation (${translation.language})`, value: etsyValue(`translation:${translation.language}`, translation) })),
    { field: 'inventory', label: etsyFieldLabel('inventory'), value: etsyValue('inventory', publication.structure) },
  ]
}

export interface EtsyChangeOptions {
  /**
   * Full update (the main row's Action, eBay Trading's rule): every line Nexus can send is ticked and locked, an attribute
   * only Etsy holds is removed, and so is every variation Etsy holds that Nexus does not (each listed in `removals`).
   * Listing fields empty in Nexus stay as Etsy holds them (a clear is a later step), and so does what Etsy cannot change.
   */
  full?: boolean
}

/**
 * The change plan of one Etsy publication. `facts` is the adapters' shared argument; the publication already carries
 * every identity Etsy needs (`products`, `ownerProductId`).
 */
export function prepareEtsyChanges(_facts: PublicationFacts, publication: EtsyPublication, baselineValues: Map<string, StudioPublishValue>,
  options: EtsyChangeOptions = {}): EtsyChangePlan {
  const owner = publication.products.find(product => product.productId === publication.ownerProductId) ?? publication.products[0]
  if (!owner) throw new Error('No included Etsy product can own this listing publication.')
  const lines = nexusLines(publication)
  const createWrites: Record<string, StudioPublishFieldWrite[]> = {}
  for (const line of lines) if (line.value.state === 'value') (createWrites[owner.productId] ??= []).push({ field: line.field, value: line.value })
  const base = { kind: 'etsy-changes' as const, publication, products: publication.products, ownerProductId: owner.productId, createWrites }
  if (!publication.listingId) {
    const label = publication.create?.state === 'active' ? 'Create Etsy listing' : 'Create Etsy listing (draft)'
    const changes = planPublicationChanges([{ ...owner, field: '__create__', label, current: etsyValue('__create__', etsyPublicationRequest(publication, 'all')),
      lastAccepted: unknown('No listing exists.'), channel: { state: 'absent' }, newListing: true }], { channel: 'Etsy' })
    return { ...base, changes, remoteRevision: 'new' }
  }
  const live = publication.live
  // Without the read (sending is off, or Etsy did not answer) nothing can be compared, so nothing is selectable.
  const unread = publication.liveSkipped ?? publication.liveReadError ?? 'The current Etsy listing could not be read.'
  const full = !!options.full
  const fullIssues: StudioPublishIssue[] = []
  const blockFull = (message: string) => fullIssues.push({ productId: owner.productId, sku: owner.sku, severity: 'error', message: `${owner.sku}: ${message}` })
  if (full && !live) blockFull(FULL_NEEDS_LIVE_READ('Etsy', unread))
  const inputs: PublicationChangeInput[] = []
  const add = (field: string, label: string, nexus: StudioPublishValue, held: StudioPublishValue, refusal?: string, removable = false) => {
    // A field empty in Nexus is not a clear: Etsy keeps its value (a real clear is a later step). A Full update removes
    // an attribute only Etsy holds (`removable`): Etsy has a delete for it.
    const current = nexus.state === 'absent' && !removable ? unknown(ETSY_EMPTY_KEPT) : nexus
    const channel = live ? held : unknown(unread)
    const lastAccepted = baselineValues.get(publicationChangeId(owner.productId, field)) ?? unknown('No accepted publish record for this field.')
    inputs.push({ ...owner, field, label, current, lastAccepted, channel,
      currentMatchesChannel: etsySame(field, current, channel), acceptedMatchesChannel: etsySame(field, lastAccepted, channel),
      ...(!live ? { refusal: unread } : refusal ? { refusal } : {}) })
  }
  const byField = new Map(lines.map(line => [line.field, line]))
  for (const field of ETSY_LISTING_FIELDS) {
    const why = live?.unread[field]
    add(field, etsyFieldLabel(field), byField.get(field)!.value, why ? unknown(why) : etsyValue(field, live?.values[field]),
      field === 'styles' ? ETSY_STYLES_CREATE_ONLY : field === 'production_partner_ids' ? ETSY_PARTNERS_CREATE_ONLY : undefined)
  }
  // Attributes: Nexus's and Etsy's, except properties used as variations (they live in the inventory, R1 §4).
  const variationIds = new Set([...publication.structure.properties, ...(live?.inventory.properties ?? [])].map(property => property.property_id))
  const liveProperties = (live?.properties ?? []).filter(property => !variationIds.has(property.property_id))
  const propertyIds = [...new Set([...publication.properties, ...liveProperties].map(property => property.property_id))].sort((a, b) => a - b)
  for (const id of propertyIds) {
    const ours = publication.properties.find(property => property.property_id === id), theirs = liveProperties.find(property => property.property_id === id)
    const field = `property:${id}`
    add(field, ours?.property_name ?? theirs?.property_name ?? `Property ${id}`, etsyValue(field, ours ?? null), etsyValue(field, theirs ?? null), undefined, full)
  }
  for (const translation of publication.translations) {
    const field = `translation:${translation.language}`
    const held = live?.translations?.find(entry => sameLanguage(entry.language, translation.language))
    add(field, `Translation (${translation.language})`, byField.get(field)!.value, live?.translations === null ? unknown(TRANSLATIONS_UNREAD) : etsyValue(field, held ?? null))
  }
  // The variation set is a full replace (R1 §3): it is never sent while a variation lacks a processing profile (Etsy
  // refuses the PUT, M1; Etsy's own profile already stands in for one empty in Nexus), while a new variation would send
  // stock Etsy's sales do not reach (order import, Owner 2026-10-01), or — in a Partial update — while Etsy holds
  // variations Nexus does not (the send would delete them, m3). A Full update removes those, and lists them.
  const noProfile = publication.structure.products.filter(product => product.readiness_state_id === null).map(product => product.sku)
  // E2 review B1 — the listing's own price, stock, SKU and processing-profile rules are kept; a variation whose values
  // would break one is refused by name (Nexus never changes a rule, and never multiplies a shared stock number).
  const ruleCheck = live ? etsyRuleCheck(publication, live) : { refusals: [], widened: false }
  const ruleRefusals = ruleCheck.refusals
  const blocking = live ? [
    ...(noProfile.length ? [`${ETSY_NEEDS_READINESS} ${andList(noProfile)} ${noProfile.length === 1 ? 'has' : 'have'} no processing profile.`] : []),
    ...(publication.newVariationStockRefusal ? [publication.newVariationStockRefusal] : []),
    ...ruleRefusals,
  ] : []
  if (full) for (const reason of blocking) blockFull(`Full update cannot be sent: ${reason}`)
  // A Partial update says them too: the variations line is unticked, and this is why.
  else for (const reason of ruleRefusals) fullIssues.push({ severity: 'warning', field: 'inventory', message: reason })
  const inventoryRefusals = [...blocking, ...(live && !full ? etsyVariationsNexusLacks(live, publication.structure) : [])]
  add('inventory', etsyFieldLabel('inventory'), byField.get('inventory')!.value, etsyValue('inventory', live?.inventory ?? null), inventoryRefusals.join(' ') || undefined)
  // A DIFFERS warning names a grouped value in a few words, not every id and key it holds.
  let changes: StudioPublishChange[] = planPublicationChanges(inputs, { channel: 'Etsy' }).map(change => change.replaces && WORDED(change.field)
    ? { ...change, replaces: publicationReplaces(change, 'Etsy', { channel: etsyWords(change.field, change.channel), nexus: etsyWords(change.field, change.current) }) } : change)
  const removals: StudioPublishRemoval[] = []
  if (full) {
    // Every line Nexus can send is ticked and locked; a line it cannot send stays as Etsy holds it (named once, below),
    // unless neither side holds anything there or it already matches. The variations are never sent again unchanged:
    // every inventory PUT is a full replace, and on a shop with domestic pricing Etsy blanks that price on each one.
    const kept: string[] = []
    changes = changes.map((change, index) => {
      const sendable = inputs[index].refusal === undefined && change.current.state !== 'unknown' && change.channel.state !== 'unknown'
        && !(change.current.state === 'absent' && change.channel.state === 'absent') && !(change.field === 'inventory' && change.status === 'SAME')
      if (sendable) return fullUpdateChange(change)
      if (change.field === 'inventory' && change.status === 'SAME' && inputs[index].refusal === undefined) return { ...change, reason: ETSY_FULL_KEEPS_VARIATIONS }
      if (live && change.status !== 'SAME' && !(change.channel.state === 'absent' && change.current.state !== 'value')) kept.push(change.label)
      return change
    })
    for (const change of changes) if (change.locked && change.current.state === 'absent' && change.channel.state === 'value')
      removals.push({ productId: change.productId, sku: change.sku, field: change.field, label: change.label, value: change.channel.value })
    if (live && changes.some(change => change.field === 'inventory' && change.locked)) {
      const ours = new Set(publication.structure.products.map(product => product.sku))
      const extra = new Map<string, EtsyInventoryStructure['products'][number]>()
      for (const product of live.inventory.products) if (product.sku && !ours.has(product.sku) && !extra.has(product.sku)) extra.set(product.sku, product)
      for (const [sku, product] of extra) removals.push({ productId: owner.productId, sku, field: 'variation', label: 'Variation removed from the listing', value: product.values })
      const unnamed = live.unnamedProducts
      if (unnamed) removals.push({ productId: owner.productId, sku: '', field: 'variation', label: `${unnamed} ${unnamed === 1 ? 'variation' : 'variations'} without a SKU removed`, value: unnamed })
    }
    const warn = (message: string) => fullIssues.push({ productId: owner.productId, sku: owner.sku, severity: 'warning', message })
    if (kept.length) warn(`${owner.sku}: Full update leaves ${kept.length === 1 ? 'this field' : `these ${kept.length} fields`} as Etsy holds ${kept.length === 1 ? 'it' : 'them'}: ${kept.join(', ')}.`)
    // Etsy has no delete for a translation (R1 §6): one Nexus does not hold stays on Etsy. The listing's own language is
    // its main text, not a translation.
    if (live?.translations) {
      const ours = new Set(publication.translations.map(translation => language(translation.language)))
      const own = new Set([live.language, live.shop.languages[0]].filter((code): code is string => !!code).map(language))
      for (const translation of live.translations) if (!ours.has(language(translation.language)) && !own.has(language(translation.language)))
        warn(`${translation.language}: Etsy keeps its translation (Etsy has no delete for translations).`)
    }
  }
  // Whenever the variations can be sent, the review says what a full replace does on Etsy, and when it widens the
  // processing-profile rule (R2-n3), says that too.
  if (changes.some(change => change.field === 'inventory' && change.selectable)) {
    fullIssues.push({ severity: 'warning', field: 'inventory', message: ETSY_INVENTORY_REPLACE_NOTE })
    if (ruleCheck.widened) fullIssues.push({ severity: 'warning', field: 'inventory', message: ETSY_READINESS_RULE_CHANGE })
  }
  return { ...base, changes, remoteRevision: live?.revision ?? 'unavailable', ...(full ? { full: true as const } : {}),
    ...(removals.length ? { removals } : {}), ...(fullIssues.length ? { fullIssues } : {}) }
}

/**
 * The publication a selection sends: the whole create, or the selected fields of a listing that exists. PURE.
 *
 * An update journals its main row, plus every variation when the variations are sent (their journals carry no field
 * writes). Its `live` is dropped: the send reads Etsy again, so a stored read never decides a write, and Etsy's stock
 * (which moves on every sale) is not part of the selection's digest.
 */
export function compileEtsyChanges(plan: EtsyChangePlan, selectedIds: string[]): EtsyCompiled {
  const selected = selectPublicationChanges(plan.changes, selectedIds)
  const publication = plan.publication
  const nothingRemoved = { removeSkus: [], removeUnnamed: false, addedSkus: [] }
  if (!selected.length) return { ...publication, products: [], fieldWrites: {}, request: null, ...nothingRemoved }
  if (!publication.listingId) return { ...publication, products: plan.products, fieldWrites: plan.createWrites, request: etsyPublicationRequest(publication, 'all'), ...nothingRemoved }
  const live = publication.live
  if (!live || !publication.liveRevision) throw new Error(ETSY_LIVE_READ_NEEDED)
  const fieldWrites: Record<string, StudioPublishFieldWrite[]> = {}
  for (const change of selected) {
    if (change.current.state === 'unknown') throw new Error('An unknown value cannot be sent to Etsy.')
    ;(fieldWrites[change.productId] ??= []).push({ field: change.field, value: change.current })
  }
  const fields = new Set(selected.map(change => change.field))
  const inventory = fields.has('inventory')
  // A Full update's variation removals: what the inventory PUT may drop (the send refuses anything else Etsy holds).
  const removed = inventory ? (plan.removals ?? []).filter(removal => removal.field === 'variation') : []
  const removeSkus = [...new Set(removed.map(removal => removal.sku).filter(Boolean))]
  const removeUnnamed = removed.some(removal => !removal.sku)
  const addedSkus = inventory ? publication.inventory.products.map(product => product.sku ?? '').filter(sku => !live.offerings[sku]) : []
  const owner = plan.products.find(product => product.productId === plan.ownerProductId) ?? plan.products[0]
  const products = [owner, ...(inventory ? publication.inventoryProducts : [])].filter((product, index, all) => all.findIndex(other => other.productId === product.productId) === index)
  const request = etsyPublicationRequest(publication, fields, { skus: removeSkus, unnamed: removeUnnamed ? live.unnamedProducts : 0 })
  return { ...publication, live: null, products, fieldWrites, request, removeSkus, removeUnnamed, addedSkus }
}

/**
 * What the review's revision digests for an Etsy plan (instead of the plan itself): Etsy's offerings reduced to their
 * processing profile, and `sold_out` read as `active`. A sale or a stock push between the review and Publish then never
 * forces a new review; everything a send depends on is still in it (`live.revision` already leaves stock out).
 */
export function etsyRevisionView(plan: EtsyChangePlan): unknown {
  const live = plan.publication.live
  if (!live) return plan
  const offerings = Object.fromEntries(Object.entries(live.offerings).map(([sku, offering]) => [sku, { readiness_state_id: offering.readiness_state_id ?? null }]))
  return { ...plan, publication: { ...plan.publication, live: { ...live, state: live.state === 'sold_out' ? 'active' : live.state, offerings } } }
}

// ── The request ───────────────────────────────────────────────────────────────────────────────────────────────────

const propertyBody = (property: EtsyPropertyValue) => ({ value_ids: [...property.value_ids], values: [...property.values], ...(property.scale_id !== null ? { scale_id: property.scale_id } : {}) })
const translationBody = (translation: EtsyTranslation) => ({ title: translation.title, description: translation.description, tags: [...translation.tags] })

/** updateListing's keys for one change line (R1 §2: form-encoded and partial); a unit Etsy clears with ''. */
function patchFields(field: EtsyListingField, values: EtsyListingValues): Record<string, unknown> {
  const cleared = () => { throw new Error(`${etsyFieldLabel(field)} cannot be cleared.`) }
  if (field === 'classification') {
    const { who_made, when_made, is_supply } = values.classification
    return who_made !== null && when_made !== null && is_supply !== null ? { who_made, when_made, is_supply } : cleared()
  }
  if (field === 'item_weight') return values.item_weight.value !== null ? { item_weight: values.item_weight.value, item_weight_unit: values.item_weight.unit ?? '' } : cleared()
  if (field === 'item_dimensions') {
    const { length, width, height, unit } = values.item_dimensions
    if (length === null && width === null && height === null) return cleared()
    return { ...(length !== null ? { item_length: length } : {}), ...(width !== null ? { item_width: width } : {}), ...(height !== null ? { item_height: height } : {}), item_dimensions_unit: unit ?? '' }
  }
  const value = values[field]
  if (value === null || (Array.isArray(value) && !value.length) || (typeof value === 'string' && !value.trim())) return cleared()
  return { [field]: Array.isArray(value) ? [...value] : value }
}

/** The fields Etsy takes only when it creates a listing (R1 §2), or cannot report back (a send must read back what it wrote). */
const CREATE_ONLY: Readonly<Record<string, string>> = { styles: ETSY_STYLES_CREATE_ONLY, production_partner_ids: ETSY_PARTNERS_CREATE_ONLY }

/**
 * The calls a send would make, in order (R1 §1–6). Paths keep the literal `{shop_id}` (read from the account at send,
 * never stored) and, for a new listing, `{listing_id}` (Etsy answers it). A new listing: createDraftListing, the
 * inventory, each attribute, each translation. A listing that exists: only `selected` (change fields; 'all' = every
 * field Nexus holds), in task order — the listing PATCH, each attribute (set, or removed by a Full update), each
 * translation, the inventory PUT last — each call naming the change fields it writes. `removed`: the variations a Full
 * update's inventory PUT drops (named in its note).
 */
export function etsyPublicationRequest(publication: EtsyPublication, selected: 'all' | ReadonlySet<string>,
  removed: { skus: readonly string[]; unnamed: number } = { skus: [], unnamed: 0 }): EtsyWireRequest {
  if (!publication.listingId) {
    if (!publication.create) throw new Error('A new Etsy listing needs its price and quantity. Review again.')
    const calls: EtsyCall[] = [
      { method: 'POST', path: '/shops/{shop_id}/listings', encoding: 'form', body: { ...publication.form, quantity: publication.create.quantity, price: publication.create.price } },
      { method: 'PUT', path: '/listings/{listing_id}/inventory', encoding: 'json', body: { ...publication.inventory } },
      ...publication.properties.map((property): EtsyCall => ({ method: 'PUT', path: `/shops/{shop_id}/listings/{listing_id}/properties/${property.property_id}`, encoding: 'form', body: propertyBody(property) })),
      ...publication.translations.map((translation): EtsyCall => ({ method: 'POST', path: `/shops/{shop_id}/listings/{listing_id}/translations/${translation.language}`, encoding: 'form', body: translationBody(translation) })),
    ]
    return { operation: 'createDraftListing', listingId: null, calls }
  }
  const listingId = publication.listingId
  const lines = new Map(nexusLines(publication).map(line => [line.field, line]))
  // 'all': every line Nexus holds a value for (a field empty in Nexus is kept on Etsy), never a create-only one.
  const picked = (field: string) => selected === 'all' ? lines.get(field)?.value.state === 'value' && !CREATE_ONLY[field] : selected.has(field)
  const calls: EtsyCall[] = []
  // 1 — the listing's own fields, in one PATCH.
  const patch: Record<string, unknown> = {}
  const patched: string[] = []
  for (const field of ETSY_LISTING_FIELDS) if (picked(field)) {
    if (CREATE_ONLY[field]) throw new Error(CREATE_ONLY[field])
    Object.assign(patch, patchFields(field, publication.values))
    patched.push(field)
  }
  if (patched.length) calls.push({ method: 'PATCH', path: `/shops/{shop_id}/listings/${listingId}`, encoding: 'form', body: patch, fields: patched })
  // 2 — each attribute by its own call: set (PUT), or — reachable only from a Full update, whose line for an attribute
  // only Etsy holds is "absent" — removed (DELETE). A Partial update never ticks an attribute empty in Nexus.
  const propertyIds = selected === 'all' ? publication.properties.map(property => property.property_id)
    : [...selected].flatMap(field => /^property:(\d+)$/.test(field) ? [Number(field.slice(9))] : [])
  for (const id of propertyIds) {
    const property = publication.properties.find(entry => entry.property_id === id)
    const path = `/shops/{shop_id}/listings/${listingId}/properties/${id}`
    calls.push(property ? { method: 'PUT', path, encoding: 'form', body: propertyBody(property), fields: [`property:${id}`] }
      : { method: 'DELETE', path, encoding: 'none', body: null, fields: [`property:${id}`], note: 'Full update removes it: Nexus holds no value here.' })
  }
  // 3 — each translation. Etsy has no delete for one; it creates one (POST) or replaces the one it holds (PUT, R1 §6).
  // The send asks Etsy again just before it writes (GET) and journals the method that answer chose.
  for (const translation of publication.translations) if (picked(`translation:${translation.language}`)) {
    const held = publication.live?.translations
    const holds = held?.some(entry => sameLanguage(entry.language, translation.language))
    calls.push({ method: holds ? 'PUT' : 'POST', path: `/shops/{shop_id}/listings/${listingId}/translations/${translation.language}`, encoding: 'form',
      body: translationBody(translation), fields: [`translation:${translation.language}`],
      ...(held ? {} : { note: `${TRANSLATIONS_UNREAD} If Etsy holds this language, the send replaces it instead (PUT).` }) })
  }
  // 4 — the variations, last: a full replace (R1 §3), built again at send from Etsy's fresh inventory
  // (`etsyInventoryReplaceBody`). Each variation Etsy holds keeps Etsy's own price, stock and on/off (D3; read at send, so
  // the review shows no live number) with Nexus's processing profile; a variation new on Etsy takes Nexus's offering.
  if (picked('inventory')) {
    const live = publication.live
    if (!live) throw new Error(ETSY_LIVE_READ_NEEDED)
    const added: string[] = []
    const products = publication.inventory.products.map(product => {
      const sku = product.sku ?? ''
      const readiness = publication.structure.products.find(entry => entry.sku === sku)?.readiness_state_id ?? null
      if (live.offerings[sku]) return { ...product, offerings: [{ price: ETSY_KEPT_AT_SEND, quantity: ETSY_KEPT_AT_SEND, is_enabled: ETSY_KEPT_AT_SEND, readiness_state_id: readiness }] }
      added.push(sku)
      return { ...product, offerings: [{ ...product.offerings[0], readiness_state_id: readiness }] }
    })
    const notes = [
      ...(added.length ? [`${added.length === 1 ? 'new variation' : 'new variations'} ${andList(added)}`] : []),
      ...(removed.skus.length ? [`removes ${removed.skus.length === 1 ? 'variation' : 'variations'} ${andList(removed.skus)}`] : []),
      ...(removed.unnamed ? [`removes ${removed.unnamed} ${removed.unnamed === 1 ? 'variation' : 'variations'} without a SKU`] : []),
    ]
    calls.push({ method: 'PUT', path: `/listings/${listingId}/inventory`, encoding: 'json', body: inventoryBody(products, publication.structure), fields: ['inventory'],
      ...(notes.length ? { note: notes.join('; ') } : {}) })
  }
  return { operation: 'updateListing', listingId, calls }
}

/** An update's inventory PUT body: the products as given, with the listing's `*_on_property` rules (Etsy's own, kept; the structure carries them). */
function inventoryBody(products: readonly unknown[], structure: EtsyInventoryStructure): Record<string, unknown> {
  const own = etsyOnProperty(structure.properties.map(property => property.property_id), structure.products.map(product => product.readiness_state_id))
  return { products, ...Object.fromEntries(ETSY_RULE_KEYS.map(key => [key, [...(structure[key] ?? own[key])]])) }
}

/**
 * Where this listing's variations, as Nexus would send them, break the listing's own `*_on_property` rules (read live):
 * a rule Nexus's variations cannot keep, or a variation Etsy does not hold (or a processing profile that changes) whose
 * value differs inside a group Etsy keeps as one. Etsy's own price and stock stand for the variations it holds (D3).
 * `widened`: the processing-profile rule is widened instead (R2-n3, `etsyFitReadiness`).
 */
function etsyRuleCheck(publication: EtsyPublication, live: EtsyLiveListing): { refusals: string[]; widened: boolean } {
  const nexusIds = publication.structure.properties.map(property => property.property_id)
  const own = etsyOwnRules(nexusIds, publication.structure.products.map(product => product.readiness_state_id))
  const kept = etsyKeptRules(live.inventory, live.inventory.properties.map(property => property.property_id), nexusIds, own)
  if ('refusal' in kept) return { refusals: [kept.refusal], widened: false }
  const offers = new Map(publication.inventory.products.map(product => [product.sku ?? '', product.offerings[0]]))
  const products: EtsyRuleProduct[] = publication.structure.products.map(product => {
    const held = live.offerings[product.sku], nexus = offers.get(product.sku)
    return { sku: product.sku, values: product.values, price: held?.price ?? nexus?.price ?? 0, quantity: held?.quantity ?? nexus?.quantity ?? 0, readiness: product.readiness_state_id,
      sets: { price: !held, quantity: !held, sku: !held, readiness: !held || (held.readiness_state_id ?? null) !== product.readiness_state_id } }
  })
  const fitted = etsyFitReadiness(kept.rules, products, nexusIds)
  return { refusals: etsyRuleConflicts(products, fitted.rules, new Map(publication.structure.properties.map(property => [property.property_id, property.property_name]))), widened: fitted.widened }
}

// ── At send ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Etsy's own property values for a variation, when they say what Nexus's say (values text, scale, a seller-named property's name). */
function sameValues(etsy: EtsyWriteProduct['property_values'], nexus: EtsyWriteProduct['property_values']): boolean {
  const ours = nexus ?? [], theirs = etsy ?? []
  return ours.length === theirs.length && ours.every(value => {
    const held = theirs.find(entry => entry.property_id === value.property_id)
    return !!held && JSON.stringify(foldedSet(held.values)) === JSON.stringify(foldedSet(value.values)) && (held.scale_id ?? null) === (value.scale_id ?? null)
      && (!CUSTOM_PROPERTY_IDS.has(value.property_id) || fold(held.property_name) === fold(value.property_name))
  })
}

/**
 * The inventory PUT body, built from Etsy's FRESH inventory (read under the listing lock just before the PUT) and Nexus.
 *
 * - The listing's own `*_on_property` rules are kept (E2 review B1): a stock number or a price Etsy shares stays one
 *   shared number — Etsy's own, echoed — and is never sent as one per variation (that would multiply the stock).
 * - Each variation Etsy holds keeps Etsy's own price, stock and on/off (D3), in Etsy's order, with Nexus's processing
 *   profile (else Etsy's) and Etsy's own property values when they say what Nexus's say — so an unchanged listing gives
 *   Etsy's own inventory back and the writer sends nothing (every PUT risks Etsy's domestic-price fault).
 * - A variation Etsy does not hold takes Nexus's offering (one set Inactive stays off) and must fit the rules.
 *
 * A full replace deletes whatever it leaves out (R1 §3), so anything Etsy holds that the review did not agree to remove
 * refuses the send, as does anything Etsy would refuse or a rule the variations would break.
 */
export function etsyInventoryReplaceBody(plan: EtsyCompiled, current: EtsyInventoryWrite): { body: EtsyInventoryWrite } | { refusal: string } {
  const refuse = (sentence: string) => ({ refusal: `${sentence} Nothing was sent.` })
  const held = new Map<string, EtsyWriteProduct[]>()
  let unnamed = 0
  for (const product of current.products) {
    const sku = product.sku?.trim()
    if (!sku) { unnamed++; continue }
    held.set(sku, [...(held.get(sku) ?? []), product])
  }
  const nexusBySku = new Map(plan.inventory.products.map(product => [product.sku ?? '', product]))
  const removable = new Set(plan.removeSkus)
  const extra = [...held.keys()].filter(sku => !nexusBySku.has(sku) && !removable.has(sku))
  if (extra.length === 1) return refuse(`Etsy now holds variation ${extra[0]} that Nexus does not; sending the variations would delete it. Review again.`)
  if (extra.length) return refuse(`Etsy now holds variations ${andList(extra)} that Nexus does not; sending the variations would delete them. Review again.`)
  if (unnamed && !plan.removeUnnamed) return refuse(unnamed === 1 ? 'Etsy now holds a variation without a SKU; sending the variations would delete it. Review again.'
    : `Etsy now holds ${unnamed} variations without a SKU; sending the variations would delete them. Review again.`)
  const kept = [...held].filter(([sku]) => nexusBySku.has(sku))
  const shared = kept.filter(([, products]) => products.length > 1).map(([sku]) => sku)
  if (shared.length) return refuse(`Etsy holds ${andList(shared)} on more than one variation, so Nexus cannot tell which is which.`)
  const several = kept.filter(([, [product]]) => product.offerings.length > 1).map(([sku]) => sku)
  if (several.length) return refuse(`Etsy holds more than one offering (price and stock) for ${andList(several)}; Nexus sends one per variation.`)
  const readinessOf = (sku: string) => plan.structure.products.find(product => product.sku === sku)?.readiness_state_id ?? null
  const copyValues = (values: EtsyWriteProduct['property_values']) => values?.map(value => ({ ...value, value_ids: [...value.value_ids], values: [...value.values] }))
  const products: EtsyWriteProduct[] = [], ruled: EtsyRuleProduct[] = []
  // Etsy's variations first, in Etsy's order; then the new ones, in the review's.
  const order = [...current.products.map(product => product.sku?.trim() ?? '').filter(sku => nexusBySku.has(sku)),
    ...plan.inventory.products.map(product => product.sku ?? '').filter(sku => !held.has(sku))]
  for (const sku of order) {
    const nexus = nexusBySku.get(sku)!, etsy = held.get(sku)?.[0]
    const offer = etsy?.offerings[0], own = nexus.offerings[0]
    const readiness = readinessOf(sku) ?? offer?.readiness_state_id ?? own.readiness_state_id ?? null
    const offering: EtsyWriteOffering = offer ? { price: offer.price, quantity: offer.quantity, is_enabled: offer.is_enabled, readiness_state_id: readiness }
      : { price: own.price, quantity: own.quantity, is_enabled: own.is_enabled, readiness_state_id: readiness }
    const values = etsy && sameValues(etsy.property_values, nexus.property_values) ? etsy.property_values : nexus.property_values
    products.push({ sku: etsy?.sku ?? sku, ...(values ? { property_values: copyValues(values) } : {}), offerings: [offering] })
    ruled.push({ sku, values: values ?? [], price: offering.price, quantity: offering.quantity, readiness,
      sets: { price: !offer, quantity: !offer, sku: !offer, readiness: !offer || (offer.readiness_state_id ?? null) !== readiness } })
  }
  const noProfile = ruled.filter(product => product.readiness == null).map(product => product.sku)
  if (noProfile.length) return refuse(`${ETSY_NEEDS_READINESS} ${andList(noProfile)} ${noProfile.length === 1 ? 'has' : 'have'} no processing profile.`)
  const unpriced = ruled.filter(product => product.sets.price && !(product.price > 0)).map(product => product.sku)
  if (unpriced.length) return refuse(`${andList(unpriced)}: a new variation needs a price above 0 on Etsy.`)
  // The listing's own rules, as Etsy holds them now (a rule Etsy does not state is its default, []).
  const nexusIds = plan.structure.properties.map(property => property.property_id)
  const etsyIds = [...new Set(current.products.flatMap(product => (product.property_values ?? []).map(value => value.property_id)))]
  const etsyRules = etsyKeptRules(current, etsyIds, nexusIds, etsyOwnRules(nexusIds, ruled.map(product => product.readiness)))
  if ('refusal' in etsyRules) return refuse(etsyRules.refusal)
  const rules = etsyFitReadiness(etsyRules.rules, ruled, nexusIds)
  const conflicts = etsyRuleConflicts(ruled, rules.rules, new Map(plan.structure.properties.map(property => [property.property_id, property.property_name])))
  if (conflicts.length) return refuse(conflicts.join(' '))
  // Each rule as Etsy stated it (its own array, untouched, when it says the same); one Etsy did not state stays unstated
  // unless it changes (a widened processing-profile rule), or the listing had no variation property on Etsy (then
  // Nexus's rules are its first).
  const body: EtsyInventoryWrite = { products }
  for (const key of ETSY_RULE_KEYS) {
    const stated = current[key]
    if (stated !== undefined) body[key] = etsySameRule(stated, rules.rules[key]) ? [...stated] : [...rules.rules[key]]
    else if (!etsyIds.length || rules.rules[key].length) body[key] = [...rules.rules[key]]
  }
  return { body }
}

/**
 * `value` as far as a PATCH of `field` wrote it: Item size sends only the measures Nexus holds (and the unit), so a
 * measure Etsy keeps on its own is not a difference. Every other field is compared whole.
 */
function asSent(field: string, value: StudioPublishValue, sent: StudioPublishValue): StudioPublishValue {
  if (field !== 'item_dimensions' || value.state !== 'value' || sent.state !== 'value') return value
  const ours = sent.value as EtsyListingValues['item_dimensions'], theirs = value.value as EtsyListingValues['item_dimensions']
  return { state: 'value', value: { unit: theirs.unit, ...Object.fromEntries((['length', 'width', 'height'] as const).filter(key => ours[key] !== null).map(key => [key, theirs[key]])) } }
}

/**
 * The read-back, field by field (only fields whose call Etsy applied): Etsy's own equality for listing fields (tags as a
 * set, a description's line ends), an attribute by its values text and scale (a removed one must be gone), a
 * translation by its texts, the variations by their structure (their price, stock and on/off are checked by the
 * inventory writer). One sentence per field that Etsy does not hold as sent.
 */
export function etsyReadBackMismatches(plan: EtsyCompiled, applied: ReadonlySet<string>, after: EtsyLiveListing): string[] {
  const mismatches: string[] = []
  const differs = (label: string) => mismatches.push(`${label}: Etsy holds something other than what Nexus sent.`)
  const removed = new Set((plan.request?.calls ?? []).filter(call => call.method === 'DELETE').flatMap(call => call.fields ?? []))
  for (const field of applied) {
    if ((ETSY_LISTING_FIELDS as readonly string[]).includes(field)) {
      const key = field as EtsyListingField
      const sent = etsyValue(field, plan.values[key])
      const ours = asSent(field, sent, sent), theirs = asSent(field, etsyValue(field, after.values[key]), sent)
      if (!(etsySame(field, ours, theirs) ?? canonical(ours) === canonical(theirs))) differs(etsyFieldLabel(field))
    } else if (field.startsWith('property:')) {
      const id = Number(field.slice(9))
      const ours = plan.properties.find(property => property.property_id === id), theirs = after.properties.find(property => property.property_id === id)
      const label = ours?.property_name ?? theirs?.property_name ?? `Property ${id}`
      if (removed.has(field)) { if (theirs) mismatches.push(`${label}: Etsy still holds it after Nexus removed it.`) }
      else if (!ours || !theirs || propertyKey(ours) !== propertyKey(theirs)) differs(label)
    } else if (field.startsWith('translation:')) {
      const code = field.slice(12)
      const label = `Translation (${code})`
      const ours = plan.translations.find(translation => sameLanguage(translation.language, code))
      if (after.translations === null) mismatches.push(`${label}: Etsy did not return its translations, so Nexus could not confirm it.`)
      else {
        const theirs = after.translations.find(translation => sameLanguage(translation.language, code))
        if (!ours || !theirs || translationKey(ours) !== translationKey(theirs)) differs(label)
      }
    } else if (field === 'inventory') {
      if (structureKey(plan.structure) !== structureKey(after.inventory)) differs(etsyFieldLabel('inventory'))
    }
  }
  return mismatches
}
