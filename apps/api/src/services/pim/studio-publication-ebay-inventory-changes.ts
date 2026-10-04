/**
 * PE P3.2 — change-only Publish for an eBay Inventory-model listing (pure). Nexus now vs the last accepted send vs the live
 * group (P3.1 reader) gives one review row per field; the send is the FRESH live group with only the ticked fields replaced,
 * because an inventory_item_group PUT replaces the whole object. Price and stock are never sent (their own doors do that).
 * Variant values, new or removed variants and the variation theme are shown but refused by name until P3.6.
 */
import type { StudioPublishChange, StudioPublishFieldWrite, StudioPublishValue } from '@nexus/shared/studio-publication'
import type { LiveValue } from '@nexus/shared/live-read'
import { planPublicationChanges, publicationChangeId, selectPublicationChanges, type PublicationChangeInput } from './studio-publication-changes.js'
import { ebayAspectKey } from '../channel-drift/ebay-content-compare.js'
import type { ServerLiveRead } from '../live-read/types.js'
import type { EbayInventoryDestination, EbayInventoryRaw } from '../live-read/ebay-inventory.js'

type Identity = { productId: string; sku: string }
type Json = Record<string, unknown>
/** What Nexus would publish, in eBay's own names (channel aspect and axis names). */
export interface EbayInventoryOurs {
  title: string | null; description: string | null; pictures: string[]; aspects: Record<string, string[]>
  axes: string[]; order: Record<string, string[]>; variants: Array<Identity & { values: Record<string, string> }>
  /** Images rebuild P2d — the photos each SKU carries (its value's set) and the aspect they vary by. */
  variationPictures?: { axis: string; bySku: Record<string, string[]> }
}
export interface EbayInventoryChangePlan {
  kind: 'ebay-inventory-changes'; changes: StudioPublishChange[]; remoteRevision: string; ownerProductId: string
  groupKey: string | null; liveGroup: Json | null; aspectNames: Record<string, string>
  /** The live inventory items the review read, by SKU — a variation picture send rewrites them whole. */
  liveItems: Record<string, Json>
  /** Where the send re-reads before it writes, and who owns the group-level fields. */
  destination: EbayInventoryDestination; owner: Identity
}

/** The fields an inventory_item_group carries. Any other live field would be dropped by a whole-object PUT, so it refuses. */
const GROUP_FIELDS = new Set(['aspects', 'description', 'imageUrls', 'inventoryItemGroupKey', 'subtitle', 'title', 'variantSKUs', 'variesBy', 'videoIds'])
const LATER = 'Variation changes on eBay Inventory listings come in a later step (P3.6); this row is not sent.'
const known = (value: unknown): StudioPublishValue => value == null || value === '' || (Array.isArray(value) && !value.length) ? { state: 'absent' } : { state: 'value', value }
const unknown = (reason: string): StudioPublishValue => ({ state: 'unknown', reason })
const fromLive = (value: LiveValue | undefined): StudioPublishValue => !value || value.state === 'absent' ? { state: 'absent' } : value.state === 'unread' ? unknown(value.reason) : value
const pictureRefusal = (urls: string[]) => !urls.length ? 'The gallery cannot be cleared; at least one picture is required.'
  : urls.length > 24 || urls.some(url => !/^https:\/\//i.test(url)) ? 'eBay requires at most 24 HTTPS picture URLs.' : undefined
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** An inventory_item PUT replaces the whole object: these fields are written back; the read-only ones are dropped; any
 *  other field would be lost, so it refuses. Availability is left out here and echoed FRESH at send (stock moves). */
const ITEM_WRITABLE = new Set(['availability', 'condition', 'conditionDescription', 'conditionDescriptors', 'packageWeightAndSize', 'product'])
const ITEM_READ_ONLY = new Set(['sku', 'locale', 'groupIds', 'inventoryItemGroupKeys'])
const texts = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
const obj = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}
/** eBay's name for the aspect our pictures vary by, as the live group spells it, or null when the group does not vary by it. */
const liveAxisName = (group: Json | null, axis: string) => (obj(group?.variesBy).specifications as unknown[] | undefined ?? []).map(obj)
  .map(s => String(s.name ?? '')).find(name => ebayAspectKey(name) === ebayAspectKey(axis)) ?? null
function variationPicturesRefusal(ours: NonNullable<EbayInventoryOurs['variationPictures']>, group: Json | null, items: Record<string, Json>): string | undefined {
  if (!liveAxisName(group, ours.axis)) return `This eBay listing does not vary by ${ours.axis}; its photos cannot vary by it.`
  for (const [sku, urls] of Object.entries(ours.bySku)) {
    if (!items[sku]) return `${sku} is not on this eBay listing yet. New variations come in a later step (P3.6).`
    if (!urls.length || urls.length > 12 || urls.some(url => !/^https:\/\//i.test(url))) return `${sku}: eBay allows 1 to 12 HTTPS photos per variation.`
    const foreign = Object.keys(items[sku]).filter(key => !ITEM_WRITABLE.has(key) && !ITEM_READ_ONLY.has(key))
    if (foreign.length) return `The live eBay item ${sku} holds an unknown field (${foreign.join(', ')}); a whole-object PUT could drop it.`
  }
  return undefined
}

export function prepareEbayInventoryChanges(input: { owner: Identity; ours: EbayInventoryOurs; live: ServerLiveRead<EbayInventoryRaw>; baselineValues: Map<string, StudioPublishValue>; destination: EbayInventoryDestination }): EbayInventoryChangePlan {
  const { owner, ours, live, baselineValues, destination } = input
  const group = live.raw.group
  const unreadReason = group ? undefined : live.errors.find(e => e.scope === 'item')?.reason ?? 'The live eBay group could not be read.'
  const channel = (field: string) => group ? fromLive(live.content[field]) : unknown(unreadReason!)
  const inputs: PublicationChangeInput[] = []
  const add = (who: Identity, field: string, label: string, current: StudioPublishValue, remote: StudioPublishValue, refusal?: string) => inputs.push({
    ...who, field, label, current, channel: remote,
    lastAccepted: baselineValues.get(publicationChangeId(who.productId, field)) ?? unknown('No accepted publish record for this field.'),
    ...(unreadReason ? { refusal: unreadReason } : refusal ? { refusal } : {}) })

  add(owner, 'title', 'Title', known(ours.title), channel('title'), !ours.title?.trim() ? 'A title is required; it cannot be cleared.' : undefined)
  add(owner, 'description', 'Description', known(ours.description), channel('description'), !ours.description?.trim() ? 'Clearing the description is unsupported; eBay requires a description.' : undefined)
  add(owner, 'pictures', 'Listing pictures', known(ours.pictures), channel('pictures'), pictureRefusal(ours.pictures))
  if (ours.variationPictures) {
    const liveVariation = group ? known({ axis: texts(obj(group.variesBy).aspectsImageVariesBy)[0] ?? null,
      bySku: Object.fromEntries(Object.keys(ours.variationPictures.bySku).map(sku => [sku, texts(obj(live.raw.items[sku]?.product).imageUrls)])) }) : unknown(unreadReason!)
    add(owner, 'variationPictures', 'Variation pictures', known(ours.variationPictures), liveVariation, variationPicturesRefusal(ours.variationPictures, group, live.raw.items))
  }

  const aspectNames: Record<string, string> = {}
  for (const name of Object.keys((group?.aspects as Json | undefined) ?? {})) aspectNames[ebayAspectKey(name)] = name
  const ourAspects = new Map(Object.entries(ours.aspects).map(([name, values]) => [ebayAspectKey(name), { name, values }]))
  const keys = new Set([...ourAspects.keys(), ...Object.keys(live.content).filter(f => f.startsWith('aspect:')).map(f => f.slice(7))])
  for (const key of keys) {
    const mine = ourAspects.get(key)
    aspectNames[key] ??= mine?.name ?? key
    add(owner, `aspect:${key}`, aspectNames[key], mine?.values.length ? known(mine.values) : unknown('This item specific is omitted; no valid authored clear was prepared.'), channel(`aspect:${key}`))
  }

  const liveVariants = live.variations?.variants.filter(v => v.state !== 'missing') ?? []
  const liveTheme = live.variations ? { axes: live.variations.axes, order: live.variations.order } : null
  if (!liveTheme || !same({ axes: ours.axes, order: ours.order }, liveTheme)) add(owner, 'variesBy', 'Variation theme', known({ axes: ours.axes, order: ours.order }), liveTheme ? known(liveTheme) : channel('variesBy'), LATER)
  for (const variant of ours.variants) {
    const remote = liveVariants.find(v => v.sku === variant.sku)
    if (!remote || !same(variant.values, remote.values)) add(variant, 'variation', remote ? 'Variation values' : 'New variation', known(variant.values), remote ? known(remote.values) : { state: 'absent' }, LATER)
  }
  for (const remote of liveVariants.filter(v => !ours.variants.some(o => o.sku === v.sku)))
    add({ productId: owner.productId, sku: remote.sku }, `variation-removed:${remote.sku}`, 'Variation not in Nexus', { state: 'absent' }, known(remote.values), LATER)

  return { kind: 'ebay-inventory-changes', changes: planPublicationChanges(inputs, { channel: 'eBay' }), remoteRevision: live.revision ?? 'unavailable',
    ownerProductId: owner.productId, groupKey: live.raw.groupKey, liveGroup: group, aspectNames, destination, owner, liveItems: live.raw.items }
}

/** The exact inventory_item_group PUT: the fresh live group with only the ticked fields replaced. */
export function compileEbayInventoryChanges(plan: EbayInventoryChangePlan, selectedIds: string[]): { groupKey: string | null; group: Json | null; items: Record<string, Json>; fieldWrites: Record<string, StudioPublishFieldWrite[]> } {
  const selected = selectPublicationChanges(plan.changes, selectedIds)
  const items: Record<string, Json> = {}
  if (!selected.length) return { groupKey: plan.groupKey, group: null, items, fieldWrites: {} }
  if (!plan.liveGroup || !plan.groupKey || plan.remoteRevision === 'unavailable') throw new Error('A successful live eBay group read is required before sending changes.')
  const foreign = Object.keys(plan.liveGroup).filter(key => !GROUP_FIELDS.has(key))
  if (foreign.length) throw new Error(`The live eBay group holds an unknown field (${foreign.join(', ')}); a whole-object PUT could drop it. Nothing will be sent.`)
  const group: Json = structuredClone(plan.liveGroup)
  const aspects: Record<string, unknown> = { ...(group.aspects as Json | undefined ?? {}) }
  const fieldWrites: Record<string, StudioPublishFieldWrite[]> = {}
  for (const change of selected) {
    if (change.current.state === 'unknown') throw new Error('An unknown value cannot be sent to eBay.')
    const value = change.current.state === 'value' ? change.current.value : null
    ;(fieldWrites[change.productId] ??= []).push({ field: change.field, value: change.current })
    if (change.field === 'title' || change.field === 'description') {
      if (typeof value !== 'string' || !value.trim()) throw new Error(`${change.label} cannot be cleared.`)
      group[change.field] = value
    } else if (change.field === 'pictures') {
      const urls = Array.isArray(value) ? value.filter((url): url is string => typeof url === 'string') : []
      const refusal = pictureRefusal(urls)
      if (refusal || urls.length !== (value as unknown[]).length) throw new Error(refusal ?? 'The picture gallery is invalid.')
      group.imageUrls = urls
    } else if (change.field.startsWith('aspect:')) {
      const key = change.field.slice(7)
      for (const name of Object.keys(aspects)) if (ebayAspectKey(name) === key) delete aspects[name]
      if (value !== null) {
        if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error('The item specific values are invalid.')
        aspects[plan.aspectNames[key] ?? key] = value
      }
      group.aspects = aspects
    } else if (change.field === 'variationPictures') {
      const pictures = value as EbayInventoryOurs['variationPictures']
      const refusal = pictures ? variationPicturesRefusal(pictures, plan.liveGroup, plan.liveItems) : 'The variation pictures are invalid.'
      if (refusal || !pictures) throw new Error(refusal)
      group.variesBy = { ...obj(group.variesBy), aspectsImageVariesBy: [liveAxisName(plan.liveGroup, pictures.axis)] }
      for (const [sku, urls] of Object.entries(pictures.bySku)) {
        const { availability: _fresh, ...body } = Object.fromEntries(Object.entries(structuredClone(plan.liveItems[sku])).filter(([key]) => ITEM_WRITABLE.has(key)))
        items[sku] = { ...body, product: { ...obj(body.product), imageUrls: urls } }
      }
    } else throw new Error(`${change.label} has no supported eBay Inventory write.`)
  }
  const variants = (g: Json) => { const { aspectsImageVariesBy: _pictures, ...rest } = obj(g.variesBy); return rest }
  if (!same(group.variantSKUs, plan.liveGroup.variantSKUs) || !same(variants(group), variants(plan.liveGroup))) throw new Error('The compiled group would change its variants. Nothing will be sent.')
  return { groupKey: plan.groupKey, group, items, fieldWrites }
}
