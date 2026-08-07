// NAF.SB.ACT — read-only: are the failures the self-test's, or the business workers'?
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const runs = await prisma.agentRun.findMany({
  where: { mode: { not: null } },
  select: {
    agentKey: true, ok: true, status: true, errorMessage: true,
    haltedReason: true, createdAt: true, mode: true,
  },
  orderBy: { createdAt: 'asc' },
})

/** Mirrors app/fleet/_shared/run-health.ts classifyFailure(). */
const klass = (r: (typeof runs)[number]): string | null => {
  if (r.status === 'running') return null
  if (r.ok) return null
  if (r.haltedReason) return 'limit'
  const e = r.errorMessage ?? ''
  if (e.includes('fetch failed')) return 'provider-unreachable'
  if (/credit balance|insufficient_quota|billing/i.test(e)) return 'provider-refused'
  if (/schema validation|failed schema/i.test(e)) return 'contract'
  return 'unknown'
}

const tally: Record<string, Record<string, number>> = {}
for (const r of runs) {
  const k = klass(r)
  if (!k) continue
  tally[k] ??= {}
  tally[k]![r.agentKey] = (tally[k]![r.agentKey] ?? 0) + 1
}
console.log('FAILURES BY CLASS → WORKER:')
console.log(JSON.stringify(tally, null, 1))

const nonDiag = runs.filter((r) => r.agentKey !== 'fleet-selftest')
console.log('\nEXCLUDING fleet-selftest:')
console.log('  runs =', nonDiag.length, '| failures =', nonDiag.filter((r) => klass(r)).length)
console.log(
  '  by class:',
  JSON.stringify(
    nonDiag.reduce<Record<string, number>>((a, r) => {
      const k = klass(r)
      if (k) a[k] = (a[k] ?? 0) + 1
      return a
    }, {}),
  ),
)
console.log(
  '  by mode:',
  JSON.stringify(
    nonDiag.reduce<Record<string, number>>((a, r) => {
      a[r.mode!] = (a[r.mode!] ?? 0) + 1
      return a
    }, {}),
  ),
)

const unreachable = runs.filter((r) => klass(r) === 'provider-unreachable')
if (unreachable.length) {
  const first = unreachable[0]!.createdAt
  const last = unreachable[unreachable.length - 1]!.createdAt
  console.log('\nprovider-unreachable window:', first.toISOString(), '→', last.toISOString())
  console.log('  spans minutes =', Math.round((+last - +first) / 60000))
}

const last12 = runs.slice(-12)
console.log('\nLAST 12 fleet runs: failures =', last12.filter((r) => klass(r)).length)
console.log('  ', JSON.stringify(last12.map((r) => `${r.agentKey}:${klass(r) ?? 'ok'}`)))

await prisma.$disconnect()
