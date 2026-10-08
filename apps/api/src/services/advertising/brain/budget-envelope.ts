/**
 * ONE BRAIN AB-7 — the money hierarchy, step 1: each product's envelope for the month in one market (design
 * 2026-10-08-ads-one-brain/DESIGN.md §2.6, §5; §10 N1). Pure: brain/budget-load.ts reads the Owner's numbers. SHADOW: the
 * envelope is decided and logged; nothing is written anywhere.
 *
 *   market budget  the stricter of the ads strategy's MARKET monthly cap and this month's Budget Manager plan (both the
 *                  Owner's; 0 is no cap, as everywhere). Σ envelopes never passes it (the market arbiter's rule, §1 point 5).
 *   own            a product's own monthly budget: the AdsStrategy PRODUCT row of its family root (monthlySpendCapCents).
 *                  The Owner's number: it wins over every share.
 *   playbook       else its enrolled playbook row's daily budget × the days of the month (§2.6).
 *   share          else its share of what the market budget leaves after the products with their own budget, by its own
 *                  campaigns' spend over the trailing window. The campaigns no product's brain owns (shared or untied:
 *                  D2) keep their share as a reserve, so the market budget also covers them.
 *   none           no market budget and nothing of its own: no envelope — no pace, no brake, no portfolio cap; said so.
 *   zero spend     a product with no spend in the window gets no share (no envelope, said): a share of nothing is a stop.
 *   bounds         own + playbook budgets above the market budget are scaled down together to fit it (both are the
 *                  Owner's; the stricter binds, as every strategy limit); a category cap in force bounds the envelope (a
 *                  product cannot spend more than its category may).
 *
 * Amounts are minor units of the market's currency (cents), as every Nexus ads amount; a split is apportioned by the
 * largest remainder, so the parts add up to the whole to the cent.
 */

export type EnvelopeSource = 'own' | 'playbook' | 'share' | 'none'

/** One product of the market as the split reads it (the family root). */
export interface EnvelopeProduct {
  productId: string
  /** Its own monthly budget: the PRODUCT strategy row of the family root (> 0), with the words naming the row. */
  own: { cents: number; from: string } | null
  /** Its enrolled playbook row's daily budget (> 0), with the words naming the row. */
  playbookDaily: { cents: number; from: string } | null
  /** Category caps in force on the product (each binds its category's spend). */
  categoryCaps: ReadonlyArray<{ cents: number; from: string }>
  /** Its own campaigns' spend over the trailing window: its weight in the share. */
  trailingSpendCents: number
}

export interface MarketBudgetInput {
  /** The ads strategy's MARKET row cap (> 0) and its words. */
  strategy: { cents: number; from: string } | null
  /** This month's Budget Manager plan for the market (> 0), its words. */
  plan: { cents: number; from: string } | null
}

export interface EnvelopeInput {
  market: string
  month: string
  daysInMonth: number
  windowDays: number
  budget: MarketBudgetInput
  products: readonly EnvelopeProduct[]
  /** The trailing spend of the market's campaigns no product's brain owns (shared or untied). */
  reserveSpendCents: number
}

export interface Envelope {
  productId: string
  /** The month's envelope; null = none (no pace, no brake, no portfolio cap). */
  cents: number | null
  source: EnvelopeSource
  /** The products' own and playbook budgets were scaled to fit the market budget: the percent kept. */
  scaledPct?: number
  /** A category cap lowered it. */
  boundBy?: string
  /** Its share of the split, percent (share only). */
  sharePct?: number
  why: string
}

export interface MarketSplit {
  market: string
  month: string
  /** The market budget in force (null: none) and where it comes from. */
  budgetCents: number | null
  budgetFrom: string | null
  /** Σ own + playbook envelopes after any scaling. */
  fixedCents: number
  /** What the share split gave out, and what it kept for campaigns no product's brain owns. */
  sharedCents: number
  reserveCents: number
  /** Σ envelopes of every product (never above the budget). */
  totalCents: number
  envelopes: Map<string, Envelope>
  why: string
  warnings: string[]
}

export const SHARE_WINDOW_DAYS = 30

export function money(cents: number | null | undefined, currency = 'EUR'): string {
  if (cents == null || !Number.isFinite(cents)) return 'none'
  try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(cents / 100) } catch { return `${(cents / 100).toFixed(2)} ${currency}` }
}

const pct1 = (x: number) => `${Math.round(x * 10) / 10} %`

/**
 * Split `total` cents by `weights` so the parts add up to `total` exactly (largest remainder; ties to the earlier one).
 * Every weight ≤ 0 (or all of them) gets 0; with no positive weight every part is 0.
 */
export function apportion(total: number, weights: readonly number[]): number[] {
  const t = Math.max(0, Math.floor(total))
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0))
  const sum = w.reduce((n, x) => n + x, 0)
  if (sum <= 0 || t === 0) return w.map(() => 0)
  const raw = w.map((x) => (t * x) / sum)
  const out = raw.map(Math.floor)
  let left = t - out.reduce((n, x) => n + x, 0)
  const order = raw.map((r, i) => ({ i, rest: r - Math.floor(r) })).filter((o) => w[o.i] > 0).sort((a, b) => b.rest - a.rest || a.i - b.i)
  for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length, left--) out[order[k].i]++
  return out
}

/** The market budget in force: the stricter of the strategy's cap and the Budget Manager's plan (0 or absent: none). */
export function marketBudget(b: MarketBudgetInput, currency = 'EUR'): { cents: number | null; from: string | null } {
  const parts = [b.strategy, b.plan].filter((p): p is { cents: number; from: string } => !!p && p.cents > 0)
  if (!parts.length) return { cents: null, from: null }
  const stricter = parts.reduce((a, p) => (p.cents < a.cents ? p : a))
  const other = parts.find((p) => p !== stricter)
  return { cents: stricter.cents, from: other ? `${stricter.from} (stricter than ${other.from}, ${money(other.cents, currency)})` : stricter.from }
}

/**
 * The envelope of every product of one market for the month, and the market's split. Pure.
 */
export function splitEnvelopes(input: EnvelopeInput, currency = 'EUR'): MarketSplit {
  const m = (c: number | null) => money(c, currency)
  const warnings: string[] = []
  const budget = marketBudget(input.budget, currency)
  const envelopes = new Map<string, Envelope>()

  // 1. The products' own budgets, else their playbook's daily budget × the month.
  type Fixed = { p: EnvelopeProduct; cents: number; source: 'own' | 'playbook'; words: string }
  const fixed = input.products.flatMap((p): Fixed[] => {
    if (p.own && p.own.cents > 0) return [{ p, cents: p.own.cents, source: 'own', words: `its own monthly budget (${p.own.from})` }]
    if (p.playbookDaily && p.playbookDaily.cents > 0) {
      return [{ p, cents: p.playbookDaily.cents * input.daysInMonth, source: 'playbook', words: `its playbook's daily budget ${m(p.playbookDaily.cents)} × ${input.daysInMonth} days (${p.playbookDaily.from})` }]
    }
    return []
  })
  const fixedSum = fixed.reduce((n, f) => n + f.cents, 0)
  let scale: number | null = null
  let fixedCents = fixedSum
  let fixedParts = fixed.map((f) => f.cents)
  if (budget.cents != null && fixedSum > budget.cents) {
    scale = budget.cents / fixedSum
    fixedParts = apportion(budget.cents, fixed.map((f) => f.cents))
    fixedCents = budget.cents
    warnings.push(`the products' own and playbook budgets (${m(fixedSum)}) are above the market budget ${m(budget.cents)} (${budget.from}): each is scaled to ${pct1(scale * 100)} to fit it`)
  }
  fixed.forEach((f, i) => {
    const scaled = scale != null ? { scaledPct: Math.round(scale * 1000) / 10 } : {}
    envelopes.set(f.p.productId, {
      productId: f.p.productId, cents: fixedParts[i], source: f.source, ...scaled,
      why: scale != null ? `${f.words}, scaled to ${pct1(scale * 100)} so the products' budgets fit the market budget ${m(budget.cents)} (${budget.from})` : f.words,
    })
  })

  // 2. The rest of the market budget, shared by trailing spend; the campaigns no product's brain owns keep their part.
  const sharers = input.products.filter((p) => !envelopes.has(p.productId))
  let sharedCents = 0
  let reserveCents = 0
  if (budget.cents == null) {
    for (const p of sharers) {
      envelopes.set(p.productId, { productId: p.productId, cents: null, source: 'none', why: `no envelope: the Owner set no monthly budget for ${input.market} (ads strategy market row or the Budget Manager's ${input.month} plan) and none for the product (its strategy row or its playbook): no pace, no brake, no portfolio cap` })
    }
  } else {
    const left = Math.max(0, budget.cents - fixedCents)
    const weights = [...sharers.map((p) => Math.max(0, p.trailingSpendCents)), Math.max(0, input.reserveSpendCents)]
    const parts = apportion(left, weights)
    const weightSum = weights.reduce((n, x) => n + x, 0)
    reserveCents = parts[parts.length - 1]
    sharers.forEach((p, i) => {
      const w = weights[i]
      if (left <= 0) {
        envelopes.set(p.productId, { productId: p.productId, cents: 0, source: 'share', sharePct: 0, why: `nothing is left of the market budget ${m(budget.cents)} (${budget.from}) after the products with their own budget (${m(fixedCents)}): its envelope is 0` })
        return
      }
      if (w <= 0) {
        envelopes.set(p.productId, { productId: p.productId, cents: null, source: 'none', why: `no envelope: its campaigns spent nothing in the last ${input.windowDays} days, so it has no share of the market budget ${m(budget.cents)} (${budget.from}); give it its own monthly budget (ads strategy, product row) or a playbook daily budget` })
        return
      }
      const share = (w / weightSum) * 100
      sharedCents += parts[i]
      envelopes.set(p.productId, {
        productId: p.productId, cents: parts[i], source: 'share', sharePct: Math.round(share * 10) / 10,
        why: `its share of the market budget ${m(budget.cents)} (${budget.from}): ${pct1(share)} of the ${m(left)} left after the products with their own budget, by its own campaigns' spend over the last ${input.windowDays} days (${m(w)})`,
      })
    })
  }

  // 3. A category cap bounds the envelope (it binds the category's spend, so it binds each of its products).
  for (const p of input.products) {
    const e = envelopes.get(p.productId)!
    const tight = p.categoryCaps.filter((c) => c.cents > 0).reduce<{ cents: number; from: string } | null>((a, c) => (!a || c.cents < a.cents ? c : a), null)
    if (!tight) continue
    if (e.cents == null) { e.why += `; a category cap of ${m(tight.cents)} (${tight.from}) binds its category's spend`; continue }
    if (tight.cents < e.cents) {
      e.why += `, lowered to the category cap ${m(tight.cents)} (${tight.from}): a product cannot spend more than its category may`
      e.cents = tight.cents
      e.boundBy = tight.from
    }
  }

  const totalCents = [...envelopes.values()].reduce((n, e) => n + (e.cents ?? 0), 0)
  const why = budget.cents == null
    ? `${input.market} has no monthly budget: only products with their own budget (or a playbook budget) have an envelope (${m(totalCents)} in all)`
    : `${input.market} monthly budget ${m(budget.cents)} (${budget.from}): ${m(fixedCents)} to products with their own budget, ${m(sharedCents)} shared by spend, ${m(reserveCents)} kept for campaigns no product's brain owns`
  return { market: input.market, month: input.month, budgetCents: budget.cents, budgetFrom: budget.from, fixedCents, sharedCents, reserveCents, totalCents, envelopes, why, warnings }
}
