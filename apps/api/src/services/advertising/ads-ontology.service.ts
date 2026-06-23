/**
 * CP P1.1 — Ad ontology graph (lazy children for the Control Plane canvas).
 *
 * One level per call so the canvas drills on demand instead of loading the
 * whole account: market → campaigns → ad groups → targets. Each node carries
 * its act-on-able properties (budget/bid/status/suppression) + hasChildren so
 * the UI can show an expand affordance. Positive targets only (negatives carry
 * no spend bid). ARCHIVED entities are hidden.
 */
import prisma from '../../db.js'

export interface OntologyNode {
  id: string
  type: 'campaign' | 'adgroup' | 'target'
  name: string
  status: string
  spendCents: number
  hasChildren: boolean
  // type-specific actionable props
  dailyBudgetCents?: number
  suppressed?: boolean
  defaultBidCents?: number
  targetingType?: string
  bidCents?: number
  kind?: string
  expressionType?: string
}

export async function getOntologyChildren(opts: { parentType: 'market' | 'campaign' | 'adgroup'; parentId: string }): Promise<{ parentType: string; parentId: string; children: OntologyNode[] }> {
  const { parentType, parentId } = opts

  if (parentType === 'market') {
    const camps = await prisma.campaign.findMany({
      where: { marketplace: parentId, status: { not: 'ARCHIVED' } },
      select: { id: true, name: true, status: true, dailyBudget: true, spend: true, bidsSuppressedAt: true, _count: { select: { adGroups: true } } },
      orderBy: { spend: 'desc' },
      take: 500,
    })
    return { parentType, parentId, children: camps.map((c) => ({ id: c.id, type: 'campaign', name: c.name, status: c.status, spendCents: Math.round(Number(c.spend ?? 0) * 100), dailyBudgetCents: Math.round(Number(c.dailyBudget ?? 0) * 100), suppressed: !!c.bidsSuppressedAt, hasChildren: c._count.adGroups > 0 })) }
  }

  if (parentType === 'campaign') {
    const groups = await prisma.adGroup.findMany({
      where: { campaignId: parentId, status: { not: 'ARCHIVED' } },
      select: { id: true, name: true, status: true, defaultBidCents: true, targetingType: true, spendCents: true, _count: { select: { targets: true } } },
      orderBy: { spendCents: 'desc' },
      take: 500,
    })
    return { parentType, parentId, children: groups.map((g) => ({ id: g.id, type: 'adgroup', name: g.name, status: g.status, spendCents: g.spendCents, defaultBidCents: g.defaultBidCents, targetingType: g.targetingType, hasChildren: g._count.targets > 0 })) }
  }

  const targets = await prisma.adTarget.findMany({
    where: { adGroupId: parentId, isNegative: false, status: { not: 'ARCHIVED' } },
    select: { id: true, expressionValue: true, status: true, bidCents: true, kind: true, expressionType: true, spendCents: true },
    orderBy: { spendCents: 'desc' },
    take: 500,
  })
  return { parentType, parentId, children: targets.map((t) => ({ id: t.id, type: 'target', name: t.expressionValue, status: t.status, spendCents: t.spendCents, bidCents: t.bidCents, kind: t.kind, expressionType: t.expressionType, hasChildren: false })) }
}
