/** READ-ONLY: why are Amazon writes failing? Group every failure source by cause. */
const { default: prisma } = await import('../src/db.js')
const H24 = new Date(Date.now() - 24 * 3600 * 1000)
const D7 = new Date(Date.now() - 7 * 24 * 3600 * 1000)
const trim = (s: string | null | undefined, n = 150) => (s ?? '(none)').replace(/\s+/g, ' ').slice(0, n)

console.log('\n═══ 1. AdMutation FAILED (queued writes: bids, suppression, base-bid) ═══')
const am = await prisma.adMutation.findMany({ where: { state: 'FAILED', updatedAt: { gte: D7 } }, select: { entityType: true, field: true, lastError: true, actor: true, attempts: true, updatedAt: true, entityId: true } })
console.log(`FAILED in last 7d: ${am.length}   (last 24h: ${am.filter((r) => r.updatedAt >= H24).length})`)
const byErr = new Map<string, { n: number; ex: typeof am[number] }>()
for (const r of am) { const k = `${r.entityType}|${r.field}|${trim(r.lastError, 90)}`; const c = byErr.get(k); if (c) c.n++; else byErr.set(k, { n: 1, ex: r }) }
for (const [k, v] of [...byErr.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12)) console.log(`  ${String(v.n).padStart(4)}×  ${k}`)

console.log('\n═══ 2. AdvertisingActionLog FAILED (inline placement pushes) ═══')
const al = await prisma.advertisingActionLog.findMany({ where: { amazonResponseStatus: 'FAILED', createdAt: { gte: D7 } }, select: { actionType: true, entityType: true, entityId: true, userId: true, createdAt: true, payloadAfter: true } })
console.log(`FAILED in last 7d: ${al.length}   (last 24h: ${al.filter((r) => r.createdAt >= H24).length})`)
const byAct = new Map<string, number>()
for (const r of al) byAct.set(`${r.entityType}|${r.actionType}`, (byAct.get(`${r.entityType}|${r.actionType}`) ?? 0) + 1)
for (const [k, n] of [...byAct.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}×  ${k}`)
if (al[0]) console.log('  sample payloadAfter:', trim(JSON.stringify(al[0].payloadAfter), 220))

console.log('\n═══ 3. OutboundSyncQueue FAILED / dead-lettered ═══')
const oq = await prisma.outboundSyncQueue.groupBy({ by: ['syncStatus'], where: { updatedAt: { gte: D7 } }, _count: { _all: true } })
for (const r of oq) console.log(`  ${r.syncStatus.padEnd(12)} ${r._count._all}`)
const dead = await prisma.outboundSyncQueue.findMany({ where: { syncStatus: 'FAILED', updatedAt: { gte: D7 } }, select: { errorCode: true, errorMessage: true, retryCount: true, maxRetries: true, payload: true, updatedAt: true }, take: 500 })
const byCode = new Map<string, { n: number; msg: string }>()
for (const r of dead) { const k = `${r.errorCode ?? '—'}|${trim(r.errorMessage, 110)}`; const c = byCode.get(k); if (c) c.n++; else byCode.set(k, { n: 1, msg: trim(r.errorMessage, 200) }) }
for (const [k, v] of [...byCode.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12)) console.log(`  ${String(v.n).padStart(4)}×  ${k}`)

console.log('\n═══ 4. Orphaned ad targets (Amazon says the entity is gone) ═══')
const orph = await prisma.adTarget.count({ where: { orphanedAt: { not: null } } })
const orphByKind = await prisma.adTarget.groupBy({ by: ['kind'], where: { orphanedAt: { not: null } }, _count: { _all: true } })
console.log(`orphaned AdTargets: ${orph}  ${orphByKind.map((r) => `${r.kind}=${r._count._all}`).join(' ')}`)

console.log('\n═══ 5. Write gate: which campaigns can push at all ═══')
const gate = await prisma.campaign.groupBy({ by: ['liveBidWritesEnabled'], _count: { _all: true } })
for (const r of gate) console.log(`  liveBidWritesEnabled=${r.liveBidWritesEnabled}: ${r._count._all} campaigns`)
const conns = await prisma.amazonAdsConnection.findMany({ select: { marketplace: true, isActive: true, writesEnabledAt: true, lastWriteAt: true } })
for (const c of conns) console.log(`  conn ${c.marketplace} active=${c.isActive} writesEnabled=${c.writesEnabledAt ? 'YES' : 'NO'} lastWrite=${c.lastWriteAt?.toISOString() ?? 'never'}`)

await prisma.$disconnect()
