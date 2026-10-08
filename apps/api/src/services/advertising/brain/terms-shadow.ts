/**
 * ONE BRAIN AB-9 — the term ledger's shadow run (design 2026-10-08-ads-one-brain/DESIGN.md §1, §2.7, §2.8, §4 steps 3–4,
 * §8 row AB-9). Once a day (jobs/ads-brain-terms.job.ts), inside one business: for every product whose negatives or harvest
 * lever is OBSERVE or higher, the market arbiter names a lead on each term sibling products meet on (brain/arbiter.ts), and
 * each of the product's terms gets ONE decision (brain/terms.ts). SHADOW: the only rows it writes are its own —
 * AdsBrainTerm (the ledger) and AdsBrainTermLead (the arbiter's leads). No mutation, no queue, no gate, no Amazon.
 *
 *   due       an enrolled product, not excluded, whose negatives or harvest lever resolves to OBSERVE, PROPOSE or AUTO
 *             (brain/settings.ts, product level). Nothing enrolled (production today): the enrollments are read, nothing
 *             is decided, and only the 30-day prune runs (two deletes of nothing).
 *   facts     per market, a fixed number of reads whatever the number of products: the Sponsored Products campaigns and
 *             who owns each (brain/ownership.ts), their ad groups and keywords, the search terms of the settled window
 *             (one aggregate; one more per Owner window that differs), the families, their primary categories and
 *             listing prices, the playbook's brand words, the protected terms, the stored harvest destinations, the ads
 *             strategy (opened once), the account's default target, and the margins (break-even ACoS).
 *   pooled    market = every search term of the market's campaigns (shared and unowned included); category = the
 *             products whose family root has that primary category; product = its own campaigns. A shared campaign is
 *             no product's (D2): its terms count for the market only.
 *   arbiter   every product family that owns a campaign in the market is a possible contender, on the terms a due product
 *             holds; leads are stored for those terms only.
 *   stored    per product × market, in one transaction: new terms created, changed decisions rewritten (state, since and
 *             the state before kept), unchanged ones only stamped with the run, terms that left the window removed. A
 *             rerun on the same facts changes no decision. Leads the same, per market.
 *   kept      30 days: rows no run has checked since (a product no longer due, a market no longer read) are deleted.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { inDatabaseTransaction } from '../../../lib/database-context.js'
import { logger } from '../../../utils/logger.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { openStrategy, type EffectiveStrategy } from '../ads-strategy/effective.js'
import { sourceLabel } from '../ads-strategy/terms.js'
import { settledBounds } from '../ads-settled-window.js'
import { isAsin, loadProtectedTerms, type ProtectedTerm } from '../ads-negation-policy.js'
import { readOwnerTargets } from '../ads-target-acos-resolver.js'
import { breakevenByProduct } from '../ads-target-acos.service.js'
import { HV_DEST_GRAINS, roleOf } from '../harvest-destination.service.js'
import { resolveCampaignOwnership } from './ownership.js'
import { resolveBrainSettings, type BrainSettings, type OverrideRow } from './settings.js'
import { arbitrate, type Claim, type LeadDecision } from './arbiter.js'
import {
  addEvidence, applyCaps, brandWordIn, decideTerm, LEDGER_WINDOW_DAYS, matchOf, negativeBlocks, NO_TERM_EVIDENCE, stateCounts, termKey, termTests,
  type HarvestDestination, type LeverEffective, type MatchKind, type ProductContext, type TermDecision, type TermEvidence, type TermFacts,
  type TermPlace, type TermState, type TermTests,
} from './terms.js'

/** Ledger and lead rows no run has checked for this long are deleted (Neon cost; the design's 30-day retention, §9). */
export const TERMS_DAYS_KEPT = 30
const ACTS: readonly string[] = ['OBSERVE', 'PROPOSE', 'AUTO']

// ── Who is due ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface DueProduct { productId: string; market: string; settings: BrainSettings }
export interface TermsDue { due: boolean; why: string; products: DueProduct[] }

const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const

/** The products whose negatives or harvest lever is OBSERVE or higher (product level). Nothing enrolled: one read. */
export async function termsDue(): Promise<TermsDue> {
  const enrollments = await prisma.adsBrainEnrollment.findMany({ select: { productId: true, marketplace: true }, orderBy: [{ marketplace: 'asc' }, { productId: 'asc' }] })
  if (!enrollments.length) return { due: false, why: 'no product is enrolled in the brain: no term to decide', products: [] }
  const overrides = await prisma.adsBrainOverride.findMany({
    where: { endedAt: null, scope: 'PRODUCT', productId: { in: [...new Set(enrollments.map((e) => e.productId))] } },
    select: OVERRIDE_SELECT,
  }) as OverrideRow[]
  const products = enrollments.flatMap((e) => {
    const settings = resolveBrainSettings({ productId: e.productId, market: e.marketplace, campaignId: null, enrolled: true, overrides })
    return ACTS.includes(settings.levers.negatives.effective) || ACTS.includes(settings.levers.harvest.effective) ? [{ productId: e.productId, market: e.marketplace, settings }] : []
  })
  return products.length
    ? { due: true, why: `${products.length} product${products.length === 1 ? '' : 's'} with the negatives or harvest lever at OBSERVE or higher`, products }
    : { due: false, why: `${enrollments.length} product${enrollments.length === 1 ? ' is' : 's are'} enrolled, none with the negatives or harvest lever at OBSERVE or higher: no term to decide`, products: [] }
}

// ── The market's facts ───────────────────────────────────────────────────────────────────────────────────────────

interface SearchRow { externalCampaignId: string; externalAdGroupId: string; query: string; evidence: TermEvidence }

/** Every search term × campaign × ad group of these campaigns over the window, summed (one aggregate). */
async function searchTerms(externalCampaignIds: readonly string[], window: { since: Date; until: Date }): Promise<SearchRow[]> {
  if (!externalCampaignIds.length) return []
  const rows = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['campaignId', 'adGroupId', 'query'],
    where: { campaignId: { in: [...externalCampaignIds] }, date: { gte: window.since, lte: window.until } },
    _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
  })
  return rows.map((r) => ({
    externalCampaignId: r.campaignId, externalAdGroupId: r.adGroupId, query: r.query,
    evidence: {
      impressions: r._sum.impressions ?? 0, clicks: r._sum.clicks ?? 0, orders: r._sum.orders7d ?? 0, salesCents: r._sum.sales7dCents ?? 0,
      spendCents: Math.round(Number(r._sum.costMicros ?? 0n) / 10_000),
    },
  }))
}

interface TargetRow { id: string; adGroupId: string; campaignId: string; kind: string; expressionType: string; expressionValue: string; bidCents: number; isNegative: boolean; negativeLevel: string | null }

/** One product family's own terms in the market, built from its campaigns' search terms, keywords and negatives. */
interface ProductTerms {
  productId: string
  campaigns: Set<string>
  adGroups: Set<string>
  node: TermEvidence
  terms: Map<string, { evidence: TermEvidence; sources: Map<string, number>; targets: TermPlace[] }>
  negatives: Array<TermPlace & { text: string }>
}

const asinTerm = (s: string) => (isAsin(s) ? s.trim().toLowerCase() : null)

/** The term a keyword or product target stands for (a product target: its ASIN), or null (a category or auto target). */
function targetTerm(t: Pick<TargetRow, 'kind' | 'expressionValue'>): string | null {
  if (t.kind === 'PRODUCT') return asinTerm(t.expressionValue)
  const k = termKey(t.expressionValue)
  return k || null
}

export interface MarketFacts {
  market: string
  dataDay: Date
  windowDays: number
  products: Map<string, ProductTerms>
  marketNode: TermEvidence
  category: Map<string, string | null>
  categoryNode: Map<string, TermEvidence>
  contexts: Map<string, ProductContext>
  sharedCampaigns: number
  /** Per due product: Owner windows' evidence per term. */
  ownerWindows: Map<string, { harvest?: Map<string, TermEvidence>; negate?: Map<string, TermEvidence> }>
  destinations: Map<string, (term: string, sources: ReadonlyMap<string, number>) => HarvestDestination>
}

const strategySourceOf = (e: EffectiveStrategy | null, key: 'targetAcosPct' | 'harvest' | 'negate' | 'target') => {
  const s = e?.resolved.fields.get(key)?.source
  return s ? `the ads strategy: ${sourceLabel(s)}` : null
}

/** One market's facts for these due products (a fixed number of reads). */
export async function loadTermsMarket(market: string, due: readonly DueProduct[], now: Date): Promise<MarketFacts> {
  const window = settledBounds(LEDGER_WINDOW_DAYS, 'SPONSORED_PRODUCTS', { now })
  const all = await prisma.campaign.findMany({
    where: { adProduct: 'SPONSORED_PRODUCTS', status: { not: 'ARCHIVED' } },
    select: { id: true, name: true, marketplace: true, externalCampaignId: true, portfolioId: true, targetingType: true },
  })
  const campaigns = all.filter((c) => strategyMarket(c.marketplace) === market)
  const owners = await resolveCampaignOwnership(campaigns.map((c) => c.id))
  const ownerOf = new Map<string, string>()
  let sharedCampaigns = 0
  for (const [id, o] of owners) {
    if (o.owner.kind === 'product') ownerOf.set(id, o.owner.productId)
    else if (o.owner.kind === 'shared') sharedCampaigns++
  }
  const campaignById = new Map(campaigns.map((c) => [c.id, c]))
  const groups = campaigns.length ? await prisma.adGroup.findMany({ where: { campaignId: { in: campaigns.map((c) => c.id) }, status: { not: 'ARCHIVED' } }, select: { id: true, campaignId: true, name: true, externalAdGroupId: true } }) : []
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const ownGroups = groups.filter((g) => ownerOf.has(g.campaignId))
  const [targetRows, searchRows] = await Promise.all([
    ownGroups.length
      ? prisma.adTarget.findMany({
        where: { adGroupId: { in: ownGroups.map((g) => g.id) }, kind: { in: ['KEYWORD', 'PRODUCT'] }, status: { not: 'ARCHIVED' }, retiredAt: null },
        select: { id: true, adGroupId: true, kind: true, expressionType: true, expressionValue: true, bidCents: true, isNegative: true, negativeLevel: true },
      })
      : Promise.resolve([]),
    searchTerms(campaigns.map((c) => c.externalCampaignId).filter((x): x is string => !!x), window),
  ])
  const targets: TargetRow[] = targetRows.map((t) => ({ ...t, campaignId: groupById.get(t.adGroupId)!.campaignId }))
  const campaignOfExt = new Map(campaigns.filter((c) => c.externalCampaignId).map((c) => [c.externalCampaignId!, c.id]))
  const groupOfExt = new Map(groups.filter((g) => g.externalAdGroupId).map((g) => [g.externalAdGroupId!, g.id]))

  // Each product family's own terms.
  const products = new Map<string, ProductTerms>()
  const productOf = (root: string) => {
    let p = products.get(root)
    if (!p) { p = { productId: root, campaigns: new Set(), adGroups: new Set(), node: NO_TERM_EVIDENCE, terms: new Map(), negatives: [] }; products.set(root, p) }
    return p
  }
  for (const [campaignId, root] of ownerOf) productOf(root).campaigns.add(campaignId)
  for (const g of ownGroups) productOf(ownerOf.get(g.campaignId)!).adGroups.add(g.id)
  const termOf = (p: ProductTerms, term: string) => {
    let t = p.terms.get(term)
    if (!t) { t = { evidence: NO_TERM_EVIDENCE, sources: new Map(), targets: [] }; p.terms.set(term, t) }
    return t
  }
  let marketNode: TermEvidence = NO_TERM_EVIDENCE
  for (const r of searchRows) {
    marketNode = addEvidence(marketNode, r.evidence)
    const campaignId = campaignOfExt.get(r.externalCampaignId)
    const root = campaignId ? ownerOf.get(campaignId) : undefined
    if (!root) continue
    const term = asinTerm(r.query) ?? termKey(r.query)
    if (!term) continue
    const p = productOf(root)
    p.node = addEvidence(p.node, r.evidence)
    const t = termOf(p, term)
    t.evidence = addEvidence(t.evidence, r.evidence)
    const groupId = groupOfExt.get(r.externalAdGroupId)
    if (groupId) t.sources.set(groupId, (t.sources.get(groupId) ?? 0) + r.evidence.clicks)
  }
  for (const t of targets) {
    const root = ownerOf.get(t.campaignId)!
    const term = targetTerm(t)
    const match = matchOf(t.expressionType, t.kind)
    if (!term || !match) continue
    const p = productOf(root)
    const place: TermPlace = { campaignId: t.campaignId, adGroupId: t.adGroupId, targetId: t.id, match }
    if (t.isNegative) {
      p.negatives.push({ ...place, level: t.negativeLevel === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD_GROUP', text: term })
      // A negative is a term of the product too (every keyword it targets or negates, §2.8).
      if (match !== 'PHRASE') termOf(p, term)
    } else termOf(p, term).targets.push({ ...place, bidCents: t.bidCents })
  }
  for (const p of products.values()) for (const n of p.negatives.filter((x) => x.match === 'PHRASE')) termOf(p, n.text)

  // Families, categories and listing prices; brand words; protections; destinations; strategy; margins.
  const roots = [...products.keys()]
  const members = roots.length
    ? await prisma.product.findMany({ where: { deletedAt: null, OR: [{ id: { in: roots } }, { parentId: { in: roots } }] }, select: { id: true, parentId: true, basePrice: true } })
    : []
  const rootOfMember = new Map(members.map((m) => [m.id, m.parentId && roots.includes(m.parentId) ? m.parentId : m.id]))
  const membersOf = new Map<string, string[]>()
  for (const [id, root] of rootOfMember) membersOf.set(root, [...(membersOf.get(root) ?? []), id])
  const memberIds = [...rootOfMember.keys()]
  const dueRoots = new Set(due.map((d) => d.productId))
  const [primaries, playbooks, protections, stored, view, ownerTargets, margins] = await Promise.all([
    memberIds.length ? prisma.productCategory.findMany({ where: { productId: { in: memberIds }, isPrimary: true }, select: { productId: true, categoryId: true } }) : Promise.resolve([]),
    prisma.adsPlaybook.findMany({ where: { channel: 'AMAZON', market, level: 'PRODUCT', scopeId: { in: memberIds.length ? memberIds : ['-'] } }, select: { scopeId: true, terms: true } }),
    loadProtectedTerms({ marketplace: market }),
    prisma.adsHarvestDestination.findMany({ where: { matchType: { in: ['EXACT', 'PRODUCT'] } }, select: { scopeGrain: true, scopeId: true, matchType: true, adGroupId: true } }),
    openStrategy(market),
    readOwnerTargets([]),
    memberIds.length ? breakevenByProduct(memberIds, [...new Set([market, ...campaigns.map((c) => c.marketplace).filter((m): m is string => !!m)])]) : Promise.resolve(new Map()),
  ])
  const category = new Map<string, string | null>()
  for (const root of roots) {
    const own = primaries.find((p) => p.productId === root) ?? primaries.filter((p) => rootOfMember.get(p.productId) === root).sort((a, b) => a.productId.localeCompare(b.productId))[0]
    category.set(root, own?.categoryId ?? null)
  }
  const categoryNode = new Map<string, TermEvidence>()
  for (const [root, cat] of category) if (cat) categoryNode.set(cat, addEvidence(categoryNode.get(cat) ?? NO_TERM_EVIDENCE, products.get(root)!.node))
  const brandOf = new Map<string, string[]>()
  for (const row of playbooks) {
    const root = rootOfMember.get(row.scopeId)
    const brand = (row.terms as { brand?: unknown } | null)?.brand
    if (!root || !Array.isArray(brand)) continue
    brandOf.set(root, [...new Set([...(brandOf.get(root) ?? []), ...brand.filter((b): b is string => typeof b === 'string').map(termKey).filter(Boolean)])])
  }
  const listPrice = (root: string) => {
    const ids = membersOf.get(root) ?? [root]
    const prices = members.filter((m) => ids.includes(m.id)).sort((a, b) => (a.id === root ? -1 : b.id === root ? 1 : a.id.localeCompare(b.id))).map((m) => Math.round(Number(m.basePrice ?? 0) * 100)).filter((c) => c > 0)
    return prices[0] ?? null
  }
  // The strategy: each due product resolved with its variations (the safer value per field); the others on their own root.
  const strategyOf = new Map<string, EffectiveStrategy | null>()
  if (!view.empty) {
    for (const root of dueRoots) if (products.has(root)) strategyOf.set(root, await view.forProducts(membersOf.get(root) ?? [root]))
    const others = roots.filter((r) => !dueRoots.has(r))
    if (others.length) for (const [id, e] of await view.forEachProduct(others)) strategyOf.set(id, e)
  }
  const accountPct = typeof ownerTargets.accountDefaultPct === 'number' && ownerTargets.accountDefaultPct > 0 ? ownerTargets.accountDefaultPct : null
  const marginOf = (root: string): { value: number; revenue: number } | null => {
    let revenue = 0, weighted = 0
    for (const id of membersOf.get(root) ?? [root]) {
      const m = margins.get(id) as { breakevenAcos: number; grossRevenueCents: number } | undefined
      if (m && m.grossRevenueCents > 0) { revenue += m.grossRevenueCents; weighted += m.breakevenAcos * m.grossRevenueCents }
    }
    return revenue > 0 ? { value: weighted / revenue, revenue } : null
  }
  const settingsOf = new Map(due.map((d) => [d.productId, d.settings]))
  const contexts = new Map<string, ProductContext>()
  for (const root of roots) {
    const e = strategyOf.get(root) ?? null
    const strategyPct = e?.values.targetAcosPct ?? null
    const targetAcos = strategyPct != null && strategyPct > 0
      ? { value: strategyPct / 100, source: strategySourceOf(e, 'targetAcosPct') ?? 'the ads strategy' }
      : accountPct != null ? { value: accountPct / 100, source: 'the account\'s default target ACoS' } : null
    const t = e?.resolved.fields.get('target')?.value as { targetKind?: unknown; targetHiPct?: unknown } | undefined
    const bandTop = t?.targetKind === 'ACOS' && typeof t.targetHiPct === 'number' && t.targetHiPct > 0
      ? { value: t.targetHiPct / 100, source: `the band top of ${strategySourceOf(e, 'target') ?? 'the ads strategy'}` }
      : targetAcos ? { value: targetAcos.value, source: `the target (${targetAcos.source})` } : null
    const settings = settingsOf.get(root) ?? null
    const termLocks = (lever: 'negatives' | 'harvest') => new Set((settings?.levers[lever].locks ?? []).filter((l) => l.ref.startsWith('term:')).map((l) => l.ref.slice('term:'.length)))
    const margin = marginOf(root)
    const cat = category.get(root) ?? null
    const p = products.get(root)!
    contexts.set(root, {
      productId: root,
      pool: {
        nodes: [
          { level: 'product', evidence: { clicks: p.node.clicks, orders: p.node.orders, salesCents: p.node.salesCents, costCents: p.node.spendCents } },
          ...(cat ? [{ level: 'category' as const, evidence: (({ clicks, orders, salesCents, spendCents }) => ({ clicks, orders, salesCents, costCents: spendCents }))(categoryNode.get(cat)!) }] : []),
          { level: 'market', evidence: { clicks: marketNode.clicks, orders: marketNode.orders, salesCents: marketNode.salesCents, costCents: marketNode.spendCents } },
        ],
        listPriceCents: listPrice(root),
      },
      targetAcos,
      bandTop,
      harvestGroup: e?.values.harvest ? { ...e.values.harvest, source: strategySourceOf(e, 'harvest') ?? 'the ads strategy' } : null,
      negateGroup: e?.values.negate ? { ...e.values.negate, source: strategySourceOf(e, 'negate') ?? 'the ads strategy' } : null,
      protections: protections as ProtectedTerm[],
      brand: brandOf.get(root) ?? [],
      margin: margin ? { value: margin.value, source: 'profit' } : targetAcos ? { value: targetAcos.value, source: 'target' } : null,
      levers: { negatives: (settings?.levers.negatives.effective ?? 'NOT_ENROLLED') as LeverEffective, harvest: (settings?.levers.harvest.effective ?? 'NOT_ENROLLED') as LeverEffective },
      lockedTerms: { negatives: termLocks('negatives'), harvest: termLocks('harvest') },
      caps: { negativesPerDay: Number(settings?.values.negativesPerDay.value ?? 20), harvestPerDay: Number(settings?.values.harvestPerDay.value ?? 10) },
    })
  }

  // The Owner's windows, where his group names another than the brain's (one aggregate per window, own campaigns only).
  const ownerWindows = new Map<string, { harvest?: Map<string, TermEvidence>; negate?: Map<string, TermEvidence> }>()
  const byWindow = new Map<number, Array<{ root: string; kind: 'harvest' | 'negate' }>>()
  for (const root of dueRoots) {
    const ctx = contexts.get(root)
    if (!ctx) continue
    for (const kind of ['harvest', 'negate'] as const) {
      const days = ctx[kind === 'harvest' ? 'harvestGroup' : 'negateGroup']?.windowDays
      if (days && days !== LEDGER_WINDOW_DAYS) byWindow.set(days, [...(byWindow.get(days) ?? []), { root, kind }])
    }
  }
  for (const [days, asks] of byWindow) {
    const roots_ = [...new Set(asks.map((a) => a.root))]
    const exts = roots_.flatMap((r) => [...products.get(r)!.campaigns].map((id) => campaignById.get(id)?.externalCampaignId).filter((x): x is string => !!x))
    const rows = await searchTerms(exts, settledBounds(Math.min(90, days), 'SPONSORED_PRODUCTS', { now }))
    for (const { root, kind } of asks) {
      const own = new Set([...products.get(root)!.campaigns].map((id) => campaignById.get(id)?.externalCampaignId).filter((x): x is string => !!x))
      const map = new Map<string, TermEvidence>()
      for (const r of rows) {
        if (!own.has(r.externalCampaignId)) continue
        const term = asinTerm(r.query) ?? termKey(r.query)
        if (term) map.set(term, addEvidence(map.get(term) ?? NO_TERM_EVIDENCE, r.evidence))
      }
      ownerWindows.set(root, { ...(ownerWindows.get(root) ?? {}), [kind]: map })
    }
  }

  // Destinations: the stored one for the source (first grain that matches), else the product's one exact ad group.
  const positivesIn = new Map<string, TargetRow[]>()
  for (const t of targets) if (!t.isNegative) positivesIn.set(t.adGroupId, [...(positivesIn.get(t.adGroupId) ?? []), t])
  const keywordsIn = (adGroupId: string, product: boolean) => (positivesIn.get(adGroupId) ?? []).filter((t) => (product ? t.kind === 'PRODUCT' : t.kind === 'KEYWORD')).length
  const destinations = new Map<string, (term: string, sources: ReadonlyMap<string, number>) => HarvestDestination>()
  for (const root of dueRoots) {
    const p = products.get(root)
    if (!p) continue
    const own = [...p.adGroups].map((id) => groupById.get(id)!).filter((g) => (campaignById.get(g.campaignId)?.targetingType ?? 'MANUAL').toUpperCase() !== 'AUTO')
    const exactGroups = own.filter((g) => roleOf(g.name, (positivesIn.get(g.id) ?? []).map((t) => ({ expressionType: t.expressionType, isNegative: false }))) === 'EXACT')
    const productGroups = own.filter((g) => keywordsIn(g.id, true) > 0)
    const familyIds = new Set(membersOf.get(root) ?? [root])
    destinations.set(root, (term, sources) => {
      const product = isAsin(term)
      const source = [...sources].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
      const g = source ? groupById.get(source) : undefined
      const c = g ? campaignById.get(g.campaignId) : undefined
      const covers = (d: { scopeGrain: string; scopeId: string }) => (d.scopeGrain === 'adGroup' && !!g && d.scopeId === g.id)
        || (d.scopeGrain === 'campaign' && !!c && d.scopeId === c.id)
        || (d.scopeGrain === 'portfolio' && !!c?.portfolioId && d.scopeId === c.portfolioId)
        || (d.scopeGrain === 'line' && familyIds.has(d.scopeId))
        || (d.scopeGrain === 'market' && strategyMarket(d.scopeId) === market)
        || d.scopeGrain === 'account'
      const hit = stored.filter((d) => d.matchType === (product ? 'PRODUCT' : 'EXACT') && covers(d))
        .sort((a, b) => (HV_DEST_GRAINS as readonly string[]).indexOf(a.scopeGrain) - (HV_DEST_GRAINS as readonly string[]).indexOf(b.scopeGrain))[0]
      if (hit) return p.adGroups.has(hit.adGroupId) ? { source: 'stored', adGroupId: hit.adGroupId, keywords: keywordsIn(hit.adGroupId, product) } : { source: 'elsewhere', adGroupId: hit.adGroupId, keywords: null }
      const list = product ? productGroups : exactGroups
      if (list.length === 1) return { source: 'own', adGroupId: list[0].id, keywords: keywordsIn(list[0].id, product) }
      return list.length ? { source: 'ambiguous', adGroupId: null, keywords: null, candidates: list.length } : { source: 'none', adGroupId: null, keywords: null }
    })
  }
  return { market, dataDay: window.until, windowDays: LEDGER_WINDOW_DAYS, products, marketNode, category, categoryNode, contexts, sharedCampaigns, ownerWindows, destinations }
}

// ── Decide (pure over the facts) ─────────────────────────────────────────────────────────────────────────────────

export interface MarketDecisions {
  byProduct: Map<string, TermDecision[]>
  leads: Map<string, LeadDecision>
}

/** The facts of one product's term, as brain/terms.ts reads them. */
function factsOf(m: MarketFacts, root: string, term: string): TermFacts {
  const p = m.products.get(root)!
  const t = p.terms.get(term) ?? { evidence: NO_TERM_EVIDENCE, sources: new Map<string, number>(), targets: [] }
  const negatives = p.negatives.filter((n) => negativeBlocks(term, { text: n.text, match: n.match as MatchKind }) && (n.match !== 'PRODUCT' || isAsin(term)))
    .map(({ text, ...rest }) => (text === term ? rest : { ...rest, text }))
  const owner = m.ownerWindows.get(root)
  const destination = m.destinations.get(root)?.(term, t.sources) ?? { source: 'none' as const, adGroupId: null, keywords: null }
  return {
    term, evidence: t.evidence, targets: t.targets, negatives, destination,
    ...(owner ? { ownerEvidence: { ...(owner.harvest ? { harvest: owner.harvest.get(term) ?? NO_TERM_EVIDENCE } : {}), ...(owner.negate ? { negate: owner.negate.get(term) ?? NO_TERM_EVIDENCE } : {}) } } : {}),
  }
}

/** The arbiter over every family that holds a due product's term, then one decision per term of each due product. */
export function decideMarket(m: MarketFacts, due: readonly DueProduct[], opts: { pinned?: ReadonlyMap<string, string> } = {}): MarketDecisions {
  const dueRoots = due.map((d) => d.productId).filter((r) => m.products.has(r))
  const held = new Set(dueRoots.flatMap((r) => [...m.products.get(r)!.terms.keys()]))
  const testsCache = new Map<string, TermTests>()
  const testsOf = (root: string, term: string) => {
    const key = `${root}\u0000${term}`
    let t = testsCache.get(key)
    if (!t) { t = termTests(factsOf(m, root, term), m.contexts.get(root)!); testsCache.set(key, t) }
    return t
  }
  const claims: Claim[] = []
  for (const [root, p] of m.products) {
    const ctx = m.contexts.get(root)!
    for (const [term, t] of p.terms) {
      if (!held.has(term)) continue
      const tests = testsOf(root, term)
      claims.push({ productId: root, term, targets: t.targets.map((x) => ({ targetId: x.targetId, campaignId: x.campaignId, adGroupId: x.adGroupId, match: x.match, bidCents: x.bidCents ?? null })), wants: tests.harvest.pass, orders: t.evidence.orders, clicks: t.evidence.clicks, profitPerClickCents: tests.profitPerClickCents, brandWord: brandWordIn(term, ctx.brand) })
    }
  }
  const leads = arbitrate(claims, opts)
  const byProduct = new Map<string, TermDecision[]>()
  for (const root of dueRoots) {
    const ctx = m.contexts.get(root)!
    const decisions = [...m.products.get(root)!.terms.keys()].sort().map((term) => {
      const lead = leads.get(term)
      return decideTerm(factsOf(m, root, term), ctx, testsOf(root, term), lead ? { leadProductId: lead.leadProductId, rule: lead.rule, leadBidCents: lead.leadBidCents, maxBidCents: lead.maxBidCents, why: lead.why } : null)
    })
    byProduct.set(root, applyCaps(decisions, ctx.caps))
  }
  return { byProduct, leads: new Map([...leads].filter(([term]) => held.has(term))) }
}

// ── Store ────────────────────────────────────────────────────────────────────────────────────────────────────────

const json = (v: unknown) => v as Prisma.InputJsonValue
const digestOf = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('base64url').slice(0, 22)
const IN_CHUNK = 1000
const chunks = <T,>(list: readonly T[]) => Array.from({ length: Math.ceil(list.length / IN_CHUNK) }, (_, i) => list.slice(i * IN_CHUNK, (i + 1) * IN_CHUNK))

/** A ledger row's content (everything the decision says; the run's own fields apart). */
export function ledgerContent(d: TermDecision, windowDays: number) {
  const evidence = {
    targets: d.targets, negatives: d.negatives, destination: d.destination,
    lead: d.lead, wouldLower: d.wouldLower, clashes: d.clashes,
    tests: {
      harvest: d.tests.harvest, negate: d.tests.negate, winner: d.tests.winner, protectionWhy: d.tests.protectionWhy,
      cr: d.tests.cr, aovCents: d.tests.aovCents, cpcCents: d.tests.cpcCents, profitPerClickCents: d.tests.profitPerClickCents,
    },
  }
  const content = {
    term: d.term, isAsin: d.isAsin, state: d.state, protection: d.protection, leadProductId: d.lead?.leadProductId ?? null,
    heldBy: d.heldBy, capped: d.capped, askFirst: d.askFirst, clashCount: d.clashes.length,
    impressions: d.evidence.impressions, clicks: d.evidence.clicks, orders: d.evidence.orders, spendCents: d.evidence.spendCents, salesCents: d.evidence.salesCents,
    windowDays, why: d.why.slice(0, 2000), evidence,
  }
  return { content, digest: digestOf(content) }
}

export interface StoreCounts { created: number; changed: number; unchanged: number; removed: number }

/**
 * Replace one product's ledger in one market with this run's decisions (one transaction, a fixed number of statements per
 * 1,000 rows): new terms created; a changed decision rewritten in place (deleted and created again with its id, its first
 * day, and — when its state moved — the state before and the new since); an unchanged one only stamped with the run; a
 * term no longer held removed.
 */
export async function storeLedger(args: { productId: string; market: string; decisions: readonly TermDecision[]; runId: string; dataDay: Date; windowDays: number; now: Date }): Promise<StoreCounts> {
  const { productId, market, runId, dataDay, now } = args
  return inDatabaseTransaction(prisma, async () => {
    const existing = await prisma.adsBrainTerm.findMany({ where: { productId, marketplace: market }, select: { id: true, term: true, state: true, previousState: true, stateSince: true, digest: true, createdAt: true } })
    const byTerm = new Map(existing.map((r) => [r.term, r]))
    const seen = new Set<string>()
    const create: Prisma.AdsBrainTermCreateManyInput[] = []
    const rewrite: Prisma.AdsBrainTermCreateManyInput[] = []
    const unchanged: string[] = []
    for (const d of args.decisions) {
      seen.add(d.term)
      const { content, digest } = ledgerContent(d, args.windowDays)
      const was = byTerm.get(d.term)
      const row = { productId, marketplace: market, ...content, evidence: json(content.evidence), digest, runId, dataDay, checkedAt: now, changedAt: now }
      if (!was) create.push({ ...row, stateSince: now })
      else if (was.digest === digest) unchanged.push(was.id)
      else {
        const moved = was.state !== d.state
        rewrite.push({ ...row, id: was.id, createdAt: was.createdAt, previousState: moved ? was.state : was.previousState, stateSince: moved ? now : was.stateSince })
      }
    }
    const gone = existing.filter((r) => !seen.has(r.term)).map((r) => r.id)
    for (const part of chunks([...rewrite.map((r) => r.id!), ...gone])) await prisma.adsBrainTerm.deleteMany({ where: { id: { in: part } } })
    for (const part of chunks([...create, ...rewrite])) await prisma.adsBrainTerm.createMany({ data: part })
    for (const part of chunks(unchanged)) await prisma.adsBrainTerm.updateMany({ where: { id: { in: part } }, data: { runId, dataDay, checkedAt: now } })
    return { created: create.length, changed: rewrite.length, unchanged: unchanged.length, removed: gone.length }
  }, { isolationLevel: 'ReadCommitted' })
}

/** Replace one market's leads with this run's (one transaction; the same way as the ledger). */
export async function storeLeads(args: { market: string; leads: ReadonlyMap<string, LeadDecision>; runId: string; now: Date }): Promise<StoreCounts> {
  const { market, runId, now } = args
  return inDatabaseTransaction(prisma, async () => {
    const existing = await prisma.adsBrainTermLead.findMany({ where: { marketplace: market }, select: { id: true, term: true, leadProductId: true, previousLeadProductId: true, leadSince: true, digest: true, createdAt: true } })
    const byTerm = new Map(existing.map((r) => [r.term, r]))
    const create: Prisma.AdsBrainTermLeadCreateManyInput[] = []
    const rewrite: Prisma.AdsBrainTermLeadCreateManyInput[] = []
    const unchanged: string[] = []
    for (const [term, l] of args.leads) {
      const content = { term, leadProductId: l.leadProductId, rule: l.rule, leadBidCents: l.leadBidCents, maxBidCents: l.maxBidCents, contenders: l.contenders, wouldLower: l.wouldLower, why: l.why.slice(0, 2000) }
      const digest = digestOf(content)
      const was = byTerm.get(term)
      const row = { marketplace: market, ...content, contenders: json(content.contenders), wouldLower: json(content.wouldLower), digest, runId, checkedAt: now, changedAt: now }
      if (!was) create.push({ ...row, leadSince: now })
      else if (was.digest === digest) unchanged.push(was.id)
      else {
        const moved = was.leadProductId !== l.leadProductId
        rewrite.push({ ...row, id: was.id, createdAt: was.createdAt, previousLeadProductId: moved ? was.leadProductId : was.previousLeadProductId, leadSince: moved ? now : was.leadSince })
      }
    }
    const gone = existing.filter((r) => !args.leads.has(r.term)).map((r) => r.id)
    for (const part of chunks([...rewrite.map((r) => r.id!), ...gone])) await prisma.adsBrainTermLead.deleteMany({ where: { id: { in: part } } })
    for (const part of chunks([...create, ...rewrite])) await prisma.adsBrainTermLead.createMany({ data: part })
    for (const part of chunks(unchanged)) await prisma.adsBrainTermLead.updateMany({ where: { id: { in: part } }, data: { runId, checkedAt: now } })
    return { created: create.length, changed: rewrite.length, unchanged: unchanged.length, removed: gone.length }
  }, { isolationLevel: 'ReadCommitted' })
}

// ── The run ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TermsRunSummary {
  ran: boolean
  why: string
  runId?: string
  products: number
  markets: string[]
  terms: number
  byState: Partial<Record<TermState, number>>
  ledger: StoreCounts
  leads: number
  /** Due products the run could not decide (no campaign of its own in the market, a deleted family root), with why. */
  skipped: Array<{ productId: string; market: string; why: string }>
  /** Shared campaigns in the markets read: no product's (D2), their terms counted for the market's pooled rate only. */
  sharedCampaigns: number
  pruned: number
}

const ZERO: StoreCounts = { created: 0, changed: 0, unchanged: 0, removed: 0 }
const sum = (a: StoreCounts, b: StoreCounts): StoreCounts => ({ created: a.created + b.created, changed: a.changed + b.changed, unchanged: a.unchanged + b.unchanged, removed: a.removed + b.removed })

/** Delete ledger and lead rows no run has checked for TERMS_DAYS_KEPT days. */
export async function pruneTerms(now: Date): Promise<number> {
  const before = new Date(now.getTime() - TERMS_DAYS_KEPT * 86_400_000)
  const [a, b] = await Promise.all([
    prisma.adsBrainTerm.deleteMany({ where: { checkedAt: { lt: before } } }),
    prisma.adsBrainTermLead.deleteMany({ where: { checkedAt: { lt: before } } }),
  ])
  return a.count + b.count
}

/** One run in the business the caller is in. Nothing due: nothing read past the enrollments, nothing written but the prune. */
export async function runTermsOnce(opts: { now?: Date; pinned?: ReadonlyMap<string, string>; due?: TermsDue } = {}): Promise<TermsRunSummary> {
  const now = opts.now ?? new Date()
  const due = opts.due ?? await termsDue()
  // The 30-day prune runs also when nothing is due: rows of a product that left the lever go after 30 days. Nothing
  // enrolled and no row: two deletes of nothing.
  if (!due.due) return { ran: false, why: due.why, products: 0, markets: [], terms: 0, byState: {}, ledger: ZERO, leads: 0, skipped: [], sharedCampaigns: 0, pruned: await pruneTerms(now) }
  const runId = randomUUID()
  const byMarket = new Map<string, DueProduct[]>()
  for (const d of due.products) byMarket.set(d.market, [...(byMarket.get(d.market) ?? []), d])
  let ledger = ZERO
  let terms = 0
  let leads = 0
  let sharedCampaigns = 0
  const states: Partial<Record<TermState, number>> = {}
  const skipped: TermsRunSummary['skipped'] = []
  for (const [market, list] of [...byMarket].sort(([a], [b]) => a.localeCompare(b))) {
    const facts = await loadTermsMarket(market, list, now)
    sharedCampaigns += facts.sharedCampaigns
    for (const d of list) if (!facts.products.has(d.productId)) skipped.push({ productId: d.productId, market, why: 'no Sponsored Products campaign of its own in this market (a shared campaign is no product\'s, D2): no term to decide' })
    const decided = decideMarket(facts, list, { pinned: opts.pinned })
    for (const [productId, decisions] of decided.byProduct) {
      ledger = sum(ledger, await storeLedger({ productId, market, decisions, runId, dataDay: facts.dataDay, windowDays: facts.windowDays, now }))
      terms += decisions.length
      for (const [s, n] of Object.entries(stateCounts(decisions))) if (n) states[s as TermState] = (states[s as TermState] ?? 0) + n
    }
    await storeLeads({ market, leads: decided.leads, runId, now })
    leads += decided.leads.size
  }
  const pruned = await pruneTerms(now)
  const summary: TermsRunSummary = { ran: true, why: due.why, runId, products: due.products.length - skipped.length, markets: [...byMarket.keys()].sort(), terms, byState: states, ledger, leads, skipped, sharedCampaigns, pruned }
  logger.info('[ads-brain-terms] shadow run', { runId, products: summary.products, markets: summary.markets, terms, ledger, leads, skipped: skipped.length, pruned })
  return summary
}

/** The run in one line (the cron's record). */
export function termsSummaryLine(s: TermsRunSummary): string {
  if (!s.ran) return `not run: ${s.why}`
  const states = Object.entries(s.byState).map(([k, n]) => `${k}=${n}`).join(' ')
  return `products=${s.products} markets=${s.markets.join(',') || '-'} terms=${s.terms} ${states} created=${s.ledger.created} changed=${s.ledger.changed} removed=${s.ledger.removed} leads=${s.leads} skipped=${s.skipped.length} shared=${s.sharedCampaigns} pruned=${s.pruned}`.replace(/\s+/g, ' ').trim()
}
