import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const sch = await import('../src/services/advertising/ads-report-schedules.service.js')
const crud = await import('../src/services/advertising/ads-report-schedules-crud.service.js')
const saved = await import('../src/services/advertising/ads-saved-reports.service.js')

console.log('OUTBOUND EMAIL ENABLED:', process.env.NEXUS_ENABLE_OUTBOUND_EMAILS === 'true' ? 'YES' : 'NO (dry run)')

// ── window resolution, from a fixed reference so it is deterministic ──
const NOW = new Date('2026-08-04T09:00:00Z')  // a Tuesday
const base = { reportId: 'campaign', from: '2026-01-01', to: '2026-01-31' } as never
console.log('\n1. WINDOW RESOLUTION (reference: Tue 2026-08-04, so yesterday = 2026-08-03)')
for (const m of sch.WINDOW_MODES) {
  const w = sch.resolveWindow(m.value, base, NOW)
  console.log(`   ${m.value.padEnd(12)} ${String(w.from).padEnd(12)} → ${w.to}   (${m.label})`)
}

// ── due detection ──
console.log('\n2. DUE DETECTION (Rome hour at reference =', sch.zonedNow(NOW).hour + ', dow=' + sch.zonedNow(NOW).dayOfWeek + ')')
const mk = (o: Record<string, unknown>) => ({ frequency: 'daily', hourLocal: 11, dayOfWeek: null, dayOfMonth: null, lastSentAt: null, ...o }) as never
console.log('   daily @11 never sent          ->', sch.isDue(mk({}), NOW))
console.log('   daily @11 sent earlier today  ->', sch.isDue(mk({ lastSentAt: new Date('2026-08-04T06:00:00Z') }), NOW))
console.log('   daily @11 sent yesterday      ->', sch.isDue(mk({ lastSentAt: new Date('2026-08-03T09:00:00Z') }), NOW))
console.log('   daily @09 (wrong hour)        ->', sch.isDue(mk({ hourLocal: 9 }), NOW))
console.log('   weekly @11 on Tue, wants Mon  ->', sch.isDue(mk({ frequency: 'weekly', dayOfWeek: 1 }), NOW))
console.log('   weekly @11 on Tue, wants Tue  ->', sch.isDue(mk({ frequency: 'weekly', dayOfWeek: 2 }), NOW))

// ── end-to-end delivery (dry run) ──
console.log('\n3. END-TO-END DELIVERY')
const sr = await saved.createSavedReport({ name: 'RPT6 harness', query: { reportId: 'search-term', groupBy: ['query'], sort: { col: 'cost', dir: 'desc' } } as never })
const s = await crud.createSchedule({ savedReportId: sr.id, recipients: 'ops@example.com', format: 'xlsx', windowMode: 'last30', frequency: 'weekly', hourLocal: 8, dayOfWeek: 1 })
const run = await sch.runSchedule(s.id)
console.log('   status      :', run.status)
console.log('   window      :', run.windowFrom, '→', run.windowTo)
console.log('   rows        :', run.rows.toLocaleString('en-GB'))
console.log('   file        :', run.fileName, `(${(run.fileBytes ?? 0).toLocaleString('en-GB')} bytes)`)
console.log('   staleNote   :', run.staleNote ?? '(none)')
console.log('   duration    :', run.durationMs + 'ms')
const log = await crud.listDeliveries(s.id)
console.log('   delivery log:', log.length, 'entry ·', JSON.stringify(log[0]?.freshness))

// ── validation guards ──
console.log('\n4. VALIDATION GUARDS')
for (const [label, bad] of [
  ['bad email', { savedReportId: sr.id, recipients: 'not-an-email', frequency: 'daily' }],
  ['no recipients', { savedReportId: sr.id, recipients: '  ', frequency: 'daily' }],
  ['bad frequency', { savedReportId: sr.id, recipients: 'a@b.co', frequency: 'hourly' }],
  ['dayOfMonth 31', { savedReportId: sr.id, recipients: 'a@b.co', frequency: 'monthly', dayOfMonth: 31 }],
  ['hour 25', { savedReportId: sr.id, recipients: 'a@b.co', frequency: 'daily', hourLocal: 25 }],
] as const) {
  try { await crud.createSchedule(bad as never); console.log(`   ${label.padEnd(15)} -> ACCEPTED (!)`) }
  catch (e) { console.log(`   ${label.padEnd(15)} -> ${(e as Error).message}`) }
}

await crud.deleteSchedule(s.id)
const { PrismaClient } = await import('@prisma/client')
await new PrismaClient().savedReport.deleteMany({ where: { name: 'RPT6 harness' } })
console.log('\n   harness data removed')
process.exit(0)
