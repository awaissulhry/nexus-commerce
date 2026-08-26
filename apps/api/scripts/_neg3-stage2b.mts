/**
 * NEG.3 — STAGE 2, completed. Restores the subject and proves the routing in one pass.
 *
 * What happened on the first attempt, recorded because it is the interesting part:
 *
 *   · `enqueueBullMQJob` failed — `redis.railway.internal` does not resolve from a workstation,
 *     even under `railway run`, because it is a Railway-private host. The OutboundSyncQueue row
 *     was still created (the enqueue is best-effort and the row is the source of truth), and the
 *     LOCAL `AdTarget.status` was already PAUSED, because `updateAdTargetWithSync` writes locally
 *     first and pushes second.
 *   · My own script then crashed on two wrong column names (`lastError`/`attemptCount`; they are
 *     `errorMessage`/`retryCount`) BEFORE the unpause ran, leaving the row locally PAUSED with a
 *     PENDING queue row and Amazon still holding ENABLED.
 *
 * That state is safe but half-applied, and leaving it would be worse than either end of it. This
 * script closes it deliberately:
 *
 *   1. enqueue the UNPAUSE, so the queue holds pause→unpause in that order;
 *   2. run `drainAdsSyncOnce` HERE rather than waiting for the Railway worker. The drain selects
 *      PENDING rows `orderBy: createdAt asc`, so FIFO is guaranteed and both land in order;
 *   3. assert the round trip on each: the pause SUCCEEDED (which is the routing proof — the id
 *      only exists under /sp/negativeKeywords, so /sp/keywords would have had to answer "not
 *      found"), and the unpause returned the row to ENABLED.
 *
 * Net effect at Amazon: nothing. Net evidence: the endpoint is right.
 */
import '../src/env.js'
const { updateAdTargetWithSync } = await import('../src/services/advertising/ads-mutation.service.js')
const { drainAdsSyncOnce } = await import('../src/workers/ads-sync.worker.js')
const { default: prisma } = await import('../src/db.js')

const SUBJECT = 'cmpee8xnu0aj9oj0138qyrfxv'
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)
let failures = 0
const check = (l: string, ok: boolean, d = '') => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗ FAIL'}  ${l}${d ? ` — ${d}` : ''}`) }
const eq = (l: string, g: unknown, w: unknown) => check(l, g === w, `got ${String(g)}, want ${String(w)}`)
const showRow = async (label: string) => {
  const r = await prisma.adTarget.findUnique({ where: { id: SUBJECT }, select: { status: true, orphanedAt: true, orphanReason: true, lastSyncStatus: true, lastSyncError: true } })
  console.log(`  ${label}: status=${r?.status} lastSyncStatus=${r?.lastSyncStatus} orphanedAt=${String(r?.orphanedAt)} err=${r?.lastSyncError ?? '—'}`)
  return r
}
const q = (id: string) => prisma.outboundSyncQueue.findUnique({ where: { id }, select: { syncStatus: true, errorMessage: true, retryCount: true, syncedAt: true, isDead: true } })

console.log('\n═══ NEG.3 — stage 2, completed ═══\n')

h('1 · Where the half-applied attempt left it')
await showRow('before')
const pending = await prisma.outboundSyncQueue.findMany({
  where: { syncType: 'AD_ENTITY_STATE_UPDATE', syncStatus: 'PENDING' },
  select: { id: true, createdAt: true, payload: true }, orderBy: { createdAt: 'asc' },
})
const mine = pending.filter((p) => (p.payload as { entityId?: string })?.entityId === SUBJECT)
console.log(`  PENDING state-update rows for this subject: ${mine.length}`)
for (const m of mine) console.log(`    ${m.id} ${m.createdAt.toISOString()} → ${JSON.stringify((m.payload as { fieldChanges?: unknown }).fieldChanges)}`)

h('2 · Enqueue the UNPAUSE so the queue reads pause → unpause')
const restore = await updateAdTargetWithSync({
  adTargetId: SUBJECT,
  patch: { status: 'ENABLED' },
  actor: 'user:neg3-stage2' as never,
  reason: 'NEG.3 stage 2 — restoring after the reversible routing probe',
  applyImmediately: true,
})
console.log(`  ok=${restore.ok} queueId=${restore.outboundQueueId} error=${restore.error ?? '—'}`)
check('the restore was accepted locally', restore.ok === true, String(restore.error))
await showRow('local, after enqueueing the restore')

h('3 · Drain — FIFO by createdAt, so the pause lands first and the restore second')
const drain = await drainAdsSyncOnce(50)
console.log(`  processed=${drain.processed} reclaimed=${drain.reclaimed} deadLettered=${drain.deadLettered}`)
for (const r of drain.results) console.log(`    ${r.queueId} → ${r.status}`)

h('4 · The round trip, asserted')
// 🔴 This loop reported "✅ passed" over an EMPTY list on its first run — the classic false zero.
// An empty subject set is now a failure, not a silent success.
check('there is something to assert about', mine.length > 0, `${mine.length} pending rows for the subject`)
for (const m of mine) {
  const row = await q(m.id)
  console.log(`  pause row ${m.id}: ${row?.syncStatus} err=${row?.errorMessage ?? '—'} dead=${row?.isDead}`)
  eq('🔴 the PAUSE reached Amazon — proof the id lives under /sp/negativeKeywords', String(row?.syncStatus), 'COMPLETED')
  // Before NEG.3 this would have been a keyword-shaped entityNotFoundError and an orphan mark.
  check('no keyword-shaped not-found was recorded', !/keywords\[0\]|entitynotfound/i.test(String(row?.errorMessage ?? '')), String(row?.errorMessage))
}
if (restore.outboundQueueId) {
  const row = await q(restore.outboundQueueId)
  console.log(`  restore row ${restore.outboundQueueId}: ${row?.syncStatus} err=${row?.errorMessage ?? '—'}`)
  eq('the RESTORE also reached Amazon', String(row?.syncStatus), 'COMPLETED')
}

h('5 · The subject is exactly where it started')
const final = await showRow('final')
eq('🔴 back to ENABLED — stage 2 changed nothing permanently', String(final?.status), 'ENABLED')
eq('🔴 orphanedAt is NULL — the trap did not fire', final?.orphanedAt, null)
eq('orphanedAt is 0 across ALL negatives', await prisma.adTarget.count({ where: { isNegative: true, orphanedAt: { not: null } } }), 0)
eq('and 0 across every target in the account', await prisma.adTarget.count({ where: { orphanedAt: { not: null } } }), 0)

console.log(`\n${failures === 0 ? '✅ stage 2 passed — the negative endpoint routing is proven, and nothing was archived' : `❌ ${failures} failed`}\n`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
