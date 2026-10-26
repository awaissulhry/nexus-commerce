/**
 * AX.11 — Search-term n-gram analysis. Tokenizes every search term into 1-
 * and 2-word grams and aggregates performance per gram — surfacing the word
 * fragments that win (high ROAS) and waste (spend, no orders) across the
 * whole account. The single highest-leverage PPC insight: act on a gram
 * once (negative it / build a campaign around it) instead of term-by-term.
 */

import prisma from '../../db.js'

export interface NgramRow {
  gram: string; n: 1 | 2
  /**
   * 🔴 NOT the number of search terms a negation of this gram would block. Measured 2026-08-12:
   * `moto protezioni` reports **61** here and only **13** queries actually contain that phrase.
   *
   * The tokenizer strips stop words BEFORE pairing (line ~62), so "giacca moto con protezioni"
   * yields the 2-gram `moto protezioni` even though those words are not adjacent in the query.
   * For a 1-gram the two counts agree; for a 2-gram this over-reports by up to 4.7×.
   *
   * Anything offering an ACTION must count contiguous token matches itself, and put that number on
   * the row instead (the Negative Targeting page's Words view does: waste/words-pure.ts).
   */
  terms: number
  impressions: number; clicks: number; costCents: number; orders: number; salesCents: number
  acos: number | null; roas: number | null
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'of', 'to', 'in', 'di', 'da', 'il', 'la', 'le', 'e', 'per', 'con', 'der', 'die', 'das', 'und'])

/** Grams under this spend in the window are left out (€3, in cents of the terms' currency). */
const MIN_COST_CENTS = 300

/**
 * NEG.6 — the scope: every field is optional, and absent means "account-wide". Its two callers name a window and a
 * market (ai-goal-suggest.service.ts) or nothing (agent-fleet negative-candidates.observation.ts).
 *
 * 🔴 The market exists because an account-wide number under a narrowed heading is a lie, and the data says so loudly.
 * Measured 2026-08-12 over 60 days: one French word's spend was 100% FR and one Italian word's 100% IT — showing either
 * under one market's heading would attribute spend to a market that never spent it.
 */
export interface NgramScope {
  windowDays?: number
  marketplace?: string | null
}

export async function analyzeNgrams(opts: NgramScope = {}): Promise<{ windowDays: number; winning: NgramRow[]; wasteful: NgramRow[] }> {
  const windowDays = opts.windowDays ?? 60
  const since = new Date(Date.now() - windowDays * 86400_000)
  const where: Record<string, unknown> = { date: { gte: since } }
  if (opts.marketplace) where.marketplace = opts.marketplace
  const rows = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query'],
    where,
    _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
  })

  const map = new Map<string, NgramRow>()
  const bump = (gram: string, n: 1 | 2, impr: number, clk: number, cost: number, ord: number, sales: number) => {
    let r = map.get(gram)
    if (!r) { r = { gram, n, terms: 0, impressions: 0, clicks: 0, costCents: 0, orders: 0, salesCents: 0, acos: null, roas: null }; map.set(gram, r) }
    r.terms++; r.impressions += impr; r.clicks += clk; r.costCents += cost; r.orders += ord; r.salesCents += sales
  }

  for (const row of rows) {
    const words = row.query.toLowerCase().split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w))
    const impr = row._sum.impressions ?? 0, clk = row._sum.clicks ?? 0
    const cost = Math.round(Number(row._sum.costMicros ?? 0n) / 10000), ord = row._sum.orders7d ?? 0, sales = row._sum.sales7dCents ?? 0
    const grams = new Set<string>()
    for (const w of words) grams.add(w)
    for (let i = 0; i < words.length - 1; i++) grams.add(`${words[i]} ${words[i + 1]}`)
    for (const g of grams) bump(g, g.includes(' ') ? 2 : 1, impr, clk, cost, ord, sales)
  }

  const all = [...map.values()].filter((r) => r.costCents >= MIN_COST_CENTS)
  for (const r of all) { r.acos = r.salesCents > 0 ? r.costCents / r.salesCents : null; r.roas = r.costCents > 0 ? r.salesCents / r.costCents : null }
  const winning = all.filter((r) => r.orders > 0).sort((a, b) => (b.roas ?? 0) - (a.roas ?? 0)).slice(0, 50)
  const wasteful = all.filter((r) => r.orders === 0).sort((a, b) => b.costCents - a.costCents).slice(0, 50)
  return { windowDays, winning, wasteful }
}
