/** ADX G7 — arm the retail guard. Measures first, then flips only on --apply. */
import './../src/env.js'
const APPLY = process.argv.includes('--apply')
const { analyzeRetailReadiness } = await import('../src/services/advertising/ads-retail-readiness.service.js')
const prisma = (await import('../src/db.js')).default

const a = await analyzeRetailReadiness({})
const toSuppress = a.campaigns.filter((c) => c.verdict === 'pause')
const verdicts = a.campaigns.reduce<Record<string, number>>((m, c) => { m[c.verdict] = (m[c.verdict] ?? 0) + 1; return m }, {})

console.log(`\n${APPLY ? 'ARMING' : 'DRY RUN'} — retail guard`)
console.log(`  campaigns analysed : ${a.campaigns.length}`)
console.log(`  verdicts           : ${JSON.stringify(verdicts)}`)
console.log(`  WOULD SUPPRESS NOW : ${toSuppress.length}  (bids → ~2¢, restorable, never a real pause)`)
for (const c of toSuppress.slice(0, 10)) console.log(`    · ${c.name} — ${c.reason}`)

if (APPLY) {
  const before = await prisma.automationRule.findFirst({
    where: { domain: 'advertising', name: '🛡 Retail guard' }, select: { id: true, dryRun: true },
  })
  if (!before) { console.log('rule not found'); process.exit(1) }
  await prisma.automationRule.update({ where: { id: before.id }, data: { dryRun: false } })
  console.log(`\n✅ '🛡 Retail guard' is LIVE (dryRun ${before.dryRun} → false)`)
  console.log(`REVERSAL: UPDATE "AutomationRule" SET "dryRun"=true WHERE id='${before.id}';`)
}
process.exit(0)
