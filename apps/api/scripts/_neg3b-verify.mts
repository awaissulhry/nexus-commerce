/**
 * NEG.3b — verify the UI-issued local-only removal, and re-assert the invariant. READ-ONLY.
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

console.log('\n═══ NEG.3b — the UI write, verified ═══\n')
h('1 · The account')
const total = await prisma.adTarget.count({ where: { isNegative: true } })
const local = await prisma.adTarget.count({ where: { isNegative: true, externalTargetId: null } })
const orphans = await prisma.adTarget.count({ where: { orphanedAt: { not: null } } })
console.log(`  negatives ${int(total)} · local-only ${int(local)} · orphaned ${int(orphans)}`)
eq('census dropped to 2,057 (2,058 before this write)', total, 2057)
eq('local-only dropped to 40 (41 before)', local, 40)
eq('🔴 orphanedAt is 0 across ALL targets', orphans, 0)

h('2 · The record the UI left')
const logs = await prisma.advertisingActionLog.findMany({
  where: { actionType: RETIRE_ACTION_TYPE }, orderBy: { createdAt: 'desc' }, take: 3,
  select: { id: true, userId: true, entityId: true, evidence: true, payloadAfter: true, amazonResponseStatus: true, outboundQueueId: true, createdAt: true },
})
console.log(`  ${RETIRE_ACTION_TYPE} logs: ${int(logs.length)} (stage 1 wrote the first)`)
const log = logs[0]
console.log(`  newest: ${log?.createdAt.toISOString()} userId=${log?.userId}`)
console.log(`  payloadAfter=${JSON.stringify(log?.payloadAfter)}`)
console.log(`  evidence=${JSON.stringify(log?.evidence)}`)
check('the operator reason was stored', JSON.stringify(log?.payloadAfter).includes('through the UI'))
check('🔴 it carries evidence', log?.evidence != null)
check('🔴 it does not claim a SUCCESS from Amazon', log?.amazonResponseStatus !== 'SUCCESS', String(log?.amazonResponseStatus))
eq('no outbound row — nothing was sent', log?.outboundQueueId, null)
check('the actor is a real user id, not the script', String(log?.userId).startsWith('user:'), String(log?.userId))

h('3 · The drawer agrees')
const ctx = await getTermContext({ term: 'giacca moto', market: 'all' })
console.log(`  「giacca moto」 ${ctx?.spread.rows} negations · ${ctx?.comparable.campaignLevel} campaign-wide`)
eq('71 → 70 negations', ctx?.spread.rows, 70)
eq('the last campaign-wide negation of this term is gone', ctx?.comparable.campaignLevel, 0)

h('4 · The probe subject is untouched')
const probe = await prisma.adTarget.findUnique({ where: { id: 'cms9b5rqq066ao501kswaksd8' }, select: { status: true, orphanedAt: true, retiredAt: true } })
console.log(`  kolchoz carrere: ${JSON.stringify(probe)}`)
eq('still ENABLED', String(probe?.status), 'ENABLED')
eq('never retired', probe?.retiredAt, null)

h('5 · Nothing was archived through us this session')
const retiredRows = await prisma.adTarget.count({ where: { isNegative: true, retiredAt: { not: null } } })
eq('🔴 retiredAt set on 0 rows — no archive has been issued', retiredRows, 0)
eq('ARCHIVED count unchanged at 62 (all mirrored in from Amazon)', await prisma.adTarget.count({ where: { isNegative: true, status: 'ARCHIVED' } }), 62)

console.log(`\n${failures === 0 ? '✅ verified' : `❌ ${failures} failed`}\n`)
await prisma.$disconnect(); process.exit(failures === 0 ? 0 : 1)
