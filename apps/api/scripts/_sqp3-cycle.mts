/**
 * SQP.3 Phase B — prove "fetch until it stops moving" end to end, on prod.
 *
 * Three passes over the SAME (asin, week): the first must change everything, the second must change
 * nothing, and the third must not ask Amazon at all. Writes the 2026-08-02 week, which currently holds
 * 0 rows — so this is pure gain and overwrites nothing.
 */
import prisma from '../src/db.js'
import { periodWindow, SQP_LOOKBACK } from '../src/services/advertising/sqp.service.js'
import { requestSqpReports, collectSqpReports } from '../src/services/advertising/sqp-async.service.js'

const MKT = process.env.CYCLE_MKT || 'IT'
const ASINS = (process.env.CYCLE_ASINS || 'B0BMSWM15B,B0BMS6ZZ4H').split(',')
const win = periodWindow('WEEK', new Date(), SQP_LOOKBACK)
const wk = win.start.toISOString().slice(0, 10)

const mk = await prisma.marketplace.findFirst({ where: { code: MKT, channel: 'AMAZON' }, select: { marketplaceId: true } })
if (!mk?.marketplaceId) throw new Error(`no marketplaceId for ${MKT}`)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const state = async () => {
  const rows = await prisma.sqpReportRequest.findMany({
    where: { marketplace: MKT, startDate: win.start, asin: { in: ASINS } },
    select: { asin: true, status: true, rowsUpserted: true, rowsChanged: true }, orderBy: { requestedAt: 'asc' },
  })
  return rows.map((r) => `${r.asin} ${r.status} upserted=${r.rowsUpserted ?? '—'} changed=${r.rowsChanged ?? 'NULL'}`).join('\n     ')
}

console.log(`━━━ target: ${MKT} week ${wk} (lookback ${SQP_LOOKBACK}) · ${ASINS.length} asins ━━━`)
console.log('  stored rows in this week BEFORE:', await prisma.searchQueryPerformance.count({ where: { reportPeriod: 'WEEK', marketplace: MKT, startDate: win.start } }))

for (const pass of [1, 2, 3]) {
  console.log(`\n━━━ PASS ${pass} · request ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  const r = await requestSqpReports({ marketplaceCode: MKT, marketplaceId: mk.marketplaceId, asins: ASINS, period: 'WEEK', start: win.start, end: win.end })
  console.log(`  created=${r.created} failed=${r.failed} alreadyOutstanding=${r.alreadyOutstanding} alreadySettled=${r.alreadySettled}`)
  if (pass === 3) {
    console.log(r.alreadySettled === ASINS.length
      ? `  ⇒ 🔴 SETTLED. Amazon was not called at all for this week. This is the change.`
      : `  ⇒ NOT settled — ${r.created} report(s) still requested.`)
    break
  }
  if (r.created === 0 && r.alreadySettled === 0) { console.log('  (nothing created and nothing settled — stopping)'); break }

  for (let i = 0; i < 40; i++) {
    await sleep(15_000)
    const c = await collectSqpReports({ limit: 20 })
    if (c.ingested > 0) { console.log(`  collect: ingested=${c.ingested} rowsUpserted=${c.rowsUpserted} rowsChanged=${c.rowsChanged}`); break }
    if (i % 4 === 3) console.log(`  …waiting (${(i + 1) * 15}s) pending=${c.stillPending}`)
  }
  console.log('  state:\n     ' + await state())
}

console.log('\n━━━ after ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('  stored rows in this week AFTER:', await prisma.searchQueryPerformance.count({ where: { reportPeriod: 'WEEK', marketplace: MKT, startDate: win.start } }))
console.log('  newest week stored anywhere:', (await prisma.searchQueryPerformance.aggregate({ _max: { startDate: true } }))._max.startDate?.toISOString().slice(0, 10))
await prisma.$disconnect()
