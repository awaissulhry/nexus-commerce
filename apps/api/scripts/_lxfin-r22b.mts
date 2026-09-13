import { readFileSync } from 'node:fs'
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const line of env.split('\n')) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '') }
const { default: prisma } = await import('../src/db.js')
const { getProductReadiness } = await import('../src/services/pim/scope-readiness.service.js')
const gale = await prisma.product.findFirstOrThrow({ where: { sku: 'GALE-JACKET' }, select: { id: true } })
const family = await prisma.product.findMany({ where: { OR: [{ id: gale.id }, { parentId: gale.id }], deletedAt: null }, select: { id: true, sku: true } })
const r = await getProductReadiness({ productId: gale.id, market: 'IT', locale: 'it' })
console.log(`family ${family.length} · matrix ${r.matrix.length}`)
for (const e of r.matrix) {
  const n = Object.keys(e.byProduct).length
  const states = [...new Set(Object.values(e.byProduct).map(v => v.state))].sort()
  if (n !== family.length || states.length > 1) console.log(`  ${e.label} · ${e.language} · ${e.coordinateKey} → byProduct ${n}/${family.length} states=[${states}] coordinate=${e.state}`)
}
const partial = r.matrix.filter(e => Object.keys(e.byProduct).length !== family.length)
console.log(`entries whose byProduct is NOT the whole family: ${partial.length} of ${r.matrix.length}`)
const mixed = r.matrix.filter(e => new Set(Object.values(e.byProduct).map(v => v.state)).size > 1)
console.log(`entries with MIXED per-product states: ${mixed.length}`)
// The other control: a product with no index rows at all.
const none = await prisma.product.findFirst({ where: { sku: 'IT-GALE-JACKET' }, select: { id: true, sku: true } })
if (none) {
  const rn = await getProductReadiness({ productId: none.id, market: 'IT', locale: 'it' })
  console.log(`POSITIVE CONTROL ${none.sku}: matrix ${rn.matrix.length} entries; master scope state ${rn.scopes[0].state} note ${JSON.stringify(rn.scopes[0].note)}`)
}
await prisma.$disconnect()
