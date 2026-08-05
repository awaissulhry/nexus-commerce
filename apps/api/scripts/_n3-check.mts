/** ADX N3 — apply the ceiling to every live rule and show what could graduate. */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const { graduationCeiling } = await import('../src/services/advertising/ads-graduation.js')
const rules = await p.automationRule.findMany({
  where: { domain: 'advertising', enabled: true },
  select: { name: true, actions: true, dryRun: true },
})
const prot = await p.adKeywordProtection.count({ where: { mode: 'WHITELIST' } })
const rows = rules.map((r) => {
  const types = (Array.isArray(r.actions) ? r.actions : []).map((a) => String((a as { type?: unknown })?.type ?? '')).filter(Boolean)
  return { name: r.name, live: !r.dryRun, ...graduationCeiling({ actionTypes: types, hasKeywordProtections: prot > 0 }) }
})
const can = rows.filter((r) => r.maxLevel === 'AUTO')
const cant = rows.filter((r) => r.maxLevel !== 'AUTO')
console.log(`\nprotected terms configured: ${prot}\n`)
console.log(`COULD GO AUTONOMOUS (${can.length}):`)
for (const r of can) console.log(`  ${r.live ? '● live ' : '○      '} ${r.name.slice(0, 58)}`)
console.log(`\nSTAYS GATED (${cant.length}):`)
for (const r of cant) console.log(`  ○       ${r.name.slice(0, 50)}\n            └ ${r.blockedBy.join(', ')}`)
await p.$disconnect()
