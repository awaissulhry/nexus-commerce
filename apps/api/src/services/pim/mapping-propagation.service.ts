/**
 * FM.5 — catalog propagation planner (read-only).
 *
 * "If the operator changes master attribute(s) X (or we recompute), what
 * does each mapped channel coordinate's value become, and what should the
 * operator review before applying?" Produces a deterministic per-(channel,
 * marketplace, fieldKey) diff by running every coordinate through the FM.2
 * resolver twice — once with current master attrs, once with the proposed
 * change overlaid — and diffing. No writes, no AI calls (cross-language
 * fields are FLAGGED needsTranslation; the FM.6 apply step fills them).
 *
 * Cascade semantics are encoded in applyMasterChanges: a master change
 * only reaches a coordinate that INHERITS the attribute (source master/
 * variant). A coordinate that overrides it (channelOverride/channelExplicit)
 * keeps its value — exactly the followMaster contract.
 */

import prisma from '../../db.js'
import { resolveAttributes, type ResolvedAttributes } from './attribute-resolver.js'
import { getResolvedRules } from './schema-mapping.service.js'
import { resolveChannelField, linkForCoordinate, isPresent, type FieldLinkGroupLike } from './resolve-channel-field.js'
import { loadFieldLinkGroups } from './payload-preview.js'
import { loadValueMapLookup, loadSizeScaleLookup } from './value-map.service.js'
import { PRICE_FIELD_KEYS, currencyForMarket } from '../field-resolution/propagation-fill.js'
import { valuesEqual } from './resolver-shadow.js'

export interface PropagationFlags {
  /** A transform changed the value (value-map / unit / template / …). */
  transformed: boolean
  /** Cross-language linked field whose translation isn't pinned yet. */
  needsTranslation: boolean
  /** The value was trimmed to the channel's max length. */
  channelLimitTrimmed: boolean
  /** A price field cascading to a different-currency market — skipped. */
  currencyMismatch: boolean
  /** Rule marks the field required but the proposed value is empty. */
  unmappedRequired: boolean
}

export interface MappingPropagationEntry {
  channel: string
  marketplace: string
  fieldKey: string
  current: unknown
  proposed: unknown
  /** update = will change; skip = guarded out (currency); unchanged kept
   *  only when flagged needsTranslation. */
  action: 'update' | 'skip' | 'unchanged'
  /** Target market language (for translate decisions / UI). */
  language: string | null
  flags: PropagationFlags
}

export interface MappingPropagationPlan {
  productId: string
  sku: string
  changedAttributes: string[]
  entries: MappingPropagationEntry[]
  counts: {
    total: number
    willUpdate: number
    needsReview: number
    skipped: number
    currencyMismatch: number
    unmappedRequired: number
  }
}

/**
 * Overlay master-attribute changes onto a coordinate's resolved attrs,
 * RESPECTING per-coordinate overrides: a change only lands where the
 * attribute is currently inherited (master/variant), never where the
 * coordinate pinned its own value. Pure.
 */
export function applyMasterChanges(
  base: ResolvedAttributes,
  changes: Record<string, unknown>,
): ResolvedAttributes {
  const next: ResolvedAttributes = { ...base }
  for (const [attr, value] of Object.entries(changes)) {
    const cur = base[attr]
    if (cur && (cur.source === 'channelOverride' || cur.source === 'channelExplicit')) {
      continue // coordinate overrides this attribute → master change doesn't reach it
    }
    next[attr] = { value, source: 'master', inheritedFrom: null }
  }
  return next
}

function channelLimited(warnings: string[]): boolean {
  return warnings.some(
    (w) => w.includes('truncat') || w.includes('channel limit') || w.includes('channel-limited'),
  )
}

/**
 * Build the per-field diff for one coordinate. Pure: takes the loaded
 * rules + base/proposed attrs + link groups + transform context.
 */
export function buildCoordinateEntries(args: {
  channel: string
  marketplace: string
  rules: Record<string, import('./schema-mapping.service.js').FieldMappingRule>
  baseAttrs: ResolvedAttributes
  proposedAttrs: ResolvedAttributes
  product: { localizedContent: unknown; categoryAttributes: unknown; variantAttributes: unknown }
  locale: string
  links: FieldLinkGroupLike[]
  transformCtx?: Parameters<typeof resolveChannelField>[0]['transformCtx']
  /** Source currency for the price guard (default EUR — Xavia's master). */
  sourceCurrency: string
}): MappingPropagationEntry[] {
  const { channel, marketplace, rules, baseAttrs, proposedAttrs, product, locale, links, transformCtx, sourceCurrency } = args
  const out: MappingPropagationEntry[] = []

  for (const [fieldKey, rule] of Object.entries(rules)) {
    const link = linkForCoordinate(links, fieldKey, channel, marketplace, null)
    const common = { fieldKey, rule, product, locale, link, transformCtx }
    const cur = resolveChannelField({ ...common, resolvedAttrs: baseAttrs })
    const prop = resolveChannelField({ ...common, resolvedAttrs: proposedAttrs })

    const changed = !valuesEqual(cur.value, prop.value)
    if (!changed && !prop.needsTranslation) continue // unaffected — don't surface

    let action: MappingPropagationEntry['action'] = changed || prop.needsTranslation ? 'update' : 'unchanged'
    const flags: PropagationFlags = {
      transformed: prop.appliedTransforms.length > 0,
      needsTranslation: prop.needsTranslation,
      channelLimitTrimmed: channelLimited(prop.warnings),
      currencyMismatch: false,
      unmappedRequired: prop.required && !isPresent(prop.value),
    }

    // Currency guard — never cascade a raw price across currencies.
    if (PRICE_FIELD_KEYS.has(fieldKey) && currencyForMarket(marketplace) !== sourceCurrency) {
      flags.currencyMismatch = true
      action = 'skip'
    }

    out.push({
      channel,
      marketplace,
      fieldKey,
      current: cur.value,
      proposed: prop.value,
      action,
      language: link?.targetLanguage ?? null,
      flags,
    })
  }

  return out
}

/**
 * Plan the fan-out of a master-attribute change across a product's mapped
 * channel coordinates. Read-only.
 */
export async function planMappingPropagation(input: {
  productId: string
  /** Master attribute key → proposed new value. */
  changes: Record<string, unknown>
  /** Optional channel filter (default: every channel the product lists on). */
  channels?: string[]
  /** Optional marketplace filter. */
  markets?: string[]
  locale?: string
  /** Currency source for the price guard (default IT → EUR). */
  sourceMarketplace?: string
}): Promise<MappingPropagationPlan> {
  const locale = input.locale ?? 'en'

  const product = await prisma.product.findUnique({ where: { id: input.productId } })
  if (!product) throw new Error(`Product not found: ${input.productId}`)
  const parent = product.parentId
    ? await prisma.product.findUnique({ where: { id: product.parentId } })
    : null

  const listings = await prisma.channelListing.findMany({ where: { productId: input.productId } })
  const links = await loadFieldLinkGroups(input.productId)
  const sourceCurrency = currencyForMarket(input.sourceMarketplace ?? 'IT')
  const lookupSizeScale = await loadSizeScaleLookup()

  let coords = listings.filter((l) => l.channel && l.marketplace)
  if (input.channels?.length) coords = coords.filter((l) => input.channels!.includes(l.channel))
  if (input.markets?.length) coords = coords.filter((l) => input.markets!.includes(l.marketplace as string))

  const entries: MappingPropagationEntry[] = []
  for (const l of coords) {
    const channel = l.channel
    const marketplace = l.marketplace as string
    const rules = await getResolvedRules(channel, marketplace, product.productType)
    if (Object.keys(rules).length === 0) continue
    const lookupValueMap = await loadValueMapLookup(channel, marketplace)
    const baseAttrs = resolveAttributes({
      product: product as any,
      parent: parent as any,
      channelListing: l as any,
      locale,
    })
    const proposedAttrs = applyMasterChanges(baseAttrs, input.changes)
    entries.push(
      ...buildCoordinateEntries({
        channel,
        marketplace,
        rules,
        baseAttrs,
        proposedAttrs,
        product: product as any,
        locale,
        links,
        transformCtx: { lookupValueMap, lookupSizeScale },
        sourceCurrency,
      }),
    )
  }

  const counts = {
    total: entries.length,
    willUpdate: entries.filter((e) => e.action === 'update').length,
    needsReview: entries.filter((e) => e.flags.needsTranslation).length,
    skipped: entries.filter((e) => e.action === 'skip').length,
    currencyMismatch: entries.filter((e) => e.flags.currencyMismatch).length,
    unmappedRequired: entries.filter((e) => e.flags.unmappedRequired).length,
  }

  return {
    productId: input.productId,
    sku: product.sku,
    changedAttributes: Object.keys(input.changes),
    entries,
    counts,
  }
}
