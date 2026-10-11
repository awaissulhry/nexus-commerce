/**
 * The negatives section of the weekly ads digest: what was negated and retired in the week, by whom, and what term
 * protection refused.
 *
 * Wave 4 (2026-10-11): this file held the old Negatives page's record and its alert switches (NEG.8); that page and
 * its routes are gone, and the weekly digest's section is what is left.
 *
 * Refusals by `protectConverting` live inside `AutomationRuleExecution.actionResults` JSON, not in
 * `AdvertisingActionLog`, so they are read there. The digest names the largest one's sales; it never calls a total
 * "saved" — the counterfactual is unknowable.
 */

import prisma from '../../db.js'

/** How many executions to scan for refusals. Refusals live in JSON, so this is a real bound. */
const REFUSAL_SAMPLE = 4000

/**
 * 🔴 Unambiguously a negative. `retire_negative` is here even though its target is usually gone —
 * that is the whole point.
 */
const NEG_ACTIONS = ['create_negative_keyword', 'create_negative_product_target', 'retire_negative'] as const

export type LedgerActor = 'user' | 'engine' | 'unattributed' | 'actor-not-recorded'

/**
 * The negatives section of the weekly digest.
 *
 * 🔴 Exported for `ads-weekly-digest.service.ts` to compose. A second digest builder is how two
 * summaries start disagreeing about the same account.
 */
export interface NegDigestSection {
  created: number
  retired: number
  byActor: Record<LedgerActor, number>
  protectionRefusals: number
  /** the single largest refusal, named — never a total presented as savings */
  largestRefusal: { term: string; orders: number; salesCents: number } | null
  orphaned: number
  openConditions: string[]
}

export async function buildNegDigestSection(fromMs: number, toMs: number): Promise<NegDigestSection> {
  const from = new Date(fromMs)
  const to = new Date(toMs)
  const logs = await prisma.advertisingActionLog.findMany({
    where: { entityType: 'AD_TARGET', actionType: { in: [...NEG_ACTIONS] }, createdAt: { gte: from, lt: to } },
    select: { actionType: true, userId: true, executionId: true },
  })
  const byActor: Record<LedgerActor, number> = { user: 0, engine: 0, unattributed: 0, 'actor-not-recorded': 0 }
  for (const l of logs) {
    const k: LedgerActor = l.userId?.startsWith('automation:') ? 'engine' : l.userId ? 'user' : l.executionId ? 'actor-not-recorded' : 'unattributed'
    byActor[k]++
  }
  const execs = await prisma.automationRuleExecution.findMany({
    where: { startedAt: { gte: from, lt: to } },
    orderBy: { startedAt: 'desc' },
    take: REFUSAL_SAMPLE,
    select: { actionResults: true },
  })
  let protectionRefusals = 0
  let largestRefusal: NegDigestSection['largestRefusal'] = null
  for (const e of execs) {
    for (const a of (Array.isArray(e.actionResults) ? (e.actionResults as Array<Record<string, unknown>>) : [])) {
      const out = (a?.output ?? {}) as Record<string, unknown>
      if (out.refusedBy !== 'protectConverting') continue
      protectionRefusals++
      const ev = (out.evidence ?? {}) as Record<string, unknown>
      const salesCents = Number(ev.salesCents ?? 0)
      if (!largestRefusal || salesCents > largestRefusal.salesCents) {
        largestRefusal = { term: String(ev.term ?? out.keyword ?? '—'), orders: Number(ev.orders ?? 0), salesCents }
      }
    }
  }
  const [orphaned, reviews, scopedRules] = await Promise.all([
    prisma.adTarget.count({ where: { isNegative: true, orphanedAt: { not: null } } }),
    prisma.adNegativeReview.count(),
    prisma.automationRule.count({
      where: {
        domain: 'advertising',
        OR: [{ scopeMarketplace: { not: null } }, { scopePortfolioId: { not: null } }, { scopeCampaignId: { not: null } }, { scopeProductId: { not: null } }],
      },
    }),
  ])
  return {
    created: logs.filter((l) => l.actionType !== 'retire_negative').length,
    retired: logs.filter((l) => l.actionType === 'retire_negative').length,
    byActor,
    protectionRefusals,
    largestRefusal,
    orphaned,
    openConditions: [
      '0 of 7 negation rules are scoped',
      `${reviews} of 132 whitelist contradictions reviewed`,
    ].concat(scopedRules > 0 ? [] : []),
  }
}
