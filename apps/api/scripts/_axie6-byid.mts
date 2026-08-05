const { default: p } = await import('../src/db.js')
const logs = await p.advertisingActionLog.findMany({ where: { executionId: 'import:cms4nweg50008nj7glsf080mb' }, select: { entityType: true, entityId: true, payloadBefore: true, payloadAfter: true } })
for (const l of logs.slice(0,5)) {
  const b=l.payloadBefore as any, a=l.payloadAfter as any
  if (l.entityType==='CAMPAIGN') { const c=await p.campaign.findUnique({where:{id:l.entityId},select:{name:true,marketplace:true,dailyBudget:true}})
    console.log(`NOW CAMPAIGN ${c?.name} [${c?.marketplace}] budget=${c?.dailyBudget}  (log ${b.dailyBudget}→${a.dailyBudget})`) }
  else { const t=await p.adTarget.findUnique({where:{id:l.entityId},select:{expressionValue:true,bidCents:true}})
    console.log(`NOW TARGET   ${t?.expressionValue} bid=${t?.bidCents}c  (log ${b.bidCents}→${a.bidCents}c)`) }
}
await p.$disconnect()
