const { default: prisma } = await import('../src/db.js')
function canonicalStem(sku: string): string {
  let s = sku.trim()
  s = s.replace(/^(IT|DE|FR|ES|UK|EU)-/i, '')
  s = s.replace(/-(ALT\d*|FBM|FBA|EBAY|AMZ|AMAZON)$/i, '')
  s = s.replace(/-(ALT\d*|FBM|FBA)$/i, '')
  return s.toUpperCase()
}
const masters = await prisma.product.findMany({ where: { parentId: null }, select: { id: true, sku: true } })
const kids = await prisma.product.findMany({ where: { parentId: { not: null } }, select: { parentId: true }, distinct: ['parentId'] })
const withKids = new Set(kids.map(k => k.parentId!))
const byStem = new Map<string, {id:string,sku:string}[]>()
for (const m of masters) {
  if (!withKids.has(m.id)) continue
  const s = canonicalStem(m.sku)
  const a = byStem.get(s) ?? []; a.push(m); byStem.set(s, a)
}
let collisions = 0
for (const [s, arr] of byStem) if (arr.length > 1) { collisions++; console.log('COLLISION stem=', s, arr.map(x=>x.sku).join(' | ')) }
console.log('RESULT child-owning masters:', [...byStem.values()].reduce((n,a)=>n+a.length,0), 'stem collisions:', collisions)
// also: any master sku with a market prefix at all?
const prefixed = masters.filter(m => /^(IT|DE|FR|ES|UK|EU)-/i.test(m.sku))
console.log('prefixed masters:', prefixed.map(p=>`${p.sku}${withKids.has(p.id)?'(has children)':'(childless)'}`).join(', ') || 'none')
await prisma.$disconnect()
