/**
 * NAF.SB.ACT.S2R — read-only evidence for the "What needs a look" band.
 *
 * Deliberately does NOT classify. `classifyFailure` lives in
 * `apps/web/src/app/fleet/_shared/run-health.ts` and is the single opinion the
 * band counts through; a probe that re-implemented its regexes would be exactly
 * the second opinion the module exists to prevent — and the probe would be the
 * one nobody notices drifting. So this prints the RAW inputs that classifier
 * reads (`errorMessage`, `haltedReason`, `status`, `ok`) and leaves the verdict
 * to the code that ships.
 *
 * Answers the two open questions in the S2 study:
 *   1. is either current business failure a `preview` (test-lane) run?
 *   2. what does the band render at every scope the operator can select?
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const runs = await prisma.agentRun.findMany({
  where: { mode: { not: null } },
  select: {
    id: true,
    agentKey: true,
    mode: true,
    trigger: true,
    ok: true,
    status: true,
    errorMessage: true,
    haltedReason: true,
    createdAt: true,
    workflowKey: true,
  },
  orderBy: { createdAt: 'desc' },
})

const SELFTEST = 'fleet-selftest'
const notOk = runs.filter((r) => !r.ok && r.status !== 'running')

console.log('=== fleet runs ===')
console.log(`total ${runs.length} · business ${runs.filter((r) => r.agentKey !== SELFTEST).length} · self-test ${runs.filter((r) => r.agentKey === SELFTEST).length}`)
console.log(`in flight (status=running, ok=false — NOT failures) = ${runs.filter((r) => r.status === 'running').length}`)

console.log('\n=== every not-ok run, raw (business first) ===')
for (const r of [...notOk].sort((a, b) => (a.agentKey === SELFTEST ? 1 : 0) - (b.agentKey === SELFTEST ? 1 : 0))) {
  const kind = r.agentKey === SELFTEST ? 'SELFTEST' : 'BUSINESS'
  console.log(
    [
      kind.padEnd(8),
      r.agentKey.padEnd(24),
      `mode=${String(r.mode).padEnd(8)}`,
      `trigger=${String(r.trigger).padEnd(9)}`,
      r.createdAt.toISOString(),
      r.haltedReason ? `halted="${r.haltedReason}"` : `err="${(r.errorMessage ?? '').slice(0, 70)}"`,
    ].join(' '),
  )
}

console.log('\n=== full error text for everything that is NOT "fetch failed" ===')
console.log('(the classifier matches on substrings, so the tail decides the class)')
for (const r of notOk) {
  const e = r.errorMessage ?? ''
  if (e.includes('fetch failed')) continue
  console.log(`\n--- ${r.agentKey} ${r.createdAt.toISOString()}`)
  console.log(r.haltedReason ? `haltedReason: ${r.haltedReason}` : e.slice(0, 400))
}

console.log('\n=== Q1 · is a failing run ever a TEST run? ===')
const bizFail = notOk.filter((r) => r.agentKey !== SELFTEST)
const bizFailPreview = bizFail.filter((r) => r.mode === 'preview')
console.log(`business failures = ${bizFail.length}, of which mode=preview (test lane) = ${bizFailPreview.length}`)
console.log(`self-test failures = ${notOk.length - bizFail.length}, of which mode=preview = ${notOk.filter((r) => r.agentKey === SELFTEST && r.mode === 'preview').length}`)

console.log('\n=== the self-test outage window (the thing Part 6 is about) ===')
const stFail = notOk.filter((r) => r.agentKey === SELFTEST)
if (stFail.length) {
  const times = stFail.map((r) => r.createdAt.getTime()).sort((a, b) => a - b)
  const span = (times[times.length - 1]! - times[0]!) / 60_000
  console.log(`${stFail.length} self-test failures spanning ${span.toFixed(1)} minutes`)
  console.log(`first ${new Date(times[0]!).toISOString()} · last ${new Date(times[times.length - 1]!).toISOString()}`)
  const byDay = new Map<string, number>()
  for (const r of stFail) {
    const d = r.createdAt.toISOString().slice(0, 10)
    byDay.set(d, (byDay.get(d) ?? 0) + 1)
  }
  console.log('by UTC day:', JSON.stringify(Object.fromEntries(byDay)))
}

console.log('\n=== how recent is the newest failure of each population? ===')
const newest = (rs: typeof runs) => (rs.length ? rs[0]!.createdAt.toISOString() : 'never')
console.log('newest business failure :', newest(bizFail))
console.log('newest self-test failure:', newest(stFail))
console.log('newest run of any kind  :', newest(runs))
console.log('runs since the newest business failure =',
  bizFail.length ? runs.filter((r) => r.createdAt > bizFail[0]!.createdAt).length : runs.length)

await prisma.$disconnect()
