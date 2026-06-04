/**
 * FM.13 — mapping coverage dashboard.
 *
 * Aggregates, per (channel, marketplace) and per productType overlay, how
 * much of the channel's schema is mapped: total fields, mapped, required,
 * required-unmapped, and a coverage %. Read-only — feeds the cross-market
 * coverage matrix on the Console (the per-market readout in FM.9 is the
 * single-cell view; this is the whole grid).
 */

import prisma from '../../db.js'
import { getMappingForMarketplace, getResolvedRules, MarketplaceNotFoundError } from './schema-mapping.service.js'

export interface CoverageStats {
  totalFields: number
  mappedFields: number
  requiredFields: number
  requiredUnmapped: number
  coveragePct: number
}

export interface MarketplaceCoverage extends CoverageStats {
  channel: string
  code: string
  byProductType: Array<{ productType: string } & CoverageStats>
}

/** Pure coverage math over a deduped field list + a rule set. */
export function statsFor(
  fields: { fieldKey: string; required: boolean }[],
  rules: Record<string, unknown>,
): CoverageStats {
  const totalFields = fields.length
  const mappedFields = fields.filter((f) => rules[f.fieldKey]).length
  const requiredFields = fields.filter((f) => f.required).length
  const requiredUnmapped = fields.filter((f) => f.required && !rules[f.fieldKey]).length
  return {
    totalFields,
    mappedFields,
    requiredFields,
    requiredUnmapped,
    coveragePct: totalFields ? Math.round((mappedFields / totalFields) * 100) : 0,
  }
}

export async function computeMarketplaceCoverage(channel: string, code: string): Promise<MarketplaceCoverage> {
  const raw = await prisma.channelSchema.findMany({
    where: { channel, OR: [{ marketplace: code }, { marketplace: null }] },
    select: { fieldKey: true, required: true, marketplace: true },
  })
  // Dedup by fieldKey — a marketplace-specific row wins over the global (null) one.
  const byKey = new Map<string, { fieldKey: string; required: boolean }>()
  for (const f of raw) {
    if (!byKey.has(f.fieldKey) || f.marketplace === code) {
      byKey.set(f.fieldKey, { fieldKey: f.fieldKey, required: f.required })
    }
  }
  const fields = [...byKey.values()]

  const defaultRules = await getResolvedRules(channel, code)

  let productTypes: string[] = []
  try {
    const mapping = await getMappingForMarketplace(channel, code)
    productTypes = Object.keys(mapping.byProductType ?? {})
  } catch (err) {
    if (!(err instanceof MarketplaceNotFoundError)) throw err
  }

  const byProductType: Array<{ productType: string } & CoverageStats> = []
  for (const pt of productTypes) {
    const rules = await getResolvedRules(channel, code, pt)
    byProductType.push({ productType: pt, ...statsFor(fields, rules) })
  }

  return { channel, code, ...statsFor(fields, defaultRules), byProductType }
}

/** Coverage for every marketplace (optionally filtered by channel). */
export async function computeCoverageMatrix(channelFilter?: string): Promise<{ marketplaces: MarketplaceCoverage[] }> {
  const markets = await prisma.marketplace.findMany({
    where: channelFilter ? { channel: channelFilter } : undefined,
    select: { channel: true, code: true },
    orderBy: [{ channel: 'asc' }, { code: 'asc' }],
  })
  const marketplaces: MarketplaceCoverage[] = []
  for (const m of markets) {
    marketplaces.push(await computeMarketplaceCoverage(m.channel, m.code))
  }
  return { marketplaces }
}
