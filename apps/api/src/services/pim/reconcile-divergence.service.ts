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
import { resolveAttributes, type ResolvedAttributes } from './attribute-resolver.js'
import { getResolvedRules, type FieldMappingRule } from './schema-mapping.service.js'
import { resolveChannelField, linkForCoordinate, type FieldLinkGroupLike } from './resolve-channel-field.js'
import { loadFieldLinkGroups } from './payload-preview.js'
import { loadValueMapLookup, loadSizeScaleLookup } from './value-map.service.js'
import { valuesEqual } from './resolver-shadow.js'

export interface DivergenceEntry {
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
    const link = linkForCoordinate(links, fieldKey, channel, marketplace, null)
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
  const locale = input.locale ?? 'en'

  const product = await prisma.product.findUnique({ where: { id: input.productId } })
  if (!product) throw new Error(`Product not found: ${input.productId}`)
  const parent = product.parentId
    ? await prisma.product.findUnique({ where: { id: product.parentId } })
    : null

  const listings = await prisma.channelListing.findMany({ where: { productId: input.productId } })
  const links = await loadFieldLinkGroups(input.productId)
  const lookupSizeScale = await loadSizeScaleLookup()

  // Master-only resolved attrs (no channelListing → no per-coordinate
  // overrides) — the baseline every coordinate is compared against.
  const masterAttrs = resolveAttributes({ product: product as any, parent: parent as any, locale })

  const entries: DivergenceEntry[] = []
  const coords = new Set<string>()
  for (const l of listings) {
    if (!l.channel || !l.marketplace) continue
    const channel = l.channel
    const marketplace = l.marketplace as string
    const rules = await getResolvedRules(channel, marketplace, product.productType)
    if (Object.keys(rules).length === 0) continue
    const lookupValueMap = await loadValueMapLookup(channel, marketplace)
    const channelAttrs = resolveAttributes({
      product: product as any,
      parent: parent as any,
      channelListing: l as any,
      locale,
    })
    const found = findCoordinateDivergences({
      channel,
      marketplace,
      rules,
      masterAttrs,
      channelAttrs,
      product: product as any,
      locale,
      links,
      transformCtx: { lookupValueMap, lookupSizeScale },
    })
    for (const e of found) coords.add(`${e.channel}/${e.marketplace}`)
    entries.push(...found)
  }

  return {
    productId: input.productId,
    sku: product.sku,
    entries,
    counts: { total: entries.length, coordinates: coords.size },
  }
}
