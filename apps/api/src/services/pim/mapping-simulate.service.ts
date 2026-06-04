/**
 * FM.14 — rule-change impact simulation.
 *
 * Before saving a rule, estimate its blast radius: across the products
 * listed on a (channel, marketplace), how many would have THIS field's
 * resolved value change under the proposed rule vs the current one — plus a
 * sample of before→after diffs. Read-only.
 *
 * Per-product links are intentionally NOT consulted here (they're rare
 * exceptions the operator handles per-product); the simulation measures the
 * RULE's reach over the master-following baseline + per-coordinate overrides
 * (overridden coordinates resolve to their override under both rules → not
 * counted as affected, which is correct: a rule change doesn't move them).
 */

import prisma from '../../db.js'
import { resolveAttributes, type ResolvedAttributes } from './attribute-resolver.js'
import { getResolvedRules, type FieldMappingRule } from './schema-mapping.service.js'
import { resolveChannelField } from './resolve-channel-field.js'
import { loadValueMapLookup, loadSizeScaleLookup } from './value-map.service.js'
import { valuesEqual } from './resolver-shadow.js'

/**
 * Pure per-candidate decision: resolve the field under the current rule and
 * the proposed rule (same attrs), report whether it changes. currentRule
 * undefined = the field is being newly mapped (current value is absent).
 */
export function simulateFieldForCandidate(args: {
  fieldKey: string
  currentRule: FieldMappingRule | undefined
  proposedRule: FieldMappingRule
  resolvedAttrs: ResolvedAttributes
  product: { localizedContent: unknown; categoryAttributes: unknown; variantAttributes: unknown }
  locale: string
  transformCtx?: Parameters<typeof resolveChannelField>[0]['transformCtx']
}): { current: unknown; proposed: unknown; changed: boolean } {
  const common = {
    fieldKey: args.fieldKey,
    resolvedAttrs: args.resolvedAttrs,
    product: args.product,
    locale: args.locale,
    link: null,
    transformCtx: args.transformCtx,
  }
  const proposed = resolveChannelField({ ...common, rule: args.proposedRule }).value
  const current = args.currentRule ? resolveChannelField({ ...common, rule: args.currentRule }).value : undefined
  return { current, proposed, changed: !valuesEqual(current, proposed) }
}

export interface SimulateResult {
  fieldKey: string
  totalCandidates: number
  scanned: number
  affectedCount: number
  capped: boolean
  samples: Array<{ productId: string; sku: string; current: unknown; proposed: unknown }>
}

export async function simulateRuleChange(input: {
  channel: string
  code: string
  fieldKey: string
  rule: FieldMappingRule
  productType?: string | null
  locale?: string
  limit?: number
  sampleSize?: number
}): Promise<SimulateResult> {
  const locale = input.locale ?? 'en'
  const limit = Math.min(input.limit ?? 300, 1000)
  const sampleSize = input.sampleSize ?? 20

  const where = {
    channel: input.channel,
    marketplace: input.code,
    ...(input.productType ? { product: { productType: input.productType } } : {}),
  }
  const totalCandidates = await prisma.channelListing.count({ where })
  const listings = await prisma.channelListing.findMany({
    where,
    take: limit,
    orderBy: { id: 'asc' },
    include: { product: true },
  })
  const capped = totalCandidates > listings.length

  // Batch-load parents for variant resolution.
  const parentIds = [
    ...new Set(listings.map((l) => l.product?.parentId).filter((x): x is string => !!x)),
  ]
  const parents = parentIds.length
    ? await prisma.product.findMany({ where: { id: { in: parentIds } } })
    : []
  const parentById = new Map(parents.map((p) => [p.id, p]))

  const currentRules = await getResolvedRules(input.channel, input.code, input.productType ?? undefined)
  const currentRule = currentRules[input.fieldKey] // undefined when adding a new rule

  const transformCtx = {
    lookupValueMap: await loadValueMapLookup(input.channel, input.code),
    lookupSizeScale: await loadSizeScaleLookup(),
  }

  let affectedCount = 0
  const samples: SimulateResult['samples'] = []
  for (const l of listings) {
    const product = l.product
    if (!product) continue
    const parent = product.parentId ? parentById.get(product.parentId) ?? null : null
    const resolvedAttrs = resolveAttributes({
      product: product as any,
      parent: parent as any,
      channelListing: l as any,
      locale,
    })
    const { current, proposed, changed } = simulateFieldForCandidate({
      fieldKey: input.fieldKey,
      currentRule,
      proposedRule: input.rule,
      resolvedAttrs,
      product: product as any,
      locale,
      transformCtx,
    })
    if (changed) {
      affectedCount++
      if (samples.length < sampleSize) {
        samples.push({ productId: product.id, sku: product.sku, current, proposed })
      }
    }
  }

  return { fieldKey: input.fieldKey, totalCandidates, scanned: listings.length, affectedCount, capped, samples }
}
