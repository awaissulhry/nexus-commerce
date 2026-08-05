/** ADX N5 — what the existing 8-check gate actually says for each AUTO-eligible rule. */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const { graduationCeiling } = await import('../src/services/advertising/ads-graduation.js')

const conn = await p.amazonAdsConnection.findFirst({ where: { isActive: true }, select: { mode: true, writesEnabledAt: true } })
const prot = await p.adKeywordProtection.count({ where: { mode: 'WHITELIST' } })
const rules = await p.automationRule.findMany({
  where: { domain: 'advertising', enabled: true },
  select: { id: true, name: true, actions: true, dryRun: true, createdAt: true,
            evaluationCount: true, matchCount: true, maxExecutionsPerDay: true },
})
const rows = rules.map((r) => {
  const types = (Array.isArray(r.actions) ? r.actions : []).map((a) => String((a as { type?: unknown })?.type ?? '')).filter(Boolean)
  const ceil = graduationCeiling({ actionTypes: types, hasKeywordProtections: prot > 0 })
  const days = Math.floor((Date.now() - r.createdAt.getTime()) / 86_400_000)
  const fails: string[] = []
  if (r.dryRun === false) fails.push('already-live')
  if (days < 14) fails.push(`window ${days}/14d`)
  if (r.evaluationCount < 10) fails.push(`evals ${r.evaluationCount}/10`)
  if (r.matchCount < 1) fails.push('no matches')
  if (conn?.mode !== 'production') fails.push('conn')
  if (!conn?.writesEnabledAt) fails.push('writes')
  return { name: r.name, ceiling: ceil.maxLevel, days, evals: r.evaluationCount, matches: r.matchCount, cap: r.maxExecutionsPerDay, fails }
})
const eligible = rows.filter((r) => r.ceiling === 'AUTO')
console.log(`\nprotected terms: ${prot} · connection: ${conn?.mode} writes=${!!conn?.writesEnabledAt}\n`)
console.log(`AUTO-eligible by policy: ${eligible.length}`)
console.log(`  gate ALREADY OPEN : ${eligible.filter((r)=>r.fails.length===0).length}`)
console.log(`  gate closed       : ${eligible.filter((r)=>r.fails.length>0).length}\n`)
for (const r of eligible) {
  console.log(`  ${r.fails.length===0?'✅':'⛔'} ${r.name.slice(0,44).padEnd(44)} age=${String(r.days).padStart(3)}d evals=${String(r.evals).padStart(6)} match=${String(r.matches).padStart(5)} cap=${r.cap}`)
  if (r.fails.length) console.log(`        └ ${r.fails.join(' · ')}`)
}
await p.$disconnect()
