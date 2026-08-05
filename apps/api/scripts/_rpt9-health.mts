import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { pipelineHealth } = await import('../src/services/advertising/ads-pipeline-health.service.js')
const h = await pipelineHealth()
console.log(`pipeline health · ${h.elapsedMs}ms\n`)
console.log('FEED                          STATUS    LAST DATA    LAG   ROWS      CRON')
for (const f of h.feeds) {
  console.log(`${f.label.padEnd(29)} ${f.status.padEnd(9)} ${String(f.lastDataDay ?? '—').padEnd(12)} ${String(f.lagDays ?? '—').padStart(3)}  ${String(f.rows).padStart(7)}   ${f.cronJob ?? '—'}${f.recentFailures ? ` (${f.recentFailures} fail)` : ''}`)
}
console.log('\nALERTS'); h.alerts.length ? h.alerts.forEach(a=>console.log('  ·', a)) : console.log('  none')
console.log('\nJOBS')
console.log('  report jobs:', h.jobs.reportJobs.map(j=>`${j.status}=${j.n}`).join(' '))
console.log(`  export download failures: ${h.jobs.exportFailures.total} (recoverable ${h.jobs.exportFailures.recoverable})`)
console.log(`  runs missing a row count: ${h.jobs.reportRunsMissingRowCount.total}`)
process.exit(0)
