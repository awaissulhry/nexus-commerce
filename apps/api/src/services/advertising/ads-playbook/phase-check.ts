/**
 * ADS PLAYBOOK PB-9 — the phase check: where ONE product stands in its playbook phase, computed by Nexus (design report 9
 * §3.7, §5.4). Read only. The `ads-playbook` effective view shows it for a product, and apply-ads-playbook op phase
 * judges a move by it (a move runs by the business's rule only when this check proposes it, outside the hold).
 *
 *   phase        the ads strategy's goal at the product (Owner decision D-PB3 = A), with the row that sets it, and since
 *                when: the oldest version of that row, counted back from its newest, that holds this goal — who switched
 *                it (a person, or the business's rule) and how
 *   hold         the phase's own least days (`minDays`, the hysteresis): until they have passed Nexus proposes no move and
 *                none runs by rule; a person's own switch is never held. A question to the Owner (ASK_OWNER) is never
 *                held. A phase whose start Nexus cannot read is held (fail closed).
 *   exits        each exit rule of the phase, every condition with its number: days in phase; ad orders, ACoS against the
 *                target ACoS in force at the product (the strategy's) and the change in ad orders against the window
 *                before, each over the condition's own window of whole days, never today, from Amazon's daily
 *                advertised-product report (Sponsored Products: every ad of the product's family in the market; the
 *                7-day attribution Nexus reads everywhere, ads-core/ad-sales.ts); sellable units from the stock service
 *                (W3-3). A number Nexus cannot measure is null and its rule is not met.
 *   proposal     the first exit rule whose conditions all hold, outside the hold
 *   costs        the break-even ACoS from profit data, the one enrollment reads (write.ts recipeFacts), beside the ACoS
 *   not measured organic rank and competitor pressure: Nexus has no feed of either, so DEFEND starts and ends on the
 *                Owner's word
 *
 * Every threshold, window and hold is the playbook's; nothing here holds a business number of its own. The money keys
 * (spend, the target, the ACoS against it) sit only under PLAYBOOK_MONEY's keys, alone.
 */
import prisma from '../../../db.js'
import { adSalesCents } from '../../ads-core/ad-sales.js'
import type { EXIT_CONDITION, Phase, TemplateDoc } from './doc.js'
import type { z } from 'zod'

const DAY_MS = 86_400_000
type Condition = z.infer<typeof EXIT_CONDITION>
type Entry = NonNullable<TemplateDoc['phases'][Phase]>
/** The metrics measured over a window of days (the others are read as they are now). */
const WINDOWED: ReadonlySet<Condition['metric']> = new Set(['adOrders', 'acosToTargetPct', 'ordersChangePct'])

/** One window of whole days ending yesterday, and the window of the same length before it. */
export interface WindowNumbers {
  days: number
  /** First day in, last day in (UTC, YYYY-MM-DD). */
  from: string
  to: string
  adOrders: number
  spendCents: number
  salesCents: number
  /** The window before it, for the change in ad orders. */
  previousAdOrders: number
}

/** What the check is computed from. Pure input. */
export interface PhaseFacts {
  phase: Phase | null
  /** When the phase started (null: Nexus cannot tell). */
  since: Date | null
  now: Date
  windows: ReadonlyMap<number, WindowNumbers>
  /** The target ACoS in force at the product, a whole percent (the strategy's). */
  targetAcosPct: number | null
  /** The product family's sellable units (null: not read). */
  sellableUnits: number | null
}

export interface ConditionCheck {
  metric: Condition['metric']
  op: Condition['op']
  value: number
  windowDays?: number
  /** Null: Nexus cannot measure it (note says why); the rule is then not met. The number sits under the metric's own key. */
  met: boolean | null
  note?: string
  [measured: string]: unknown
}

export interface ExitCheck { to: Phase | 'ASK_OWNER'; met: boolean; conditions: ConditionCheck[] }

export interface PhaseCheckCore {
  daysInPhase: number | null
  hold: { minDays: number | null; held: boolean; daysLeft: number; note: string }
  exits: ExitCheck[]
  /** The move Nexus proposes now: the first exit rule met, outside the hold (a question to the Owner never held). */
  proposal: { to: Phase | 'ASK_OWNER'; rule: number; note: string } | null
  /** A rule met while the hold lasts: proposed once it has passed (if it still holds then). */
  heldProposal?: { to: Phase; rule: number; daysLeft: number }
}

const round1 = (n: number) => Math.round(n * 10) / 10
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The windows (days) the conditions of a phase's exit rules measure over. Pure. */
export function windowsOf(entry: Entry | undefined): number[] {
  const days = new Set<number>()
  for (const rule of entry?.exit ?? []) for (const c of rule.when) if (WINDOWED.has(c.metric) && c.windowDays) days.add(c.windowDays)
  return [...days].sort((a, b) => a - b)
}

/** One condition with its number, or null and why. Pure. */
export function measureCondition(c: Condition, facts: PhaseFacts, daysInPhase: number | null): ConditionCheck {
  const base = { metric: c.metric, op: c.op, value: c.value, ...(c.windowDays ? { windowDays: c.windowDays } : {}) }
  const out = (measured: number | null, note?: string): ConditionCheck => ({
    ...base,
    [c.metric]: measured,
    met: measured == null ? null : c.op === 'gte' ? measured >= c.value : measured <= c.value,
    ...(note ? { note } : {}),
  })
  if (c.metric === 'daysInPhase') return out(daysInPhase, daysInPhase == null ? 'Nexus cannot tell when this phase started' : undefined)
  if (c.metric === 'sellableUnits') return out(facts.sellableUnits, facts.sellableUnits == null ? 'the stock of the product could not be read' : undefined)
  if (!c.windowDays) return out(null, 'the rule names no window of days for it')
  const w = facts.windows.get(c.windowDays)
  if (!w) return out(null, `no ${c.windowDays}-day window was read`)
  if (c.metric === 'adOrders') return out(w.adOrders)
  if (c.metric === 'ordersChangePct') {
    if (w.previousAdOrders <= 0) return out(null, `no ad orders in the ${c.windowDays} days before, so no change can be measured`)
    return out(round1(((w.adOrders - w.previousAdOrders) / w.previousAdOrders) * 100))
  }
  // acosToTargetPct
  if (facts.targetAcosPct == null) return out(null, 'no target ACoS is in force for this product')
  if (w.salesCents <= 0) return out(null, `no ad sales in the ${c.windowDays} days, so no ACoS`)
  return out(round1(((w.spendCents / w.salesCents) * 100 / facts.targetAcosPct) * 100))
}

/** The hold, the exit rules with their numbers, and the move proposed. Pure. */
export function evaluatePhaseCheck(entry: Entry | undefined, facts: PhaseFacts): PhaseCheckCore {
  const daysInPhase = facts.since ? Math.max(0, Math.floor((facts.now.getTime() - facts.since.getTime()) / DAY_MS)) : null
  const minDays = entry?.minDays ?? null
  const held = minDays != null && minDays > 0 && (daysInPhase == null || daysInPhase < minDays)
  const daysLeft = held ? (daysInPhase == null ? minDays! : minDays! - daysInPhase) : 0
  const hold = {
    minDays,
    held,
    daysLeft,
    note: minDays == null
      ? 'The playbook sets no hold for this phase (minDays): only its exit rules decide.'
      : held
        ? daysInPhase == null
          ? `Held: Nexus cannot tell when this phase started, so it proposes no move and none runs by rule; a person may switch by hand.`
          : `Held for ${plural(daysLeft, 'more day')} (at least ${minDays} in a phase): Nexus proposes no move and none runs by rule until then; a person may switch by hand.`
        : `The ${minDays}-day hold has passed.`,
  }
  const exits: ExitCheck[] = (entry?.exit ?? []).map((rule) => {
    const conditions = rule.when.map((c) => measureCondition(c, facts, daysInPhase))
    return { to: rule.to, met: conditions.every((c) => c.met === true), conditions }
  })
  const first = exits.findIndex((e) => e.met)
  let proposal: PhaseCheckCore['proposal'] = null
  let heldProposal: PhaseCheckCore['heldProposal']
  if (first >= 0) {
    const to = exits[first].to
    if (to === 'ASK_OWNER') proposal = { to, rule: first, note: 'The playbook asks the Owner: a person decides what comes next.' }
    else if (held) heldProposal = { to, rule: first, daysLeft }
    else proposal = { to, rule: first, note: `Every condition of exit rule ${first + 1} holds: Nexus proposes ${to}.` }
  }
  return { daysInPhase, hold, exits, proposal, ...(heldProposal ? { heldProposal } : {}) }
}

// ── The reads ─────────────────────────────────────────────────────────────────────────────────────

const ymd = (d: Date) => d.toISOString().slice(0, 10)

/**
 * Each window's ad orders, spend and sales (and the ad orders of the window before) for the product family's Sponsored
 * Products ads in the market, whole days ending yesterday, from Amazon's daily advertised-product report.
 */
export async function adWindows(market: string, familyIds: readonly string[], days: readonly number[], now: Date): Promise<Map<number, WindowNumbers>> {
  const out = new Map<number, WindowNumbers>()
  if (!days.length) return out
  const { strategyMarketOf } = await import('../ads-strategy/terms.js')
  const members = await prisma.product.findMany({ where: { id: { in: [...familyIds] } }, select: { amazonAsin: true } })
  const asins = members.map((m) => m.amazonAsin?.trim()).filter((a): a is string => !!a)
  const ads = await prisma.adProductAd.findMany({
    where: { OR: [{ productId: { in: [...familyIds] } }, ...(asins.length ? [{ asin: { in: asins } }] : [])] },
    select: { id: true, adGroup: { select: { campaign: { select: { marketplace: true } } } } },
  })
  const here = strategyMarketOf(market)
  const adIds = ads.filter((a) => strategyMarketOf(a.adGroup.campaign.marketplace) === here).map((a) => a.id)
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const longest = Math.max(...days)
  const start = new Date(today.getTime() - 2 * longest * DAY_MS)
  const rows = adIds.length
    ? await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['date'],
      where: { entityType: 'PRODUCT_AD', adProduct: 'SPONSORED_PRODUCTS', localEntityId: { in: adIds }, date: { gte: start, lt: today } },
      _sum: { costMicros: true, sales7dCents: true, orders7d: true },
    })
    : []
  for (const d of days) {
    const from = new Date(today.getTime() - d * DAY_MS)
    const before = new Date(today.getTime() - 2 * d * DAY_MS)
    const w: WindowNumbers = { days: d, from: ymd(from), to: ymd(new Date(today.getTime() - DAY_MS)), adOrders: 0, spendCents: 0, salesCents: 0, previousAdOrders: 0 }
    for (const r of rows) {
      const at = new Date(r.date).getTime()
      if (at >= from.getTime()) {
        w.adOrders += r._sum.orders7d ?? 0
        w.spendCents += Math.round(Number(r._sum.costMicros ?? 0) / 10_000)
        w.salesCents += adSalesCents(r._sum)
      } else if (at >= before.getTime()) w.previousAdOrders += r._sum.orders7d ?? 0
    }
    out.set(d, w)
  }
  return out
}

/** Since when the row that sets the goal holds it: the oldest version, counted back from its newest, with this goal. */
export async function phaseStart(strategyId: string, phase: string): Promise<{ at: Date; via: string; actor: string; approvalId: string | null; version: number } | null> {
  const versions = await prisma.adsStrategyVersion.findMany({
    where: { strategyId }, orderBy: { version: 'desc' }, take: 200,
    select: { version: true, values: true, via: true, actor: true, approvalId: true, createdAt: true },
  })
  let start: (typeof versions)[number] | null = null
  for (const v of versions) {
    if ((v.values as { goal?: unknown } | null)?.goal !== phase) break
    start = v
  }
  return start ? { at: start.createdAt, via: start.via, actor: start.actor, approvalId: start.approvalId, version: start.version } : null
}

export interface PhaseCheck extends PhaseCheckCore {
  phase: Phase | null
  source: { level: string; label: string; version: number } | null
  since: string | null
  lastSwitch: { at: string; version: number; via: string; actor: string; by: 'person' | 'rule' | 'system'; approvalId: string | null } | null
  measured: {
    windows: Array<WindowNumbers & { acosPct: number | null }>
    targetAcosPct: number | null
    targetFrom: string | null
    stock: { sellableUnits: number | null; unitsPerDay: number | null; daysOfCover: number | null; products: number; outOfStock: number; lowStock: number; shared: boolean; note?: string }
    costs: { breakEvenAcosPct: number | null; breakEvenFrom: string }
  }
  notMeasured: string
  note: string
}

const NOT_MEASURED = "Organic rank and competitor pressure: Nexus has no feed of either, so DEFEND starts and ends on the Owner's word."
const CHECK_NOTE =
  'Computed by Nexus now; nothing changes because of it. A move runs only as apply-ads-playbook op phase: by the business\'s rule only '
  + 'when this check proposes it outside the hold (and, when it adds spend, only where the Owner allowed raising moves); a person may '
  + 'switch at any time.'

/**
 * The phase check of one product (`productId`: the playbook row's product; its family's ads and stock) in one market,
 * against its resolved playbook doc. Read only.
 */
export async function loadPhaseCheck(args: { market: string; channel?: string; productId: string; doc: TemplateDoc; now?: Date }): Promise<PhaseCheck> {
  const channel = args.channel ?? 'AMAZON'
  const now = args.now ?? new Date()
  const [{ openStrategy }, { productFamily }, { readProductStock }, { recipeFacts }] = await Promise.all([
    import('../ads-strategy/effective.js'), import('../ads-strategy/load.js'), import('../ads-stock-risk.service.js'), import('./write.js'),
  ])
  const view = await openStrategy(args.market, channel)
  const resolved = (await view.forProducts([args.productId])).resolved
  const goal = resolved.fields.get('goal')
  const phase = typeof goal?.value === 'string' && goal.value ? (goal.value as Phase) : null
  const target = resolved.fields.get('targetAcosPct')
  const entry = phase ? args.doc.phases[phase] : undefined

  const start = phase && goal?.source ? await phaseStart(goal.source.strategyId, phase) : null
  let by: 'person' | 'rule' | 'system' = 'person'
  if (start?.approvalId) {
    const decided = await prisma.agentApproval.findUnique({ where: { id: start.approvalId }, select: { decisionVia: true } })
    if (decided?.decisionVia === 'auto') by = 'rule'
  } else if (start && (start.via === 'system' || start.via === 'adopt')) by = 'system'

  const family = await productFamily(args.productId)
  const [windows, stock, costs] = await Promise.all([
    adWindows(args.market, family, windowsOf(entry), now),
    readProductStock(family),
    recipeFacts(args.market, channel, args.productId, null),
  ])
  const products = [...stock.values()]
  const units = products.reduce((n, p) => n + p.units, 0)
  const paced = products.filter((p) => p.unitsPerDay != null)
  const perDay = paced.length ? paced.reduce((n, p) => n + (p.unitsPerDay ?? 0), 0) : null
  const shared = products.some((p) => p.pooled)
  const facts: PhaseFacts = {
    phase, since: start?.at ?? null, now, windows,
    targetAcosPct: typeof target?.value === 'number' ? target.value : null,
    sellableUnits: products.length ? units : null,
  }
  const core = evaluatePhaseCheck(entry, facts)
  return {
    phase,
    source: goal?.source ? { level: goal.source.level, label: goal.source.label, version: goal.source.version } : null,
    since: start ? start.at.toISOString() : null,
    lastSwitch: start ? { at: start.at.toISOString(), version: start.version, via: start.via, actor: start.actor, by, approvalId: start.approvalId } : null,
    ...core,
    measured: {
      windows: [...windows.values()].map((w) => ({ ...w, acosPct: w.salesCents > 0 ? round1((w.spendCents / w.salesCents) * 100) : null })),
      targetAcosPct: facts.targetAcosPct,
      targetFrom: target?.source ? `${target.source.label} v${target.source.version}` : null,
      stock: {
        sellableUnits: facts.sellableUnits,
        unitsPerDay: perDay,
        daysOfCover: perDay && perDay > 0 ? Math.floor((units / perDay) * 10) / 10 : null,
        products: products.length,
        outOfStock: products.filter((p) => p.risk === 'out-of-stock').length,
        lowStock: products.filter((p) => p.risk === 'low-stock').length,
        shared,
        ...(shared ? { note: "Some of it is another business's shared stock: that business's sales are not in this pace, so the cover is overstated." } : {}),
      },
      costs: { breakEvenAcosPct: costs.facts.breakEvenPct, breakEvenFrom: costs.from.breakEvenFrom },
    },
    notMeasured: NOT_MEASURED,
    note: phase
      ? CHECK_NOTE
      : `No phase yet: the ads strategy sets no goal for this product. A person (or Claude, asked) picks the first one with apply-ads-playbook op phase. ${CHECK_NOTE}`,
  }
}
