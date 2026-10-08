/**
 * ONE BRAIN AB-9 — the `ads-brain` tool's view `terms` (design 2026-10-08-ads-one-brain/DESIGN.md §1, §2.7, §2.8; §10: the
 * Owner builds every screen, so this is the read API his page and Claude share). Read only: it changes nothing, in Nexus or
 * at Amazon, and stores nothing.
 *
 *   product × market  the term ledger the shadow stored (brain/terms-shadow.ts): one decision per term with its state,
 *                     since when, the protection, the arbiter's lead, what holds it and why; the counts per state; the
 *                     arbiter's leads on the terms this product meets a sibling on; the clashes its decisions remove; the
 *                     harvest candidates with no destination yet. A product with no stored ledger (not enrolled, or its
 *                     negatives and harvest levers OFF) is decided NOW instead — a dry run, never stored — so the Owner can
 *                     read what the ledger would say before he enrolls it.
 *   market            the products with a stored ledger there, their counts per state, and the market's leads.
 *
 * Money: every amount (spend, sales, CPC, order value, profit per click, bids, the spend gate, the ACoS bound) sits under a
 * `money` key, which the tool hides from a person without the ad-spend permission (ads-brain.tools.ts restrictedFields);
 * the visible words name no amount (brain/terms.ts writes them so).
 */
import prisma from '../../../db.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { productFamily } from './ownership.js'
import { resolveBrainSettings, type OverrideRow } from './settings.js'
import { decideMarket, ledgerContent, loadTermsMarket, TERMS_DAYS_KEPT } from './terms-shadow.js'
import { isTermState, LEDGER_WINDOW_DAYS, stateCounts, TERM_STATES, type TermState } from './terms.js'

const PRODUCT_NOT_FOUND = 'Product not found'
export const DEFAULT_TERMS_LIMIT = 100
export const MAX_TERMS_LIMIT = 500
/** A ledger older than this was not checked by the last daily run. */
const STALE_HOURS = 36

/** The order the view lists states in: what the brain would do first, then what stands. */
const STATE_ORDER: readonly TermState[] = ['NEGATE_CANDIDATE', 'HARVEST_CANDIDATE', 'OWNED_BY_SIBLING', 'PROTECTED', 'NEGATED', 'TARGETED', 'WATCH']

interface StoredRow {
  term: string; isAsin: boolean; state: string; previousState: string | null; stateSince: Date | null; protection: string | null
  leadProductId: string | null; heldBy: string | null; capped: boolean; askFirst: boolean
  impressions: number; clicks: number; orders: number; spendCents: number; salesCents: number; why: string; evidence: unknown
}

type Place = { campaignId: string; adGroupId: string; targetId: string; match: string; level?: string | null; bidCents?: number | null; text?: string }
type Evidence = {
  targets?: Place[]; negatives?: Place[]; destination?: Record<string, unknown>; lead?: Record<string, unknown> | null
  wouldLower?: unknown[]; clashes?: Array<Record<string, unknown>>
  tests?: { harvest?: Record<string, unknown>; negate?: Record<string, unknown>; cr?: number; aovCents?: number | null; cpcCents?: number | null; profitPerClickCents?: number | null }
}

/** One ledger row as the view shows it, money under `money`. Pure. */
export function termView(r: StoredRow) {
  const e = (r.evidence ?? {}) as Evidence
  const h = e.tests?.harvest ?? {}
  const n = e.tests?.negate ?? {}
  const lead = e.lead as { leadProductId?: string; isThis?: boolean; rule?: string; leadBidCents?: number | null; maxBidCents?: number | null } | null | undefined
  return {
    term: r.term, ...(r.isAsin ? { asin: true } : {}), state: r.state, since: r.stateSince?.toISOString() ?? null, ...(r.previousState ? { previousState: r.previousState } : {}),
    protection: r.protection, lead: lead?.leadProductId ? { productId: lead.leadProductId, isThis: !!lead.isThis, rule: lead.rule ?? null } : null,
    heldBy: r.heldBy, ...(r.capped ? { capped: true } : {}), ...(r.askFirst ? { askFirst: true } : {}),
    clicks: r.clicks, orders: r.orders, impressions: r.impressions,
    cr: typeof e.tests?.cr === 'number' ? Number(e.tests.cr.toFixed(5)) : null,
    targetedIn: (e.targets ?? []).map((t) => ({ campaignId: t.campaignId, adGroupId: t.adGroupId, targetId: t.targetId, match: t.match })),
    negatedIn: (e.negatives ?? []).map((t) => ({ campaignId: t.campaignId, adGroupId: t.adGroupId, targetId: t.targetId, match: t.match, level: t.level ?? null, ...(t.text ? { text: t.text } : {}) })),
    destination: e.destination ?? null,
    harvest: { by: h.by ?? null, pass: !!h.pass, ordersNeeded: h.ordersNeeded ?? null, clicksNeeded: h.clicksNeeded ?? null, ...(h.refused ? { refused: h.refused } : {}) },
    negate: { by: n.by ?? null, pass: !!n.pass, clicksNeeded: n.clicksNeeded ?? null, ...(n.refused ? { refused: n.refused } : {}) },
    why: r.why,
    money: {
      spendCents: r.spendCents, salesCents: r.salesCents, cpcCents: e.tests?.cpcCents ?? null, aovCents: e.tests?.aovCents ?? null,
      profitPerClickCents: e.tests?.profitPerClickCents ?? null,
      bids: (e.targets ?? []).map((t) => ({ targetId: t.targetId, bidCents: t.bidCents ?? null })),
      harvest: { acosLowerBound: h.acosLowerBound ?? null, acosCeiling: h.acosCeiling ?? null },
      negate: { spendGateCents: n.spendGateCents ?? null, targetCpaCents: n.targetCpaCents ?? null },
      ...(lead?.leadProductId ? { lead: { leadBidCents: lead.leadBidCents ?? null, maxBidCents: lead.maxBidCents ?? null } } : {}),
      ...(e.wouldLower?.length ? { wouldLower: e.wouldLower } : {}),
    },
  }
}

interface LeadRow {
  term: string; leadProductId: string; previousLeadProductId: string | null; leadSince: Date | null; rule: string
  leadBidCents: number | null; maxBidCents: number | null; contenders: unknown; wouldLower: unknown; why: string
}
type ContenderRow = { productId: string; lead: boolean; targets: number; wants: boolean; orders: number; clicks: number; profitPerClickCents: number | null; bidCents: number | null; brandWord: string | null }

/** One lead as the view shows it, money under `money`. Pure. */
export function leadView(l: LeadRow, productId?: string) {
  const contenders = (Array.isArray(l.contenders) ? l.contenders : []) as ContenderRow[]
  return {
    term: l.term, leadProductId: l.leadProductId, ...(productId ? { thisProductLeads: l.leadProductId === productId } : {}), rule: l.rule,
    since: l.leadSince?.toISOString() ?? null, ...(l.previousLeadProductId ? { previousLeadProductId: l.previousLeadProductId } : {}),
    contenders: contenders.map((c) => ({ productId: c.productId, lead: c.lead, targets: c.targets, wants: c.wants, orders: c.orders, clicks: c.clicks, brandWord: c.brandWord })),
    why: l.why,
    money: {
      leadBidCents: l.leadBidCents, maxBidCents: l.maxBidCents,
      contenders: contenders.map((c) => ({ productId: c.productId, bidCents: c.bidCents, profitPerClickCents: c.profitPerClickCents })),
      wouldLower: Array.isArray(l.wouldLower) ? l.wouldLower : [],
    },
  }
}

const sortRows = <T extends { state: string; clicks: number; term: string }>(rows: T[]) =>
  rows.sort((a, b) => STATE_ORDER.indexOf(a.state as TermState) - STATE_ORDER.indexOf(b.state as TermState) || b.clicks - a.clicks || a.term.localeCompare(b.term))

const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const

/** View terms. With productId and market: the product's ledger (stored, else decided now). With market alone: the market's ledgers. */
export async function brainTerms(args: { productId?: string; market?: string; state?: string; limit?: number; now?: Date }): Promise<{ data: unknown } | { error: string }> {
  const market = args.market ? strategyMarket(args.market) : null
  if (args.market && !market) return { error: `${args.market} is not a market code` }
  if (!market) return { error: 'name the market (market), and optionally a productId: view terms reads one market' }
  if (args.state && !isTermState(args.state)) return { error: `state is one of ${TERM_STATES.join(', ')}, not ${args.state}` }
  const limit = Math.max(1, Math.min(MAX_TERMS_LIMIT, Math.round(args.limit ?? DEFAULT_TERMS_LIMIT)))
  const now = args.now ?? new Date()
  const shadow = 'SHADOW: the ledger decides and logs; nothing is written to Amazon (negatives go live with AB-10, harvest with AB-11)'
  if (!args.productId) {
    const [counts, checked, leads] = await Promise.all([
      prisma.adsBrainTerm.groupBy({ by: ['productId', 'state'], where: { marketplace: market }, _count: { _all: true } }),
      prisma.adsBrainTerm.groupBy({ by: ['productId'], where: { marketplace: market }, _max: { checkedAt: true, dataDay: true } }),
      prisma.adsBrainTermLead.count({ where: { marketplace: market } }),
    ])
    const ids = [...new Set(checked.map((c) => c.productId))]
    const names = new Map((ids.length ? await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, sku: true, deletedAt: true } }) : []).map((p) => [p.id, p]))
    return {
      data: {
        view: 'terms', scope: { market }, note: shadow,
        products: checked.filter((c) => !names.get(c.productId)?.deletedAt).map((c) => ({
          productId: c.productId, name: names.get(c.productId)?.name ?? null, sku: names.get(c.productId)?.sku ?? null,
          checkedAt: c._max.checkedAt?.toISOString() ?? null, dataDay: c._max.dataDay?.toISOString().slice(0, 10) ?? null,
          counts: Object.fromEntries(TERM_STATES.map((s) => [s, counts.find((x) => x.productId === c.productId && x.state === s)?._count._all ?? 0])),
        })).sort((a, b) => a.productId.localeCompare(b.productId)),
        leads,
        next: 'Read one product with productId and market: its ledger, the leads on the terms it meets a sibling on, and the clashes the ledger removes. A product with no stored ledger is decided now (a dry run).',
      },
    }
  }
  if (!(await prisma.product.count({ where: { id: args.productId, deletedAt: null } }))) return { error: PRODUCT_NOT_FOUND }
  const family = await productFamily(args.productId)
  if (!family) return { error: `product ${args.productId} has no single family (a parentless product whose ASIN variations of several families carry): fix its family first` }
  const root = family.root
  const [enrollment, overrides] = await Promise.all([
    prisma.adsBrainEnrollment.findFirst({ where: { productId: root, marketplace: market }, select: { id: true } }),
    prisma.adsBrainOverride.findMany({ where: { endedAt: null, scope: 'PRODUCT', productId: root, marketplace: market }, select: OVERRIDE_SELECT }) as Promise<OverrideRow[]>,
  ])
  const settings = resolveBrainSettings({ productId: root, market, campaignId: null, enrolled: !!enrollment, overrides })
  const product = {
    productId: root, market, enrolled: !!enrollment,
    levers: Object.fromEntries((['negatives', 'harvest'] as const).map((l) => [l, { effective: settings.levers[l].effective, why: settings.levers[l].why }])),
    caps: { negativesPerDay: settings.values.negativesPerDay.value, harvestPerDay: settings.values.harvestPerDay.value },
  }
  const stored = await prisma.adsBrainTerm.count({ where: { productId: root, marketplace: market } })
  let rows: StoredRow[]
  let counts: Record<string, number>
  let total: number
  let source: Record<string, unknown>
  let leadRows: LeadRow[]
  let clashRows: StoredRow[]
  let noDestination: StoredRow[]
  if (stored) {
    const where = { productId: root, marketplace: market }
    const select = { term: true, isAsin: true, state: true, previousState: true, stateSince: true, protection: true, leadProductId: true, heldBy: true, capped: true, askFirst: true, impressions: true, clicks: true, orders: true, spendCents: true, salesCents: true, why: true, evidence: true } as const
    // The order first, on the light columns only; the evidence of the rows shown after (Neon transfer).
    const [byState, checked, order, clashes, harvests] = await Promise.all([
      prisma.adsBrainTerm.groupBy({ by: ['state'], where, _count: { _all: true } }),
      prisma.adsBrainTerm.aggregate({ where, _max: { checkedAt: true, dataDay: true, windowDays: true } }),
      prisma.adsBrainTerm.findMany({ where: { ...where, ...(args.state ? { state: args.state } : {}) }, select: { id: true, term: true, state: true, clicks: true } }),
      prisma.adsBrainTerm.findMany({ where: { ...where, clashCount: { gt: 0 } }, select, take: 200, orderBy: { clicks: 'desc' } }),
      prisma.adsBrainTerm.findMany({ where: { ...where, state: 'HARVEST_CANDIDATE' }, select, take: 200 }),
    ])
    counts = Object.fromEntries(TERM_STATES.map((s) => [s, byState.find((b) => b.state === s)?._count._all ?? 0]))
    total = order.length
    const shown = sortRows(order).slice(0, limit).map((r) => r.id)
    const full = new Map((shown.length ? await prisma.adsBrainTerm.findMany({ where: { id: { in: shown } }, select: { id: true, ...select } }) : []).map((r) => [r.id, r]))
    rows = shown.map((rowId) => full.get(rowId)).filter((r): r is NonNullable<typeof r> => !!r)
    clashRows = clashes
    noDestination = harvests
    const at = checked._max.checkedAt
    source = {
      kind: 'stored', checkedAt: at?.toISOString() ?? null, dataDay: checked._max.dataDay?.toISOString().slice(0, 10) ?? null, windowDays: checked._max.windowDays ?? LEDGER_WINDOW_DAYS,
      keptDays: TERMS_DAYS_KEPT, ...(at && now.getTime() - at.getTime() > STALE_HOURS * 3_600_000 ? { stale: `not checked for more than ${STALE_HOURS} hours: the product may no longer be due (its negatives and harvest levers OFF), or the daily run did not reach it` } : {}),
    }
    const contested = [...new Set((await prisma.adsBrainTerm.findMany({ where: { ...where, leadProductId: { not: null } }, select: { term: true } })).map((r) => r.term))]
    leadRows = contested.length ? await prisma.adsBrainTermLead.findMany({ where: { marketplace: market, term: { in: contested } }, orderBy: { term: 'asc' }, take: 200 }) : []
  } else {
    // A dry run: decided now from what Nexus holds, never stored (the shadow stores only a due product's ledger).
    const due = { productId: root, market, settings }
    const facts = await loadTermsMarket(market, [due], now)
    if (!facts.products.has(root)) {
      return { data: { view: 'terms', scope: { productId: root, market }, note: shadow, product, source: { kind: 'dryRun' }, counts: stateCounts([]), terms: [], why: 'no Sponsored Products campaign of its own in this market (a shared campaign is no product\'s, D2): no term to decide' } }
    }
    const decided = decideMarket(facts, [due])
    const decisions = decided.byProduct.get(root) ?? []
    const all: StoredRow[] = decisions.map((d) => ({ ...ledgerContent(d, facts.windowDays).content, previousState: null, stateSince: null }) as StoredRow)
    counts = stateCounts(decisions)
    const list = args.state ? all.filter((r) => r.state === args.state) : all
    total = list.length
    rows = sortRows(list).slice(0, limit)
    clashRows = all.filter((r) => ((r.evidence as Evidence).clashes ?? []).length > 0)
    noDestination = all.filter((r) => r.state === 'HARVEST_CANDIDATE')
    source = { kind: 'dryRun', decidedAt: now.toISOString(), dataDay: facts.dataDay.toISOString().slice(0, 10), windowDays: facts.windowDays, note: 'decided now from what Nexus holds — not stored; the daily shadow stores a ledger only for an enrolled product whose negatives or harvest lever is OBSERVE or higher' }
    leadRows = [...decided.leads.values()].map((l) => ({ term: l.term, leadProductId: l.leadProductId, previousLeadProductId: null, leadSince: null, rule: l.rule, leadBidCents: l.leadBidCents, maxBidCents: l.maxBidCents, contenders: l.contenders, wouldLower: l.wouldLower, why: l.why }))
  }
  const clashesRemoved = clashRows.flatMap((r) => ((r.evidence as Evidence).clashes ?? []).map((c) => ({ term: r.term, state: r.state, kind: c.kind, what: c.what, resolution: c.resolution })))
  const withoutDestination = noDestination
    .filter((r) => !['stored', 'own'].includes(String(((r.evidence as Evidence).destination ?? {}).source)))
    .map((r) => ({ term: r.term, destination: (r.evidence as Evidence).destination ?? null }))
  return {
    data: {
      view: 'terms', scope: { productId: root, market }, note: shadow, product, source, counts,
      ...(args.state ? { state: args.state } : {}), shown: rows.length, of: total,
      terms: rows.map(termView),
      leads: leadRows.map((l) => leadView(l, root)),
      clashesRemoved,
      gaps: { harvestWithoutDestination: withoutDestination },
      next: total > rows.length ? `${total - rows.length} more: ask with state (one of ${TERM_STATES.join(', ')}) or a higher limit (at most ${MAX_TERMS_LIMIT})` : null,
    },
  }
}
