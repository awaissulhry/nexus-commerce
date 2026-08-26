/** NAF.SB.0 — read-only diagnosis of fleet run health: what fails, how often,
 *  when, on which model/provider. No writes. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const fleet = { mode: { not: null } } as const

const total = await prisma.agentRun.count({ where: fleet })
const byStatus = await prisma.agentRun.groupBy({ by: ['status'], where: fleet, _count: { _all: true } })
const byMode = await prisma.agentRun.groupBy({ by: ['mode'], where: fleet, _count: { _all: true } })
const byProviderModel = await prisma.agentRun.groupBy({
  by: ['provider', 'model', 'ok'], where: fleet, _count: { _all: true },
})

console.log('=== fleet runs ===', total)
console.log('status :', byStatus.map((r) => `${r.status}=${r._count._all}`).join(' · '))
console.log('mode   :', byMode.map((r) => `${r.mode}=${r._count._all}`).join(' · '))
console.log('prov/model/ok:', byProviderModel.map((r) => `${r.provider}|${r.model}|ok=${r.ok}:${r._count._all}`).join(' · '))

const failed = await prisma.agentRun.findMany({
  where: { ...fleet, OR: [{ ok: false }, { status: 'failed' }] },
  select: {
    id: true, agentKey: true, mode: true, status: true, provider: true, model: true,
    errorMessage: true, haltedReason: true, latencyMs: true, createdAt: true,
    inputTokens: true, outputTokens: true,
  },
  orderBy: { createdAt: 'desc' },
})
console.log('\n=== failures ===', failed.length, `(${total ? Math.round((failed.length / total) * 100) : 0}% of fleet runs)`)

const byMsg = new Map<string, { n: number; first: Date; last: Date; keys: Set<string>; latencies: number[] }>()
for (const f of failed) {
  const msg = (f.errorMessage || f.haltedReason || '(no message)').slice(0, 120)
  const e = byMsg.get(msg) || { n: 0, first: f.createdAt, last: f.createdAt, keys: new Set<string>(), latencies: [] }
  e.n++
  if (f.createdAt < e.first) e.first = f.createdAt
  if (f.createdAt > e.last) e.last = f.createdAt
  e.keys.add(f.agentKey)
  if (f.latencyMs != null) e.latencies.push(f.latencyMs)
  byMsg.set(msg, e)
}
for (const [msg, e] of [...byMsg.entries()].sort((a, b) => b[1].n - a[1].n)) {
  const lat = e.latencies.length ? `${Math.min(...e.latencies)}–${Math.max(...e.latencies)}ms` : 'n/a'
  console.log(`\n[${e.n}×] ${msg}`)
  console.log(`     window: ${e.first.toISOString()} → ${e.last.toISOString()}`)
  console.log(`     workers: ${[...e.keys].join(', ')}`)
  console.log(`     latency: ${lat}`)
}

// Did any failure ever consume tokens? A `fetch failed` that burned tokens
// reached Anthropic; one that burned none never left the process.
const burned = failed.filter((f) => f.inputTokens > 0 || f.outputTokens > 0)
console.log(`\ntoken-burning failures: ${burned.length}/${failed.length} (0 tokens = never reached the provider)`)

console.log('\n=== last 12 fleet runs ===')
const recent = await prisma.agentRun.findMany({
  where: fleet, orderBy: { createdAt: 'desc' }, take: 12,
  select: { agentKey: true, mode: true, status: true, ok: true, latencyMs: true, findingCount: true, costUSD: true, createdAt: true, errorMessage: true },
})
for (const r of recent)
  console.log(`${r.createdAt.toISOString()} ${r.mode?.padEnd(8)} ${r.agentKey.padEnd(26)} ${r.status.padEnd(7)} ok=${r.ok} ${String(r.latencyMs ?? '-').padStart(6)}ms findings=${r.findingCount} $${r.costUSD}${r.ok ? '' : ` ← ${(r.errorMessage || '').slice(0, 60)}`}`)

await prisma.$disconnect()
