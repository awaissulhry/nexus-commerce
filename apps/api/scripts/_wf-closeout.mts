/**
 * WF.3 — close out the ads dead letters the DL.1 routing bug produced.
 *
 * ONLY the AD_BID_UPDATE rows whose error is entityNotFound: those carry bid intents from days ago
 * that the engine has since re-derived and landed successfully, so replaying them would push stale
 * values at Amazon. Marked CANCELLED with an accurate reason; ZERO Amazon calls are made.
 *
 * Deliberately does NOT touch the 2,547 PRICE_UPDATE / QUANTITY_UPDATE failures — those are a
 * different subsystem with a different cause, and burying them under an ads label would erase them.
 *
 * Pass --apply to write; default is a dry run.
 */
const { default: prisma } = await import('../src/db.js')
const APPLY = process.argv.includes('--apply')
const REASON = 'superseded — DL.1 routing bug (product/auto bids sent to /sp/keywords); routing fixed 2026-08-03 and live bids have since converged'

const where = {
  syncStatus: 'FAILED' as const,
  syncType: 'AD_BID_UPDATE',
  errorMessage: { contains: 'entityNotFound' },
}
const n = await prisma.outboundSyncQueue.count({ where })
const newest = await prisma.outboundSyncQueue.findFirst({ where, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } })
console.log(`matching rows: ${n}`)
console.log(`newest: ${newest?.updatedAt.toISOString()}  (the DL.1 fix deployed 2026-08-03T01:00Z)`)
if (newest && newest.updatedAt >= new Date('2026-08-03T01:00:00Z')) {
  console.error('REFUSING: a matching row is NEWER than the routing fix — that would mean the bug is live again, not history.')
  process.exit(1)
}
if (!APPLY) { console.log('\nDRY RUN — pass --apply to close them out.'); await prisma.$disconnect(); process.exit(0) }
const r = await prisma.outboundSyncQueue.updateMany({ where, data: { syncStatus: 'CANCELLED', errorCode: 'SUPERSEDED_DL1', errorMessage: REASON, isDead: false } })
console.log(`closed out: ${r.count}`)
const left = await prisma.outboundSyncQueue.groupBy({ by: ['syncType'], where: { syncStatus: 'FAILED' }, _count: { _all: true } })
console.log('remaining FAILED rows by type:')
for (const x of left) console.log(`  ${x.syncType}: ${x._count._all}`)
await prisma.$disconnect()
