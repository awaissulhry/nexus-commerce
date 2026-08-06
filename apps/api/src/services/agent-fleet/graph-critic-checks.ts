/**
 * NAF.H — H2: the critic's STRUCTURAL checks. Phase C's pairwise
 * same-term query only sees literal keyword clashes; the graph sees the
 * relationships the substrate derived — a campaign that cannibalizes
 * another without sharing a single verbatim term, and spend pointed at
 * variations whose pooled stock cannot support it.
 *
 * Advisories, not forced blocks: the graph is derived nightly and can be
 * a day old, so the critic model weighs them (the prompt already names
 * both checks). An empty graph yields no advisories — never a fabricated
 * concern.
 */
import type { PlanItemT } from '@nexus/shared/agent-fleet'
import prisma from '../../db.js'
import { neighbors } from './graph-traversal.service.js'

export interface GraphAdvisory {
  check: string
  findingId?: string
  note: string
}

const externalIdsOf = (item: PlanItemT): string[] => {
  const args = item.args as Record<string, unknown>
  return [args.externalCampaignId, args.sourceExternalCampaignId]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
}

export async function computeGraphAdvisories(
  items: PlanItemT[],
): Promise<GraphAdvisory[]> {
  const advisories: GraphAdvisory[] = []
  const wanted = new Map<string, PlanItemT[]>()
  for (const item of items) {
    for (const ext of externalIdsOf(item)) {
      wanted.set(ext, [...(wanted.get(ext) ?? []), item])
    }
  }
  if (wanted.size === 0) return advisories

  const campaigns = await prisma.campaign.findMany({
    where: { externalCampaignId: { in: [...wanted.keys()] } },
    select: { id: true, name: true, externalCampaignId: true },
  })

  for (const c of campaigns) {
    const touching = wanted.get(c.externalCampaignId!) ?? []
    const edges = await neighbors('campaign', c.id, [
      'COMPETES_WITH',
      'CANNIBALIZES',
      'SHARES_INVENTORY',
    ])

    for (const e of edges) {
      const otherId = e.fromId === c.id ? e.toId : e.fromId
      const props = (e.properties ?? {}) as Record<string, unknown>
      if (e.relation === 'CANNIBALIZES' || e.relation === 'COMPETES_WITH') {
        const context =
          e.relation === 'CANNIBALIZES'
            ? `graph edge: ${e.fromId === c.id ? 'this campaign cannibalizes' : 'this campaign is cannibalized by'} campaign ${otherId}${props.on ? ` on ${String(props.on)}` : ''}`
            : `graph edge: competes with campaign ${otherId}${Array.isArray(props.sharedKeywords) ? ` on ${(props.sharedKeywords as string[]).slice(0, 3).join(', ')}` : ''}`
        for (const item of touching) {
          advisories.push({
            check: 'no_self_competition',
            findingId: item.findingId,
            note: `${c.name}: ${context} — structural, independent of literal term overlap`,
          })
        }
      }
      if (e.relation === 'SHARES_INVENTORY') {
        for (const item of touching) {
          advisories.push({
            check: 'inventory_supports_spend',
            findingId: item.findingId,
            note: `${c.name}: shares the inventory pool with campaign ${otherId} (${String(props.variationIds ? (props.variationIds as unknown[]).length : '?')} shared variation(s)) — added spend here draws the same stock`,
          })
        }
      }
    }

    // inventory floor: what this campaign advertises must be in stock.
    const targets = await neighbors('campaign', c.id, ['TARGETS'])
    const productIds = targets
      .filter((t) => t.fromId === c.id)
      .map((t) => t.toId)
    if (productIds.length > 0) {
      const products = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { totalStock: true },
      })
      const totalStock = products.reduce((s, p) => s + p.totalStock, 0)
      if (totalStock === 0) {
        for (const item of touching) {
          advisories.push({
            check: 'inventory_supports_spend',
            findingId: item.findingId,
            note: `${c.name}: every advertised product is at ZERO stock (${productIds.length} product(s)) — spend here buys clicks for nothing sellable`,
          })
        }
      }
    }
  }
  return advisories
}
