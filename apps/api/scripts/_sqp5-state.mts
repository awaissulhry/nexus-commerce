/** SQP.5 — §7 stop conditions, and §4.1/§4.4 from the ledger. Read-only, no Amazon calls. */
import '../src/env.js'
import prisma from '../src/db.js'

console.log('━━━ §7 STOP CONDITIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
const rt = await prisma.rankTarget.count({ where: { maxBiasPct: { not: null } } })
console.log(`  RankTarget maxBiasPct non-null: ${rt}${rt ? '  🔴 STOP' : '  ✓ all NULL'}`)
console.log(`  NEXUS_COVERAGE_ENGINE_MODE=[${process.env.NEXUS_COVERAGE_ENGINE_MODE ?? 'unset'}] · NEXUS_SQP_ROTATION=[${process.env.NEXUS_SQP_ROTATION ?? 'unset'}] · NEXUS_SQP_YIELD_ORDER_OFF=[${process.env.NEXUS_SQP_YIELD_ORDER_OFF ?? 'unset'}]`)
const st = await prisma.sqpReportRequest.groupBy({ by: ['status'], _count: { _all: true } })
const stuck = st.filter((s) => s.status !== 'INGESTED').reduce((a, s) => a + s._count._all, 0)
console.log(`  SqpReportRequest: ${st.map((s) => `${s.status}=${s._count._all}`).join(' ')}${stuck ? `  · ${stuck} non-terminal` : '  ✓ all terminal'}`)
const blocking: any[] = await prisma.$queryRawUnsafe(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL`)
console.log(`  _prisma_migrations genuinely blocking: ${blocking.length}${blocking.length ? ' 🔴' : '  ✓ zero'}`)

console.log('\n━━━ §4.1 · drain rate as a function of BATCH SIZE ━━━━━━━━━━━━━━━━━━━━━━━━')
const reqs = await prisma.sqpReportRequest.findMany({
  select: { marketplace: true, asin: true, startDate: true, requestedAt: true, doneAt: true, collectedAt: true,
            rowsParsed: true, rowsChanged: true, status: true },
  orderBy: { requestedAt: 'asc' },
})
console.log(`  ledger: ${reqs.length} requests · ${reqs.filter(r=>r.doneAt).length} with doneAt`)
// a batch = requests whose requestedAt cluster within 90 min of the first
const batches: Array<{ key: string; rows: typeof reqs }> = []
for (const r of reqs) {
  const last = batches[batches.length - 1]
  if (last && +r.requestedAt - +last.rows[0]!.requestedAt < 90 * 60_000) last.rows.push(r)
  else batches.push({ key: r.requestedAt.toISOString().slice(5, 16), rows: [r] })
}
console.log('  batch start        n   createSpan  genSpan(1st→lastDone)  gen/report   collectLag p50')
for (const b of batches) {
  const rs = b.rows
  const createSpan = (+rs[rs.length-1]!.requestedAt - +rs[0]!.requestedAt) / 60_000
  const dones = rs.filter((r) => r.doneAt).map((r) => +r.doneAt!)
  const genSpan = dones.length ? (Math.max(...dones) - +rs[0]!.requestedAt) / 60_000 : NaN
  const lags = rs.filter((r) => r.collectedAt && r.doneAt).map((r) => (+r.collectedAt! - +r.doneAt!) / 60_000).sort((a,b)=>a-b)
  const p50 = lags.length ? lags[Math.floor(lags.length/2)]! : NaN
  console.log(`  ${b.key}  ${String(rs.length).padStart(3)}   ${createSpan.toFixed(1).padStart(9)}m ${genSpan.toFixed(1).padStart(21)}m ${(genSpan/rs.length).toFixed(2).padStart(10)}m ${p50.toFixed(1).padStart(14)}m`)
}
console.log('  🔴 createSpan / n is the createReport throttle; genSpan is the SERIAL generation queue.')

console.log('\n━━━ §4.4 · does a re-fetch change anything? rowsChanged by week AGE ━━━━━━━')
const withChanged = reqs.filter((r) => r.rowsChanged !== null && r.collectedAt)
console.log(`  ${withChanged.length} requests carry rowsChanged (the column SQP.3 added)`)
const byAge = new Map<string, { n: number; changed: number; zero: number; rows: number }>()
for (const r of withChanged) {
  const ageD = Math.floor((+r.collectedAt! - +r.startDate) / 86_400_000)
  const bucket = ageD < 14 ? '0-13d' : ageD < 21 ? '14-20d' : ageD < 28 ? '21-27d' : ageD < 50 ? '28-49d' : '50d+'
  const c = byAge.get(bucket) ?? { n: 0, changed: 0, zero: 0, rows: 0 }
  c.n++; c.changed += r.rowsChanged!; c.rows += r.rowsParsed ?? 0; if (r.rowsChanged === 0) c.zero++
  byAge.set(bucket, c)
}
console.log('  week age at fetch   requests   rowsParsed   rowsCHANGED   fetches changing NOTHING')
for (const k of ['0-13d','14-20d','21-27d','28-49d','50d+']) {
  const c = byAge.get(k); if (!c) continue
  console.log(`  ${k.padEnd(17)} ${String(c.n).padStart(9)} ${String(c.rows).padStart(12)} ${String(c.changed).padStart(13)}   ${c.zero} of ${c.n}`)
}
// re-fetches specifically: the same (mkt, asin, week) asked more than once
const key = (r: typeof reqs[0]) => `${r.marketplace}|${r.asin}|${r.startDate.toISOString().slice(0,10)}`
const seen = new Map<string, number>()
for (const r of reqs) seen.set(key(r), (seen.get(key(r)) ?? 0) + 1)
const repeats = [...seen.values()].filter((n) => n > 1).length
const repeatReqs = reqs.filter((r) => (seen.get(key(r)) ?? 0) > 1 && r.rowsChanged !== null)
const laterOfRepeat = repeatReqs.filter((r, i, a) => a.findIndex((x) => key(x) === key(r)) !== i)
console.log(`\n  (asin, week) pairs asked more than once: ${repeats}`)
console.log(`  their LATER fetches: ${laterOfRepeat.length} · rowsChanged total ${laterOfRepeat.reduce((s,r)=>s+(r.rowsChanged??0),0)} · changing nothing: ${laterOfRepeat.filter(r=>r.rowsChanged===0).length}`)
await prisma.$disconnect()
