/** READ-ONLY. GX.4 — do the links carry the window? */
import '../src/env.js'
const { hierarchyChildren } = await import('../src/services/advertising/ads-hierarchy.service.js')
const W = { from: '2026-07-01', to: '2026-08-25' }
const pf = (await hierarchyChildren({ level: 'market', parentId: 'market:IT', ...W, decompose: 'product', marketplaces: [] }))
  .nodes.sort((a,b)=>(b.metrics.cost??0)-(a.metrics.cost??0))[0]
const camps = await hierarchyChildren({ level: 'portfolio', parentId: pf.id, ...W, decompose: 'product', marketplaces: [] })
const c = camps.nodes.sort((a,b)=>(b.metrics.cost??0)-(a.metrics.cost??0))[0]
console.log('campaign href :', c.href)
const kids = await hierarchyChildren({ level: 'campaign', parentId: c.id, ...W, decompose: 'target', marketplaces: [] })
console.log('target href   :', kids.nodes.find(n=>n.kind==='target')?.href)
console.log('product href  :', (await hierarchyChildren({ level: 'campaign', parentId: c.id, ...W, decompose: 'product', marketplaces: [] })).nodes.find(n=>n.kind==='product')?.href)
console.log('\ncaveats on a campaign with a remainder:')
for (const cv of kids.caveats) console.log('  ·', cv.slice(0, 150))
const { default: prisma } = await import('../src/db.js'); await prisma.$disconnect()
