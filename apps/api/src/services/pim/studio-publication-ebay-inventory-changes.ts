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
}
export interface EbayInventoryChangePlan {
  kind: 'ebay-inventory-changes'; changes: StudioPublishChange[]; remoteRevision: string; ownerProductId: string
  groupKey: string | null; liveGroup: Json | null; aspectNames: Record<string, string>
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

  return { kind: 'ebay-inventory-changes', changes: planPublicationChanges(inputs), remoteRevision: live.revision ?? 'unavailable',
    ownerProductId: owner.productId, groupKey: live.raw.groupKey, liveGroup: group, aspectNames, destination, owner }
}

/** The exact inventory_item_group PUT: the fresh live group with only the ticked fields replaced. */
export function compileEbayInventoryChanges(plan: EbayInventoryChangePlan, selectedIds: string[]): { groupKey: string | null; group: Json | null; fieldWrites: Record<string, StudioPublishFieldWrite[]> } {
  const selected = selectPublicationChanges(plan.changes, selectedIds)
  if (!selected.length) return { groupKey: plan.groupKey, group: null, fieldWrites: {} }
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
    } else throw new Error(`${change.label} has no supported eBay Inventory write.`)
  }
  if (!same(group.variantSKUs, plan.liveGroup.variantSKUs) || !same(group.variesBy, plan.liveGroup.variesBy)) throw new Error('The compiled group would change its variants. Nothing will be sent.')
  return { groupKey: plan.groupKey, group, fieldWrites }
}
