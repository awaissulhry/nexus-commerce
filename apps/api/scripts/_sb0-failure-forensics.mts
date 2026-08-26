/** NAF.SB.0 — which provider did the 21 `fetch failed` runs actually try to reach?
 *  Read-only: inspects steps/input JSON on the failed rows. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const fetchFails = await prisma.agentRun.findMany({
  where: { mode: { not: null }, errorMessage: 'fetch failed' },
  select: { id: true, agentKey: true, createdAt: true, latencyMs: true, steps: true, input: true, charterVersion: true },
  orderBy: { createdAt: 'asc' },
})
console.log('=== fetch failed rows ===', fetchFails.length)
const first = fetchFails[0]
console.log('\nfirst row steps:', JSON.stringify(first?.steps)?.slice(0, 900))
console.log('\nfirst row input:', JSON.stringify(first?.input)?.slice(0, 500))

// Latency histogram — a ~60-90s timeout points at an unreachable local endpoint;
// sub-second points at DNS/connection refused.
const buckets = { '<1s': 0, '1-10s': 0, '10-60s': 0, '>60s': 0 }
for (const r of fetchFails) {
  const ms = r.latencyMs ?? 0
  if (ms < 1000) buckets['<1s']++
  else if (ms < 10_000) buckets['1-10s']++
  else if (ms < 60_000) buckets['10-60s']++
  else buckets['>60s']++
}
console.log('\nlatency buckets:', JSON.stringify(buckets))

// What ran successfully immediately before and after the outage window?
const around = await prisma.agentRun.findMany({
  where: { mode: { not: null }, createdAt: { gte: new Date('2026-08-06T08:00:00Z'), lte: new Date('2026-08-06T11:00:00Z') } },
  select: { agentKey: true, createdAt: true, ok: true, provider: true, model: true, errorMessage: true },
  orderBy: { createdAt: 'asc' },
})
console.log('\n=== every run 08:00–11:00 on 2026-08-06 ===')
for (const r of around)
  console.log(`${r.createdAt.toISOString()} ${r.agentKey.padEnd(22)} ok=${String(r.ok).padEnd(5)} ${String(r.provider ?? '-').padEnd(10)} ${String(r.model ?? '-').padEnd(22)} ${(r.errorMessage ?? '').slice(0, 45)}`)

// Total spend, and charter states.
const agg = await prisma.agentRun.aggregate({ where: { mode: { not: null } }, _sum: { costUSD: true, inputTokens: true, outputTokens: true } })
console.log('\n=== lifetime fleet spend ===', `$${agg._sum.costUSD}`, `· in=${agg._sum.inputTokens} out=${agg._sum.outputTokens} tokens`)

const charters = await prisma.agentCharter.findMany({
  select: { key: true, tier: true, version: true, autonomyLevel: true, autonomyCap: true, enabled: true, dailyBudgetUSD: true, maxTokensPerRun: true, cadence: true },
  orderBy: [{ tier: 'asc' }, { key: 'asc' }],
})
console.log('\n=== charters ===')
for (const c of charters)
  console.log(`${c.key.padEnd(26)} v${c.version} ${String(c.tier).padEnd(10)} autonomy=${String(c.autonomyLevel).padEnd(8)} cap=${String(c.autonomyCap).padEnd(8)} enabled=${String(c.enabled).padEnd(5)} $${c.dailyBudgetUSD}/day maxTok=${c.maxTokensPerRun} cadence=${c.cadence ?? '-'}`)

await prisma.$disconnect()
