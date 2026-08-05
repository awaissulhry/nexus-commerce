const { default: prisma } = await import('../src/db.js')
const r = await prisma.channelListing.findFirst({
  where: { channel: 'AMAZON', marketplace: 'IT', product: { sku: 'GALE_JACKET_BLACK_3XL_FBM' } },
  select: { stockBuffer: true, quantity: true, followMasterQuantity: true, syncPaused: true },
})
console.log('RESTORED STATE:', JSON.stringify(r))
const audits = await prisma.syncControlAudit.count({ where: { actor: { startsWith: 'excel:' } } })
console.log('excel-actor audit rows:', audits)
await prisma.$disconnect()
