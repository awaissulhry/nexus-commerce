import { readFileSync } from 'node:fs'
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const line of env.split('\n')) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '') }
const { default: prisma } = await import('../src/db.js')
const { getProductReadiness } = await import('../src/services/pim/scope-readiness.service.js')
const gale = await prisma.product.findFirstOrThrow({ where: { sku: 'GALE-JACKET' }, select: { id: true } })
const family = await prisma.product.findMany({ where: { OR: [{ id: gale.id }, { parentId: gale.id }], deletedAt: null }, select: { id: true, sku: true } })
const r = await getProductReadiness({ productId: gale.id, market: 'IT', locale: 'it' })
const e = r.matrix.find(x => x.channel === 'EBAY' && x.language === 'it')!
const byState: Record<string, string[]> = {}
for (const [id, v] of Object.entries(e.byProduct)) (byState[v.state] ??= []).push(family.find(f => f.id === id)?.sku ?? id)
console.log(e.label, e.language, 'coordinate =', e.state, 'pct', e.pct)
for (const [state, skus] of Object.entries(byState)) console.log(`  ${state} (${skus.length}): ${skus.sort().join(', ')}`)
await prisma.$disconnect()
