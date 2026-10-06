/**
 * AM-15 — one market picker, one scope. Every Dashboard read that feeds a tile under the picker carries the chosen
 * market: trends (Spend/Sales/ACoS/ROAS/Orders, chart), alerts, summary (Campaigns, True margin) and momentum (Top
 * movers, placements). Before, summary was fetched with no market at all and momentum's market was ignored by the API.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('./DashboardClient.tsx', import.meta.url)), 'utf8')

describe('Dashboard reads follow the market picker', () => {
  const reads = [...SRC.matchAll(/fetch\(`\$\{base\}\/api\/advertising\/([a-z-]+)\?([^`]*)`/g)].map((m) => ({ path: m[1], query: m[2] }))

  it('reads the four tile sources', () => {
    expect(reads.map((r) => r.path).sort()).toEqual(['alerts', 'momentum', 'summary', 'trends'])
  })

  it('every one of them carries the market', () => {
    for (const r of reads) expect(r.query, r.path).toMatch(/\$\{mp/)
  })
})
