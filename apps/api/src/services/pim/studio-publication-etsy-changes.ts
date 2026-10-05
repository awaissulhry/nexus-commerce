/**
 * E1 (Etsy publisher, 2026-10-05) — the Etsy change plan: one line per listing field, attribute, translation and the
 * variation set, compared with the live Etsy listing and the last accepted publish (`planPublicationChanges`), and the
 * exact calls a send would make (`etsyPublicationRequest`). PURE: the live listing was read by `prepareEtsyPublication`.
 *
 * A new listing is ONE line: its value is the whole request, so the review shows exactly what Publish would send. A
 * listing that exists is reviewed field by field; a field empty in Nexus is never cleared on Etsy by a tick (Etsy keeps
 * its value), and Nexus never sends a price or a stock number from here (D3: the price and stock pushes do).
 */
import { type StudioPublishChange, type StudioPublishFieldWrite, type StudioPublishValue } from '@nexus/shared/studio-publication'
import type { PublicationFacts } from './studio-publication-plan.js'
import { planPublicationChanges, publicationChangeId, publicationReplaces, selectPublicationChanges, type PublicationChangeInput } from './studio-publication-changes.js'
import { andList, etsyOnProperty, etsyValue, etsyVariationsNexusLacks, ETSY_NEEDS_READINESS } from './studio-publication-etsy-build.js'
import { etsyFieldLabel } from './studio-publication-etsy-problems.js'
import { ETSY_LISTING_FIELDS, type EtsyCall, type EtsyChangePlan, type EtsyCompiled, type EtsyInventoryStructure, type EtsyListingField, type EtsyListingValues,
  type EtsyPropertyValue, type EtsyPublication, type EtsyTranslation, type EtsyWireRequest } from './studio-publication-etsy-types.js'

const unknown = (reason: string): StudioPublishValue => ({ state: 'unknown', reason })

export const ETSY_EMPTY_KEPT = 'Empty in Nexus; Etsy keeps its value.'
export const ETSY_STYLES_CREATE_ONLY = 'Etsy takes styles only when a listing is created; Nexus cannot change them on a listing that exists.'
export const ETSY_LIVE_READ_NEEDED = 'A successful live Etsy read is required before sending changes.'
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
/** The variation set, by values text (case ignored, sorted) and scale, never by `value_ids` (Etsy renumbers them, R1 §3). */
const structureKey = (value: EtsyInventoryStructure) => JSON.stringify({
  properties: [...(value.properties ?? [])].sort((a, b) => a.property_id - b.property_id)
    .map(p => [p.property_id, p.scale_id ?? null, CUSTOM_PROPERTY_IDS.has(p.property_id) ? fold(p.property_name) : null]),
  products: [...(value.products ?? [])].sort((a, b) => a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0)
    .map(p => [p.sku, [...p.values].sort((a, b) => a.property_id - b.property_id).map(v => [v.property_id, foldedSet(v.values)]), p.readiness_state_id ?? null]),
})
const translationKey = (value: Partial<EtsyTranslation>) => JSON.stringify([String(value.title ?? '').trim(), plain(value.description), foldedSet(value.tags)])

/** Etsy's own equality for a field, or undefined for exact equality (`planPublicationChanges`). Only two values compare. */
function etsySame(field: string, a: StudioPublishValue, b: StudioPublishValue): boolean | undefined {
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

/**
 * The change plan of one Etsy publication. `facts` is the adapters' shared argument; the publication already carries
 * every identity Etsy needs (`products`, `ownerProductId`).
 */
export function prepareEtsyChanges(_facts: PublicationFacts, publication: EtsyPublication, baselineValues: Map<string, StudioPublishValue>): EtsyChangePlan {
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
  const inputs: PublicationChangeInput[] = []
  const add = (field: string, label: string, nexus: StudioPublishValue, held: StudioPublishValue, refusal?: string) => {
    // A field empty in Nexus is not a clear: Etsy keeps its value (a real clear is a later step).
    const current = nexus.state === 'absent' ? unknown(ETSY_EMPTY_KEPT) : nexus
    const channel = live ? held : unknown(unread)
    const lastAccepted = baselineValues.get(publicationChangeId(owner.productId, field)) ?? unknown('No accepted publish record for this field.')
    inputs.push({ ...owner, field, label, current, lastAccepted, channel,
      currentMatchesChannel: etsySame(field, current, channel), acceptedMatchesChannel: etsySame(field, lastAccepted, channel),
      ...(!live ? { refusal: unread } : refusal ? { refusal } : {}) })
  }
  const byField = new Map(lines.map(line => [line.field, line]))
  for (const field of ETSY_LISTING_FIELDS) {
    const why = live?.unread[field]
    add(field, etsyFieldLabel(field), byField.get(field)!.value, why ? unknown(why) : etsyValue(field, live?.values[field]), field === 'styles' ? ETSY_STYLES_CREATE_ONLY : undefined)
  }
  // Attributes: Nexus's and Etsy's, except properties used as variations (they live in the inventory, R1 §4).
  const variationIds = new Set([...publication.structure.properties, ...(live?.inventory.properties ?? [])].map(property => property.property_id))
  const liveProperties = (live?.properties ?? []).filter(property => !variationIds.has(property.property_id))
  const propertyIds = [...new Set([...publication.properties, ...liveProperties].map(property => property.property_id))].sort((a, b) => a - b)
  for (const id of propertyIds) {
    const ours = publication.properties.find(property => property.property_id === id), theirs = liveProperties.find(property => property.property_id === id)
    const field = `property:${id}`
    add(field, ours?.property_name ?? theirs?.property_name ?? `Property ${id}`, etsyValue(field, ours ?? null), etsyValue(field, theirs ?? null))
  }
  for (const translation of publication.translations) {
    const field = `translation:${translation.language}`
    const held = live?.translations?.find(entry => entry.language.toLowerCase() === translation.language.toLowerCase())
    add(field, `Translation (${translation.language})`, byField.get(field)!.value, live?.translations === null ? unknown(TRANSLATIONS_UNREAD) : etsyValue(field, held ?? null))
  }
  // The variation set is a full replace (R1 §3): it is never sent while a variation lacks a processing profile (Etsy
  // refuses the PUT, M1; Etsy's own profile already stands in for one empty in Nexus) or while Etsy holds variations
  // Nexus does not (the send would delete them, m3).
  const noProfile = publication.structure.products.filter(product => product.readiness_state_id === null).map(product => product.sku)
  const inventoryRefusals = live ? [
    ...(noProfile.length ? [`${ETSY_NEEDS_READINESS} ${andList(noProfile)} ${noProfile.length === 1 ? 'has' : 'have'} no processing profile.`] : []),
    ...etsyVariationsNexusLacks(live, publication.structure),
  ] : []
  add('inventory', etsyFieldLabel('inventory'), byField.get('inventory')!.value, etsyValue('inventory', live?.inventory ?? null), inventoryRefusals.join(' ') || undefined)
  // A DIFFERS warning names a grouped value in a few words, not every id and key it holds.
  const changes: StudioPublishChange[] = planPublicationChanges(inputs, { channel: 'Etsy' }).map(change => change.replaces && WORDED(change.field)
    ? { ...change, replaces: publicationReplaces(change, 'Etsy', { channel: etsyWords(change.field, change.channel), nexus: etsyWords(change.field, change.current) }) } : change)
  return { ...base, changes, remoteRevision: live?.revision ?? 'unavailable' }
}

/** The publication a selection sends: the whole create, or the selected fields of a listing that exists. PURE. */
export function compileEtsyChanges(plan: EtsyChangePlan, selectedIds: string[]): EtsyCompiled {
  const selected = selectPublicationChanges(plan.changes, selectedIds)
  const publication = plan.publication
  if (!selected.length) return { ...publication, products: [], fieldWrites: {}, request: null }
  if (!publication.listingId) return { ...publication, products: plan.products, fieldWrites: plan.createWrites, request: etsyPublicationRequest(publication, 'all') }
  if (!publication.live || !publication.liveRevision) throw new Error(ETSY_LIVE_READ_NEEDED)
  const fieldWrites: Record<string, StudioPublishFieldWrite[]> = {}
  for (const change of selected) {
    if (change.current.state === 'unknown') throw new Error('An unknown value cannot be sent to Etsy.')
    ;(fieldWrites[change.productId] ??= []).push({ field: change.field, value: change.current })
  }
  return { ...publication, products: plan.products, fieldWrites, request: etsyPublicationRequest(publication, new Set(selected.map(change => change.field))) }
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

/**
 * The calls a send would make, in order (R1 §1–6). Paths keep the literal `{shop_id}` (read from the account at send,
 * never stored) and, for a new listing, `{listing_id}` (Etsy answers it). A new listing: createDraftListing, the
 * inventory, each attribute, each translation. A listing that exists: only `selected` (change fields; 'all' = every
 * field Nexus holds), each by its own endpoint.
 */
export function etsyPublicationRequest(publication: EtsyPublication, selected: 'all' | ReadonlySet<string>): EtsyWireRequest {
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
  // 'all': every line Nexus holds a value for (a field empty in Nexus is kept on Etsy); styles never (create only).
  const picked = (field: string) => selected === 'all' ? lines.get(field)?.value.state === 'value' && field !== 'styles' : selected.has(field)
  const calls: EtsyCall[] = []
  const patch: Record<string, unknown> = {}
  for (const field of ETSY_LISTING_FIELDS) if (picked(field)) {
    if (field === 'styles') throw new Error(ETSY_STYLES_CREATE_ONLY)
    Object.assign(patch, patchFields(field, publication.values))
  }
  if (Object.keys(patch).length) calls.push({ method: 'PATCH', path: `/shops/{shop_id}/listings/${listingId}`, encoding: 'form', body: patch })
  if (picked('inventory')) {
    // A full replace (R1 §3): each variation Etsy holds keeps Etsy's own price and stock (D3) with Nexus's processing
    // profile; a variation new on Etsy takes Nexus's offering.
    const live = publication.live
    if (!live) throw new Error(ETSY_LIVE_READ_NEEDED)
    const added: string[] = []
    const products = publication.inventory.products.map(product => {
      const sku = product.sku ?? ''
      const held = live.offerings[sku]
      const readiness = publication.structure.products.find(entry => entry.sku === sku)?.readiness_state_id ?? null
      if (!held) added.push(sku)
      return { ...product, offerings: [{ ...(held ?? product.offerings[0]), readiness_state_id: readiness }] }
    })
    calls.push({ method: 'PUT', path: `/listings/${listingId}/inventory`, encoding: 'json', body: inventoryBody(products, publication.structure),
      ...(added.length ? { note: `${added.length === 1 ? 'new variation' : 'new variations'} ${added.join(', ')}` } : {}) })
  }
  const propertyIds = selected === 'all' ? publication.properties.map(property => property.property_id)
    : [...selected].flatMap(field => /^property:(\d+)$/.test(field) ? [Number(field.slice(9))] : [])
  for (const id of propertyIds) {
    // An attribute empty in Nexus is kept on Etsy (its line cannot be ticked): there is nothing to send for it.
    const property = publication.properties.find(entry => entry.property_id === id)
    if (!property) throw new Error(`Property ${id}: ${ETSY_EMPTY_KEPT}`)
    calls.push({ method: 'PUT', path: `/shops/{shop_id}/listings/${listingId}/properties/${id}`, encoding: 'form', body: propertyBody(property) })
  }
  for (const translation of publication.translations) if (picked(`translation:${translation.language}`)) {
    const held = publication.live?.translations
    const path = `/shops/{shop_id}/listings/${listingId}/translations/${translation.language}`
    // Etsy has no delete for a translation; it creates one (POST) or replaces the one it holds (PUT, R1 §6).
    const holds = held?.some(entry => entry.language.toLowerCase() === translation.language.toLowerCase())
    calls.push({ method: holds ? 'PUT' : 'POST', path, encoding: 'form', body: translationBody(translation),
      ...(held ? {} : { note: `${TRANSLATIONS_UNREAD} If Etsy holds this language, the send replaces it instead (PUT).` }) })
  }
  return { operation: 'updateListing', listingId, calls }
}

/** An update's inventory PUT body: the products as given, with the `*_on_property` arrays the structure calls for (its processing profiles may be Etsy's). */
function inventoryBody(products: EtsyPublication['inventory']['products'], structure: EtsyInventoryStructure): Record<string, unknown> {
  return { products, ...etsyOnProperty(structure.properties.map(property => property.property_id), structure.products.map(product => product.readiness_state_id)) }
}
