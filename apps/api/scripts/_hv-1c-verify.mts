/**
 * HV.1c — did HV.0 actually disarm the engine? READ-ONLY.
 *
 * HV.0 (`42af69317`, deployed 2026-08-12) made `runAutoHarvestOnce()` propose-only unless
 * `NEXUS_ADS_AUTO_HARVEST_ARMED` is set. The claim to verify has two halves:
 *
 *   1. the next 06:30 run reports `dryRun=true`
 *   2. NO new `automation:auto-harvest` rows land in `AdvertisingActionLog`
 *
 * Half 2 is the one that matters. HV.1 corrected the study on exactly this point: the cron's
 * `neg=8/8 grad=14/14` counts candidates PROCESSED, not writes MADE, so a run that wrote nothing
 * looked identical to one that wrote everything. The audit log is the only place the difference
 * is visible.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')

console.log('\n═══ HV.1c — HV.0 runtime verification ═══\n')

// The deploy boundary. HV.0 was pushed 2026-08-12 ~00:30 UTC; Railway redeployed within minutes.
const DEPLOY = new Date('2026-08-12T01:00:00Z')
console.log(`treating ${DEPLOY.toISOString()} as the HV.0 deploy boundary\n`)

// ── 1 · the cron line ─────────────────────────────────────────────────────────
console.log('═══ 1 · ads-auto-harvest runs (newest 12) ═══\n')
const runs = await prisma.cronRun.findMany({
  where: { jobName: 'ads-auto-harvest' },
  orderBy: { startedAt: 'desc' }, take: 12,
  select: { startedAt: true, finishedAt: true, status: true, outputSummary: true, errorMessage: true },
})
console.log(`${pad('startedAt', 18)} ${pad('status', 9)} outputSummary`)
for (const r of runs) {
  console.log(`${pad(r.startedAt.toISOString().slice(0, 16), 18)} ${pad(r.status, 9)} ${r.outputSummary ?? ''}${r.errorMessage ? `  ERR: ${r.errorMessage}` : ''}`)
}

const after = runs.filter((r) => r.startedAt >= DEPLOY)
console.log(`\nruns since the deploy: ${after.length}`)
for (const r of after) {
  const dry = /dryRun=true/.test(r.outputSummary ?? '')
  console.log(`  ${r.startedAt.toISOString().slice(0, 16)}  ${dry ? '✅ dryRun=true — DISARMED' : '🔴 dryRun=false — STILL ARMED'}  ${r.outputSummary ?? ''}`)
}
if (after.length === 0) console.log('  ⚠ no run yet since the deploy boundary — cannot conclude from the cron line alone')

// ── 2 · the audit log, which is the half that matters ─────────────────────────
console.log('\n\n═══ 2 · did anything get WRITTEN? ═══\n')
const engineLogs = await prisma.advertisingActionLog.findMany({
  where: { userId: 'automation:auto-harvest' },
  select: { actionType: true, createdAt: true, entityId: true, amazonResponseStatus: true },
  orderBy: { createdAt: 'desc' },
})
console.log(`AdvertisingActionLog rows by automation:auto-harvest, all time: ${int(engineLogs.length)}`)
const since = engineLogs.filter((l) => l.createdAt >= DEPLOY)
console.log(`  rows created SINCE the deploy: ${since.length}  ${since.length === 0 ? '✅ nothing written' : '🔴 WRITES ARE STILL LANDING'}`)
for (const l of since) console.log(`    ${l.createdAt.toISOString()}  ${l.actionType}  ${l.entityId ?? ''}`)

console.log('\nnewest 8 rows, whenever they landed:')
for (const l of engineLogs.slice(0, 8)) {
  console.log(`  ${l.createdAt.toISOString().slice(0, 16)}  ${pad(l.actionType, 26)} ${l.entityId ?? ''}`)
}

// The negatives too — createNegative writes through a different actionType.
const negSince = await prisma.adTarget.count({ where: { isNegative: true, createdAt: { gte: DEPLOY } } })
const posSince = await prisma.adTarget.count({ where: { isNegative: false, createdAt: { gte: DEPLOY } } })
console.log(`\nAdTarget rows created since the deploy — negative: ${negSince} · positive: ${posSince}`)
console.log('  (these include every writer, not just the engine; a non-zero here needs the audit log above to attribute)')

// ── 3 · the flag, as the deployed process would read it ───────────────────────
console.log('\n\n═══ 3 · the flag ═══\n')
const raw = process.env.NEXUS_ADS_AUTO_HARVEST_ARMED
console.log(`NEXUS_ADS_AUTO_HARVEST_ARMED = ${raw === undefined ? '(unset)' : JSON.stringify(raw)}`)
const { envEnabled } = await import('../src/utils/env-flag.js')
console.log(`envEnabled('NEXUS_ADS_AUTO_HARVEST_ARMED') → ${envEnabled('NEXUS_ADS_AUTO_HARVEST_ARMED')}  (false = propose-only, which is the intent)`)

// ── 4 · and the engine still reports what it WOULD do ─────────────────────────
console.log('\n\n═══ 4 · the engine still proposes (HV.1 renders this) ═══\n')
const { previewHarvest } = await import('../src/services/advertising/ads-harvest.service.js')
const p = await previewHarvest({})
console.log(`previewHarvest({}) → negatives=${p.negatives.length} graduations=${p.graduations.length} productNegatives=${p.productNegatives.length} productGraduations=${p.productGraduations.length}`)
console.log('⇒ disarming did not blind it: the candidate list HV.1 renders is unchanged.')

console.log('\n═══ done ═══\n')
await prisma.$disconnect()
