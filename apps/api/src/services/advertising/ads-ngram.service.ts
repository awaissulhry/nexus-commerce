/**
 * AX.11 — Search-term n-gram analysis. Tokenizes every search term into 1-
 * and 2-word grams and aggregates performance per gram — surfacing the word
 * fragments that win (high ROAS) and waste (spend, no orders) across the
 * whole account. The single highest-leverage PPC insight: act on a gram
 * once (negative it / build a campaign around it) instead of term-by-term.
 */

import prisma from '../../db.js'

export interface NgramRow {
  gram: string; n: 1 | 2; terms: number
  impressions: number; clicks: number; costCents: number; orders: number; salesCents: number
  acos: number | null; roas: number | null
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'of', 'to', 'in', 'di', 'da', 'il', 'la', 'le', 'e', 'per', 'con', 'der', 'die', 'das', 'und'])

export async function analyzeNgrams(opts: { windowDays?: number; minCostCents?: number } = {}): Promise<{ windowDays: number; winning: NgramRow[]; wasteful: NgramRow[] }> {
  const windowDays = opts.windowDays ?? 60
  const minCost = opts.minCostCents ?? 300
  const since = new Date(Date.now() - windowDays * 86400_000)
  const rows = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query'],
    where: { date: { gte: since } },
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

  const all = [...map.values()].filter((r) => r.costCents >= minCost)
  for (const r of all) { r.acos = r.salesCents > 0 ? r.costCents / r.salesCents : null; r.roas = r.costCents > 0 ? r.salesCents / r.costCents : null }
  const winning = all.filter((r) => r.orders > 0).sort((a, b) => (b.roas ?? 0) - (a.roas ?? 0)).slice(0, 50)
  const wasteful = all.filter((r) => r.orders === 0).sort((a, b) => b.costCents - a.costCents).slice(0, 50)
  return { windowDays, winning, wasteful }
}
