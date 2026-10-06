/**
 * AME.15-17 — Campaign launcher + keyword-graduation funnel.
 *
 * Launch (AME.15): one action builds the canonical per-product structure — an
 * Auto (discovery) campaign + a Manual campaign with Exact / Phrase / Broad ad
 * groups, all advertising the product.
 *
 * Funnel (AME.16): winning search terms graduate Auto/Broad → Exact (the
 * existing harvest funnel). Then cross-match NEGATION stops the levels from
 * cannibalising each other — every Exact keyword becomes a negative-exact in the
 * Phrase / Broad / Auto ad groups, and every Phrase keyword a negative-phrase in
 * the Broad / Auto ad groups. Traffic flows to the most specific match that owns
 * the term (exactly the operator's ask). PB-7: inside ONE product's playbook
 * campaigns in one market only (crossMatchNegations below).
 *
 * State (AME.17): per-keyword journey across match types for the funnel UI.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { createCampaignLocal, createAdGroupLocal, createProductAdLocal, createKeywordLocal } from './ads-create.service.js'
import { PRODUCT_NOT_FOUND } from '../agents/tools/live-product.js'
import { findLiveProduct } from './ads-strategy/load.js'
import { strategyMarketOf } from './ads-strategy/terms.js'
import { compileIsolationFor, isolateProduct } from './ads-playbook/isolation-run.js'
import type { ScopeGroup } from './ads-playbook/isolation.js'

type MatchRole = 'AUTO' | 'BROAD' | 'PHRASE' | 'EXACT'

export interface LaunchInput { productId: string; marketplace: string; dailyBudgetEur?: number; defaultBidEur?: number; keywords?: string[]; userId?: string }

export async function launchProductFunnel(input: LaunchInput): Promise<{ autoCampaignId: string; manualCampaignId: string; adGroups: Record<string, string> }> {
  const product = await prisma.product.findUnique({ where: { id: input.productId }, select: { id: true, sku: true, amazonAsin: true, name: true } })
  if (!product) throw new Error('product not found')
  const budget = input.dailyBudgetEur ?? 10
  const bid = input.defaultBidEur ?? 0.5
  const base = (product.name || product.sku || product.id).slice(0, 56)
  // CM-20 — `creationFlow`: every add below belongs to a campaign this launch creates.
  const ad = { sku: product.sku ?? undefined, asin: product.amazonAsin ?? undefined, productId: product.id, userId: input.userId, creationFlow: true }

  const autoCamp = await createCampaignLocal({ name: `${base} — Auto`, type: 'SP', marketplace: input.marketplace, targetingType: 'AUTO', dailyBudgetEur: budget, userId: input.userId })
  const autoAg = await createAdGroupLocal({ campaignId: autoCamp.id, name: `${base} — Auto`, defaultBidEur: bid, userId: input.userId, creationFlow: true })
  await createProductAdLocal({ adGroupId: autoAg.id, ...ad })

  const manualCamp = await createCampaignLocal({ name: `${base} — Manual`, type: 'SP', marketplace: input.marketplace, targetingType: 'MANUAL', dailyBudgetEur: budget, userId: input.userId })
  const adGroups: Record<string, string> = { AUTO: autoAg.id }
  for (const role of ['EXACT', 'PHRASE', 'BROAD'] as const) {
    const ag = await createAdGroupLocal({ campaignId: manualCamp.id, name: `${base} — ${role}`, defaultBidEur: bid, userId: input.userId, creationFlow: true })
    await createProductAdLocal({ adGroupId: ag.id, ...ad })
    adGroups[role] = ag.id
    for (const kw of input.keywords ?? []) {
      await createKeywordLocal({ adGroupId: ag.id, keywordText: kw, matchType: role, bidEur: bid, userId: input.userId, creationFlow: true })
    }
  }
  logger.info('[AME.15] launched product funnel', { productId: product.id, autoCampaignId: autoCamp.id, manualCampaignId: manualCamp.id })
  return { autoCampaignId: autoCamp.id, manualCampaignId: manualCamp.id, adGroups }
}

// Classify an ad group's match role by its name suffix, falling back to the
// majority of its positive keyword targets' expression types.
function roleOf(name: string, targets: Array<{ expressionType: string; isNegative: boolean }>): MatchRole | null {
  const n = (name || '').toUpperCase()
  if (n.includes('AUTO')) return 'AUTO'
  if (n.includes('EXACT')) return 'EXACT'
  if (n.includes('PHRASE')) return 'PHRASE'
  if (n.includes('BROAD')) return 'BROAD'
  const counts: Record<string, number> = {}
  for (const t of targets) { if (t.isNegative) continue; const e = t.expressionType.toUpperCase(); counts[e] = (counts[e] ?? 0) + 1 }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]
  return top === 'EXACT' || top === 'PHRASE' || top === 'BROAD' ? top : null
}

// HV.3 — exported (one keyword; no behaviour change) so the Keyword Harvest page's destination
// resolver reads the SAME product → ad-group walk this funnel does, rather than a second copy that
// would drift. Nothing else in this file is touched by HV.3.
export async function gatherProductAdGroups(productId: string) {
  const childRows = await prisma.product.findMany({ where: { parentId: productId }, select: { id: true } })
  const productIds = [...new Set([productId, ...childRows.map((c) => c.id)])]
  const ads = await prisma.adProductAd.findMany({ where: { productId: { in: productIds } }, select: { adGroupId: true } })
  const adGroupIds = [...new Set(ads.map((a) => a.adGroupId))]
  if (adGroupIds.length === 0) return []
  return prisma.adGroup.findMany({
    where: { id: { in: adGroupIds } },
    select: { id: true, name: true, externalAdGroupId: true, campaign: { select: { externalCampaignId: true, marketplace: true } }, targets: { select: { expressionType: true, expressionValue: true, isNegative: true } } },
  })
}

export interface NegationProposal { keywordText: string; matchType: 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE'; adGroupId: string; adGroupName: string; role: MatchRole; reason: string }

/** The match role a playbook slot plays here: its own, never read from a name. */
const SLOT_ROLE = (g: ScopeGroup | undefined): MatchRole => (g?.role === 'exact' ? 'EXACT' : g?.match === 'PHRASE' ? 'PHRASE' : g?.match === 'BROAD' ? 'BROAD' : 'AUTO')

/**
 * Cross-match negation plan (AME.16). Returns proposals; apply=true writes them.
 *
 * PB-7 (the Owner's rule 3) — a thin caller of the playbook's isolation (ads-playbook/isolation-run.ts), the one
 * planner and writer. The walk it replaces crossed products (every ad group holding one of the product's ads, campaigns
 * that also advertise other products included) and markets, counted paused, archived and product targets as owners,
 * read each ad group's role from its name, wrote through the push-only call with no Nexus row and counted a refusal as
 * applied. Now: one market; only a product enrolled in a playbook there (refused by name otherwise); the playbook's
 * slots, the planner's checks and the write service; `applied` = what reached Amazon.
 */
export async function crossMatchNegations(productId: string, apply: boolean, actor: string, market: string): Promise<{
  proposals: NegationProposal[]; applied: number; errors: string[]; local: number; alreadyStanding: number
  leftAlone: Array<{ text: string; adGroupId: string | null; why: string }>; excluded: Array<{ slot: string; campaignId: string; adGroupId: string | null; why: string }>
} | { refused: string }> {
  const code = strategyMarketOf(market)
  if (!code) return { refused: 'Name a market (for example "IT"): isolation keeps one product\'s own playbook campaigns apart in one market, so nothing was planned.' }
  const product = await findLiveProduct({ productId })
  if (!product) return { refused: PRODUCT_NOT_FOUND }
  const rows = await prisma.adsPlaybook.findMany({
    where: { channel: 'AMAZON', market: code, level: 'PRODUCT', scopeId: { in: [product.id, ...(product.parentId ? [product.parentId] : [])] } },
    select: { id: true, scopeId: true, enrolled: true },
  })
  const own = rows.find((r) => r.scopeId === product.id)
  const parent = rows.find((r) => r.scopeId === product.parentId)
  if ((own?.enrolled ?? parent?.enrolled) !== true) {
    return { refused: `${product.sku} is not in an ads playbook in ${code}. Isolation keeps one product's own playbook campaigns apart and nothing else, so nothing is planned.` }
  }
  const links = await prisma.adsPlaybookLink.findMany({ where: { playbookId: { in: rows.map((r) => r.id) }, kind: 'slot' }, select: { playbookId: true } })
  const row = [own, parent].find((r) => r && links.some((l) => l.playbookId === r.id))
  if (!row) return { refused: `${product.sku}'s playbook in ${code} holds no campaign yet: there is nothing to keep apart.` }
  const compiled = await compileIsolationFor(row.id)
  if ('problems' in compiled) return { refused: compiled.problems.join('; ') }
  if (compiled.compiled.problems.length) return { refused: compiled.compiled.problems.join('; ') }
  const run = await isolateProduct({ action: compiled.compiled.action, actor, dryRun: !apply })
  if ('refused' in run) return run
  const groupOf = new Map(run.scope.groups.map((g) => [g.adGroupId, g]))
  const proposals = run.chosen.map((a): NegationProposal => ({
    keywordText: a.text, matchType: a.match === 'PHRASE' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT', adGroupId: a.adGroupId,
    adGroupName: groupOf.get(a.adGroupId)?.name ?? a.slot, role: SLOT_ROLE(groupOf.get(a.adGroupId)), reason: a.why,
  }))
  const w = run.written
  if (w) logger.info('[AME.16] cross-match negations applied', { productId, market: code, added: w.added, local: w.local, refused: w.refused.length, failed: w.failed.length })
  return {
    proposals,
    applied: w?.added ?? 0,
    errors: w ? [...w.refused.map((r) => `${r.text}: ${r.reason}`), ...w.failed.map((f) => `${f.text}: ${f.error}`)] : [],
    local: w?.local ?? 0,
    alreadyStanding: (w?.alreadyStanding ?? 0) + run.plan.alreadyStanding,
    leftAlone: [...(w?.leftAlone ?? []), ...run.plan.leftAlone].map((l) => ({ text: l.text, adGroupId: l.adGroupId, why: l.why })),
    excluded: run.scope.excluded,
  }
}

/** Per-keyword funnel journey across match types + ad-group breakdown (AME.17). */
export async function getFunnelState(productId: string): Promise<{
  adGroups: Array<{ id: string; name: string; role: MatchRole | null; positives: Array<{ kw: string; match: string }>; negatives: Array<{ kw: string; match: string }> }>
  journey: Array<{ keyword: string; matchTypes: string[]; negatedIn: number }>
}> {
  const adGroups = await gatherProductAdGroups(productId)
  const classified = adGroups.map((ag) => ({
    id: ag.id, name: ag.name, role: roleOf(ag.name, ag.targets),
    positives: ag.targets.filter((t) => !t.isNegative).map((t) => ({ kw: t.expressionValue, match: t.expressionType })),
    negatives: ag.targets.filter((t) => t.isNegative).map((t) => ({ kw: t.expressionValue, match: t.expressionType })),
  }))
  const present = new Map<string, Set<string>>()
  const negated = new Map<string, number>()
  for (const c of classified) {
    for (const p of c.positives) { const k = p.kw.toLowerCase(); const s = present.get(k) ?? new Set(); s.add(p.match.toUpperCase()); present.set(k, s) }
    for (const nkw of c.negatives) { const k = nkw.kw.toLowerCase(); negated.set(k, (negated.get(k) ?? 0) + 1) }
  }
  const journey = [...present.entries()].map(([keyword, roles]) => ({ keyword, matchTypes: [...roles], negatedIn: negated.get(keyword) ?? 0 }))
  return { adGroups: classified, journey }
}
