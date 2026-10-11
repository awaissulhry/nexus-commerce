/**
 * HARVEST ENGINE — D2 (Owner 2026-10-10): a harvest rule may run on Auto, INSIDE ITS CAPS (ads-graduation.ts
 * HARVEST_RULE_CAPS). The legacy rule path (ads-harvest.service.ts applyHarvest, a rule's automatic run: actor
 * `automation:<ruleId>`) asks this guard before each keyword it creates:
 *
 *   day      at most `keywordsPerDay` new keywords per rule a day (UTC), counted from its own create audit rows
 *   own      only into the product's own campaigns: the destination's campaign advertises the same product family as the
 *            source's (brain/ownership.ts; a shared or another product's campaign is refused)
 *   paused   never from a source a person paused (AdsHarvestSourcePause)
 *
 * and, once a keyword landed, keeps ONE harvest record for it (AdsBrainHarvest, actorKind RULE / PERSON) so every
 * harvest is judged after its window + 72 h and can be put back from the Keyword Harvest page, like the brain's.
 * A person's own path (a promote, an accepted card) is never capped. Reads and the record only; never fails a write.
 */
import { Prisma } from '@nexus/database'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { HARVEST_RULE_CAPS } from '../ads-graduation.js'
import { JUDGE_AFTER_MS } from '../brain/harvest.js'
import { resolveCampaignOwnership } from '../brain/ownership.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { normTerm } from './ids.js'

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))

export interface RuleHarvestGuard {
  /** Why this create may not run now (the rule's caps), or null. */
  refusal(a: { sourceAdGroupId: string | null; destAdGroupId: string }): Promise<{ deniedAt: string; why: string } | null>
  /** A keyword it created landed: counted against the day. */
  created(): void
  /** Keep the harvest record of a landed keyword (best effort). */
  record(a: { query: string; matchType: string; sourceAdGroupId: string | null; destAdGroupId: string; keywordTargetId: string; bidCents: number | null; negatives?: ReadonlyArray<{ adTargetId: string | null; matchType: string }>; now?: Date }): Promise<void>
  /** A later handover negated the source (the new home proved itself): its negative joins the record the landing kept. */
  recordHandover(a: { query: string; sourceAdGroupId: string | null; negatives: ReadonlyArray<{ adTargetId: string | null; matchType: string }>; now?: Date }): Promise<void>
}

/** The guard for one applyHarvest call; null caps for a person's own path (only the record is kept). */
export async function ruleHarvestGuard(actor: string | undefined, opts: { caps?: boolean; now?: Date } = {}): Promise<RuleHarvestGuard> {
  const now = opts.now ?? new Date()
  const automatic = opts.caps !== false && !!actor && actor.startsWith('automation:')
  const ruleActor = !!actor && actor.startsWith('automation:')
  const ruleId = ruleActor ? actor!.replace(/^(automation:)+/, '') : null
  let used = 0
  if (automatic) {
    used = await prisma.advertisingActionLog.count({
      where: { userId: { in: [`automation:${ruleId}`, `automation:automation:${ruleId}`] }, entityType: 'AD_TARGET', actionType: { in: ['create_keyword', 'create_target', 'AD_TARGET_CREATE'] }, createdAt: { gte: startOfUtcDay(now) } },
    }).catch(() => 0)
  }
  const owners = new Map<string, string | null>()
  const groups = new Map<string, { campaignId: string; marketplace: string | null } | null>()
  const groupOf = async (id: string) => {
    if (!groups.has(id)) {
      const g = await prisma.adGroup.findUnique({ where: { id }, select: { campaignId: true, campaign: { select: { marketplace: true } } } }).catch(() => null)
      groups.set(id, g ? { campaignId: g.campaignId, marketplace: g.campaign?.marketplace ?? null } : null)
    }
    return groups.get(id) ?? null
  }
  const ownerOf = async (campaignId: string) => {
    if (!owners.has(campaignId)) {
      const o = (await resolveCampaignOwnership([campaignId]).catch(() => new Map())).get(campaignId)
      owners.set(campaignId, o?.owner.kind === 'product' ? o.owner.productId : null)
    }
    return owners.get(campaignId) ?? null
  }
  return {
    async refusal({ sourceAdGroupId, destAdGroupId }) {
      if (!automatic) return null
      if (sourceAdGroupId && await prisma.adsHarvestSourcePause.findFirst({ where: { adGroupId: sourceAdGroupId }, select: { id: true } })) {
        return { deniedAt: 'harvest_source_paused', why: 'harvesting from this source is paused (Keyword Harvest → Sources)' }
      }
      if (used >= HARVEST_RULE_CAPS.keywordsPerDay) return { deniedAt: 'harvest_rule_cap', why: `the rule created its ${HARVEST_RULE_CAPS.keywordsPerDay} keywords for today (D2: a harvest rule runs on Auto inside its caps); the rest wait for tomorrow` }
      const dest = await groupOf(destAdGroupId)
      const src = sourceAdGroupId ? await groupOf(sourceAdGroupId) : null
      if (!dest || !src) return { deniedAt: 'harvest_rule_own_campaigns', why: 'the source or the destination ad group is not in Nexus: a rule harvests only into the product\'s own campaigns' }
      const [dp, sp] = await Promise.all([ownerOf(dest.campaignId), ownerOf(src.campaignId)])
      if (!dp || !sp || dp !== sp) return { deniedAt: 'harvest_rule_own_campaigns', why: 'the destination is not one of the product\'s own campaigns (a shared or another product\'s campaign): a rule on Auto harvests only into the product\'s own campaigns (D2)' }
      return null
    },
    created() { used++ },
    async record(a) {
      try {
        const src = a.sourceAdGroupId ? await groupOf(a.sourceAdGroupId) : null
        const dest = await groupOf(a.destAdGroupId)
        if (!src || !dest) return
        const productId = await ownerOf(src.campaignId)
        const market = strategyMarket(dest.marketplace)
        if (!productId || !market) return
        const now = a.now ?? new Date()
        const term = normTerm(a.query)
        const key = { product_market_term: workspaceKey({ productId, marketplace: market, term }) }
        const was = await prisma.adsBrainHarvest.findUnique({ where: key as never, select: { id: true, status: true } })
        // One harvest per term: a record in flight or placed by another actor is left as it is.
        if (was && !['SHADOW', 'HELD', 'DECLINED', 'REFUSED', 'FAILED', 'UNDONE'].includes(was.status)) return
        const landed = (a.negatives ?? []).filter((n) => !!n.adTargetId)
        const sources = !a.sourceAdGroupId ? [] : landed.length
          ? landed.map((n) => ({ adGroupId: a.sourceAdGroupId!, campaignId: src.campaignId, role: null, action: 'negate', negMatch: n.matchType === 'PHRASE' ? 'PHRASE' : 'EXACT', why: 'negative in the source', negativeTargetId: n.adTargetId, result: 'landed' }))
          : [{ adGroupId: a.sourceAdGroupId, campaignId: src.campaignId, role: null, action: 'kept', why: 'the source keeps running until the new keyword proves itself (a later handover negates it, and joins this record)' }]
        const data = {
          isAsin: /^b0[a-z0-9]{8}$/i.test(term), status: 'DONE', level: automatic ? 'AUTO' : 'PROPOSE', destinationKind: 'EXISTING', destHow: 'rule',
          destCampaignId: dest.campaignId, destAdGroupId: a.destAdGroupId, bidCents: a.bidCents, keywordTargetId: a.keywordTargetId, landedAt: now,
          judgeAfter: new Date(now.getTime() + JUDGE_AFTER_MS), verdict: 'WAITING', sources: sources as never, heldBy: null,
          why: `${ruleActor ? 'A harvest rule' : 'A person'} harvested it (${a.matchType.toLowerCase()})`, evidence: { keywordBefore: 'none' }, digest: '', runId: actor ?? 'harvest',
          decidedAt: now, checkedAt: now, changedAt: now, actorKind: ruleActor ? 'RULE' : 'PERSON', actorId: ruleActor ? ruleId : (actor ?? '').replace(/^user:/, '') || null,
          match: a.matchType === 'PHRASE' ? 'PHRASE' : 'EXACT', approvalId: null, undoApprovalId: null, attempts: 1, lastError: null, judgedAt: null,
          // M6 — nothing of an earlier harvest of the term carries over.
          changeSetId: null, funnel: Prisma.DbNull, newCampaign: Prisma.DbNull, stage: 'DONE', judgement: Prisma.DbNull,
        }
        if (was) await prisma.adsBrainHarvest.update({ where: { id: was.id }, data })
        else await prisma.adsBrainHarvest.create({ data: { productId, marketplace: market, term, ...data } })
      } catch (error) {
        logger.warn('[harvest-engine] the rule harvest record was not kept', { error: error instanceof Error ? error.message : String(error) })
      }
    },
    async recordHandover(a) {
      try {
        const landed = a.negatives.filter((n) => !!n.adTargetId)
        if (!a.sourceAdGroupId || !landed.length) return
        const src = await groupOf(a.sourceAdGroupId)
        if (!src) return
        const productId = await ownerOf(src.campaignId)
        const market = strategyMarket(src.marketplace)
        if (!productId || !market) return
        const key = { product_market_term: workspaceKey({ productId, marketplace: market, term: normTerm(a.query) }) }
        const was = await prisma.adsBrainHarvest.findUnique({ where: key as never, select: { id: true, status: true, actorKind: true, sources: true } })
        if (!was || was.actorKind === 'BRAIN' || !['DONE', 'HALF_DONE'].includes(was.status)) return
        const sources = (Array.isArray(was.sources) ? was.sources as Array<Record<string, unknown>> : []).filter((b) => !(b.adGroupId === a.sourceAdGroupId && b.action === 'kept'))
        for (const n of landed) if (!sources.some((b) => b.negativeTargetId === n.adTargetId)) sources.push({ adGroupId: a.sourceAdGroupId, campaignId: src.campaignId, role: null, action: 'negate', negMatch: n.matchType === 'PHRASE' ? 'PHRASE' : 'EXACT', why: 'negative in the source at the handover', negativeTargetId: n.adTargetId, result: 'landed' })
        await prisma.adsBrainHarvest.update({ where: { id: was.id }, data: { sources: sources as never, changedAt: a.now ?? new Date() } })
      } catch (error) {
        logger.warn('[harvest-engine] the handover was not added to the harvest record', { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}
