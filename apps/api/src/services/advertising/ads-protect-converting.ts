/**
 * NEG.0(a) — "Never create a negative for a term that converted."
 *
 * `_shared/RuleBuilder.tsx:851` renders a switch, ON BY DEFAULT, over this sentence:
 *
 *   "Never create a negative for a term that converted (≥1 order) in the last 30 days in any
 *    campaign — protects proven keywords from being blocked."
 *
 * `ads-rule-adapter.service.ts:174-175` writes it into the rule's action JSON as
 * `protectConverting` / `protectDays`. Until this file existed, `grep -rn protectConverting
 * apps/api/src` returned exactly one hit: the adapter that writes it. **Nothing read it.**
 *
 * This is the reader. It is deliberately split in two:
 *
 *   · `convertedTermsIn(days)` — the one database read, account-wide, no marketplace filter,
 *     because the promise says "in ANY campaign" and a market-scoped check would be a weaker
 *     sentence than the one on the screen.
 *   · `decideNegation()` — a PURE function over that map. Every rule that matters is testable
 *     without a database, which is what makes "a test that fails if the branch is removed"
 *     something other than an aspiration.
 *
 * One normalisation, `normaliseNegTerm`, is used on both sides of the comparison. Amazon's search
 * terms arrive lower-case; our negatives do not (`AIRMESH pant`, `giacca MOSS`). Comparing the raw
 * strings would have let exactly the terms the operator most wants protected through the check.
 */

import prisma from '../../db.js'

/** Case-folded, whitespace-collapsed. The ONE normalisation, used on both sides of the compare. */
export const normaliseNegTerm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

export interface ProtectConvertingConfig {
  enabled: boolean
  days: number
}

export interface ConvertedTerm {
  /** Orders attributed to this query inside the window, account-wide. */
  orders: number
  salesCents: number
  /** Which marketplaces it converted in — so a refusal can name where, not just that. */
  markets: string[]
}

export interface NegationDecision {
  allowed: boolean
  /** Always populated, allowed or not: a refusal nobody can read is a silent skip. */
  reason: string
  evidence: {
    term: string
    orders: number
    salesCents: number
    markets: string[]
    windowDays: number
  } | null
}

/** The window's floor, defaulted and bounded. 0 or a negative would silently disable the check. */
const DEFAULT_DAYS = 30
const clampDays = (n: unknown): number => {
  const d = Math.floor(Number(n))
  return Number.isFinite(d) && d > 0 ? Math.min(d, 365) : DEFAULT_DAYS
}

/**
 * Read the toggle off a rule's action JSON.
 *
 * 🔴 ABSENT MEANS ON. The builder's switch defaults to on and the adapter writes
 * `protectConverting: a0.protectConverting !== false`, so a rule that never saw the switch — every
 * seeded rule in the account — carries no key at all. Defaulting those to OFF would mean the
 * protection covered only the rules built after the switch shipped, which is the same shape of
 * half-protection this fix exists to end. Only an explicit `false` turns it off.
 */
export function protectConvertingConfig(action: Record<string, unknown> | null | undefined): ProtectConvertingConfig {
  const raw = action?.protectConverting
  return {
    enabled: raw !== false,
    days: clampDays(action?.protectDays),
  }
}

/**
 * The decision. Pure — no clock, no database, no I/O.
 *
 * `converted` is keyed by `normaliseNegTerm(query)`; callers build it with `convertedTermsIn`.
 */
export function decideNegation(args: {
  term: string
  config: ProtectConvertingConfig
  converted: ReadonlyMap<string, ConvertedTerm>
}): NegationDecision {
  const { term, config, converted } = args
  const key = normaliseNegTerm(term)

  if (!key) return { allowed: false, reason: 'Refused: empty term.', evidence: null }
  if (!config.enabled) {
    return {
      allowed: true,
      reason: `Allowed: "protect converting search terms" is off on this rule.`,
      evidence: null,
    }
  }

  const hit = converted.get(key)
  if (!hit || hit.orders < 1) {
    return {
      allowed: true,
      reason: `Allowed: "${term}" has no attributed order in the last ${config.days} days in any campaign.`,
      evidence: null,
    }
  }

  const where = hit.markets.length ? ` in ${hit.markets.join(', ')}` : ''
  return {
    allowed: false,
    reason:
      `Refused by "protect converting search terms": "${term}" converted ` +
      `${hit.orders} order${hit.orders === 1 ? '' : 's'} (€${(hit.salesCents / 100).toFixed(2)})${where} ` +
      `in the last ${config.days} days. Negating it would block a term that is earning.`,
    evidence: {
      term: key,
      orders: hit.orders,
      salesCents: hit.salesCents,
      markets: hit.markets,
      windowDays: config.days,
    },
  }
}

/**
 * Every search term with at least one attributed order in the window, account-wide.
 *
 * Rows with `orders7d = 0` are excluded in the WHERE rather than summed and discarded: they are the
 * overwhelming majority, they cannot change the answer (they add zero), and leaving them out keeps
 * the grouped read small enough to run on every negation.
 *
 * `now` is injectable so a caller can pin the window; the default is the wall clock.
 */
export async function convertedTermsIn(days: number, now: Date = new Date()): Promise<Map<string, ConvertedTerm>> {
  const since = new Date(now.getTime() - clampDays(days) * 24 * 60 * 60 * 1000)
  const rows = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query', 'marketplace'],
    where: { date: { gte: since }, orders7d: { gt: 0 } },
    _sum: { orders7d: true, sales7dCents: true },
  })

  const out = new Map<string, ConvertedTerm>()
  for (const r of rows) {
    const key = normaliseNegTerm(r.query)
    if (!key) continue
    const cur = out.get(key) ?? { orders: 0, salesCents: 0, markets: [] }
    cur.orders += r._sum.orders7d ?? 0
    cur.salesCents += r._sum.sales7dCents ?? 0
    if (r.marketplace && !cur.markets.includes(r.marketplace)) cur.markets.push(r.marketplace)
    out.set(key, cur)
  }
  for (const v of out.values()) v.markets.sort()
  return out
}

/**
 * The whole check, for a caller that has one term or a batch of them: one read, N pure decisions.
 *
 * Returns a Map keyed by `normaliseNegTerm(term)` so a caller can look up either spelling.
 */
export async function checkProtectConverting(args: {
  terms: string[]
  config: ProtectConvertingConfig
  now?: Date
}): Promise<Map<string, NegationDecision>> {
  const out = new Map<string, NegationDecision>()
  const keys = [...new Set(args.terms.map(normaliseNegTerm).filter(Boolean))]
  if (!keys.length) return out

  // The one short-circuit: an OFF toggle asks the database nothing. It is also the branch that
  // makes the disabled case cheap enough that nobody is tempted to skip the check "for speed".
  const converted = args.config.enabled ? await convertedTermsIn(args.config.days, args.now) : new Map<string, ConvertedTerm>()
  for (const term of args.terms) {
    const key = normaliseNegTerm(term)
    if (!key || out.has(key)) continue
    out.set(key, decideNegation({ term, config: args.config, converted }))
  }
  return out
}
