import { readFileSync } from 'node:fs'
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const line of env.split('\n')) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '') }
const { default: prisma } = await import('../src/db.js')
const { getProductReadiness } = await import('../src/services/pim/scope-readiness.service.js')
for (const sku of ['GALE-JACKET', 'VX-TEST-3AX']) {
  const p = await prisma.product.findFirstOrThrow({ where: { sku }, select: { id: true } })
  const r = await getProductReadiness({ productId: p.id, market: 'IT', locale: 'it' })
  const byLang = new Map<string, string[]>()
  for (const e of r.matrix) { const k = e.language; const a = byLang.get(k) ?? []; if (e.channel) a.push(e.label); byLang.set(k, a) }
  console.log(`\n${sku}: matrix ${r.matrix.length}`)
  for (const [lang, labels] of byLang) console.log(`  ${lang}: ${labels.length} channel coordinates${labels.length ? ' → ' + labels.join(' | ') : ''}`)
}
await prisma.$disconnect()
