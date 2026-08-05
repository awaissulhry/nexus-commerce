import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const since = new Date(Date.now() - 24 * 3600 * 1000)
const failing = await p.adMutation.findMany({ where: { state: 'FAILED', entityType: 'AD_TARGET', updatedAt: { gte: since } }, select: { entityId: true } })
const failIds = [...new Set(failing.map((f) => f.entityId))]
const t = await p.adTarget.findMany({ where: { id: { in: failIds } }, select: { kind: true, adGroupId: true } })
const agIds = [...new Set(t.map(x => x.adGroupId))]
const sib = await p.adTarget.findMany({ where: { adGroupId: { in: agIds }, id: { notIn: failIds } }, select: { kind: true } })
const tally = (rows: {kind:string}[]) => { const m = new Map<string,number>(); for (const r of rows) m.set(r.kind,(m.get(r.kind)??0)+1); return [...m.entries()].sort((a,b)=>b[1]-a[1]) }
console.log('FAILING target kinds :', JSON.stringify(tally(t)))
console.log('SIBLING target kinds :', JSON.stringify(tally(sib)))
// Did ANY write to a non-keyword target ever succeed?
const ok = await p.adMutation.findMany({ where: { state: 'APPLIED', entityType: 'AD_TARGET' }, select: { entityId: true }, take: 500 })
const okT = await p.adTarget.findMany({ where: { id: { in: [...new Set(ok.map(o=>o.entityId))] } }, select: { kind: true } })
console.log('APPLIED (successful) target kinds, all time:', JSON.stringify(tally(okT)))
await p.$disconnect()
