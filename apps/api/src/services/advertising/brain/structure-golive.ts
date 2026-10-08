/**
 * ONE BRAIN AB-16 — the go-live of a campaign the brain built (design 2026-10-08-ads-one-brain/DESIGN.md §2.9 "Going live
 * (D1 = B)", §10 D1 = B): the question the Owner's code rule asks (services/agents/tools/ads-code-rule.ts, the line
 * 'brain structure go-live: inside an enrolled product, inside caps') at the three doors a new structure goes live through —
 * set-campaign-live-writes on, restore-campaign of a campaign born at the floor, and apply-ads-playbook start.
 *
 *   brain-built  a campaign the brain's own approved build made (AdsBrainStructure.builtCampaignIds of a proposal that is
 *                BUILT or LIVE_PROPOSED): a single-keyword campaign, or a split's copy. Anything else — a campaign a person or
 *                Claude built, one of a proposal that went live already — is answered null: the door's own line, as before.
 *   inside caps  brain/structure.ts goLiveVerdict on the facts read now: the campaign's product is enrolled in the market and
 *                its structure lever still PROPOSE (the Owner did not take it back), no kill switch stops it, the env ceiling
 *                is live, the campaign's daily budget is
 *                inside the first-budget cap, the product's live single-keyword campaigns are below skcMax, and its money
 *                brake holds no raise. Several campaigns at one door: inside only when every one is.
 *
 * Reads only. A read that fails answers null (the door's own line: the code, as before) — never a looser door.
 */
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { resolveBrainSettings, type OverrideRow } from './settings.js'
import { leverKillWhy } from './kill-switch.js'
import { structureCeiling } from './structure-load.js'
import { firstBudgetCap, goLiveVerdict, type StructureKind } from './structure.js'
import type { LeverEffective } from './terms.js'

const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {})

export interface StructureGoLive {
  /** Every campaign named is inside the caps: a normal approval sends its go-live (D1 = B). */
  inside: boolean
  /** In words, per campaign when they differ. */
  why: string
  campaigns: Array<{ campaignId: string; key: string; productId: string; inside: boolean; why: string }>
}

/** The product a brain-built campaign is for: the proposal's (an SKC), or the copy's (a split: its step's product). */
export function productOf(row: { kind: string; productId: string; plan: unknown; evidence: unknown }, campaignId: string): string {
  if (row.kind !== 'SPLIT') return row.productId
  const plan = obj(row.plan)
  const built = Array.isArray(plan.built) ? plan.built as string[][] : []
  const copies = Array.isArray(obj(row.evidence).copies) ? obj(row.evidence).copies as Array<{ productId: string }> : []
  const step = built.findIndex((ids) => Array.isArray(ids) && ids.includes(campaignId))
  return (step >= 0 ? copies[step]?.productId : null) ?? row.productId
}

/**
 * Is the go-live of these campaigns a brain-built structure inside its caps? Null when any of them is not a campaign the
 * brain built and is waiting to go live (the door's own line applies), or when the facts cannot be read.
 */
export async function structureGoLive(campaignIds: readonly string[]): Promise<StructureGoLive | null> {
  const ids = [...new Set(campaignIds.filter(Boolean))]
  if (!ids.length) return null
  try {
    const rows = await prisma.adsBrainStructure.findMany({
      where: { builtCampaignIds: { hasSome: ids }, status: { in: ['BUILT', 'LIVE_PROPOSED'] } },
      select: { key: true, kind: true, status: true, productId: true, marketplace: true, plan: true, evidence: true, builtCampaignIds: true },
    })
    const rowOf = new Map<string, (typeof rows)[number]>()
    for (const r of rows) for (const id of r.builtCampaignIds) if (ids.includes(id)) rowOf.set(id, r)
    if (ids.some((id) => !rowOf.has(id))) return null
    const pairs = ids.map((id) => ({ campaignId: id, row: rowOf.get(id)!, productId: productOf(rowOf.get(id)!, id) }))
    const products = [...new Set(pairs.map((p) => p.productId))]
    const markets = [...new Set(pairs.map((p) => p.row.marketplace))]
    const [campaigns, enrollments, overrides, budgets, liveSkcs] = await Promise.all([
      prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, dailyBudget: true } }),
      prisma.adsBrainEnrollment.findMany({ where: { productId: { in: products }, marketplace: { in: markets } }, select: { productId: true, marketplace: true } }),
      prisma.adsBrainOverride.findMany({ where: { endedAt: null, scope: 'PRODUCT', productId: { in: products } }, select: OVERRIDE_SELECT }) as Promise<OverrideRow[]>,
      prisma.adsBrainBudgetDecision.findMany({ where: { productId: { in: products }, marketplace: { in: markets } }, orderBy: { createdAt: 'desc' }, select: { productId: true, marketplace: true, envelopeCents: true, month: true, brake: true }, take: 200 }),
      prisma.adsBrainStructure.groupBy({ by: ['productId', 'marketplace'], where: { kind: 'SKC', status: 'LIVE', productId: { in: products } }, _count: { _all: true } }),
    ])
    const ceiling = structureCeiling()
    const kills = new Map<string, string | null>()
    for (const p of pairs) {
      const k = `${p.productId}\u0000${p.row.marketplace}`
      if (!kills.has(k)) kills.set(k, await leverKillWhy('structure', p.productId, p.row.marketplace))
    }
    const out = pairs.map(({ campaignId, row, productId }) => {
      const market = row.marketplace
      const enrolled = enrollments.some((e) => e.productId === productId && e.marketplace === market)
      const s = resolveBrainSettings({ productId, market, campaignId: null, enrolled, overrides })
      const plan = budgets.find((b) => b.productId === productId && b.marketplace === market)
      const withEnvelope = budgets.find((b) => b.productId === productId && b.marketplace === market && b.envelopeCents != null)
      const cap = firstBudgetCap(withEnvelope?.envelopeCents ?? null, withEnvelope?.month ?? null, Number(s.values.firstBudgetPctOfEnvelope.value))
      const c = campaigns.find((x) => x.id === campaignId)
      const v = goLiveVerdict({
        kind: row.kind as StructureKind, status: row.status, enrolled,
        structure: s.levers.structure.effective as LeverEffective, structureWhy: s.levers.structure.why,
        budgetCents: c?.dailyBudget != null ? Math.round(Number(c.dailyBudget) * 100) : null, budgetCapCents: cap.cents,
        liveSkcs: liveSkcs.find((l) => l.productId === productId && l.marketplace === market)?._count._all ?? 0, skcMax: Number(s.values.skcMax.value),
        brake: plan?.brake ?? null,
        killed: kills.get(`${productId}\u0000${market}`) ?? null, ceiling,
      })
      return { campaignId, key: row.key, productId, inside: v.inside, why: v.why }
    })
    const inside = out.every((o) => o.inside)
    const whys = [...new Set(out.map((o) => o.why))]
    return { inside, why: whys.length === 1 ? whys[0] : out.map((o) => `${o.campaignId}: ${o.why}`).join(' · '), campaigns: out }
  } catch (error) {
    logger.warn('[ads-brain-structure] the go-live facts could not be read: the code rule applies as before', { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}
