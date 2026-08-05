/**
 * ACR.7 — strip emojis from live AutomationRule names (operator decision 2026-08-05).
 * Renames in place by id — nothing references rules by name except the seed, whose rename
 * map now carries every old spelling.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rules = await prisma.automationRule.findMany({ select: { id: true, name: true } })
const strip = (n: string) => n.replace(/^[^\w\s(]+️?\s*/u, '').trim()
let renamed = 0
for (const r of rules) {
  const clean = strip(r.name)
  if (clean !== r.name && clean.length > 0) {
    await prisma.automationRule.update({ where: { id: r.id }, data: { name: clean } })
    console.log(`  ${r.name}  →  ${clean}`)
    renamed += 1
  }
}
console.log(`\n${renamed} of ${rules.length} rules renamed.`)
await prisma.$disconnect()
