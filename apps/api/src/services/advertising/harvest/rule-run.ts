/**
 * HARVEST ENGINE — a harvest rule's AUTOMATIC run on the one engine (D2, Owner 2026-10-10; HCORE review H3 + M7). A rule at
 * Auto (harvest_and_negate's graduation half, its product targets, promote_to_exact) no longer writes through the legacy
 * path: each term it found goes through the same plan and the same writer as the page's and Claude's harvests —
 *
 *   one bar      the term must pass the ONE harvest bar (the ads strategy's group, else the brain's test: plan.ts, actor RULE)
 *   one bid      the bid brain's goal bid (else the CPC held inside the strategy's band)
 *   the 10-08    keyword + negative exact in EVERY source of the product where the term ran + the funnel blocks, one change set
 *   caps         at most HARVEST_RULE_CAPS.keywordsPerDay new keywords a day per rule (its create audit rows today, the legacy
 *                path's included), only into the product's own campaigns (the plan's ad groups are the product's own by
 *                construction; a shared campaign's term is held), never from a paused source, never a new campaign, never
 *                into a campaign whose harvest or negatives lever the brain runs
 *   record       one harvest record per term (actorKind RULE, actorId the rule): judged after window + 72 h, put back by a
 *                person (the page's Undo) — automation never undoes it
 *
 * A person's acceptance of a rule's card keeps its own path (ads-harvest.service.ts applyHarvest: a person's write).
 */
import prisma from '../../../db.js'
import { HARVEST_RULE_CAPS } from '../ads-graduation.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { resolveCampaignOwnership } from '../brain/ownership.js'
import { executeChangeSet, type ItemOutcome } from './execute.js'
import { candidateIdOf, normTerm } from './ids.js'
import { previewChangeSet, type PreviewBody } from './preview.js'
import type { HarvestMatch, Who } from './write.js'

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))

export interface RuleTerm { query: string; externalAdGroupId: string; match?: HarvestMatch; toAdGroupId?: string | null }
export interface RuleRunOutcome {
  harvested: number
  held: Array<{ query: string; why: string }>
  capped: number
  items: ItemOutcome[]
}

/** The keywords a rule created today (UTC): its create audit rows (the engine's writes carry the rule's actor too). */
export async function ruleKeywordsToday(ruleId: string, now: Date): Promise<number> {
  return prisma.advertisingActionLog.count({
    where: { userId: { in: [`automation:${ruleId}`, `automation:automation:${ruleId}`] }, entityType: 'AD_TARGET', actionType: { in: ['create_keyword', 'create_target', 'AD_TARGET_CREATE'] }, createdAt: { gte: startOfUtcDay(now) } },
  })
}

/** Run a rule's automatic harvest of these terms on the engine, inside its caps. */
export async function runRuleHarvest(a: { ruleId: string; terms: readonly RuleTerm[]; now?: Date }): Promise<RuleRunOutcome> {
  const now = a.now ?? new Date()
  const out: RuleRunOutcome = { harvested: 0, held: [], capped: 0, items: [] }
  if (!a.terms.length) return out
  const exts = [...new Set(a.terms.map((t) => t.externalAdGroupId))]
  const groups = new Map((await prisma.adGroup.findMany({ where: { externalAdGroupId: { in: exts } }, select: { id: true, externalAdGroupId: true, campaignId: true, campaign: { select: { marketplace: true } } } }))
    .map((g) => [g.externalAdGroupId!, g]))
  const owners = await resolveCampaignOwnership([...new Set([...groups.values()].map((g) => g.campaignId))])
  // One item per term × product × market (a term found in two sources of one product is one harvest of every source).
  const byMarket = new Map<string, Map<string, PreviewBody['items'][number] & { query: string }>>()
  for (const t of a.terms) {
    const g = groups.get(t.externalAdGroupId)
    const market = strategyMarket(g?.campaign?.marketplace)
    const owner = g ? owners.get(g.campaignId)?.owner : undefined
    if (!g || !market) { out.held.push({ query: t.query, why: 'its source ad group is not in Nexus' }); continue }
    if (owner?.kind !== 'product') { out.held.push({ query: t.query, why: 'its source campaign is no single product\'s (a shared campaign): a rule harvests only into the product\'s own campaigns' }); continue }
    const cid = candidateIdOf(market, owner.productId, normTerm(t.query))
    const items = byMarket.get(market) ?? new Map()
    if (!items.has(cid)) items.set(cid, { candidateId: cid, query: t.query, ...(t.match ? { match: t.match } : {}), ...(t.toAdGroupId ? { to: { adGroupId: t.toAdGroupId } } : {}) })
    byMarket.set(market, items)
  }
  let left = Math.max(0, HARVEST_RULE_CAPS.keywordsPerDay - await ruleKeywordsToday(a.ruleId, now))
  const who: Who = { actor: `automation:${a.ruleId}`, manual: false, changeSetId: null, reason: `Harvest rule ${a.ruleId} on Auto, inside its caps (D2): the keyword, its source and funnel blocks in one change set` }
  for (const [, items] of byMarket) {
    const list = [...items.values()]
    const pv = await previewChangeSet({ items: list.map(({ query: _q, ...item }) => item) }, { actor: 'RULE', who, now })
    if ('error' in pv) { for (const i of list) out.held.push({ query: i.query, why: pv.error }); continue }
    // The day's cap: the first harvestable items, in the order the rule found them; the rest wait for tomorrow.
    for (const item of pv.plan.items) {
      if (item.refusal) { out.held.push({ query: item.term, why: item.refusal }); continue }
      if (left <= 0) {
        item.refusal = `the rule created its ${HARVEST_RULE_CAPS.keywordsPerDay} keywords for today (D2: a harvest rule runs on Auto inside its caps); it waits for tomorrow`
        out.capped++
        out.held.push({ query: item.term, why: item.refusal })
        continue
      }
      left--
    }
    if (!pv.plan.items.some((i) => !i.refusal)) continue
    const ran = await executeChangeSet({ ...pv.plan, newCampaigns: [], newPortfolios: [] }, { actor: 'RULE', actorId: a.ruleId, who, now })
    out.items.push(...ran.items.filter((i) => i.status !== 'SKIPPED'))
    out.harvested += ran.ok
  }
  return out
}
