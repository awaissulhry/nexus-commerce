/**
 * FM.12 — divergence reconciliation (read-only scan).
 *
 * Finds per-coordinate fields where the operator PINNED a value (a channel
 * override) that diverges from what the catalog mapping + master would
 * resolve. Surfaces them so the operator can adopt-master (drop the
 * override → follow master, re-syncing it) or keep (intentional). The scan
 * resolves each field twice — once with the coordinate's overrides
 * (channelAttrs) and once master-only (no channelListing) — and reports the
 * fields whose override differs from the master-resolved value.
 *
 * Read-only. The bulk adopt/keep apply (reuses FM.6) + live drift surfacing
 * via SSE are FM.12 follow-ons.
 */

import prisma from '../../db.js'
import { type ResolvedAttributes } from './attribute-resolver.js'
import { type FieldMappingRule } from './schema-mapping.service.js'
import { resolveChannelField, linkForCoordinate, type FieldLinkGroupLike } from './resolve-channel-field.js'
import { resolveBatch } from './mapping/resolve-batch.service.js'
import { channelValuePatch, storedChannelState } from './channel-value-mutation.js'
import type { Prisma } from '@prisma/client'
import { valuesEqual } from './resolver-shadow.js'

// B.6 — adopt-master: clear a per-coordinate override so the field follows
// master again. Well-known fields are gated by a followMaster* flag (set it
// true → the resolver ignores the *Override column); everything else lives in
// the overrideData JSON bag (delete the key). Mirrors the resolver's own
// override model in attribute-resolver.ts.
const WELL_KNOWN_FOLLOW: Record<string, string> = {
  title: 'followMasterTitle',
  description: 'followMasterDescription',
  price: 'followMasterPrice',
  quantity: 'followMasterQuantity',
  bulletPoints: 'followMasterBulletPoints',
}

/** Pure: the ChannelListing update that adopts master for one attribute. */
export function buildAdoptMasterUpdate(
  overrideData: Record<string, unknown> | null,
  attribute: string,
): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  const od = overrideData ?? {}
  if (attribute in od) {
    const next = { ...od }
    delete next[attribute]
    data.overrideData = next
  }
  const followFlag = WELL_KNOWN_FOLLOW[attribute]
  if (followFlag) data[followFlag] = true
  return data
}

/** Clear a coordinate's override for one master attribute (adopt master). */
export async function adoptMasterForCoordinate(input: {
  productId: string
  channel: string
  marketplace: string
  attribute: string
  channelConnectionId?: string | null
  aliasKey?: string
  expectedVersion?: number
  actor?: string | null
}): Promise<{ ok: true; changed: boolean }> {
  const listings = await prisma.channelListing.findMany({ where: { productId: input.productId,
    channel: input.channel, marketplace: input.marketplace,
    ...(input.channelConnectionId !== undefined ? { channelConnectionId: input.channelConnectionId } : {}),
    aliasKey: input.aliasKey ?? '' } })
  if (!listings.length) throw new Error('No listing for this coordinate')
  if (listings.length !== 1) throw Object.assign(new Error('Select the listing account before adopting Master.'), { statusCode: 409 })
  const listing = listings[0]
  if (input.expectedVersion === undefined || input.expectedVersion !== listing.version) {
    throw Object.assign(new Error('The listing changed or its version is missing. Reload before adopting Master.'), { statusCode: 409 })
  }
  const result = await resolveBatch({ productIds: [input.productId], channel: input.channel,
    marketplace: input.marketplace, channelConnectionId: listing.channelConnectionId, aliasKey: listing.aliasKey })
  const field = result.catalogue?.fields.find(f => f.fieldKey === input.attribute)
  if (!field || field.sourceOwner || !result.products[0]?.cells[field.fieldKey]?.rule) {
    throw Object.assign(new Error('This field has no shared mapping to adopt. Open its owning workspace.'), { statusCode: 400 })
  }
  const keys = [...new Set([field.sheetKey ?? field.fieldKey, field.fieldKey])]
  const state = storedChannelState(listing as unknown as Record<string, unknown>, field.channelStore, keys)
  if (state.state === 'inherited') return { ok: true, changed: false }
  const data = channelValuePatch(listing as unknown as Record<string, unknown>, field.channelStore, keys, 'INHERIT')
  await prisma.$transaction(async tx => {
    const written = await tx.channelListing.updateMany({ where: { id: listing.id, version: listing.version, updatedAt: listing.updatedAt },
      data: { ...data, version: { increment: 1 } } as Prisma.ChannelListingUpdateManyMutationInput })
    if (written.count !== 1) throw Object.assign(new Error('The listing changed. Reload before adopting Master.'), { statusCode: 409 })
    await tx.channelListingOverride.create({ data: { channelListingId: listing.id, fieldName: field.fieldKey,
      previousValue: JSON.stringify(state.value) ?? null, newValue: null, isActive: false,
      changedBy: input.actor ?? null, reason: 'Adopt shared mapping' } })
  })
  return { ok: true, changed: true }
}

export interface DivergenceEntry {
  listingId?: string
  channelConnectionId?: string | null
  aliasKey?: string
  listingVersion?: number
  channel: string
  marketplace: string
  fieldKey: string
  /** The value the coordinate currently pins (an override). */
  overrideValue: unknown
  /** What following the master + catalog mapping would resolve to. */
  masterValue: unknown
}

export interface DivergenceReport {
  productId: string
  sku: string
  entries: DivergenceEntry[]
  counts: { total: number; coordinates: number }
}

/**
 * Pure per-coordinate divergence finder: for each mapped field, if the
 * channel-resolved value is a per-coordinate override AND differs from the
 * master-resolved value, it's a divergence. Both attr sets + the rules are
 * supplied by the caller (DB-loaded).
 */
export function findCoordinateDivergences(args: {
  channel: string
  marketplace: string
  rules: Record<string, FieldMappingRule>
  masterAttrs: ResolvedAttributes
  channelAttrs: ResolvedAttributes
  product: { localizedContent: unknown; categoryAttributes: unknown; variantAttributes: unknown }
  locale: string
  links: FieldLinkGroupLike[]
  transformCtx?: Parameters<typeof resolveChannelField>[0]['transformCtx']
}): DivergenceEntry[] {
  const { channel, marketplace, rules, masterAttrs, channelAttrs, product, locale, links, transformCtx } = args
  const out: DivergenceEntry[] = []
  for (const [fieldKey, rule] of Object.entries(rules)) {
    const link = linkForCoordinate(links, fieldKey, channel, marketplace, null, locale)
    const common = { fieldKey, rule, product, locale, link, transformCtx }
    const chan = resolveChannelField({ ...common, resolvedAttrs: channelAttrs })
    if (chan.source !== 'override') continue // only operator-pinned fields can diverge
    const mast = resolveChannelField({ ...common, resolvedAttrs: masterAttrs })
    if (!valuesEqual(chan.value, mast.value)) {
      out.push({ channel, marketplace, fieldKey, overrideValue: chan.value, masterValue: mast.value })
    }
  }
  return out
}

/** Scan one product's coordinates for override-vs-master divergence. */
export async function scanProductDivergence(input: {
  productId: string
  locale?: string
}): Promise<DivergenceReport> {
  const product = await prisma.product.findUnique({ where: { id: input.productId }, select: { id: true, sku: true } })
  if (!product) throw new Error(`Product not found: ${input.productId}`)
  const listings = await prisma.channelListing.findMany({ where: { productId: input.productId } })
  const entries: DivergenceEntry[] = []
  const coords = new Set<string>()
  for (const listing of listings) {
    if (!listing.channel || !listing.marketplace) continue
    const coordinate = { channel: listing.channel, marketplace: listing.marketplace,
      channelConnectionId: listing.channelConnectionId, aliasKey: listing.aliasKey }
    const args = { ...coordinate, productIds: [input.productId], locale: input.locale, includeCatalogue: false }
    const current = await resolveBatch(args)
    const inherited = await resolveBatch({ ...args, inheritMappedFields: true })
    for (const cell of Object.values(current.products[0]?.cells ?? {})) {
      const master = inherited.products[0]?.cells[cell.fieldKey]
      if (cell.provenance !== 'override' || !master || valuesEqual(cell.value, master.value)) continue
      entries.push({ ...coordinate, listingId: listing.id, listingVersion: listing.version, fieldKey: cell.fieldKey,
        overrideValue: cell.value, masterValue: master.value })
      coords.add(listing.id)
    }
  }
  return { productId: product.id, sku: product.sku, entries, counts: { total: entries.length, coordinates: coords.size } }
}
