/**
 * NEG.X — roll back the 26 local rows my own defect created. READ-then-WRITE, local only.
 *
 * 🔴 These correspond to NOTHING at Amazon: the ads client is in SANDBOX mode, so `createNegative`
 * logged and returned a stub with `mode: 'sandbox'` and a null keyword id. My mirror treated that
 * as a real create. Deleting them is a local-only correction, not an Amazon action.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const rows = await prisma.adTarget.findMany({
  where: { isNegative: true, expressionValue: 'protezioni', expressionType: 'NEGATIVE_PHRASE', externalTargetId: null },
  select: { id: true, createdAt: true, adGroup: { select: { name: true, campaign: { select: { name: true } } } } },
})
console.log(`local protezioni rows with NO Amazon id: ${rows.length}`)
const ids = rows.map((r) => r.id)
const logs = await prisma.advertisingActionLog.findMany({
  where: { entityId: { in: ids }, actionType: 'create_negative_keyword' }, select: { id: true },
})
console.log(`their create logs: ${logs.length}`)
// 🔴 Refuse to delete anything carrying an Amazon id — that would be a real negation.
const withExt = await prisma.adTarget.count({
  where: { isNegative: true, expressionValue: 'protezioni', externalTargetId: { not: null } },
})
if (withExt > 0) { console.log(`🔴 ${withExt} protezioni rows DO carry an Amazon id — refusing to touch anything`); await prisma.$disconnect(); process.exit(1) }

const delLogs = await prisma.advertisingActionLog.deleteMany({ where: { id: { in: logs.map((l) => l.id) } } })
const delRows = await prisma.adTarget.deleteMany({ where: { id: { in: ids } } })
console.log(`\ndeleted ${delRows.count} AdTarget rows and ${delLogs.count} action logs`)

const after = {
  negatives: await prisma.adTarget.count({ where: { isNegative: true } }),
  protezioni: await prisma.adTarget.count({ where: { isNegative: true, expressionValue: 'protezioni' } }),
  logs: await prisma.advertisingActionLog.count({ where: { actionType: 'create_negative_keyword' } }),
  orphaned: await prisma.adTarget.count({ where: { isNegative: true, orphanedAt: { not: null } } }),
}
console.log(`AFTER  negatives ${after.negatives.toLocaleString('en-IE')} (baseline 2,059) · protezioni ${after.protezioni} · create logs ${after.logs} (baseline 850) · orphaned ${after.orphaned}`)
console.log(after.negatives === 2059 && after.protezioni === 0 && after.logs === 850 ? '✓ restored to baseline' : '🔴 NOT at baseline')
await prisma.$disconnect()
