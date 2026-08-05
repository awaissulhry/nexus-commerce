const { default: p } = await import('../src/db.js')
const logs = await p.advertisingActionLog.findMany({
  where: { executionId: 'import:cms4nweg50008nj7glsf080mb' },
  orderBy: { createdAt: 'asc' },
  select: { id: true, actionType: true, entityType: true, entityId: true, payloadBefore: true, payloadAfter: true, amazonResponseStatus: true, outboundQueueId: true, rolledBackAt: true },
})
console.log('LOGROWS', logs.length)
for (const l of logs.slice(0, 4)) {
  const b = l.payloadBefore as Record<string, unknown>, a = l.payloadAfter as Record<string, unknown>
  const keys = [...new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])].filter(k => JSON.stringify(b?.[k]) !== JSON.stringify(a?.[k]))
  console.log(` ${l.actionType} ${l.entityType} status=${l.amazonResponseStatus} q=${l.outboundQueueId ? 'yes' : 'no'} changed=${keys.map(k=>`${k}:${JSON.stringify(b?.[k])}→${JSON.stringify(a?.[k])}`).join(' ')}`)
}
await p.$disconnect()
