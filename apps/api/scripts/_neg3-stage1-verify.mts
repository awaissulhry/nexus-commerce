/**
 * NEG.3 — stage 1, the record it left. READ-ONLY.
 *
 * Split out of `_neg3-stage1.mts` because that script picks a NEW subject on every run: re-running
 * it to check the aftermath would retire a second row. This one only reads.
 */
import '../src/env.js'
const { RETIRE_ACTION_TYPE } = await import('../src/services/advertising/negatives-retire.service.js')
const { getTermContext } = await import('../src/services/advertising/negatives.service.js')
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)
let failures = 0
const check = (l: string, ok: boolean, d = '') => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗ FAIL'}  ${l}${d ? ` — ${d}` : ''}`) }
const eq = (l: string, g: unknown, w: unknown) => check(l, g === w, `got ${String(g)}, want ${String(w)}`)

console.log('\n═══ NEG.3 — stage 1, the record ═══\n')

h('1 · The retire log')
const logs = await prisma.advertisingActionLog.findMany({
  where: { actionType: RETIRE_ACTION_TYPE },
  orderBy: { createdAt: 'desc' },
  select: { id: true, userId: true, entityId: true, entityType: true, evidence: true, payloadBefore: true, payloadAfter: true, amazonResponseStatus: true, outboundQueueId: true, createdAt: true },
})
console.log(`  ${RETIRE_ACTION_TYPE} logs: ${int(logs.length)}`)
const log = logs[0]
if (!log) { console.log('  ✗ FAIL — none found'); await prisma.$disconnect(); process.exit(1) }
console.log(`  id=${log.id} userId=${log.userId} entityId=${log.entityId} entityType=${log.entityType}`)
console.log(`  amazonResponseStatus=${String(log.amazonResponseStatus)} outboundQueueId=${String(log.outboundQueueId)}`)
console.log(`  payloadBefore=${JSON.stringify(log.payloadBefore)}`)
console.log(`  payloadAfter=${JSON.stringify(log.payloadAfter)}`)
console.log(`  evidence=${JSON.stringify(log.evidence)}`)

check('🔴 it carries EVIDENCE — 0 of the 856 create-logs do', log.evidence != null)
// `ads-create.service.ts:43` hard-codes amazonResponseStatus 'SUCCESS' even when only a local row
// was written. A retirement that never reached Amazon must not claim otherwise.
check('🔴 it does NOT claim a SUCCESS response from Amazon', log.amazonResponseStatus !== 'SUCCESS', String(log.amazonResponseStatus))
eq('no outbound row is attached', log.outboundQueueId, null)
check('the actor is recorded', !!log.userId, String(log.userId))
check('payloadAfter states it never reached Amazon', JSON.stringify(log.payloadAfter).includes('"reachedAmazon":false'))

h('2 · The account, after')
const total = await prisma.adTarget.count({ where: { isNegative: true } })
const localOnly = await prisma.adTarget.count({ where: { isNegative: true, externalTargetId: null } })
const orphans = await prisma.adTarget.count({ where: { isNegative: true, orphanedAt: { not: null } } })
const retired = await prisma.adTarget.count({ where: { isNegative: true, retiredAt: { not: null } } })
console.log(`  negatives ${int(total)} · local-only ${int(localOnly)} · retiredAt set ${int(retired)} · orphaned ${int(orphans)}`)
eq('census is 2,058 (was 2,059)', total, 2058)
eq('local-only is 41 (was 42)', localOnly, 41)
eq('🔴 orphanedAt is still 0 — the routing fix has not been exercised yet, and nothing broke', orphans, 0)
// The local-only row was DELETED, so it carries no retiredAt — the column records rows we archived
// and kept, which is the (a)/(b) path. Stated so the 0 is not read as "the stamp is broken".
eq('retiredAt is 0 — path (c) deletes the row, so there is none to stamp', retired, 0)

h('3 · The drawer agrees')
const ctx = await getTermContext({ term: 'giacca moto', market: 'all' })
console.log(`  「giacca moto」 ${ctx?.spread.rows} negations · ${ctx?.comparable.campaignLevel} campaign-wide · ${ctx?.remainder.total} listed`)
eq('72 → 71 negations', ctx?.spread.rows, 71)
eq('the campaign-wide count dropped from 2 to 1', ctx?.comparable.campaignLevel, 1)
eq('the list is complete', ctx?.negations.length, 71)

console.log(`\n${failures === 0 ? '✅ stage 1 record verified' : `❌ ${failures} failed`}\n`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
