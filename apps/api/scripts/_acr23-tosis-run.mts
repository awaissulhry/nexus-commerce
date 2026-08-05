/**
 * ACR.2.3 — run the FIXED tos-is ingest (pollMinutes 45) against prod, IT only.
 *
 * The nightly cron has logged `errors=9` for twelve consecutive nights at ~622s — the old
 * 10-minute poll ceiling. The fix is committed but its first scheduled run is tomorrow, so
 * this exercises the fixed path now, on one profile, to find out whether Amazon actually
 * returns `topOfSearchImpressionShare` for this account at all.
 *
 * Only writes: UPDATE topOfSearchIS on existing Top-of-Search rows (a column that is
 * currently NULL on all 3,552 rows in every market). Creates nothing, deletes nothing.
 */
import '../src/env.js'
await import('../src/db.js')
const { ingestTopOfSearchIS } = await import('../src/services/advertising/ads-tos-is-ingest.service.js')

const t0 = Date.now()
console.log('[tos-is] starting IT-only ingest, windowDays=30, pollMinutes=45 …')
const r = await ingestTopOfSearchIS({ windowDays: 30, marketplace: 'IT' })
console.log(`[tos-is] finished in ${Math.round((Date.now() - t0) / 1000)}s`)
console.log(JSON.stringify(r, null, 2))
const { default: prisma } = await import('../src/db.js')
const after = await prisma.amazonAdsPlacementReport.count({ where: { topOfSearchIS: { not: null } } })
console.log(`[tos-is] rows now carrying a ToS-IS: ${after}`)
await prisma.$disconnect()
