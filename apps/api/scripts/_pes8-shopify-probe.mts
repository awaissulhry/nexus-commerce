import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { getStudioColumns } = await import('../src/services/pim/studio-columns.js')
const set = await getStudioColumns({ market: 'IT', productTypes: ['OUTERWEAR'], onlyChannels: ['SHOPIFY'], includeEmptyChannels: true })
const chan = set.columns.filter((c: any) => /^(shopify|woocommerce|etsy)_/i.test(c.writeField))
console.log('SHOPIFY coordinate columns total:', set.columns.length)
console.log('shopify_/woo_/etsy_ prefixed write fields:', chan.length ? chan.map((c: any) => c.writeField).join(', ') : '(NONE — no per-channel write field exists)')
console.log('sample writeFields:', set.columns.slice(0, 8).map((c: any) => c.writeField).join(', '))
await prisma.$disconnect()
