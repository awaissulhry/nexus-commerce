import type { MappingFieldRow, MappingPushImpact } from '@nexus/shared/channel-mapping'
import prisma from '../../db.js'
import { fieldRowOf } from './store.js'

/**
 * CHMAP M4 — the push follows the ACTIVE mapping version (study §8.4, §11.3 option A).
 *
 * Only the Owner's own decisions change a push: a field is left out of what Nexus sends when the Owner ignored, or
 * handed to another workflow, or made "read on import only", EVERY column of the version that carries it. The
 * rules' own decisions never change a push. With no ACTIVE version — production today — nothing changes.
 *
 * What "left out" means per channel (the difference list shows it before anything is sent):
 *   - Amazon: the attribute is not sent; Amazon keeps its value (the change planner never turns an omission into a clear).
 *     Amazon takes an attribute whole, so a part is never left out alone: that would clear the part on Amazon.
 *   - eBay: the item specific is left out. On a live listing the change-only publish starts from eBay's own specifics
 *     and cannot send an omission, so eBay keeps its value (`studio-publication-ebay-changes.vitest.test.ts` pins it).
 *   - A new listing, on either channel, is created without the field.
 */
export interface PushExclusions {
  /** Channel spec field keys the push leaves out (`team_name`, `aspect_Genere`). */
  fieldKeys: Set<string>
  /** Channel spec field keys a column of the version still sends. */
  sentKeys: Set<string>
  /** eBay item-specific names the push leaves out, folded (`team name`). */
  specifics: Set<string>
  /** The version that decided, for the review's wording. */
  source: { setId: string; version: number; label: string } | null
}

const EMPTY: PushExclusions = { fieldKeys: new Set(), sentKeys: new Set(), specifics: new Set(), source: null }
export const foldName = (v: string) => v.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase()

/** An Amazon spec key is its attribute, or `attribute__part` (true for all 1,529 keys of the golden specs). */
export const amazonRootOf = (key: string) => key.split('__')[0]

/**
 * The Amazon attributes the push leaves out. Amazon replaces an attribute whole, so it is left out only when the Owner
 * stopped at least one of its columns and no column of the version still sends any part of it.
 */
export function amazonExcludedRoots(excluded: Pick<PushExclusions, 'fieldKeys' | 'sentKeys'>): Set<string> {
  const sent = new Set([...excluded.sentKeys].map(amazonRootOf))
  return new Set([...excluded.fieldKeys].map(amazonRootOf).filter(root => !sent.has(root)))
}

/** Pure: the fields and specifics a version tells the push to leave out. */
export function pushExclusions(fields: readonly MappingFieldRow[]): Omit<PushExclusions, 'source'> {
  const byTarget = new Map<string, MappingFieldRow[]>()
  for (const f of fields) {
    if (!f.targetKey || (f.targetKind !== 'channelField' && f.targetKind !== 'itemSpecific')) continue
    const key = `${f.targetKind}\u0000${f.targetKey}`
    byTarget.set(key, [...(byTarget.get(key) ?? []), f])
  }
  const out = { fieldKeys: new Set<string>(), sentKeys: new Set<string>(), specifics: new Set<string>() }
  for (const [key, rows] of byTarget) {
    const ownerDecided = rows.some(r => r.decidedBy === 'owner')
    const sent = rows.some(r => r.state === 'mapped' && r.direction !== 'in')
    if (sent && key.startsWith('channelField\u0000')) out.sentKeys.add(key.slice('channelField\u0000'.length))
    if (!ownerDecided || sent) continue
    const [kind, target] = key.split('\u0000')
    if (kind === 'channelField') out.fieldKeys.add(target)
    else out.specifics.add(foldName(target.replace(/^itemSpecifics\./, '')))
  }
  return out
}

/**
 * The exclusions for one destination: the most recently activated ACTIVE version of this channel and market whose
 * form covers the product type (Amazon) or category (eBay). Cached per call site through `pushExclusionsCache`.
 */
export async function activePushExclusions(channel: 'AMAZON' | 'EBAY', marketplace: string, category: string): Promise<PushExclusions> {
  if (process.env.NEXUS_PUSH_FOLLOWS_MAPPING === '0') return EMPTY
  const sets = await prisma.channelMappingSet.findMany({
    where: { channel, marketplace: marketplace.toUpperCase(), status: 'ACTIVE', formKind: channel === 'AMAZON' ? 'AMAZON_TEMPLATE' : 'EBAY_WORKBOOK' },
    orderBy: { activatedAt: 'desc' }, select: { id: true, version: true, formKey: true, marketplace: true },
  })
  const set = sets.find(s => s.formKey.split('+').includes(category.toUpperCase()) || s.formKey.split('+').includes(category))
  if (!set) return EMPTY
  const fields = (await prisma.channelMappingField.findMany({ where: { setId: set.id } })).map(fieldRowOf)
  const { fieldKeys, sentKeys, specifics } = pushExclusions(fields)
  return { fieldKeys, sentKeys, specifics, source: { setId: set.id, version: set.version, label: `${channel === 'AMAZON' ? 'Amazon' : 'eBay'} ${set.marketplace} · ${set.formKey} · v${set.version}` } }
}

export function pushExclusionsCache() {
  const cache = new Map<string, Promise<PushExclusions>>()
  return (channel: 'AMAZON' | 'EBAY', marketplace: string, category: string) => {
    const key = JSON.stringify([channel, marketplace, category])
    if (!cache.has(key)) cache.set(key, activePushExclusions(channel, marketplace, category))
    return cache.get(key)!
  }
}

/**
 * What a version makes the push leave out, keyed for comparison and worded for the Owner, and the Owner's stops the push
 * cannot follow, with the reason. Amazon: whole attributes (§ above). eBay: item specifics only; the builder sends its
 * other fields from the listing as before.
 */
export function pushStops(channel: string, fields: readonly MappingFieldRow[]): { stops: Map<string, string>; kept: string[] } {
  const excluded = pushExclusions(fields)
  const stops = new Map<string, string>()
  const kept: string[] = []
  if (channel === 'AMAZON') {
    const roots = amazonExcludedRoots(excluded)
    for (const root of roots) stops.set(root, root)
    for (const key of excluded.fieldKeys) if (!roots.has(amazonRootOf(key))) kept.push(`${key}: Amazon takes ${amazonRootOf(key)} as one field, and another column still sends it`)
    return { stops, kept: kept.sort() }
  }
  const specific = (name: string) => stops.set(foldName(name), `item specific “${name}”`)
  for (const f of fields) if (f.targetKind === 'itemSpecific' && f.targetKey && excluded.specifics.has(foldName(f.targetKey.replace(/^itemSpecifics\./, '')))) specific(f.targetKey.replace(/^itemSpecifics\./, ''))
  for (const key of excluded.fieldKeys) {
    const aspect = fields.find(f => f.targetKind === 'channelField' && f.targetKey === key && f.channelKey.startsWith('aspect:'))
    if (aspect) specific(aspect.channelKey.slice('aspect:'.length))
    else kept.push(`${key}: the eBay push follows a version for item specifics only`)
  }
  return { stops, kept: kept.sort() }
}

/**
 * The difference list shown before an activation or a retirement: which fields the push starts or stops sending, the
 * Owner's stops it cannot follow, and how many listings of that channel and market it touches.
 *   activate: this version replaces the form's ACTIVE one.  retire: this version stops being followed (no version after).
 */
export async function pushImpact(setId: string, on: 'activate' | 'retire' = 'activate'): Promise<MappingPushImpact | null> {
  const set = await prisma.channelMappingSet.findUnique({ where: { id: setId }, include: { fields: true } })
  if (!set) return null
  const none = { stops: new Map<string, string>(), kept: [] as string[] }
  const current = on === 'retire' ? (set.status === 'ACTIVE' ? set : null)
    : await prisma.channelMappingSet.findFirst({ where: { channel: set.channel, marketplace: set.marketplace, formKind: set.formKind, formKey: set.formKey, status: 'ACTIVE', id: { not: set.id } }, include: { fields: true } })
  const next = on === 'retire' ? none : pushStops(set.channel, set.fields.map(fieldRowOf))
  const before = current ? pushStops(set.channel, current.fields.map(fieldRowOf)) : none
  const stops = [...next.stops].filter(([key]) => !before.stops.has(key)).map(([, label]) => label).sort()
  const starts = [...before.stops].filter(([key]) => !next.stops.has(key)).map(([, label]) => label).sort()
  const listings = stops.length || starts.length ? await listingsOfForm(set.channel, set.marketplace, set.formKey.split('+')) : 0
  return { stops, starts, kept: next.kept, listings, replaces: on === 'activate' && current ? current.version : null,
    note: `${set.channel === 'AMAZON' ? 'Amazon' : 'eBay'} keeps the current value of a field Nexus stops sending. A new listing is created without it.` }
}

/** The listings of a channel and market whose product type (Amazon) or category (eBay) is in the form — the one the push uses. */
async function listingsOfForm(channel: string, marketplace: string, categories: string[]): Promise<number> {
  const listings = await prisma.channelListing.findMany({ where: { channel, marketplace, product: { deletedAt: null } }, select: { productId: true, platformAttributes: true } })
  if (!listings.length) return 0
  const { categoryForListing, resolveCategoriesForProducts } = await import('../pim/mapping/category-mapping.service.js')
  const resolved = await resolveCategoriesForProducts({ productIds: listings.map(l => l.productId), channel, marketplace })
  const wanted = new Set(categories.map(c => c.toUpperCase()))
  return listings.filter(l => wanted.has(String(categoryForListing(resolved[l.productId], channel, l.platformAttributes).channelCategoryId ?? '').toUpperCase())).length
}
