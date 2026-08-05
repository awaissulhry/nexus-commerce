/** READ-ONLY: what actually makes a Brand Metrics row unique? */
const prisma = (await import('../src/db.js')).default
const svc = await import('../src/services/advertising/ads-brand-metrics.service.js')
const L = (s = '') => console.log(s)

const job = await (prisma as any).amazonAdsReportJob.findFirst({
  where: { adProduct: 'BRAND_METRICS', status: 'COMPLETED' },
  orderBy: { createdAt: 'desc' },
})
L(`job ${job.id} profile=${job.profileId} ${String(job.startDate).slice(0, 10)}..${String(job.endDate).slice(0, 10)}`)

const conn = await (prisma as any).amazonAdsConnection.findUnique({ where: { profileId: job.profileId }, select: { region: true, marketplace: true } })
const status = await svc.fetchBrandMetricsStatus(job.profileId, (conn.region ?? 'EU') as 'EU', job.externalReportId)
if (!status.location) { L('no location'); process.exit(1) }
const buf = Buffer.from(await (await fetch(status.location)).arrayBuffer())
const raw = svc.decodeReportPayload(buf) as { brandBuildingMetrics: Array<{ metadata: Record<string, unknown> }> }
const items = raw.brandBuildingMetrics ?? []

L(`\nmarketplace=${conn.marketplace}  raw records: ${items.length}`)
L('\nmetadata of every record:')
for (const it of items) {
  const m = it.metadata
  L(`  date=${m.metricsComputationDate}  lookback=${m.lookbackPeriod}  tree=${m.categoryNodeTreeName}  node=${String(m.categoryNodeName).slice(0, 46)}`)
}

const key = (m: Record<string, unknown>, ...fields: string[]) => fields.map((f) => String(m[f])).join('|')
for (const combo of [
  ['metricsComputationDate'],
  ['metricsComputationDate', 'lookbackPeriod'],
  ['metricsComputationDate', 'lookbackPeriod', 'categoryNodeName'],
  ['metricsComputationDate', 'lookbackPeriod', 'categoryNodeName', 'categoryNodeTreeName'],
]) {
  const s = new Set(items.map((i) => key(i.metadata, ...combo)))
  L(`\n${s.size === items.length ? '✅ UNIQUE' : '⛔ collides'}  ${s.size}/${items.length} distinct by [${combo.join(', ')}]`)
}

L('\ndistinct values:')
for (const f of ['metricsComputationDate', 'lookbackPeriod', 'categoryNodeName', 'categoryNodeTreeName']) {
  const s = new Set(items.map((i) => String(i.metadata[f])))
  L(`  ${f}: ${s.size} → ${[...s].slice(0, 8).map((v) => v.slice(0, 40)).join(' , ')}`)
}

await prisma.$disconnect()
