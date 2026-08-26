/**
 * NEG.3 — STAGE 1. The local-only path. **Nothing leaves the building.**
 *
 * The 42 rows with no `externalTargetId` do not exist at Amazon, so retiring one cannot produce an
 * HTTP call, cannot orphan anything, and cannot be undone-at-Amazon because there is nothing there
 * to undo. That is exactly why it is stage 1: it exercises the audit row, the evidence, the
 * `retiredAt` stamp and the census arithmetic with the Amazon call physically impossible.
 *
 * It DOES delete a local row. Run with `--commit` to do it; without the flag it reports the
 * subject and the before-state and stops.
 *
 * `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_neg3-stage1.mts [--commit]`
 */
import '../src/env.js'
const { retireNegatives, RETIRE_ACTION_TYPE } = await import('../src/services/advertising/negatives-retire.service.js')
const { getTermContext, normaliseNegTerm } = await import('../src/services/advertising/negatives.service.js')
const { default: prisma } = await import('../src/db.js')

const COMMIT = process.argv.includes('--commit')
const int = (n: number) => n.toLocaleString('en-IE')
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)
let failures = 0
const check = (label: string, ok: boolean, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗ FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`) }
const eq = (label: string, got: unknown, want: unknown) => check(label, got === want, `got ${String(got)}, want ${String(want)}`)

console.log(`\n═══ NEG.3 — stage 1 (local-only) ${COMMIT ? '· COMMITTING' : '· DRY REPORT, pass --commit to write'} ═══\n`)

// ── choose the subject from the data ──────────────────────────────────────────────────────────
h('1 · The subject')
const localOnly = await prisma.adTarget.findMany({
  where: { isNegative: true, externalTargetId: null, status: 'ENABLED', retiredAt: null },
  select: {
    id: true, expressionValue: true, negativeLevel: true, status: true, createdAt: true,
    adGroup: { select: { name: true, campaign: { select: { name: true, status: true, marketplace: true } } } },
  },
})
console.log(`  local-only, ENABLED, not yet retired: ${int(localOnly.length)}`)
if (localOnly.length === 0) { console.log('  nothing to do'); await prisma.$disconnect(); process.exit(0) }

// Prefer a row whose term is negated in many other places, so removing it cannot be the last thing
// blocking that term — the safest possible first write.
const all = await prisma.adTarget.findMany({ where: { isNegative: true }, select: { expressionValue: true } })
const spread = new Map<string, number>()
for (const n of all) { const k = normaliseNegTerm(n.expressionValue); spread.set(k, (spread.get(k) ?? 0) + 1) }
const subject = [...localOnly].sort((a, b) => (spread.get(normaliseNegTerm(b.expressionValue)) ?? 0) - (spread.get(normaliseNegTerm(a.expressionValue)) ?? 0))[0]
const key = normaliseNegTerm(subject.expressionValue)
console.log(`  chosen: id=${subject.id}`)
console.log(`    term 「${subject.expressionValue}」 · ${subject.negativeLevel} · ${subject.status}`)
console.log(`    campaign "${subject.adGroup?.campaign?.name}" (${subject.adGroup?.campaign?.status}) · ad group "${subject.adGroup?.name}"`)
console.log(`    this term is negated in ${int(spread.get(key) ?? 0)} rows in total, so removing this one leaves ${int((spread.get(key) ?? 1) - 1)} still blocking it`)

// ── before ────────────────────────────────────────────────────────────────────────────────────
h('2 · Before')
const before = {
  total: await prisma.adTarget.count({ where: { isNegative: true } }),
  localOnly: await prisma.adTarget.count({ where: { isNegative: true, externalTargetId: null } }),
  termRows: await prisma.adTarget.count({ where: { isNegative: true, expressionValue: subject.expressionValue } }),
  retireLogs: await prisma.advertisingActionLog.count({ where: { actionType: RETIRE_ACTION_TYPE } }),
  orphans: await prisma.adTarget.count({ where: { isNegative: true, orphanedAt: { not: null } } }),
  outbound: await prisma.outboundSyncQueue.count(),
}
console.log(`  negatives ${int(before.total)} · local-only ${int(before.localOnly)} · rows for this exact term ${int(before.termRows)}`)
console.log(`  ${RETIRE_ACTION_TYPE} logs ${int(before.retireLogs)} · orphaned negatives ${int(before.orphans)} · outbound queue rows ${int(before.outbound)}`)
const ctxBefore = await getTermContext({ term: subject.expressionValue, market: 'all' })
console.log(`  term-context says: ${ctxBefore?.spread.rows} negations · ${ctxBefore?.remainder.total} in the list`)

if (!COMMIT) {
  console.log('\n  DRY REPORT — nothing written. Re-run with --commit to retire this row.\n')
  await prisma.$disconnect(); process.exit(0)
}

// ── the write ─────────────────────────────────────────────────────────────────────────────────
h('3 · Retiring — path (c), no Amazon call is possible')
const res = await retireNegatives({
  adTargetIds: [subject.id],
  actor: 'user:neg3-stage1' as never,
  retireReason: 'NEG.3 stage 1 — verifying the local-only retirement path end to end',
})
console.log(`  summary: ${JSON.stringify(res.summary)}`)
for (const o of res.outcomes) console.log(`  outcome: ${o.kind} · delivery=${o.delivery} · ${o.reason ?? ''}`)

eq('exactly one outcome', res.outcomes.length, 1)
eq('kind is removed_local', res.outcomes[0]?.kind, 'removed_local')
eq('🔴 delivery is not_applicable — nothing was sent', res.outcomes[0]?.delivery, 'not_applicable')
check('an audit row id came back', !!res.outcomes[0]?.actionLogId)
eq('no outbound queue row was created', res.outcomes[0]?.outboundQueueId, null)

// ── after ─────────────────────────────────────────────────────────────────────────────────────
h('4 · After — every number checked, not assumed')
const after = {
  total: await prisma.adTarget.count({ where: { isNegative: true } }),
  localOnly: await prisma.adTarget.count({ where: { isNegative: true, externalTargetId: null } }),
  termRows: await prisma.adTarget.count({ where: { isNegative: true, expressionValue: subject.expressionValue } }),
  retireLogs: await prisma.advertisingActionLog.count({ where: { actionType: RETIRE_ACTION_TYPE } }),
  orphans: await prisma.adTarget.count({ where: { isNegative: true, orphanedAt: { not: null } } }),
  outbound: await prisma.outboundSyncQueue.count(),
}
eq('the census drops by exactly one', after.total, before.total - 1)
eq('local-only drops by exactly one', after.localOnly, before.localOnly - 1)
eq('this term loses exactly one row', after.termRows, before.termRows - 1)
eq('exactly one retire log was written', after.retireLogs, before.retireLogs + 1)
eq('🔴 NOTHING was enqueued for Amazon', after.outbound, before.outbound)
eq('🔴 orphanedAt is still 0 across all negatives', after.orphans, 0)
eq('the row is gone', await prisma.adTarget.count({ where: { id: subject.id } }), 0)

h('5 · The record it left')
const log = await prisma.advertisingActionLog.findFirst({
  where: { actionType: RETIRE_ACTION_TYPE }, orderBy: { createdAt: 'desc' },
  select: { id: true, userId: true, entityId: true, evidence: true, payloadBefore: true, payloadAfter: true, amazonResponseStatus: true, createdAt: true },
})
console.log(`  log ${log?.id}`)
console.log(`    userId=${log?.userId ?? '—'} entityId=${log?.entityId}`)
console.log(`    payloadAfter=${JSON.stringify(log?.payloadAfter)}`)
console.log(`    evidence=${JSON.stringify(log?.evidence)}`)
eq('the log points at the row we removed', log?.entityId, subject.id)
check('🔴 it carries EVIDENCE — 0 of the 856 create-logs do', log?.evidence != null, JSON.stringify(log?.evidence))
// `ads-create.service.ts:43` hard-codes amazonResponseStatus 'SUCCESS' even for a local-only
// write. A retirement that never reached Amazon must not claim otherwise.
check('🔴 it does NOT claim a SUCCESS response from Amazon', log?.amazonResponseStatus !== 'SUCCESS', String(log?.amazonResponseStatus))

h('6 · The drawer agrees')
const ctxAfter = await getTermContext({ term: subject.expressionValue, market: 'all' })
eq('term-context lost exactly one negation', ctxAfter?.spread.rows, (ctxBefore?.spread.rows ?? 0) - 1)
eq('and the list it returns is the same length', ctxAfter?.negations.length, ctxAfter?.spread.rows)

console.log(`\n${failures === 0 ? '✅ stage 1 passed — the local path is proven and Amazon was never contacted' : `❌ ${failures} assertion(s) failed`}\n`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
