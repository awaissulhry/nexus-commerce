/** ACR.1.5 — run the real Foresight service against prod. READ-ONLY. */
import '../src/env.js'
const { getForesight } = await import('../src/services/advertising/ads-foresight.service.js')
const f = await getForesight()
console.log(`\nGenerated ${f.generatedAt}  ·  tz ${f.timezone}`)
console.log(`Schedules: ${f.schedulesConsidered.enabled} enabled of ${f.schedulesConsidered.total}`)
console.log(`Scheduled bid changes in 24h: ${f.scheduledBidChanges ?? '— (account stopped)'}`)
console.log(`\nNOTES:`)
for (const n of f.notes) console.log(`  · ${n}`)
console.log(`\nENGINES:`)
for (const e of f.engines) {
  console.log(`  ${e.name.padEnd(22)} ${e.cadence.padEnd(20)} ${String(e.fires).padStart(4)} fires  ${e.canWrite ? 'CAN WRITE' : `blocked: ${e.blockedReason}`}`)
  if (e.nextFires.length) console.log(`      next: ${e.nextFires.slice(0, 3).join(', ')}`)
}
console.log(`\nTIMELINE (local hour · bid changes · suppressed · unbounded · engine ticks · governing targets):`)
for (const h of f.hours) {
  const t = h.targets.map((x) => `${x.name}×${x.schedules}`).join(', ')
  const ticks = h.engineRuns.reduce((a, r) => a + r.fires, 0)
  console.log(
    `  ${String(h.hour).padStart(2, '0')}:00  chg=${String(h.bidChanges).padStart(3)}  sup=${String(h.suppressed).padStart(2)}  unb=${String(h.unbounded).padStart(2)}  noCap=${String(h.noCpcCeiling).padStart(2)}  ticks=${String(ticks).padStart(3)}  ${t.slice(0, 60)}`,
  )
}
const { default: prisma } = await import('../src/db.js')
await prisma.$disconnect()
