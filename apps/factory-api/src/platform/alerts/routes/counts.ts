import type { Reader } from '../store'

/** How many routes each rule keeps (B-W2b-435; ANA-041: the rules list's "goes to", ../rules.ts ruleViews). */
export async function routeCounts(db: Reader, ruleIds: readonly string[]): Promise<Map<string, number>> {
  if (ruleIds.length === 0) return new Map()
  const rows = await db.alertRoute.groupBy({ by: ['ruleId'], where: { ruleId: { in: [...ruleIds] } }, _count: { _all: true } })
  return new Map(rows.map((row) => [row.ruleId, row._count._all]))
}
