/**
 * 🔴 ACR.0.2-bis — why does a COMPLETED report poll forever? READ-ONLY.
 *
 * The live ToS-IS run logs `[ADS-LIVE] report pending { attempt: 52, status: "COMPLETED" }`.
 * The poll loop's success branch is:
 *
 *     if (status.status === 'COMPLETED' && status.location) { …download… }
 *
 * Status IS 'COMPLETED', so the only way to fall through is `status.location` being absent —
 * i.e. Amazon returns the download URL under a DIFFERENT KEY. That would mean the report was
 * never slow at all, and ACR.0.2's fix (raise the ceiling 10 → 45 minutes) cannot work: it
 * only changes how long we wait before giving up on a report that finished in seconds.
 *
 * This dumps the raw status response for a report id so the real key is a fact, not a guess.
 *
 * Usage: npx tsx scripts/_acr23-report-status.mts <reportId> [profileId]
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { liveCall } = await import('../src/services/advertising/ads-api-client.js')

const reportId = process.argv[2]
if (!reportId) { console.error('usage: _acr23-report-status.mts <reportId> [profileId]'); process.exit(1) }

let profileId = process.argv[3]
let region = 'eu'
if (!profileId) {
  const conn = await prisma.amazonAdsConnection.findFirst({
    where: { isActive: true, marketplace: 'IT' },
    select: { profileId: true, region: true },
  })
  if (!conn) { console.error('no active IT connection'); process.exit(1) }
  profileId = conn.profileId
  region = conn.region
}
console.log(`\nreport ${reportId} · profile ${profileId} · region ${region}\n`)

const status = await liveCall<Record<string, unknown>>({
  profileId, region: region as 'eu',
  method: 'GET',
  path: `/reporting/reports/${reportId}`,
  skipCallLog: true,
})

console.log('RAW STATUS RESPONSE KEYS:')
for (const [k, v] of Object.entries(status)) {
  const s = typeof v === 'string' ? (v.length > 110 ? `${v.slice(0, 110)}…(${v.length} chars)` : v) : JSON.stringify(v)
  console.log(`  ${k.padEnd(22)} = ${s}`)
}

console.log('\nWHAT THE CLIENT LOOKS FOR:')
console.log(`  status.status   = ${JSON.stringify(status.status)}   ${status.status === 'COMPLETED' ? '✓ terminal' : ''}`)
console.log(`  status.location = ${JSON.stringify(status.location)}   ${status.location ? '✓ present' : '🔴 ABSENT — this is why it loops'}`)

const urlish = Object.keys(status).filter((k) => /url|location|download|href|document/i.test(k))
console.log(`\n  URL-ish keys actually present: ${urlish.length ? urlish.join(', ') : '(none)'}`)
for (const k of urlish) {
  const v = status[k]
  console.log(`    ${k}: ${typeof v === 'string' ? `${v.slice(0, 80)}…` : JSON.stringify(v)}`)
}

await prisma.$disconnect()
