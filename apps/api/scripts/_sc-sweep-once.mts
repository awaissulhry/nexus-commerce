/** One manual trading readback sweep (the deployed fix's code path):
 *  GetItem reads + stamp corrections + staggered heal enqueues + auto-resolve.
 *  Prod dispatchers on Railway consume the queue rows. */
process.env.NEXUS_EBAY_REAL_API = 'true'
const { readBackEbayTradingQuantities } = await import('../src/services/ebay-inventory-readback.service.js')
const r = await readBackEbayTradingQuantities()
console.log('SWEEP RESULT', JSON.stringify(r))
const { default: prisma } = await import('../src/db.js')
const open = await prisma.syncHealthLog.count({ where: { channel: 'EBAY', conflictType: 'CHANNEL_QTY_READBACK', resolutionStatus: 'UNRESOLVED' } })
console.log('open eBay readback logs after sweep =', open)
await prisma.$disconnect()
