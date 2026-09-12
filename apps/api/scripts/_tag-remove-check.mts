import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pid = 'cmp27serw0235nv019i5ebyck'
const rows = await prisma.productTag.findMany({ where: { productId: pid }, select: { tagId: true, tag: { select: { name: true } } } })
console.log('ProductTag rows for the product:', rows.map((r) => `${r.tag.name}(${r.tagId})`).join(', ') || '(none)')
const kids = await prisma.product.findMany({ where: { parentId: pid }, select: { id: true } })
const kidTags = await prisma.productTag.findMany({ where: { productId: { in: kids.map((k) => k.id) } }, select: { productId: true, tag: { select: { name: true } } } })
console.log('children:', kids.length, '| child tag rows:', kidTags.length, kidTags.slice(0, 4).map((k) => k.tag.name).join(','))
const cache = await prisma.productReadCache.findUnique({ where: { id: pid }, select: { id: true, updatedAt: true } }).catch(() => null)
console.log('read cache row:', cache ? `present updatedAt=${cache.updatedAt.toISOString()}` : 'absent')
await prisma.$disconnect(); process.exit(0)
