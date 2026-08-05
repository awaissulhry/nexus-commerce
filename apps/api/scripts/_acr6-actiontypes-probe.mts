/** ACR.6 — which action types do advertising executions ACTUALLY emit? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const since = new Date(); since.setUTCDate(since.getUTCDate() - 30); since.setUTCHours(0, 0, 0, 0)

const execs = await prisma.automationRuleExecution.findMany({
  where: { startedAt: { gte: since }, status: { in: ['SUCCESS', 'PARTIAL'] }, rule: { domain: 'advertising' } },
  select: { actionResults: true, dryRun: true, rule: { select: { name: true } } },
})
console.log(`\n${execs.length} advertising executions (SUCCESS|PARTIAL, 30d)`)

const types = new Map<string, { n: number; ok: number; outputKeys: Map<string, number> }>()
let noActions = 0
for (const e of execs) {
  const list = (e.actionResults as Array<{ type?: string; ok?: boolean; output?: Record<string, unknown> }> | null) ?? []
  if (!Array.isArray(list) || list.length === 0) { noActions++; continue }
  for (const a of list) {
    const k = String(a?.type ?? '(no type)')
    if (!types.has(k)) types.set(k, { n: 0, ok: 0, outputKeys: new Map() })
    const t = types.get(k)!
    t.n++
    if (a?.ok) t.ok++
    for (const key of Object.keys(a?.output ?? {})) t.outputKeys.set(key, (t.outputKeys.get(key) ?? 0) + 1)
  }
}
console.log(`${noActions} executions carried an EMPTY actionResults array\n`)
console.log('action type'.padEnd(34) + 'count'.padStart(8) + '  ok'.padStart(8) + '   output keys (top 6)')
for (const [k, v] of [...types.entries()].sort((a, b) => b[1].n - a[1].n)) {
  const keys = [...v.outputKeys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([kk, c]) => `${kk}:${c}`).join(' ')
  console.log(k.padEnd(34) + String(v.n).padStart(8) + String(v.ok).padStart(8) + '   ' + keys)
}

// What the shipped aggregation counts, for comparison.
const COUNTED = new Set(['harvest_and_negate', 'bid_to_target_acos', 'retail_guard'])
const counted = [...types.entries()].filter(([k]) => COUNTED.has(k)).reduce((a, [, v]) => a + v.n, 0)
const total = [...types.values()].reduce((a, v) => a + v.n, 0)
console.log(`\nthe aggregation counts ${counted} of ${total} action results (${total ? ((counted / total) * 100).toFixed(1) : '0'}%)`)

await prisma.$disconnect()
