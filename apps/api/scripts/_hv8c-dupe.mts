/** HV.8c — does the sweep proposedKey really produce duplicate cards? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const int=(n:any)=>Number(n).toLocaleString('en-IE')
const rows = await prisma.$queryRaw<Array<{rule:string;key:string;day:string;cards:bigint;entities:bigint}>>`
  SELECT "ruleName" AS rule, "proposedKey" AS key, TO_CHAR("createdAt",'YYYY-MM-DD') AS day,
         COUNT(*)::bigint AS cards, COUNT(DISTINCT "entityId")::bigint AS entities
  FROM "AdsRuleSuggestion" GROUP BY 1,2,3 HAVING COUNT(*) > 1 ORDER BY 4 DESC LIMIT 12`
console.log('\nrule × proposedKey × day where more than one card exists:')
for (const r of rows) console.log(`  ${String(r.cards).padStart(3)} cards / ${String(r.entities).padStart(3)} distinct entities  ${r.day}  ${String(r.key).slice(0,30).padEnd(32)} ${String(r.rule).slice(0,34)}`)
const tot = await prisma.adsRuleSuggestion.count()
const keys = await prisma.$queryRaw<Array<{n:bigint}>>`SELECT COUNT(DISTINCT ("ruleId","proposedKey"))::bigint AS n FROM "AdsRuleSuggestion"`
console.log(`\n  total suggestion rows: ${int(tot)} · distinct (ruleId, proposedKey): ${int(keys[0].n)}`)
const byType = await prisma.$queryRaw<Array<{key:string;cards:bigint;entities:bigint}>>`
  SELECT SPLIT_PART("proposedKey",':',1) AS key, COUNT(*)::bigint AS cards, COUNT(DISTINCT "entityId")::bigint AS entities
  FROM "AdsRuleSuggestion" GROUP BY 1 ORDER BY 2 DESC`
console.log('\n  by action type:')
for (const b of byType) console.log(`    ${String(b.key).padEnd(34)} cards=${String(int(b.cards)).padStart(6)} distinct entities=${int(b.entities)}`)
await prisma.$disconnect()
