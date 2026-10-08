/**
 * ONE BRAIN AB-7 — the money hierarchy, step 3: the Amazon portfolio-cap plan of one product in one market (design
 * 2026-10-08-ads-one-brain/DESIGN.md §2.6, §9–§10 N1 and N2). Pure. SHADOW: planned and logged; AB-8 writes it.
 *
 *   why a cap  the portfolio cap is the only limit Amazon enforces (even if Nexus is down): monthly recurring, reset on
 *              the 1st; when it is reached EVERY campaign in the portfolio stops (INDUSTRY-2026-10 §2.4). So it is a
 *              backstop above the envelope (115 %), and the pace aims well below it (90 %).
 *   N1         portfolioCapOn (default on). portfolioCapCents (the Owner's own amount) replaces portfolioCapPct × the
 *              envelope; a lock of the whole portfolioCap lever holds his own value (or the cap as it is) and the brain
 *              only recommends. Each named with who set it.
 *   split      a product whose own campaigns sit in several portfolios has its cap split across them by their share of
 *              last month's spend (this month's when last month had none, else by campaign count).
 *   N2         a cap can follow a product only where the portfolio holds that product alone: a portfolio that also holds
 *              another product's campaign (or a shared or untied one), and own campaigns in no portfolio, are "move
 *              first" while ownPortfolio is on (the brain proposes one portfolio per product); with it off they get none.
 *   spend      a planned cap below the portfolio's spend this month (plus one day) would stop every campaign in it at
 *              once: the brain's own amount is raised to that floor; the Owner's own amount is kept and warned about.
 *   today      what Amazon holds now (the synced portfolio): a cap already equal to the plan is "keep".
 */
import type { Resolved } from './settings.js'
import type { SettingValue } from './levers.js'
import { apportion, money } from './budget-envelope.js'

export interface PortfolioFacts {
  /** Amazon's portfolio id (Campaign.portfolioId); null = the product's own campaigns in no portfolio. */
  portfolioId: string | null
  name: string | null
  /** The product's own campaigns in it. */
  campaignIds: readonly string[]
  /** Other campaigns in it (another product's, shared or untied): a cap there would stop them too. */
  otherCampaigns: number
  /** The product's own campaigns' spend in it last month, and this month so far. */
  lastMonthSpendCents: number
  monthSpendCents: number
  /** What Amazon holds now (synced): its budget policy and amount; null when the portfolio was never synced. */
  today: { policy: string | null; amountCents: number | null; inBudget: boolean | null } | null
}

export interface PortfolioCapSettings {
  on: Resolved<SettingValue>
  pct: Resolved<SettingValue>
  amountCents: Resolved<SettingValue>
  ownPortfolio: Resolved<SettingValue>
  /** A lock of the whole portfolioCap lever (its value: { amountCents } or null = as it is). */
  lock: Resolved<unknown> | null
}

export type PortfolioCapAction = 'set' | 'keep' | 'move-first' | 'none'

export interface PortfolioCapEntry {
  portfolioId: string | null
  name: string | null
  campaigns: number
  sharePct: number | null
  /** The planned cap here (null: none); for "move first", what it will be once the move is done. */
  capCents: number | null
  todayPolicy: string | null
  todayCapCents: number | null
  action: PortfolioCapAction
  /** The cap had to be raised to this month's spend in it (the brain's amount), or is below it (the Owner's). */
  belowSpend?: boolean
  why: string
}

export interface PortfolioCapPlan {
  on: boolean
  source: 'owner-amount' | 'owner-lock' | 'envelope' | 'off' | 'none'
  /** Percent of the envelope (the setting in force). */
  pct: number
  totalCents: number | null
  portfolios: PortfolioCapEntry[]
  why: string
}

const by = (r: { source: string; by: string | null }) => (r.source === 'default' ? 'the brain\'s default' : `the Owner's ${r.source} setting${r.by ? ` (${r.by})` : ''}`)

/** The portfolio-cap plan of one product in one market. Pure. */
export function planPortfolioCaps(input: {
  envelopeCents: number | null
  settings: PortfolioCapSettings
  portfolios: readonly PortfolioFacts[]
  runRateCents: number | null
}, words: (c: number) => string = (c) => money(c)): PortfolioCapPlan {
  const s = input.settings
  const pct = Number(s.pct.value) || 115
  const on = s.on.value !== false
  // By portfolio id, the campaigns in no portfolio last.
  const groups = [...input.portfolios].sort((a, b) => (a.portfolioId == null ? 1 : 0) - (b.portfolioId == null ? 1 : 0) || (a.portfolioId ?? '').localeCompare(b.portfolioId ?? ''))
  const today = (p: PortfolioFacts) => ({ todayPolicy: p.today?.policy ?? null, todayCapCents: p.today?.amountCents ?? null })
  const base = (p: PortfolioFacts) => ({ portfolioId: p.portfolioId, name: p.name, campaigns: p.campaignIds.length, ...today(p) })

  if (!on) {
    return {
      on: false, source: 'off', pct, totalCents: null,
      portfolios: groups.map((p) => ({ ...base(p), sharePct: null, capCents: null, action: 'none', why: 'no cap: the Owner switched the portfolio cap off (N1)' })),
      why: `no portfolio cap: portfolioCapOn is off by ${by(s.on)}${s.on.reason ? `: "${s.on.reason}"` : ''}`,
    }
  }

  // The total: the Owner's lock, else his own amount, else the envelope × the percent.
  const lockAmount = s.lock && s.lock.value && typeof (s.lock.value as { amountCents?: unknown }).amountCents === 'number' ? (s.lock.value as { amountCents: number }).amountCents : null
  const recommended = input.envelopeCents != null ? Math.round((input.envelopeCents * pct) / 100) : null
  let source: PortfolioCapPlan['source']
  let total: number | null
  if (s.lock) { source = 'owner-lock'; total = lockAmount ?? groups.reduce<number | null>((n, p) => (p.today?.amountCents != null ? (n ?? 0) + p.today.amountCents : n), null) }
  else if (typeof s.amountCents.value === 'number') { source = 'owner-amount'; total = s.amountCents.value }
  else if (recommended != null) { source = 'envelope'; total = recommended }
  else { source = 'none'; total = null }

  if (s.lock) {
    return {
      on: true, source, pct, totalCents: total,
      portfolios: groups.map((p) => ({ ...base(p), sharePct: null, capCents: null, action: 'keep', why: `locked at the Owner's own value by ${by(s.lock!)}: the brain writes nothing here` })),
      why: `the portfolio cap is locked at the Owner's own value (${lockAmount != null ? words(lockAmount) : 'as it is now'}) by ${by(s.lock)}: the brain writes nothing${recommended != null ? `; it would plan ${words(recommended)} (${pct} % of the envelope)` : ''}`,
    }
  }
  if (total == null) {
    return {
      on: true, source, pct, totalCents: null,
      portfolios: groups.map((p) => ({ ...base(p), sharePct: null, capCents: null, action: 'none', why: 'no envelope: no cap to plan' })),
      why: 'no portfolio cap planned: the product has no envelope this month (and the Owner set no cap amount of his own)',
    }
  }

  // The split: last month's spend, else this month's, else campaign count.
  const weightsOf = (k: 'lastMonthSpendCents' | 'monthSpendCents') => groups.map((p) => Math.max(0, p[k]))
  const sum = (w: number[]) => w.reduce((n, x) => n + x, 0)
  let basis = 'last month\'s spend'
  let weights = weightsOf('lastMonthSpendCents')
  if (sum(weights) <= 0) { weights = weightsOf('monthSpendCents'); basis = 'this month\'s spend' }
  if (sum(weights) <= 0) { weights = groups.map((p) => p.campaignIds.length); basis = 'their number of campaigns' }
  const parts = apportion(total, weights)
  const wsum = sum(weights)
  const n2 = s.ownPortfolio.value !== false
  const owner = source === 'owner-amount'

  const portfolios: PortfolioCapEntry[] = groups.map((p, i) => {
    const sharePct = wsum > 0 ? Math.round((weights[i] / wsum) * 1000) / 10 : null
    let cap = parts[i]
    const head = { ...base(p), sharePct }
    if (!p.portfolioId) {
      return { ...head, capCents: cap, action: n2 ? 'move-first' : 'none', why: n2 ? `${p.campaignIds.length} own campaign${p.campaignIds.length === 1 ? ' is' : 's are'} in no portfolio: Amazon caps only portfolios — move ${p.campaignIds.length === 1 ? 'it' : 'them'} into the product's own portfolio first (N2)` : 'in no portfolio, and the Owner keeps today\'s portfolios (N2 off): no cap' }
    }
    if (p.otherCampaigns > 0) {
      return { ...head, capCents: cap, action: n2 ? 'move-first' : 'none', why: n2 ? `the portfolio also holds ${p.otherCampaigns} other campaign${p.otherCampaigns === 1 ? '' : 's'} (another product's, shared or untied): a cap would stop them too — move this product's campaigns into its own portfolio first (N2)` : `the portfolio also holds ${p.otherCampaigns} other campaign${p.otherCampaigns === 1 ? '' : 's'} and the Owner keeps today's portfolios (N2 off): no cap` }
    }
    const floor = p.monthSpendCents + Math.round((input.runRateCents ?? 0) * (wsum > 0 ? weights[i] / wsum : 1))
    let belowSpend: boolean | undefined
    let note = ''
    if (cap < floor) {
      belowSpend = true
      if (owner) note = `; ⚠ below this month's spend in it plus one day (${words(floor)}): Amazon would stop every campaign in it at once — the Owner's amount is kept`
      else { note = `; raised to this month's spend in it plus one day (${words(floor)}): a lower cap would stop every campaign in it at once`; cap = floor }
    }
    const same = p.today?.policy === 'MONTHLY_RECURRING' && p.today.amountCents === cap
    return {
      ...head, capCents: cap, action: same ? 'keep' : 'set', ...(belowSpend ? { belowSpend } : {}),
      why: `${sharePct ?? 100} % of the cap by ${basis}${same ? ': Amazon already holds it (monthly)' : `: Amazon holds ${p.today?.policy && p.today.policy !== 'NO_CAP' ? `${p.today.policy.toLowerCase().replace(/_/g, ' ')} ${p.today.amountCents != null ? words(p.today.amountCents) : ''}`.trim() : 'no cap'} today`}${note}`,
    }
  })
  const head = source === 'owner-amount' ? `the Owner's own cap ${words(total)} (${by(s.amountCents)})` : `${pct} % of the envelope ${words(input.envelopeCents!)} = ${words(total)}${s.pct.source === 'default' ? '' : ` (${by(s.pct)})`}`
  return {
    on: true, source, pct, totalCents: total, portfolios,
    why: `monthly portfolio cap ${head}: a hard backstop Amazon enforces even if Nexus is down; across ${groups.length} portfolio group${groups.length === 1 ? '' : 's'} by ${basis}`,
  }
}
