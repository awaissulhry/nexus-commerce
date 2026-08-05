/** Build a 1-row Sync Control import workbook (buffer edit) for a GALE FBM listing. */
const { default: prisma } = await import('../src/db.js')
const { buildSyncControlWorkbook } = await import('../src/services/sync-control-excel.js')
const fs = await import('node:fs')

const target = await prisma.channelListing.findFirst({
  where: { channel: 'AMAZON', marketplace: 'IT', isPublished: true, listingStatus: { notIn: ['ENDED','REMOVED'] },
    fulfillmentMethod: { not: 'FBA' }, product: { sku: { contains: 'GALE_JACKET_BLACK_3XL' } } },
  select: { stockBuffer: true, product: { select: { sku: true, name: true } } },
})
if (!target) { console.log('NO TARGET'); await prisma.$disconnect(); process.exit(1) }
const sku = target.product!.sku
const cur = target.stockBuffer ?? 0
const test = cur + 2
console.log(`TARGET ${sku} @ AMAZON:IT currentBuffer=${cur} -> test=${test}`)

const dir = '/private/tmp/claude-501/-Users-awais-nexus-commerce/9c5fbc56-8b89-4a23-9801-2fc73a2033a3/scratchpad'
const mk = (buffer: number) => [{
  product: target.product!.name ?? '', sku, channel: 'AMAZON', market: 'IT', itemId: '', lane: 'LISTING',
  mode: 'Follow', pinnedQty: '' as const, buffer, pool: '' as const, intended: '' as const, live: '' as const, drift: '', locked: '',
}]
fs.writeFileSync(`${dir}/gale-buffer-test.xlsx`, await buildSyncControlWorkbook(mk(test), []))
fs.writeFileSync(`${dir}/gale-buffer-revert.xlsx`, await buildSyncControlWorkbook(mk(cur), []))
console.log('wrote gale-buffer-test.xlsx (buffer=' + test + ') and gale-buffer-revert.xlsx (buffer=' + cur + ')')
await prisma.$disconnect()
