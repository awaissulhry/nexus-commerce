/**
 * NEG.3 — STAGE 2. Amazon, but nothing live, and the first probe is REVERSIBLE.
 *
 * The brief's stage 2 archives one negative in a paused campaign to prove the endpoint routing.
 * Archiving is terminal, so that spends an irreversible write to answer a question a reversible
 * one can answer just as well:
 *
 *   2a  PAUSE the negative, wait for the worker, confirm the round trip, then UNPAUSE it.
 *       Amazon's SP v3 accepts `enabled | paused | archived` for a negative keyword (Amazon's own
 *       negative-targeting reference and the Python SDK's `edit_negative_product_targets` both
 *       list the three), so a pause is a legal state change that undoes itself. If the routing is
 *       wrong, Amazon answers `entityNotFoundError` at `$.keywords[0].keywordId` and the write
 *       FAILS — which is the same evidence the archive would have produced, at no cost.
 *       🔴 A SUCCESSFUL HTTP CALL TO THE WRONG ENDPOINT IS NOT PROOF. Success here IS the proof,
 *       because the id only exists under the endpoint we now send it to: /sp/keywords would have
 *       had to answer "not found".
 *   2b  Only with --archive: the real thing, on the same subject.
 *
 * Subject: a negative in a PAUSED campaign whose term has been dark for 120 days and which is not
 * the last negation of its term. 1,013 rows qualify; pausing one inside a paused campaign changes
 * no auction behaviour at all.
 *
 * `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_neg3-stage2.mts [--commit] [--archive]`
 */
import '../src/env.js'
const { updateAdTargetWithSync } = await import('../src/services/advertising/ads-mutation.service.js')
const { retireNegatives } = await import('../src/services/advertising/negatives-retire.service.js')
const { normaliseNegTerm } = await import('../src/services/advertising/negatives.service.js')
const { default: prisma } = await import('../src/db.js')

const COMMIT = process.argv.includes('--commit')
const ARCHIVE = process.argv.includes('--archive')
const int = (n: number) => n.toLocaleString('en-IE')
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)
let failures = 0
const check = (l: string, ok: boolean, d = '') => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗ FAIL'}  ${l}${d ? ` — ${d}` : ''}`) }
const eq = (l: string, g: unknown, w: unknown) => check(l, g === w, `got ${String(g)}, want ${String(w)}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

console.log(`\n═══ NEG.3 — stage 2 ${COMMIT ? (ARCHIVE ? '· PAUSE PROBE + ARCHIVE' : '· PAUSE PROBE ONLY (reversible)') : '· DRY REPORT'} ═══\n`)

// ── the subject ───────────────────────────────────────────────────────────────────────────────
h('1 · The subject — at Amazon, in a PAUSED campaign, term dark for 120 days')
const since120 = new Date(Date.now() - 120 * 86400_000)
const traffic = new Map(
  (await prisma.amazonAdsSearchTerm.groupBy({ by: ['query'], where: { date: { gte: since120 } }, _sum: { impressions: true, orders7d: true } }))
    .map((r) => [normaliseNegTerm(r.query), { impr: r._sum.impressions ?? 0, orders: r._sum.orders7d ?? 0 }]),
)
const all = await prisma.adTarget.findMany({ where: { isNegative: true }, select: { expressionValue: true } })
const spread = new Map<string, number>()
for (const n of all) { const k = normaliseNegTerm(n.expressionValue); spread.set(k, (spread.get(k) ?? 0) + 1) }

const candidates = await prisma.adTarget.findMany({
  where: { isNegative: true, status: 'ENABLED', externalTargetId: { not: null }, negativeLevel: { not: 'CAMPAIGN' }, orphanedAt: null, retiredAt: null },
  select: {
    id: true, expressionValue: true, externalTargetId: true, negativeLevel: true, status: true,
    adGroup: { select: { name: true, externalAdGroupId: true, campaign: { select: { name: true, status: true, marketplace: true } } } },
  },
})
const subject = candidates
  .filter((c) => c.adGroup?.campaign?.status === 'PAUSED')
  .filter((c) => { const t = traffic.get(normaliseNegTerm(c.expressionValue)); return !t || (t.impr === 0 && t.orders === 0) })
  .filter((c) => (spread.get(normaliseNegTerm(c.expressionValue)) ?? 0) > 1)[0]

if (!subject) { console.log('  no qualifying subject'); await prisma.$disconnect(); process.exit(1) }
console.log(`  id=${subject.id}  externalTargetId=${subject.externalTargetId}`)
console.log(`  term 「${subject.expressionValue}」 · ${subject.negativeLevel} · negated in ${int(spread.get(normaliseNegTerm(subject.expressionValue)) ?? 0)} rows`)
console.log(`  ad group "${subject.adGroup?.name}" (ext ${subject.adGroup?.externalAdGroupId})`)
console.log(`  campaign "${subject.adGroup?.campaign?.name}" — ${subject.adGroup?.campaign?.status} · ${subject.adGroup?.campaign?.marketplace}`)
console.log(`  120d traffic for this term: ${JSON.stringify(traffic.get(normaliseNegTerm(subject.expressionValue)) ?? { impr: 0, orders: 0 })}`)
console.log(`\n  route this SHOULD take: PUT /sp/negativeKeywords   (before NEG.3 it was PUT /sp/keywords)`)

if (!COMMIT) { console.log('\n  DRY REPORT — nothing written.\n'); await prisma.$disconnect(); process.exit(0) }

// ── 2a · the reversible probe ─────────────────────────────────────────────────────────────────
const waitForQueue = async (queueId: string, label: string) => {
  for (let i = 0; i < 40; i++) {
    const row = await prisma.outboundSyncQueue.findUnique({ where: { id: queueId }, select: { syncStatus: true, lastError: true, attemptCount: true, payload: true } })
    if (row && !['PENDING', 'PROCESSING'].includes(String(row.syncStatus))) return row
    await sleep(3000)
  }
  return prisma.outboundSyncQueue.findUnique({ where: { id: queueId }, select: { syncStatus: true, lastError: true, attemptCount: true, payload: true } })
}

h('2a · PAUSE — reversible, and it proves the routing')
const pause = await updateAdTargetWithSync({
  adTargetId: subject.id,
  patch: { status: 'PAUSED' },
  actor: 'user:neg3-stage2' as never,
  reason: 'NEG.3 stage 2 — reversible probe of the negative-keyword endpoint routing',
  applyImmediately: true,
})
console.log(`  enqueued: ok=${pause.ok} queueId=${pause.outboundQueueId} error=${pause.error ?? '—'}`)
check('the write was accepted locally', pause.ok === true, String(pause.error))
if (!pause.outboundQueueId) { console.log('  ✗ FAIL — no outbound row'); await prisma.$disconnect(); process.exit(1) }

const q1 = await waitForQueue(pause.outboundQueueId, 'pause')
console.log(`  queue row: ${q1?.syncStatus} · attempts=${q1?.attemptCount} · error=${q1?.lastError ?? '—'}`)
eq('🔴 the round trip SUCCEEDED — the id exists under the endpoint we now use', String(q1?.syncStatus), 'COMPLETED')
const afterPause = await prisma.adTarget.findUnique({ where: { id: subject.id }, select: { status: true, orphanedAt: true, orphanReason: true, lastSyncStatus: true, lastSyncError: true } })
console.log(`  row: status=${afterPause?.status} lastSyncStatus=${afterPause?.lastSyncStatus} orphanedAt=${String(afterPause?.orphanedAt)} err=${afterPause?.lastSyncError ?? '—'}`)
eq('🔴 orphanedAt is STILL NULL — the trap did not fire', afterPause?.orphanedAt, null)
eq('the entity stamp records the success', afterPause?.lastSyncStatus, 'SUCCESS')
// Had the routing been wrong, Amazon would have answered entityNotFoundError at
// $.keywords[0].keywordId and this would read FAILED with an orphan mark.
check('no keyword-shaped not-found error was recorded', !/keywords\[0\]/.test(String(afterPause?.lastSyncError ?? '')), String(afterPause?.lastSyncError))

// ── undo it ───────────────────────────────────────────────────────────────────────────────────
h('2a-undo · back to ENABLED — the probe leaves nothing behind')
const unpause = await updateAdTargetWithSync({
  adTargetId: subject.id,
  patch: { status: 'ENABLED' },
  actor: 'user:neg3-stage2' as never,
  reason: 'NEG.3 stage 2 — restoring after the reversible probe',
  applyImmediately: true,
})
console.log(`  enqueued: ok=${unpause.ok} queueId=${unpause.outboundQueueId}`)
const q2 = unpause.outboundQueueId ? await waitForQueue(unpause.outboundQueueId, 'unpause') : null
console.log(`  queue row: ${q2?.syncStatus} · error=${q2?.lastError ?? '—'}`)
eq('the restore also succeeded', String(q2?.syncStatus), 'COMPLETED')
const restored = await prisma.adTarget.findUnique({ where: { id: subject.id }, select: { status: true, orphanedAt: true } })
eq('🔴 the subject is back to ENABLED — stage 2a changed nothing permanently', String(restored?.status), 'ENABLED')
eq('and it is still not orphaned', restored?.orphanedAt, null)

const orphansNow = await prisma.adTarget.count({ where: { isNegative: true, orphanedAt: { not: null } } })
eq('🔴 orphanedAt is 0 across ALL negatives', orphansNow, 0)

if (!ARCHIVE) {
  console.log(`\n${failures === 0 ? '✅ stage 2a passed — the routing is proven, REVERSIBLY, and nothing was archived' : `❌ ${failures} failed`}\n`)
  await prisma.$disconnect(); process.exit(failures === 0 ? 0 : 1)
}

// ── 2b · the real thing ───────────────────────────────────────────────────────────────────────
h('2b · ARCHIVE — irreversible, on the same subject')
const res = await retireNegatives({
  adTargetIds: [subject.id],
  actor: 'user:neg3-stage2' as never,
  retireReason: 'NEG.3 stage 2b — first archive of a negative through this product',
})
console.log(`  summary: ${JSON.stringify(res.summary)}`)
for (const o of res.outcomes) console.log(`  outcome: ${o.kind} reachedAmazon=${o.reachedAmazon} queue=${o.outboundQueueId} ${o.reason ?? ''}`)
eq('kind is retired', res.outcomes[0]?.kind, 'retired')
const q3 = res.outcomes[0]?.outboundQueueId ? await waitForQueue(res.outcomes[0].outboundQueueId!, 'archive') : null
console.log(`  queue row: ${q3?.syncStatus} · error=${q3?.lastError ?? '—'}`)
eq('🔴 the archive reached Amazon', String(q3?.syncStatus), 'COMPLETED')
const archived = await prisma.adTarget.findUnique({ where: { id: subject.id }, select: { status: true, retiredAt: true, retireReason: true, orphanedAt: true, lastSyncStatus: true } })
console.log(`  row: status=${archived?.status} retiredAt=${archived?.retiredAt?.toISOString()} orphanedAt=${String(archived?.orphanedAt)}`)
eq('the row is ARCHIVED', String(archived?.status), 'ARCHIVED')
check('🔴 retiredAt is stamped — the first negative in this account with a retirement date', archived?.retiredAt != null)
eq('and it is not orphaned', archived?.orphanedAt, null)
eq('orphanedAt is still 0 account-wide', await prisma.adTarget.count({ where: { isNegative: true, orphanedAt: { not: null } } }), 0)

console.log(`\n${failures === 0 ? '✅ stage 2 passed' : `❌ ${failures} failed`}\n`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
