/** WH — 🔴 fixing the counter ENABLES a cap that has never fired. What does it now stop? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const int=(n:number)=>n.toLocaleString('en-IE')
const dayStart = new Date(); dayStart.setUTCHours(0,0,0,0)
const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', enabled: true, maxExecutionsPerDay: { not: null } },
  select: { id:true, name:true, autonomyLevel:true, maxExecutionsPerDay:true, dryRun:true },
})
console.log(`enabled advertising rules with a daily cap: ${rules.length}\n`)
const rows: Array<{n:string;lvl:string;cap:number;today:number;over:boolean}> = []
for (const r of rules) {
  const today = await prisma.automationRuleExecution.count({
    where: { ruleId: r.id, startedAt: { gte: dayStart }, OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }] },
  })
  rows.push({ n:r.name, lvl:String(r.autonomyLevel), cap:r.maxExecutionsPerDay!, today, over: today >= r.maxExecutionsPerDay! })
}
rows.sort((a,b)=> (b.today/b.cap) - (a.today/a.cap))
for (const r of rows) console.log(`  ${r.over?'🔴 WOULD CAP':'   under    '} ${r.n.padEnd(38)} ${r.lvl.padEnd(8)} ${String(r.today).padStart(5)}/${String(r.cap).padEnd(5)} today`)
const capped = rows.filter(r=>r.over)
const cappedAuto = capped.filter(r=>r.lvl==='AUTO')
console.log(`\n🔴 rules that would hit their cap TODAY: ${capped.length} of ${rows.length}`)
console.log(`   of those on AUTO (i.e. writes that would stop): ${cappedAuto.length}${cappedAuto.length?` — ${cappedAuto.map(r=>r.n).join(', ')}`:''}`)
console.log(`   of those on PROPOSE (dry runs that would stop): ${capped.filter(r=>r.lvl==='PROPOSE').length}`)
await prisma.$disconnect()
