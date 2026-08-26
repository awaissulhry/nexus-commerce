/**
 * NEG.3b — STAGE 2, the approved pause probe. **This one reaches Amazon.**
 *
 * It proves the NEG.3 endpoint routing end to end on the real path:
 *   updateAdTargetWithSync → OutboundSyncQueue → the worker's dispatch → PUT /sp/negativeKeywords
 *
 * Not a direct API call: the point is to prove the PATH, not the endpoint in isolation. Before the
 * NEG.3 fix this same write went to /sp/keywords, Amazon answered `entityNotFoundError` at
 * `$.keywords[0].keywordId`, and the row would have been orphaned permanently.
 *
 * 🔴 A 200 from a correctly-shaped call is NOT proof. The proof is Amazon reflecting the state
 * back. This reads it back from `/sp/negativeKeywords/list` — Amazon's own truth for that keyword
 * id — rather than trusting our own response parsing.
 *
 * Subject safety (all re-verified by `_neg3b-subject.mts`, and again here before writing):
 *   · the campaign is ALREADY on the live-write allowlist — no configuration change, nothing to
 *     revert, nothing to forget
 *   · the term is dead: 0 impressions and 0 orders in 120 days
 *   · 16 negations of the term exist, so pausing one leaves 15 blocking it
 *   · pause is reversible; nothing is archived in this session
 *
 * ABORT WITHOUT RETRYING if: the row orphans · the write is refused · Amazon does not mirror the
 * state · the term takes an impression during the probe. A retry on a failed structural write is
 * how you end up with two of them.
 *
 * `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_neg3b-probe.mts [--commit]`
 */
import '../src/env.js'
const { updateAdTargetWithSync } = await import('../src/services/advertising/ads-mutation.service.js')
const { drainAdsSyncOnce } = await import('../src/workers/ads-sync.worker.js')
const { listNegativeKeywords } = await import('../src/services/advertising/ads-api-client.js')
const { normaliseNegTerm } = await import('../src/services/advertising/negatives.service.js')
const { default: prisma } = await import('../src/db.js')

const COMMIT = process.argv.includes('--commit')
const SUBJECT_ID = 'cms9b5rqq066ao501kswaksd8'
const TERM = 'kolchoz carrere'
const int = (n: number) => n.toLocaleString('en-IE')
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)
let failures = 0
const check = (l: string, ok: boolean, d = '') => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗ FAIL'}  ${l}${d ? ` — ${d}` : ''}`) }
const eq = (l: string, g: unknown, w: unknown) => check(l, g === w, `got ${String(g)}, want ${String(w)}`)
const abort = async (why: string) => {
  console.log(`\n🔴 ABORTING — ${why}\n   Not retrying. Report and stop.\n`)
  await prisma.$disconnect(); process.exit(2)
}

console.log(`\n═══ NEG.3b — pause probe ${COMMIT ? '· WRITING TO AMAZON' : '· DRY REPORT'} ═══\n`)

// ── 1 · snapshot ──────────────────────────────────────────────────────────────────────────────
h('1 · Snapshot')
const row = await prisma.adTarget.findUnique({
  where: { id: SUBJECT_ID },
  select: {
    id: true, expressionValue: true, expressionType: true, status: true, externalTargetId: true,
    negativeLevel: true, orphanedAt: true, retiredAt: true, lastSyncStatus: true, lastSyncedAt: true,
    adGroup: { select: { name: true, externalAdGroupId: true, campaign: { select: { id: true, name: true, status: true, marketplace: true, externalCampaignId: true, liveBidWritesEnabled: true } } } },
  },
})
if (!row) await abort('the subject row no longer exists')
console.log(`  id=${row!.id} ext=${row!.externalTargetId}`)
console.log(`  「${row!.expressionValue}」 ${row!.expressionType} ${row!.negativeLevel} · status=${row!.status}`)
console.log(`  ad group "${row!.adGroup?.name}" · campaign "${row!.adGroup?.campaign?.name}" (${row!.adGroup?.campaign?.status}, allowlisted=${row!.adGroup?.campaign?.liveBidWritesEnabled})`)
console.log(`  lastSyncStatus=${row!.lastSyncStatus} lastSyncedAt=${row!.lastSyncedAt?.toISOString()}`)

const since120 = new Date(Date.now() - 120 * 86400_000)
const tr = await prisma.amazonAdsSearchTerm.aggregate({ where: { date: { gte: since120 }, query: TERM }, _sum: { impressions: true, clicks: true, orders7d: true } })
console.log(`  120d traffic for 「${TERM}」: impr=${tr._sum.impressions ?? 0} clicks=${tr._sum.clicks ?? 0} orders=${tr._sum.orders7d ?? 0}`)
const negCount = await prisma.adTarget.count({ where: { isNegative: true, expressionValue: { equals: row!.expressionValue } } })
console.log(`  negations of this term: ${int(negCount)} — pausing one leaves ${int(negCount - 1)}`)

// re-verify every safety criterion at the moment of writing, not at the moment of planning
check('campaign is allowlisted', row!.adGroup?.campaign?.liveBidWritesEnabled === true)
check('🔴 the term is still dead over 120 days', (tr._sum.impressions ?? 0) === 0 && (tr._sum.orders7d ?? 0) === 0)
check('more than one negation exists', negCount > 1)
check('the row is ENABLED', String(row!.status) === 'ENABLED')
check('the row is confirmed at Amazon', row!.externalTargetId != null)
check('the row is not orphaned', row!.orphanedAt == null)
const orphansBefore = await prisma.adTarget.count({ where: { orphanedAt: { not: null } } })
eq('🔴 orphanedAt is 0 account-wide BEFORE', orphansBefore, 0)
if (failures > 0) await abort('a safety criterion no longer holds')

// ── Amazon's state, before ────────────────────────────────────────────────────────────────────
h('2 · Amazon\'s own state, before')
const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace: row!.adGroup!.campaign!.marketplace!, isActive: true }, select: { profileId: true } })
if (!conn?.profileId) await abort('no active Amazon Ads connection for this marketplace')
const ctx = { profileId: conn!.profileId, region: 'EU' as const }
const readBack = async () => {
  const list = await listNegativeKeywords(ctx, { campaignIds: [row!.adGroup!.campaign!.externalCampaignId!] })
  return list.find((k) => String(k.keywordId ?? k.negativeKeywordId) === String(row!.externalTargetId))
}
const before = await readBack()
console.log(`  Amazon says: ${before ? JSON.stringify(before) : 'NOT FOUND in this campaign\'s negative keywords'}`)
if (!before) await abort('Amazon does not return this negative keyword — the id or the campaign is wrong, and pausing would be a blind write')
eq('Amazon holds it as ENABLED', String(before!.state).toUpperCase(), 'ENABLED')

if (!COMMIT) { console.log('\n  DRY REPORT — nothing written. Re-run with --commit.\n'); await prisma.$disconnect(); process.exit(failures === 0 ? 0 : 1) }

// ── 3 · pause, through the real path ──────────────────────────────────────────────────────────
h('3 · PAUSE — through updateAdTargetWithSync → queue → worker → /sp/negativeKeywords')
const pause = await updateAdTargetWithSync({
  adTargetId: SUBJECT_ID,
  patch: { status: 'PAUSED' },
  actor: 'user:neg3b-probe' as never,
  reason: 'NEG.3b — reversible probe of the negative-keyword endpoint routing',
  applyImmediately: true,
})
console.log(`  accepted locally: ok=${pause.ok} queueId=${pause.outboundQueueId} error=${pause.error ?? '—'}`)
if (!pause.ok || !pause.outboundQueueId) await abort(`the write was not accepted: ${pause.error}`)

const drain1 = await drainAdsSyncOnce(50)
console.log(`  drain: processed=${drain1.processed}`)
const q1 = await prisma.outboundSyncQueue.findUnique({ where: { id: pause.outboundQueueId! }, select: { syncStatus: true, errorMessage: true, errorCode: true, syncedAt: true } })
console.log(`  outbound row: ${q1?.syncStatus} · code=${q1?.errorCode ?? '—'} · err=${q1?.errorMessage ?? '—'}`)
if (String(q1?.syncStatus) === 'SKIPPED') await abort(`the write gate refused: ${q1?.errorMessage}`)
eq('🔴 the outbound write SUCCEEDED', String(q1?.syncStatus), 'SUCCESS')
const afterPauseRow = await prisma.adTarget.findUnique({ where: { id: SUBJECT_ID }, select: { status: true, orphanedAt: true, orphanReason: true, lastSyncStatus: true, lastSyncError: true } })
console.log(`  row: status=${afterPauseRow?.status} lastSyncStatus=${afterPauseRow?.lastSyncStatus} orphanedAt=${String(afterPauseRow?.orphanedAt)} err=${afterPauseRow?.lastSyncError ?? '—'}`)
if (afterPauseRow?.orphanedAt) await abort(`the row ORPHANED: ${afterPauseRow.orphanReason}`)
eq('🔴 orphanedAt is still NULL — the trap did not fire', afterPauseRow?.orphanedAt, null)
check('no keyword-shaped not-found was recorded', !/keywords\[0\]|entitynotfound/i.test(String(afterPauseRow?.lastSyncError ?? '')), String(afterPauseRow?.lastSyncError))

// ── 4 · 🔴 the actual proof: Amazon reflects it ───────────────────────────────────────────────
h('4 · 🔴 THE PROOF — read the state back from Amazon')
const mirrored = await readBack()
console.log(`  Amazon says: ${mirrored ? JSON.stringify(mirrored) : 'NOT FOUND'}`)
if (!mirrored) await abort('Amazon no longer returns the keyword after the write')
eq('🔴 Amazon now holds it as PAUSED — the write reached the right endpoint and the right entity', String(mirrored!.state).toUpperCase(), 'PAUSED')

// ── 5 · unpause ───────────────────────────────────────────────────────────────────────────────
h('5 · UNPAUSE — back to exactly where it started')
const restore = await updateAdTargetWithSync({
  adTargetId: SUBJECT_ID,
  patch: { status: 'ENABLED' },
  actor: 'user:neg3b-probe' as never,
  reason: 'NEG.3b — restoring after the reversible probe',
  applyImmediately: true,
})
console.log(`  accepted locally: ok=${restore.ok} queueId=${restore.outboundQueueId} error=${restore.error ?? '—'}`)
if (!restore.outboundQueueId) await abort('the restore was not enqueued — the subject is left PAUSED and needs manual attention')
await drainAdsSyncOnce(50)
const q2 = await prisma.outboundSyncQueue.findUnique({ where: { id: restore.outboundQueueId! }, select: { syncStatus: true, errorMessage: true } })
console.log(`  outbound row: ${q2?.syncStatus} · err=${q2?.errorMessage ?? '—'}`)
eq('the restore reached Amazon', String(q2?.syncStatus), 'SUCCESS')
const restoredAtAmazon = await readBack()
console.log(`  Amazon says: ${restoredAtAmazon ? JSON.stringify(restoredAtAmazon) : 'NOT FOUND'}`)
eq('🔴 Amazon holds it as ENABLED again — the probe left nothing behind', String(restoredAtAmazon?.state).toUpperCase(), 'ENABLED')

// ── 6 · the invariant ─────────────────────────────────────────────────────────────────────────
h('6 · The invariant, after')
const finalRow = await prisma.adTarget.findUnique({ where: { id: SUBJECT_ID }, select: { status: true, orphanedAt: true, retiredAt: true } })
eq('the local row is ENABLED', String(finalRow?.status), 'ENABLED')
eq('it was never retired', finalRow?.retiredAt, null)
eq('🔴 orphanedAt is 0 across ALL targets', await prisma.adTarget.count({ where: { orphanedAt: { not: null } } }), 0)
eq('and 0 across all negatives', await prisma.adTarget.count({ where: { isNegative: true, orphanedAt: { not: null } } }), 0)
eq('the negation count is unchanged', await prisma.adTarget.count({ where: { isNegative: true } }), 2058)

console.log(`\n${failures === 0 ? '✅ THE ROUTING IS PROVEN AGAINST AMAZON — and nothing was archived' : `❌ ${failures} failed`}\n`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
