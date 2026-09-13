/** LX.FIN item 2 (R-LX-22) — the per-coordinate readiness the master sheet's columns will render. READ ONLY. */
import { readFileSync } from 'node:fs'
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const line of env.split('\n')) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '') }
const { default: prisma } = await import('../src/db.js')
const db = (await prisma.$queryRawUnsafe<any[]>('SELECT current_database()::text AS current_database'))[0]
const gale = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { id: true, version: true } })
console.log('DISCRIMINATOR', db, 'GALE-JACKET version', gale?.version)
const { getProductReadiness } = await import('../src/services/pim/scope-readiness.service.js')

for (const [label, productId] of [['GALE-JACKET (has index rows)', gale!.id], ['VX-TEST-3AX (fixture)', 'cmtzci5kf0000njr9f8yhrsxm']] as const) {
  const r = await getProductReadiness({ productId, market: 'IT', locale: 'it' })
  const family = await prisma.product.findMany({ where: { OR: [{ id: productId }, { parentId: productId }], deletedAt: null }, select: { id: true, sku: true } })
  console.log(`\n=== ${label} — family ${family.length} products, matrix ${r.matrix.length} entries`)
  for (const entry of r.matrix.slice(0, 6)) {
    const keys = Object.keys(entry.byProduct)
    console.log(`  ${entry.label} · ${entry.language} · coordinate ${entry.coordinateKey}`)
    console.log(`    coordinate verdict: ${entry.state} pct ${entry.pct}`)
    console.log(`    byProduct ${keys.length}/${family.length} products:`,
      keys.map(k => `${family.find(f => f.id === k)?.sku ?? k}=${entry.byProduct[k].state}${entry.byProduct[k].pct === null ? '' : `/${entry.byProduct[k].pct}%`}`).join(' '))
    const missing = family.filter(f => !keys.includes(f.id))
    if (missing.length) console.log(`    NOT in byProduct (→ the cell says "Not computed"): ${missing.map(f => f.sku).join(', ')}`)
  }
  // Set claim with its control: the union of byProduct keys must be a SUBSET of the family.
  const union = new Set(r.matrix.flatMap(e => Object.keys(e.byProduct)))
  console.log(`  union of byProduct keys = ${union.size}; all in family: ${[...union].every(id => family.some(f => f.id === id))}`)
}
await prisma.$disconnect()
