import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { getReportingCoverage } = await import('../src/services/advertising/ads-reporting-coverage.service.js')
const t0 = Date.now()
const c = await getReportingCoverage()
console.log(`\nqueried in ${Date.now() - t0}ms · warnings: ${c.warnings.length ? c.warnings.join(' | ') : 'none'}\n`)
console.log('REPORT'.padEnd(20), 'ROWS'.padStart(7), 'DAYS'.padStart(5), 'SPAN'.padStart(5), 'LAG'.padStart(4), ' WINDOW', '  PER-MARKET lag')
for (const [id, r] of Object.entries(c.reports)) {
  const mk = r.byMarket.map((m) => `${m.marketplace}:${m.lagDays ?? '—'}d/${m.rows}`).join(' ')
  console.log(
    id.padEnd(20),
    String(r.rows).padStart(7),
    String(r.days).padStart(5),
    String(r.spanDays).padStart(5),
    String(r.lagDays ?? '—').padStart(4),
    ` ${r.firstDay ?? '—'}→${r.lastDay ?? '—'}`,
    ` ${mk}`,
  )
}
console.log('\nCAMPAIGN CENSUS'); for (const c2 of c.campaigns) console.log(' ', c2.adProduct.padEnd(20), `enabled=${c2.enabled} paused=${c2.paused} other=${c2.other}`)
console.log('\nPIPELINE'); console.log(' jobs:', JSON.stringify(c.pipeline.reportJobs), '\n exportFailures:', c.pipeline.exportJobFailures, ' kioskJobs:', c.pipeline.dataKioskJobs)
console.log(' types:'); for (const t of c.pipeline.reportTypes) console.log('   ', t.adProduct.padEnd(20), t.reportTypeId.padEnd(22), `jobs=${t.jobs} rows=${t.rowsIngested}`)
process.exit(0)
