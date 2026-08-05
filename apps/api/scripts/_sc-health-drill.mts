/** READ-ONLY: drill into health alerts — dead letters, qty mismatches, auth failures. */
const { default: prisma } = await import('../src/db.js')
const day = new Date(Date.now() - 24 * 3600e3)

// 1) Dead letters last 24h (health: isDead + diedAt>=24h)
const dead = await prisma.outboundSyncQueue.findMany({
  where: { isDead: true, diedAt: { gte: day } },
  select: { targetChannel: true, targetRegion: true, errorMessage: true, retryCount: true, diedAt: true, syncType: true, product: { select: { sku: true } } },
  orderBy: { diedAt: 'desc' },
})
const dlByErr = new Map<string, { n: number; sample: string; skus: Set<string> }>()
for (const d of dead) {
  const key = `${d.targetChannel}|${d.syncType}|${(d.errorMessage ?? '?').slice(0, 100)}`
  const psku = d.product?.sku ?? '?'
  const e = dlByErr.get(key) ?? { n: 0, sample: `${psku}@${d.targetRegion}`, skus: new Set<string>() }
  e.n++; e.skus.add(psku)
  dlByErr.set(key, e)
}
console.log(`DEAD_LETTERS 24h = ${dead.length}`)
for (const [k, v] of [...dlByErr.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  [${v.n}] uniqueSkus=${v.skus.size} sample=${v.sample}\n    ${k}`)
}

// 2) qtyMismatches = syncHealthLog CHANNEL_QTY_READBACK UNRESOLVED 24h
const mm = await prisma.syncHealthLog.findMany({
  where: { conflictType: 'CHANNEL_QTY_READBACK', resolutionStatus: 'UNRESOLVED', createdAt: { gte: day } },
  select: { errorMessage: true, errorDetails: true, product: { select: { sku: true } }, createdAt: true },
  orderBy: { createdAt: 'desc' },
})
const mmBySku = new Map<string, number>()
for (const m of mm) { const k = m.product?.sku ?? (m.errorMessage ?? '?').slice(0, 60); mmBySku.set(k, (mmBySku.get(k) ?? 0) + 1) }
console.log(`\nQTY_READBACK UNRESOLVED 24h = ${mm.length}; unique sku-keys = ${mmBySku.size}`)
for (const [k, n] of [...mmBySku.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  [${n}] ${k}`)
for (const m of mm.slice(0, 3)) console.log('  sample:', (m.errorMessage ?? '').slice(0, 200))

// 3) authFailures = CHANNEL_AUTH_FAILURE UNRESOLVED 24h
const auth = await prisma.syncHealthLog.findMany({
  where: { conflictType: 'CHANNEL_AUTH_FAILURE', resolutionStatus: 'UNRESOLVED', createdAt: { gte: day } },
  select: { errorMessage: true, createdAt: true },
  orderBy: { createdAt: 'desc' },
})
console.log(`\nAUTH FAILURES UNRESOLVED 24h = ${auth.length}`)
for (const a of auth) console.log(`  ${a.createdAt.toISOString()} ${(a.errorMessage ?? '').slice(0, 160)}`)
await prisma.$disconnect()
