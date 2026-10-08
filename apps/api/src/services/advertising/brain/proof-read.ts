/**
 * ONE BRAIN AB-20 — the proof, read from Nexus's data (design 2026-10-08-ads-one-brain/DESIGN.md §7 "Proof", §8 row AB-20).
 * Read only: it changes nothing. The maths is brain/proof.ts; this finds the products, their comparisons and their days.
 *
 *   brain products   the products the brain ACTS on in the market — enrolled in the brain, or owning a campaign the bid
 *                    brain runs LIVE or HELD (BB-6: the keyword bids lever, live before enrolment as on the first pilot). The
 *                    day it started is the first of — the day the bid brain took one of the product's own campaigns LIVE (its
 *                    snapshot), the day a lever of the product went to AUTO (the Owner's level, ended or not), the day a
 *                    lever's snapshot was taken. A product whose every lever is still in shadow has no start: nothing to
 *                    compare. `since` names the day instead (one product).
 *   comparisons      products of the same market whose own campaigns no brain runs (not enrolled there, no campaign the bid
 *                    brain runs LIVE or HELD), matched by category, price band and spend level (proof.ts matchControls).
 *   days             per product, its OWN campaigns only (a campaign several products share is no product's to credit, D2):
 *                    ad spend, ad sales (7-day) and ad orders from the daily Sponsored Products report
 *                    (AmazonAdsDailyPerformance, campaign rows); its total sales from Nexus's daily true profit
 *                    (ProductProfitDaily.grossRevenueCents, the family's members) for TACoS.
 *   margin           the product's contribution margin before ads: Nexus's daily true profit over 90 days (revenue − cost of
 *                    goods from product-costs − Amazon's fees; ads-target-acos.service.ts breakevenByProduct, the members
 *                    weighted by revenue); else its cost price against its list price (product-costs — Amazon's fees not
 *                    counted, so the margin and the ad profit read high: said so); else none — ad profit is not measured.
 *   cost             a product whose brain started less than 4 weeks ago answers at once (no comparison is looked for); the
 *                    rest is a fixed number of queries per market, whatever the number of products.
 */
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { EXCLUDE_AMS_DAILY } from '../../ads-core/ams-daily.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { settledEnd } from '../ads-settled-window.js'
import { readSnapshot } from '../bid-brain/enrollment.js'
import { productCampaigns, productFamily, resolveCampaignOwnership } from './ownership.js'
import {
  addDays, daysBetween, designResult, DESIGN_WORDS, MATCH_NONE, matchControls, MEASURE_WORDS, MEASURES, MIN_ORDERS, pairWeeks, PRICE_BAND_RATIO, PROOF_WEEKS_DEFAULT,
  PROOF_WEEKS_MAX, PROOF_WEEKS_MIN, type ArmInput, type DayRow, type Design, type DesignResult, type Match, type MatchFacts, type PairWeeks,
} from './proof.js'
import { amount } from './cycle.js'

const DAY_MS = 86_400_000
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err))
const OWNED_MODES = ['LIVE', 'HELD']

/** Where a product's margin comes from (said in the view and the report). */
export type MarginSource = 'true-profit' | 'cost-price' | 'none'
export const MARGIN_SOURCE_WORDS: Record<MarginSource, string> = {
  'true-profit': 'its contribution margin from Nexus\'s daily true profit over 90 days (revenue − cost of goods from product-costs − Amazon\'s fees)',
  'cost-price': 'its cost price (product-costs) against its list price — Amazon\'s fees are not counted, so the margin and the ad profit read high',
  none: 'no margin: no cost price is known (set-product-costs) — ad profit is not measured',
}

interface ProductFacts {
  productId: string
  name: string | null
  members: string[]
  own: string[]
  categoryId: string | null
  priceCents: number | null
  margin: number | null
  marginSource: MarginSource
}

/** The day the brain started acting on a product (null: still in shadow), and how that day is known. */
export async function brainStartOf(productId: string, market: string, own: readonly string[]): Promise<{ day: string; how: string } | null> {
  const [bid, levels, enrollment] = await Promise.all([
    own.length ? prisma.bidBrainEnrollment.findMany({ where: { campaignId: { in: [...own] }, mode: { in: OWNED_MODES } }, select: { campaignId: true, snapshot: true, updatedAt: true } }) : Promise.resolve([]),
    prisma.adsBrainOverride.findMany({ where: { productId, marketplace: market, scope: 'PRODUCT', kind: 'LEVEL' }, select: { key: true, value: true, createdAt: true } }),
    prisma.adsBrainEnrollment.findFirst({ where: { productId, marketplace: market }, select: { snapshots: true } }),
  ])
  const found: Array<{ at: string; how: string }> = []
  for (const b of bid) {
    const taken = readSnapshot(b.snapshot)?.takenAt
    const at = taken && !Number.isNaN(Date.parse(taken)) ? taken : b.updatedAt.toISOString()
    found.push({ at, how: `the bid brain took campaign ${b.campaignId} live` })
  }
  for (const l of levels) if (l.value === 'AUTO') found.push({ at: l.createdAt.toISOString(), how: `the ${l.key} lever went to AUTO` })
  for (const [lever, snap] of Object.entries((enrollment?.snapshots ?? {}) as Record<string, { takenAt?: unknown }>)) {
    if (typeof snap?.takenAt === 'string' && !Number.isNaN(Date.parse(snap.takenAt))) found.push({ at: snap.takenAt, how: `the ${lever} lever went live` })
  }
  const first = found.sort((a, b) => a.at.localeCompare(b.at))[0]
  return first ? { day: first.at.slice(0, 10), how: first.how } : null
}

/** The market's spellings a daily row may carry (the short code and every campaign marketplace that maps to it). */
async function marketSpellings(market: string): Promise<string[]> {
  const rows = await prisma.campaign.findMany({ where: { adProduct: 'SPONSORED_PRODUCTS' }, distinct: ['marketplace'], select: { marketplace: true } })
  return [...new Set([market, ...rows.map((r) => r.marketplace).filter((x): x is string => !!x && strategyMarket(x) === market)])]
}

/** Category, price and margin of products (family roots with their members), in a fixed number of queries. */
async function productFacts(list: ReadonlyArray<{ productId: string; members: string[]; own: string[] }>, spellings: readonly string[]): Promise<Map<string, ProductFacts>> {
  const memberIds = [...new Set(list.flatMap((p) => p.members))]
  if (!memberIds.length) return new Map()
  const { breakevenByProduct } = await import('../ads-target-acos.service.js')
  const [products, categories, margins] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true, basePrice: true, costPrice: true } }),
    prisma.productCategory.findMany({ where: { productId: { in: memberIds }, isPrimary: true }, select: { productId: true, categoryId: true } }),
    breakevenByProduct(memberIds, spellings, 90).catch((err: unknown) => { logger.warn('[ads-brain] proof: the margins could not be read', { error: msg(err) }); return new Map<string, { breakevenAcos: number; grossRevenueCents: number }>() }),
  ])
  const byId = new Map(products.map((p) => [p.id, p]))
  const out = new Map<string, ProductFacts>()
  for (const p of list) {
    const ordered = [p.productId, ...p.members.filter((m) => m !== p.productId).sort()]
    const price = ordered.map((id) => Math.round(Number(byId.get(id)?.basePrice ?? 0) * 100)).find((c) => c > 0) ?? null
    const category = categories.find((c) => c.productId === p.productId)?.categoryId ?? categories.filter((c) => ordered.includes(c.productId)).sort((a, b) => a.productId.localeCompare(b.productId))[0]?.categoryId ?? null
    let revenue = 0, weighted = 0
    for (const id of ordered) {
      const m = margins.get(id)
      if (m && m.grossRevenueCents > 0) { revenue += m.grossRevenueCents; weighted += m.breakevenAcos * m.grossRevenueCents }
    }
    let margin: number | null = revenue > 0 ? weighted / revenue : null
    let source: MarginSource = margin != null ? 'true-profit' : 'none'
    if (margin == null) {
      const withCost = ordered.map((id) => byId.get(id)).find((x) => x && Number(x.costPrice ?? 0) > 0 && Number(x.basePrice ?? 0) > 0)
      if (withCost) { margin = Math.max(-1, Math.min(1, 1 - Number(withCost.costPrice) / Number(withCost.basePrice))); source = 'cost-price' }
    }
    out.set(p.productId, { productId: p.productId, name: byId.get(p.productId)?.name ?? null, members: p.members, own: p.own, categoryId: category, priceCents: price, margin, marginSource: source })
  }
  return out
}

/** Each product's days over [from, to]: its own campaigns' ad rows, its members' total sales. Two queries. */
async function productDays(list: readonly ProductFacts[], from: string, to: string, spellings: readonly string[]): Promise<Map<string, { rows: DayRow[]; revenueKnown: boolean }>> {
  const campaignOwner = new Map<string, string>()
  for (const p of list) for (const c of p.own) campaignOwner.set(c, p.productId)
  const memberOwner = new Map<string, string>()
  for (const p of list) for (const m of p.members) memberOwner.set(m, p.productId)
  const range = { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) }
  const [ads, revenue] = await Promise.all([
    campaignOwner.size ? prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId', 'date'],
      where: { entityType: 'CAMPAIGN', adProduct: 'SPONSORED_PRODUCTS', localEntityId: { in: [...campaignOwner.keys()] }, date: range, ...EXCLUDE_AMS_DAILY },
      _sum: { costMicros: true, sales7dCents: true, orders7d: true },
    }) : Promise.resolve([]),
    memberOwner.size ? prisma.productProfitDaily.groupBy({ by: ['productId', 'date'], where: { productId: { in: [...memberOwner.keys()] }, marketplace: { in: [...spellings] }, date: range }, _sum: { grossRevenueCents: true } }) : Promise.resolve([]),
  ])
  const days = new Map<string, Map<string, DayRow>>()
  const rowOf = (productId: string, day: string) => {
    const m = days.get(productId) ?? new Map<string, DayRow>()
    days.set(productId, m)
    const r = m.get(day) ?? { day, spendCents: 0, salesCents: 0, orders: 0, revenueCents: null }
    m.set(day, r)
    return r
  }
  for (const a of ads) {
    const owner = a.localEntityId ? campaignOwner.get(a.localEntityId) : null
    if (!owner) continue
    const r = rowOf(owner, isoDay(new Date(a.date)))
    r.spendCents += Math.round(Number(a._sum.costMicros ?? 0n) / 10_000)
    r.salesCents += a._sum.sales7dCents ?? 0
    r.orders += a._sum.orders7d ?? 0
  }
  const revenueKnown = new Set<string>()
  for (const v of revenue) {
    const owner = memberOwner.get(v.productId)
    if (!owner) continue
    revenueKnown.add(owner)
    const r = rowOf(owner, isoDay(new Date(v.date)))
    r.revenueCents = (r.revenueCents ?? 0) + (v._sum.grossRevenueCents ?? 0)
  }
  return new Map(list.map((p) => [p.productId, { rows: [...(days.get(p.productId)?.values() ?? [])], revenueKnown: revenueKnown.has(p.productId) }]))
}

const sumOver = (rows: readonly DayRow[], from: string, to: string, pick: (r: DayRow) => number) => rows.filter((r) => r.day >= from && r.day <= to).reduce((n, r) => n + pick(r), 0)

// ── The proof ────────────────────────────────────────────────────────────────────────────────────────────────────

export type ProofStatus = 'NO_BRAIN_PRODUCT' | 'NOT_ENOUGH_DATA' | 'MEASURED'

export interface ProductProof {
  productId: string
  name: string | null
  /** The day the brain started acting on it, and how that is known; null: in shadow. */
  start: { day: string; how: string } | null
  status: ProofStatus
  /** Why there is no measure or no verdict yet. */
  notEnough: string[]
  comparison: { productId: string; name: string | null; why: string } | null
  matchWhy: string | null
  margin: { source: MarginSource; words: string }
  comparisonMargin: { source: MarginSource; words: string } | null
  result: DesignResult | null
  window: PairWeeks['window'] | null
}

export interface ProofReport {
  market: string
  /** The market's money (the ad report's), for the amounts. */
  currency: string
  newestDay: string
  weeks: number
  status: ProofStatus
  products: ProductProof[]
  /** Per design, the brain products' results pooled. */
  pooled: DesignResult[]
}

/**
 * The proof for a market (or one product): each brain product with its comparison and its own result, and the results of
 * each design pooled over the products. `newestDay` defaults to the newest settled Sponsored Products day.
 */
export async function readProof(args: { market: string; productId?: string | null; weeks?: number | null; since?: string | null; newestDay?: string | null; now?: Date }): Promise<ProofReport | { refusal: string }> {
  const market = strategyMarket(args.market)
  if (!market) return { refusal: `${args.market} is not an Amazon market code (business-overview lists them)` }
  const weeks = Math.max(PROOF_WEEKS_MIN, Math.min(PROOF_WEEKS_MAX, Math.round(args.weeks ?? PROOF_WEEKS_DEFAULT)))
  const newestDay = args.newestDay ?? isoDay(settledEnd('SPONSORED_PRODUCTS', { now: args.now ?? new Date() }).until)
  if (args.since && !/^\d{4}-\d{2}-\d{2}$/.test(args.since)) return { refusal: 'since is a day, YYYY-MM-DD' }
  // The brain products: one (by its family root) or every one enrolled in the market.
  let roots: string[]
  if (args.productId) {
    const family = await productFamily(args.productId)
    if (!family) return { refusal: 'Product not found' }
    roots = [family.root]
  } else {
    // Enrolled, or owning a campaign the bid brain runs (its LIVE campaigns resolved to their one product; a shared one is no product's).
    const [enrolled, live] = await Promise.all([
      prisma.adsBrainEnrollment.findMany({ where: { marketplace: market }, select: { productId: true }, take: 200 }),
      prisma.bidBrainEnrollment.findMany({ where: { marketplace: market, mode: { in: OWNED_MODES } }, select: { campaignId: true }, take: 500 }),
    ])
    const liveRoots = [...(await resolveCampaignOwnership(live.map((l) => l.campaignId))).values()].flatMap((o) => (o.owner.kind === 'product' ? [o.owner.productId] : []))
    roots = [...new Set([...enrolled.map((e) => e.productId), ...liveRoots])].sort()
  }
  const spellings = await marketSpellings(market)
  const currency = (await prisma.amazonAdsDailyPerformance.findFirst({ where: { marketplace: { in: spellings } }, select: { currencyCode: true }, orderBy: { date: 'desc' } }))?.currencyCode ?? 'EUR'
  const report: ProofReport = { market, currency, newestDay, weeks, status: 'NO_BRAIN_PRODUCT', products: [], pooled: [] }
  if (!roots.length) return report

  // Each brain product: its family, own campaigns and start; one younger than 4 settled weeks answers at once.
  const brains: Array<{ productId: string; members: string[]; own: string[]; start: { day: string; how: string } | null }> = []
  for (const root of roots) {
    const [family, campaigns] = await Promise.all([productFamily(root), productCampaigns(root, market)])
    const own = (campaigns?.owned ?? []).map((c) => c.campaignId)
    const start = args.since && args.productId ? { day: args.since, how: 'the day you named' } : await brainStartOf(root, market, own)
    brains.push({ productId: root, members: (family?.members ?? []).map((m) => m.id), own, start })
  }
  const due = brains.filter((b) => b.start && daysBetween(b.start.day, newestDay) + 1 >= PROOF_WEEKS_MIN * 7 && b.own.length)
  const brainFacts = await productFacts(brains.map((b) => ({ productId: b.productId, members: b.members.length ? b.members : [b.productId], own: b.own })), spellings)

  // The comparisons: products of the market whose own campaigns no brain runs. Read only when a brain product is due.
  let candidates: ProductFacts[] = []
  if (due.length) {
    const campaigns = (await prisma.campaign.findMany({ where: { adProduct: 'SPONSORED_PRODUCTS', status: { not: 'ARCHIVED' }, marketplace: { in: spellings } }, select: { id: true } })).map((c) => c.id)
    const [owners, enrolled, bidOwned] = await Promise.all([
      resolveCampaignOwnership(campaigns),
      prisma.adsBrainEnrollment.findMany({ where: { marketplace: market }, select: { productId: true } }),
      prisma.bidBrainEnrollment.findMany({ where: { mode: { in: OWNED_MODES } }, select: { campaignId: true } }),
    ])
    const inBrain = new Set([...enrolled.map((e) => e.productId), ...brains.map((b) => b.productId)])
    const bidRun = new Set(bidOwned.map((b) => b.campaignId))
    const ownOf = new Map<string, string[]>()
    for (const o of owners.values()) if (o.owner.kind === 'product' && o.market === market) ownOf.set(o.owner.productId, [...(ownOf.get(o.owner.productId) ?? []), o.campaignId])
    const free = [...ownOf].filter(([root, own]) => !inBrain.has(root) && !own.some((c) => bidRun.has(c)))
    const roots = free.map(([root]) => root)
    const members = roots.length ? await prisma.product.findMany({ where: { deletedAt: null, OR: [{ id: { in: roots } }, { parentId: { in: roots } }] }, select: { id: true, parentId: true } }) : []
    const membersOf = new Map<string, string[]>()
    for (const m of members) { const r = m.parentId && roots.includes(m.parentId) ? m.parentId : m.id; membersOf.set(r, [...(membersOf.get(r) ?? []), m.id]) }
    const facts = await productFacts(free.map(([root, own]) => ({ productId: root, members: membersOf.get(root) ?? [root], own })), spellings)
    // Only those that can fit some brain product's category and price band need their days read.
    candidates = [...facts.values()].filter((c) => due.some((b) => {
      const bf = brainFacts.get(b.productId)
      if (!bf) return false
      if (bf.categoryId && c.categoryId !== bf.categoryId) return false
      return bf.priceCents == null || (c.priceCents != null && Math.abs(Math.log(c.priceCents / bf.priceCents)) <= Math.log(PRICE_BAND_RATIO) + 1e-9)
    }))
  }
  const from = due.length ? addDays(due.map((b) => b.start!.day).sort()[0], -7 * weeks) : newestDay
  const days = await productDays([...due.map((b) => brainFacts.get(b.productId)!).filter(Boolean), ...candidates], from, newestDay, spellings)

  // Matching on the weeks before (spend level) and since (ads running).
  const matchOf = (f: ProductFacts, start: string): MatchFacts => {
    const rows = days.get(f.productId)?.rows ?? []
    return {
      productId: f.productId, name: f.name, categoryId: f.categoryId, priceCents: f.priceCents,
      spendBeforeCents: sumOver(rows, addDays(start, -7 * weeks), addDays(start, -1), (r) => r.spendCents),
      spendSinceCents: sumOver(rows, start, newestDay, (r) => r.spendCents),
      orders: sumOver(rows, addDays(start, -7 * weeks), newestDay, (r) => r.orders),
    }
  }
  const matches = new Map<string, Match>()
  for (const b of due) {
    // Each brain product matched on its own window (its start); a comparison used once.
    const taken = new Set([...matches.values()].map((m) => m.control?.productId).filter(Boolean) as string[])
    const one = matchControls([matchOf(brainFacts.get(b.productId)!, b.start!.day)], candidates.filter((c) => !taken.has(c.productId)).map((c) => matchOf(c, b.start!.day)))
    matches.set(b.productId, one.get(b.productId)!)
  }

  const byDesign = new Map<Design, Array<{ pw: PairWeeks; margins: { brain: number | null; control: number | null }; seed: string }>>()
  for (const b of brains) {
    const f = brainFacts.get(b.productId)
    const margin = { source: f?.marginSource ?? 'none' as MarginSource, words: MARGIN_SOURCE_WORDS[f?.marginSource ?? 'none'] }
    const base: ProductProof = { productId: b.productId, name: f?.name ?? null, start: b.start, status: 'NOT_ENOUGH_DATA', notEnough: [], comparison: null, matchWhy: null, margin, comparisonMargin: null, result: null, window: null }
    if (!b.start) { report.products.push({ ...base, status: 'NO_BRAIN_PRODUCT', notEnough: ['the brain writes nothing on this product yet (every lever in shadow): nothing to compare'] }); continue }
    if (!b.own.length) { report.products.push({ ...base, notEnough: ['the product has no campaign of its own in this market: no ad day can be credited to it'] }); continue }
    const settled = daysBetween(b.start.day, newestDay) + 1
    if (settled < PROOF_WEEKS_MIN * 7) { report.products.push({ ...base, notEnough: [`${Math.max(0, settled)} of ${PROOF_WEEKS_MIN * 7} settled days since the brain started on ${b.start.day} (${PROOF_WEEKS_MIN} full weeks needed)`] }); continue }
    const match = matches.get(b.productId) ?? { control: null, why: MATCH_NONE, considered: 0 }
    const controlFacts = match.control ? candidates.find((c) => c.productId === match.control!.productId) ?? null : null
    const arm = (p: ProductFacts): ArmInput => ({ productId: p.productId, margin: p.margin, rows: days.get(p.productId)?.rows ?? [], revenueKnown: !!days.get(p.productId)?.revenueKnown })
    const pw = pairWeeks({ brain: arm(f!), control: controlFacts ? arm(controlFacts) : null, start: b.start.day, newestDay, weeks })
    const comparison = controlFacts ? { productId: controlFacts.productId, name: controlFacts.name, why: match.why } : null
    const comparisonMargin = controlFacts ? { source: controlFacts.marginSource, words: MARGIN_SOURCE_WORDS[controlFacts.marginSource] } : null
    if ('notEnough' in pw) { report.products.push({ ...base, notEnough: [pw.notEnough], comparison, matchWhy: match.why, comparisonMargin }); continue }
    const margins = { brain: f!.margin, control: controlFacts?.margin ?? null }
    const seed = `${market}:${b.productId}:${controlFacts?.productId ?? '-'}:${b.start.day}:${pw.weeks}`
    const result = designResult([pw], [margins], seed)
    const notEnough = [...result.missing, ...(f!.margin == null ? ['no margin for the brain product: ad profit is not measured'] : []), ...(controlFacts && controlFacts.margin == null && pw.design !== 'pre-post' ? ['no margin for the comparison product: ad profit is not measured'] : [])]
    report.products.push({ ...base, status: result.enough ? 'MEASURED' : 'NOT_ENOUGH_DATA', notEnough, comparison, matchWhy: match.why, comparisonMargin, result, window: pw.window })
    byDesign.set(pw.design, [...(byDesign.get(pw.design) ?? []), { pw, margins, seed }])
  }
  for (const [, pairs] of [...byDesign].sort(([a], [b]) => a.localeCompare(b))) {
    if (pairs.length > 1) report.pooled.push(designResult(pairs.map((p) => p.pw), pairs.map((p) => p.margins), `${market}:pooled:${pairs.map((p) => p.seed).join('|')}`))
  }
  report.status = report.products.some((p) => p.status === 'MEASURED') ? 'MEASURED' : report.products.some((p) => p.status === 'NOT_ENOUGH_DATA') ? 'NOT_ENOUGH_DATA' : 'NO_BRAIN_PRODUCT'
  return report
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────────────────────────

const VERDICT_WORDS: Record<string, string> = { better: 'better with the brain', worse: 'worse with the brain', 'no difference shown': 'no difference shown yet' }

/** The report's one line about the proof of one product: status, design, weeks, verdict per measure — no amounts. Pure. */
export function proofLine(p: ProductProof | null): string {
  if (!p) return 'Proof (A/B, ad profit): could not be read.'
  if (p.status === 'NO_BRAIN_PRODUCT') return `Proof (A/B, ad profit): nothing to compare yet — ${p.notEnough[0] ?? 'the brain writes nothing on this product'}.`
  const against = p.comparison ? ` against ${p.comparison.name ?? p.comparison.productId}` : ''
  if (!p.result) return `Proof (A/B, ad profit): not enough data yet — ${p.notEnough.join('; ')}.`
  const r = p.result
  const head = `Proof (A/B, ad profit, ${r.design === 'did' ? 'difference-in-differences' : r.design === 'matched' ? 'matched pair' : 'before and after'}, ${r.weeks} weeks${against})`
  if (p.status !== 'MEASURED') return `${head}: not enough data yet — ${p.notEnough.join('; ')}; the numbers so far are in ads-brain view proof, no verdict.`
  const words = MEASURES.map((m) => `${MEASURE_WORDS[m]} ${r.measures[m].verdict ? VERDICT_WORDS[r.measures[m].verdict!] : r.measures[m].note ?? 'not measured'}`)
  return `${head}: ${words.join('; ')} (95 % intervals${r.design === 'pre-post' ? '; the market\'s own movement is not removed' : ''})${p.notEnough.length ? `; ${p.notEnough.join('; ')}` : ''}.`
}

/** The proof line of one product for the day's report (never throws: a failed read is said). */
export async function proofStatusLine(productId: string, market: string, newestDay: string): Promise<string> {
  try {
    const r = await readProof({ market, productId, newestDay })
    if ('refusal' in r) return `Proof (A/B, ad profit): could not be read (${r.refusal}).`
    return proofLine(r.products[0] ?? null)
  } catch (err) {
    logger.warn('[ads-brain] the proof line could not be read', { productId, market, error: msg(err) })
    return `Proof (A/B, ad profit): could not be read (${msg(err)}).`
  }
}

/** An amount of a measure in words: ad profit in the market's money a week, orders a week, ratios as percentage points. */
function amountWords(m: (typeof MEASURES)[number], v: number | null, currency: string): string | null {
  if (v == null) return null
  if (m === 'adProfit') return `${v < 0 ? '−' : '+'}${amount(Math.round(Math.abs(v)), currency)} a week`
  if (m === 'orders') return `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)} a week`
  return `${v < 0 ? '−' : '+'}${(Math.abs(v) * 100).toFixed(1)} points`
}

const resultView = (r: DesignResult, currency: string) => ({
  design: r.design, how: DESIGN_WORDS[r.design], pairs: r.pairs, weeks: r.weeks, enough: r.enough, missing: r.missing, adOrders: r.orders,
  verdicts: Object.fromEntries(MEASURES.map((m) => [m, r.measures[m].verdict ?? (r.enough ? r.measures[m].note ?? 'not measured' : 'no verdict: not enough data yet')])),
  // Every amount and interval: ad-spend money.
  money: Object.fromEntries(MEASURES.map((m) => {
    const e = r.measures[m]
    return [m, { estimate: amountWords(m, e.estimate, currency), interval95: e.low != null && e.high != null ? [amountWords(m, e.low, currency), amountWords(m, e.high, currency)] : null, method: e.method, ...(e.note ? { note: e.note } : {}) }]
  })),
})

/**
 * View proof (ads-brain): the brain products of a market (or one) against their matched comparisons — design, weeks,
 * comparison and why it was chosen, margins and where they come from, ad orders on each side, each measure's verdict, and
 * under `money` each difference with its 95 % interval; the designs pooled when several products have one. Read only.
 */
export async function brainProof(args: { market?: string; productId?: string; weeks?: number; since?: string }): Promise<{ data: unknown } | { error: string }> {
  if (!args.market) return { error: 'view proof needs market (one Amazon market code, business-overview)' }
  const r = await readProof({ market: args.market, productId: args.productId ?? null, weeks: args.weeks ?? null, since: args.since ?? null })
  if ('refusal' in r) return { error: r.refusal }
  return {
    data: {
      market: r.market, newestDay: r.newestDay, weeks: r.weeks, status: r.status,
      headline: r.status === 'NO_BRAIN_PRODUCT'
        ? 'No product acts under the brain in this market yet: nothing to prove.'
        : r.status === 'MEASURED' ? 'Measured: each product below carries its verdict per measure (95 % intervals).' : `Not enough data yet: a verdict needs ${PROOF_WEEKS_MIN} settled weeks since the brain started and ${MIN_ORDERS} ad orders on each side.`,
      products: r.products.map((p) => ({
        productId: p.productId, name: p.name, start: p.start, status: p.status, notEnough: p.notEnough, line: proofLine(p),
        comparison: p.comparison, ...(p.matchWhy && !p.comparison ? { noComparison: p.matchWhy } : {}),
        margin: p.margin, ...(p.comparisonMargin ? { comparisonMargin: p.comparisonMargin } : {}), window: p.window,
        ...(p.result ? { result: resultView(p.result, r.currency) } : {}),
      })),
      ...(r.pooled.length ? { pooled: r.pooled.map((x) => resultView(x, r.currency)) } : {}),
      uses: [
        'ad spend, ad sales (7-day attribution) and ad orders of each product\'s OWN campaigns, from the daily Sponsored Products report (a campaign several products share is credited to none)',
        'total sales per product from Nexus\'s daily true profit (for TACoS)',
        'margins as each product says (margin.words)',
        `the newest settled day ${r.newestDay}; weeks of 7 days from the day the brain started, ${PROOF_WEEKS_MIN}–${PROOF_WEEKS_MAX}`,
      ],
      method: 'Additive measures (ad profit, ad orders): a 95 % t interval on the weekly differences, Welch\'s degrees of freedom. Ratios (ACoS, TACoS): a 95 % bootstrap over whole weeks (2,000 draws, a fixed seed), the brain product and its comparison drawn on the same weeks. A verdict only when the interval is wholly on one side of zero and there is enough data.',
    },
  }
}
