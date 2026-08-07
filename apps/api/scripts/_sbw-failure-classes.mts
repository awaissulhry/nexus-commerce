/**
 * NAF.SB.W — read-only: how do fleet runs actually fail? The Workers page
 * wants a "Status" column, and a status column that says "failed" without
 * saying WHICH KIND of failed is decoration. This counts the classes.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const runs = await prisma.agentRun.findMany({
  where: { mode: { not: null } },
  select: {
    agentKey: true, status: true, ok: true, mode: true, trigger: true,
    errorMessage: true, haltedReason: true, createdAt: true,
    costUSD: true, findingCount: true, latencyMs: true,
  },
  orderBy: { createdAt: 'desc' },
})

function classify(e: string | null, halted: string | null): string {
  if (halted) return `halted:${halted}`
  if (!e) return 'failed, no message recorded'
  if (e.includes('fetch failed')) return 'provider unreachable (fetch failed)'
  if (e.includes('credit balance')) return 'provider refused: out of credit'
  if (e.includes('schema validation')) return 'output failed its own contract'
  if (/budget|ceiling/i.test(e)) return 'budget stop'
  return `other: ${e.slice(0, 60)}`
}

const byClass = new Map<string, number>()
const byWorker = new Map<string, { total: number; failed: number; classes: Set<string> }>()
for (const r of runs) {
  const w = byWorker.get(r.agentKey) ?? { total: 0, failed: 0, classes: new Set<string>() }
  w.total++
  if (!r.ok) {
    w.failed++
    const c = classify(r.errorMessage, r.haltedReason)
    w.classes.add(c)
    byClass.set(c, (byClass.get(c) ?? 0) + 1)
  }
  byWorker.set(r.agentKey, w)
}

console.log('\n=== TOTAL FLEET RUNS ===', runs.length)
console.log('statuses:', [...new Set(runs.map((r) => r.status))].join(', '))
console.log('triggers:', [...new Set(runs.map((r) => r.trigger))].join(', '))
console.log('\n=== FAILURE CLASSES ===')
for (const [c, n] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${c}`)
}
console.log('\n=== PER WORKER ===')
for (const [k, w] of byWorker) {
  console.log(`  ${k.padEnd(28)} ${w.total} runs, ${w.failed} failed  [${[...w.classes].join(' | ')}]`)
}

const newest = runs[0]
console.log('\nnewest fleet run:', newest?.createdAt, newest?.agentKey)
console.log('oldest fleet run:', runs[runs.length - 1]?.createdAt)

await prisma.$disconnect()
