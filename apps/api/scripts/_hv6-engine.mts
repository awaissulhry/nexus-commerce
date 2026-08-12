/** HV.6 — what the engine registry says about the harvest engine vs what HV.0 made true. READ-ONLY. */
import '../src/env.js'
const { getEngineLevers } = await import('../src/services/advertising/ads-control-room.service.js')
const { getAutomationState } = await import('../src/services/advertising/ads-automation-state.service.js')
const { envEnabled } = await import('../src/utils/env-flag.js')
const { default: prisma } = await import('../src/db.js')

console.log('\n═══ the account dial ═══')
const st = await getAutomationState()
console.log(JSON.stringify(st, null, 2).slice(0, 700))

console.log('\n═══ NEXUS_ADS_AUTO_HARVEST_ARMED, as this process reads it ═══')
console.log(`  raw=${JSON.stringify(process.env.NEXUS_ADS_AUTO_HARVEST_ARMED)}  envEnabled=${envEnabled('NEXUS_ADS_AUTO_HARVEST_ARMED')}`)

console.log('\n═══ the engine registry — what the Control Room renders ═══')
const { levers, global } = await getEngineLevers()
for (const l of levers as any[]) {
  const mark = l.id === 'auto-harvest' ? ' ⬅' : ''
  console.log(`  ${String(l.id).padEnd(20)} "${String(l.name).padEnd(26)}" level=${String(l.level).padEnd(8)} gate=${String(l.writeGate ?? l.gate ?? '-').padEnd(8)} why="${String(l.why ?? '').slice(0, 74)}"${mark}`)
}
console.log(`\n  global: ${JSON.stringify(global).slice(0, 300)}`)

console.log('\n═══ what the engine ACTUALLY did on its last 10 nightly runs ═══')
const runs = await prisma.cronRun.findMany({ where: { jobName: 'ads-auto-harvest' }, orderBy: { startedAt: 'desc' }, take: 10,
  select: { startedAt: true, status: true, outputSummary: true, errorMessage: true } })
for (const r of runs) console.log(`  ${r.startedAt.toISOString().slice(0,16)} ${String(r.status).padEnd(8)} ${String(r.outputSummary ?? r.errorMessage ?? '').slice(0, 96)}`)
await prisma.$disconnect()
