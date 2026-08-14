/**
 * SQP.3 Phase C — the yield curve. Read-only.
 *
 * Widening only pays if the ASINs past the current cut return rows. Three things decide that: how big
 * the pool even is, whether the current cut is STABLE (an unstable cut is accidental rotation), and how
 * row yield falls off with rank.
 */
import prisma from '../src/db.js'
import { ourAsinsForMarketplace, periodWindow, SQP_LOOKBACK } from '../src/services/advertising/sqp.service.js'

const MKTS = ['DE', 'ES', 'FR', 'IT']
const win = periodWindow('WEEK', new Date(), SQP_LOOKBACK)

console.log('━━━ 1 · the pool: how many ASINs could we ask for at all? ━━━━━━━━━━━━━━━━━━')
console.log('mkt  listings  distinctAsin  ACTIVE  otherStatuses')
for (const m of MKTS) {
  const rows = await prisma.channelListing.findMany({
    where: { channel: 'AMAZON', OR: [{ marketplace: m }, { region: m }] },
    select: { externalParentId: true, externalListingId: true, listingStatus: true }, take: 1000,
  })
  const asin = (l: typeof rows[0]) => l.externalParentId || l.externalListingId
  const distinct = new Set(rows.map(asin).filter(Boolean) as string[])
  const active = new Set(rows.filter((r) => r.listingStatus === 'ACTIVE').map(asin).filter(Boolean) as string[])
  const st = new Map<string, number>()
  for (const r of rows) st.set(r.listingStatus ?? 'null', (st.get(r.listingStatus ?? 'null') ?? 0) + 1)
  console.log(`${m.padEnd(4)} ${String(rows.length).padStart(8)} ${String(distinct.size).padStart(13)} ${String(active.size).padStart(7)}  ${[...st].map(([k,v])=>`${k}=${v}`).join(' ')}`)
}

console.log('\n━━━ 2 · is the current cut STABLE? (called twice, and vs what was requested) ━━━')
for (const m of MKTS) {
  const a1 = await ourAsinsForMarketplace(m, 10)
  const a2 = await ourAsinsForMarketplace(m, 10)
  const same = a1.join(',') === a2.join(',')
  const requested = (await prisma.sqpReportRequest.findMany({
    where: { marketplace: m, reportPeriod: 'WEEK', startDate: win.start }, select: { asin: true }, distinct: ['asin'],
  })).map((r) => r.asin)
  const overlap = a1.filter((x) => requested.includes(x)).length
  console.log(`${m}: two calls agree=${same} · selection∩lastNight = ${overlap}/${a1.length}${overlap < a1.length ? '  🔴 the cut MOVED' : ''}`)
}

console.log('\n━━━ 3 · the yield curve — rows per ASIN, by rank in the selection ━━━━━━━━━━━')
for (const m of MKTS) {
  const sel = await ourAsinsForMarketplace(m, 40)
  const counts: Array<{ asin: string; rows: number; weeks: number }> = []
  for (const a of sel) {
    const rows = await prisma.searchQueryPerformance.count({ where: { marketplace: m, asin: a } })
    const weeks = (await prisma.searchQueryPerformance.findMany({ where: { marketplace: m, asin: a }, select: { startDate: true }, distinct: ['startDate'] })).length
    counts.push({ asin: a, rows, weeks })
  }
  const inCut = counts.slice(0, 10), past = counts.slice(10)
  const sum = (x: typeof counts) => x.reduce((s, c) => s + c.rows, 0)
  console.log(`${m}: pool sampled ${sel.length} · rank 1-10 rows=${sum(inCut)} (${inCut.filter(c=>c.rows>0).length} with data) · rank 11+ rows=${sum(past)} (${past.filter(c=>c.rows>0).length}/${past.length} with data)`)
  const never = counts.filter((c) => c.rows === 0).length
  console.log(`   never returned a row: ${never}/${counts.length}`)
}

console.log('\n━━━ 4 · FR — why it looks different ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
const frL = await prisma.channelListing.findMany({
  where: { channel: 'AMAZON', OR: [{ marketplace: 'FR' }, { region: 'FR' }] },
  select: { externalParentId: true, externalListingId: true, listingStatus: true, sku: true }, take: 200,
})
const byStatus = new Map<string, number>()
for (const l of frL) byStatus.set(l.listingStatus ?? 'null', (byStatus.get(l.listingStatus ?? 'null') ?? 0) + 1)
console.log('  FR listing statuses:', [...byStatus].map(([k,v])=>`${k}=${v}`).join(' '))
for (const m of MKTS) {
  const rows = await prisma.searchQueryPerformance.groupBy({
    by: ['startDate'], where: { marketplace: m }, _count: { _all: true }, orderBy: { startDate: 'desc' }, take: 3,
  })
  console.log(`  ${m} newest weeks: ${rows.map((r) => `${r.startDate.toISOString().slice(5,10)}=${r._count._all}`).join(' ')}`)
}
await prisma.$disconnect()
