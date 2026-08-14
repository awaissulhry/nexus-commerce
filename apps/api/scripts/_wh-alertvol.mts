/** WH — if alert_operator starts notifying, how many notifications per day? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const int=(n:number)=>n.toLocaleString('en-IE')
const dayStart = new Date(); dayStart.setUTCHours(0,0,0,0)
const rules = await prisma.automationRule.findMany({ where: { domain:'advertising' }, select:{ id:true,name:true,enabled:true,actions:true } })
const users = await prisma.userProfile.count()
let total = 0
for (const r of rules) {
  const acts = (Array.isArray(r.actions)?r.actions as any[]:[]).map(a=>String(a?.type))
  if (!acts.includes('alert_operator')) continue
  const today = await prisma.automationRuleExecution.count({ where: { ruleId: r.id, startedAt: { gte: dayStart } } })
  console.log(`  ${r.enabled?'ON ':'off'} ${r.name.padEnd(38)} ${int(today)} executions today`)
  if (r.enabled) total += today
}
console.log(`\nalert_operator executions today (enabled rules): ${int(total)}`)
console.log(`userProfile rows notifyAutomation fans out to: ${int(Math.min(users,100))} (capped at 100)`)
console.log(`🔴 Notification rows that would be created per day: ${int(total * Math.min(users,100))}`)
const existing = await prisma.notification.count()
console.log(`   existing Notification rows in the table: ${int(existing)}`)
await prisma.$disconnect()
