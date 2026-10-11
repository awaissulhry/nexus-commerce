/**
 * HARVEST ENGINE — the Sources view (GET /api/advertising/harvest/sources, POST …/sources/assign|detach|pause|resume): every
 * ad group of the market that feeds search terms to harvest (automatic, broad, phrase, and product-target ad groups), with
 * the harvest rules on it, the terms it found and those it gave over the one window (`windowDays`, the Terms view's), and
 * whether harvesting from it is paused.
 *
 *   assign / detach  a builder harvest rule (keyword-harvesting) reads the ad groups its mapping names (`look`): assign adds
 *                    the ad group to its first mapping, detach takes it out (an ad group the rule also creates into keeps
 *                    its entry, without `look`). A rule that reaches its sources by its scope (harvest_and_negate,
 *                    promote_to_exact) is refused, named: its scope is edited in the rule. Audited.
 *   pause / resume   Nexus only, at once: no harvest — the page, Claude, a rule or the brain — takes a term from a paused
 *                    source (AdsHarvestSourcePause); resume deletes the row.
 */
import prisma from '../../../db.js'
import type { AdsActor } from '../ads-mutation.service.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { roleOf } from '../harvest-destination.service.js'
import { resolveCampaignOwnership } from '../brain/ownership.js'
import { adGroupRef, campaignRef, portfolioRef, productRef, type Ref } from './ids.js'
import { harvestRuleReach, isHarvestRule, rulesAt } from './rule-reach.js'
import { blocksOf } from './write.js'
import { settledBounds } from '../ads-settled-window.js'
import { LEDGER_WINDOW_DAYS } from '../brain/terms.js'

export const MAX_SOURCE_IDS = 500

export interface SourceRow {
  id: string
  adGroup: Ref
  campaign: Ref
  portfolio: Ref | null
  product: Ref | null
  role: 'AUTO' | 'BROAD' | 'PHRASE' | 'PRODUCT' | null
  rules: Ref[]
  paused: null | { by: string; at: string }
  /** S9 — over the ONE window (the Terms view's: the ledger's settled days, `windowDays` on the answer). */
  terms: number
  sellingTerms: number
  harvested: number
}

export async function harvestSources(q: { market: string }, opts: { now?: Date } = {}): Promise<{ data: { market: string; windowDays: number; rows: SourceRow[]; totals: { sources: number; paused: number; withRule: number; sellingGroups: number } } } | { error: string; status: 400 }> {
  const market = strategyMarket(q.market)
  if (!market) return { error: `market: ${q.market} is not a market code`, status: 400 }
  const now = opts.now ?? new Date()
  // S9 — one window everywhere: the Terms view's (the term ledger's settled days), said on the answer.
  const window = settledBounds(LEDGER_WINDOW_DAYS, 'SPONSORED_PRODUCTS', { now })
  const since = window.since
  const campaigns = (await prisma.campaign.findMany({
    where: { adProduct: 'SPONSORED_PRODUCTS', status: { not: 'ARCHIVED' } },
    select: { id: true, name: true, marketplace: true, portfolioId: true, targetingType: true, externalCampaignId: true },
  })).filter((c) => strategyMarket(c.marketplace) === market)
  const byId = new Map(campaigns.map((c) => [c.id, c]))
  const groups = campaigns.length ? await prisma.adGroup.findMany({ where: { campaignId: { in: campaigns.map((c) => c.id) }, status: { not: 'ARCHIVED' } }, select: { id: true, name: true, campaignId: true, externalAdGroupId: true } }) : []
  const groupIds = groups.map((g) => g.id)
  const [targets, terms, owners, reach, pauses, records, mappingRules, portfolioRows] = await Promise.all([
    groupIds.length ? prisma.adTarget.findMany({ where: { adGroupId: { in: groupIds }, isNegative: false, status: { not: 'ARCHIVED' }, kind: { in: ['KEYWORD', 'PRODUCT'] } }, select: { adGroupId: true, kind: true, expressionType: true } }) : Promise.resolve([]),
    prisma.amazonAdsSearchTerm.groupBy({ by: ['adGroupId', 'query'], where: { date: { gte: since, lte: window.until }, campaignId: { in: campaigns.map((c) => c.externalCampaignId).filter((x): x is string => !!x) } }, _sum: { orders7d: true } }),
    resolveCampaignOwnership(campaigns.map((c) => c.id)),
    harvestRuleReach(market),
    prisma.adsHarvestSourcePause.findMany({ select: { adGroupId: true, pausedBy: true, createdAt: true } }),
    prisma.adsBrainHarvest.findMany({ where: { marketplace: market, status: { in: ['DONE', 'HALF_DONE'] }, landedAt: { gte: since } }, select: { sources: true } }),
    prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { id: true, name: true, actions: true } }),
    prisma.amazonAdsPortfolio.findMany({ select: { externalPortfolioId: true, name: true } }),
  ])
  const portfolios = new Map(portfolioRows.map((p) => [p.externalPortfolioId, p.name]))
  const productIds = [...new Set([...owners.values()].flatMap((o) => (o.owner.kind === 'product' ? [o.owner.productId] : [])))]
  const products = new Map((productIds.length ? await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true, sku: true } }) : []).map((p) => [p.id, p]))
  const termsBy = new Map<string, { terms: number; converting: number }>()
  for (const t of terms) {
    const cur = termsBy.get(t.adGroupId) ?? { terms: 0, converting: 0 }
    cur.terms++
    if ((t._sum.orders7d ?? 0) > 0) cur.converting++
    termsBy.set(t.adGroupId, cur)
  }
  const harvestedBy = new Map<string, number>()
  for (const r of records) for (const s of blocksOf(r.sources)) if (s.adGroupId) harvestedBy.set(s.adGroupId, (harvestedBy.get(s.adGroupId) ?? 0) + 1)
  const pauseOf = new Map(pauses.map((p) => [p.adGroupId, p]))
  // Builder harvest rules that name an ad group in their mapping (look).
  const lookers = new Map<string, Ref[]>()
  for (const r of mappingRules) {
    if (!isHarvestRule(r.actions)) continue
    const a0 = (Array.isArray(r.actions) ? r.actions[0] : null) as { mappings?: Array<{ groups?: Array<{ id?: unknown; look?: unknown; paused?: unknown }> }> } | null
    for (const m of a0?.mappings ?? []) for (const g of m.groups ?? []) {
      if (g.id == null || g.look === false || g.paused === true) continue
      const id = String(g.id)
      lookers.set(id, [...(lookers.get(id) ?? []), { id: r.id, name: r.name }])
    }
  }
  const rows: SourceRow[] = []
  for (const g of groups) {
    const c = byId.get(g.campaignId)!
    const mine = targets.filter((t) => t.adGroupId === g.id)
    const keywords = mine.filter((t) => t.kind === 'KEYWORD')
    let role: SourceRow['role'] = String(c.targetingType ?? '').toUpperCase() === 'AUTO' ? 'AUTO' : roleOf(g.name, keywords.map((t) => ({ expressionType: String(t.expressionType ?? ''), isNegative: false }))) as SourceRow['role']
    if (!keywords.length && mine.some((t) => t.kind === 'PRODUCT') && role !== 'AUTO') role = 'PRODUCT'
    const stats = g.externalAdGroupId ? termsBy.get(g.externalAdGroupId) : undefined
    if ((role as string) === 'EXACT' || (!role && !stats)) continue
    const owner = owners.get(c.id)?.owner
    const p = owner?.kind === 'product' ? products.get(owner.productId) : undefined
    const ruleRefs = new Map<string, Ref>()
    // A rule whose scope reaches the campaign, or a builder rule whose mapping reads this ad group (never the market).
    for (const r of rulesAt(reach, c.id, g.id)) ruleRefs.set(r.id, { id: r.id, name: r.name })
    for (const r of lookers.get(g.id) ?? []) ruleRefs.set(r.id, r)
    const pause = pauseOf.get(g.id)
    rows.push({
      id: g.id, adGroup: adGroupRef(g.id, g.name, c.id), campaign: campaignRef(c.id, c.name),
      portfolio: c.portfolioId ? portfolioRef(c.portfolioId, portfolios.get(c.portfolioId)) : null,
      product: p ? productRef(p.id, p.name ?? p.sku) : null, role, rules: [...ruleRefs.values()],
      paused: pause ? { by: pause.pausedBy, at: pause.createdAt.toISOString() } : null,
      terms: stats?.terms ?? 0, sellingTerms: stats?.converting ?? 0, harvested: harvestedBy.get(g.id) ?? 0,
    })
  }
  rows.sort((a, b) => b.sellingTerms - a.sellingTerms || a.campaign.name.localeCompare(b.campaign.name) || a.adGroup.name.localeCompare(b.adGroup.name))
  const selling = rows.filter((r) => r.sellingTerms > 0).length
  return { data: { market, windowDays: LEDGER_WINDOW_DAYS, rows, totals: { sources: rows.length, paused: rows.filter((r) => r.paused).length, withRule: rows.filter((r) => r.rules.length).length, sellingGroups: selling } } }
}

type Mapping = { groups?: Array<Record<string, unknown>> }

/** Assign (look) or detach these ad groups on a builder harvest rule's first mapping. */
async function editMapping(ruleId: string, adGroupIds: readonly string[], assign: boolean, actor: AdsActor): Promise<{ id: string; ok: boolean; changed: number; error?: string }> {
  const rule = await prisma.automationRule.findUnique({ where: { id: ruleId }, select: { id: true, name: true, domain: true, actions: true } })
  if (!rule || rule.domain !== 'advertising' || !isHarvestRule(rule.actions)) return { id: ruleId, ok: false, changed: 0, error: `No harvest rule ${ruleId} in this business.` }
  const actions = (Array.isArray(rule.actions) ? JSON.parse(JSON.stringify(rule.actions)) : []) as Array<Record<string, unknown>>
  const a0 = actions[0]
  if (!a0 || a0.type !== 'keyword-harvesting') return { id: ruleId, ok: false, changed: 0, error: `"${rule.name}" reaches its sources by its scope (market, portfolio, campaign or product): change its scope in the rule.` }
  const mappings = (Array.isArray(a0.mappings) ? a0.mappings : []) as Mapping[]
  if (!mappings.length) mappings.push({ groups: [] })
  let changed = 0
  for (const id of adGroupIds) {
    for (const [i, m] of mappings.entries()) {
      const groups = Array.isArray(m.groups) ? m.groups : []
      const at = groups.findIndex((g) => String(g.id) === id)
      if (assign) {
        if (i > 0) break
        if (at < 0) { groups.push({ id, look: true, types: {} }); changed++ }
        else if (groups[at].look === false || groups[at].paused === true) { groups[at] = { ...groups[at], look: true, paused: false }; changed++ }
      } else if (at >= 0 && groups[at].look !== false) {
        const types = (groups[at].types ?? {}) as Record<string, unknown>
        if (Object.values(types).some(Boolean)) groups[at] = { ...groups[at], look: false }
        else groups.splice(at, 1)
        changed++
      }
      m.groups = groups
    }
  }
  if (!changed) return { id: ruleId, ok: true, changed: 0 }
  a0.mappings = mappings
  await prisma.automationRule.update({ where: { id: ruleId }, data: { actions: actions as never } })
  const { auditRule } = await import('../ads-rule-crud.service.js')
  await auditRule(actor, 'update_rule', ruleId, { actions: rule.actions as object }, { actions }, `${rule.name}: ${changed} source ad group${changed === 1 ? '' : 's'} ${assign ? 'assigned' : 'detached'} (Keyword Harvest → Sources)`)
  return { id: ruleId, ok: true, changed }
}

export async function assignSources(ruleId: string, adGroupIds: readonly string[], actor: AdsActor) {
  return editMapping(ruleId, [...new Set(adGroupIds)].slice(0, MAX_SOURCE_IDS), true, actor)
}

/** Detach these ad groups from one rule, or (no rule named) from every builder harvest rule that reads them. */
export async function detachSources(ruleId: string | null, adGroupIds: readonly string[], actor: AdsActor) {
  const ids = [...new Set(adGroupIds)].slice(0, MAX_SOURCE_IDS)
  if (ruleId) return { results: [await editMapping(ruleId, ids, false, actor)] }
  const rules = (await prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { id: true, actions: true } }))
    .filter((r) => isHarvestRule(r.actions) && (r.actions as Array<{ type?: unknown }>)[0]?.type === 'keyword-harvesting')
  const results = []
  for (const r of rules) {
    const out = await editMapping(r.id, ids, false, actor)
    if (out.changed || !out.ok) results.push(out)
  }
  return { results }
}

export async function pauseSources(adGroupIds: readonly string[], by: string, reason?: string | null) {
  const ids = [...new Set(adGroupIds)].slice(0, MAX_SOURCE_IDS)
  const found = new Set((await prisma.adGroup.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((g) => g.id))
  const existing = new Set((await prisma.adsHarvestSourcePause.findMany({ where: { adGroupId: { in: ids } }, select: { adGroupId: true } })).map((p) => p.adGroupId))
  const add = ids.filter((id) => found.has(id) && !existing.has(id))
  if (add.length) await prisma.adsHarvestSourcePause.createMany({ data: add.map((adGroupId) => ({ adGroupId, pausedBy: by, reason: reason ?? null })), skipDuplicates: true })
  return { paused: add, already: ids.filter((id) => existing.has(id)), notFound: ids.filter((id) => !found.has(id)) }
}

export async function resumeSources(adGroupIds: readonly string[]) {
  const ids = [...new Set(adGroupIds)].slice(0, MAX_SOURCE_IDS)
  const out = await prisma.adsHarvestSourcePause.deleteMany({ where: { adGroupId: { in: ids } } })
  return { resumed: out.count }
}
