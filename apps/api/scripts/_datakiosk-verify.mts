/** LIVE verification of the Data Kiosk economics pipeline.
 *  Adopts the already-completed query 111255020663 as a job row and runs the
 *  real ingest path, so the production code — not a probe — is what's proven. */
const prisma = (await import('../src/db.js')).default
const p = prisma as any
const L = (s = '') => console.log(s)
const svc = await import('../src/services/amazon/data-kiosk.service.js')

const QID = process.argv[2] ?? '111255020663'
const MKT = process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'

let job = await p.dataKioskQueryJob.findFirst({ where: { externalQueryId: QID } })
if (!job) {
  job = await p.dataKioskQueryJob.create({
    data: {
      queryType: 'economics', marketplaceId: MKT,
      startDate: new Date('2026-07-19'), endDate: new Date('2026-07-25'),
      externalQueryId: QID, status: 'IN_PROGRESS',
      query: svc.buildEconomicsQuery({ startDate: '2026-07-19', endDate: '2026-07-25', marketplaceIds: [MKT] }),
    },
  })
  L(`adopted query ${QID} as job ${job.id}`)
}

L('\n── running the real poll+ingest cycle ──────────────────────────')
const out = await svc.runDataKioskPollCycle()
L(JSON.stringify(out, null, 2))

L('\n── what landed ────────────────────────────────────────────────')
const n = await p.amazonEconomicsDaily.count()
L(`AmazonEconomicsDaily rows: ${n}`)

const agg = await p.$queryRawUnsafe(`
  SELECT "marketplace", COUNT(*)::int AS rows,
         MIN("date")::text AS first, MAX("date")::text AS last,
         SUM("unitsOrdered")::int AS units,
         ROUND(SUM("netProductSales")::numeric, 2)::text AS sales,
         ROUND(SUM("netProceedsTotal")::numeric, 2)::text AS proceeds,
         ROUND(SUM("feesTotal")::numeric, 2)::text AS fees,
         ROUND(SUM("adsTotal")::numeric, 2)::text AS ads,
         COUNT(*) FILTER (WHERE "netProceedsPerUnit" IS NULL)::int AS null_perunit,
         COUNT(*) FILTER (WHERE "costOfGoodsSold" IS NULL)::int AS null_cogs
  FROM "AmazonEconomicsDaily" GROUP BY 1`)
for (const r of agg as any[]) {
  L(`  ${r.marketplace}: ${r.rows} rows ${r.first}..${r.last}`)
  L(`     units=${r.units} sales=${r.sales} proceeds=${r.proceeds} fees=${r.fees} ads=${r.ads}`)
  L(`     null perUnit=${r.null_perunit}  null COGS=${r.null_cogs}`)
}

L('\n── a row with real money (proves fee/ad summing) ──────────────')
const rows = await p.amazonEconomicsDaily.findMany({
  where: { unitsOrdered: { gt: 0 } }, orderBy: { netProductSales: 'desc' }, take: 3,
  select: { date: true, childAsin: true, msku: true, unitsOrdered: true, netProductSales: true, feesTotal: true, feesCount: true, adsTotal: true, adsCount: true, netProceedsTotal: true, netProceedsPerUnit: true, costOfGoodsSold: true },
})
for (const r of rows) {
  L(`  ${String(r.date).slice(0, 10)} ${r.childAsin} ${r.msku}`)
  L(`     units=${r.unitsOrdered} sales=${r.netProductSales} fees=${r.feesTotal}(${r.feesCount}) ads=${r.adsTotal}(${r.adsCount}) → netProceeds=${r.netProceedsTotal} perUnit=${r.netProceedsPerUnit} cogs=${r.costOfGoodsSold}`)
}

L('\n── grain check: any duplicate (mkt,date,asin,msku)? ───────────')
const dupes = await p.$queryRawUnsafe(`
  SELECT COUNT(*)::int AS n FROM (
    SELECT "marketplaceId","date","childAsin","msku" FROM "AmazonEconomicsDaily"
    GROUP BY 1,2,3,4 HAVING COUNT(*) > 1
  ) t`)
L(`  duplicate keys: ${(dupes as any[])[0].n} (must be 0 — the unique index enforces it)`)

L('\n── job row ────────────────────────────────────────────────────')
const jobs = await p.dataKioskQueryJob.findMany({ select: { externalQueryId: true, status: true, rowsIngested: true, attempts: true, errorMessage: true } })
for (const j of jobs) L(`  ${j.externalQueryId} ${j.status} rows=${j.rowsIngested} attempts=${j.attempts} err=${j.errorMessage ?? '-'}`)

await prisma.$disconnect()
