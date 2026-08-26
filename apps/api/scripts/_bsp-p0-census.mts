import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const out = (s: string) => console.log(`§ ${s}`)

// 1. BudgetSchedule rows
const scheds = await prisma.budgetSchedule.findMany({ orderBy: { createdAt: 'desc' } })
out(`BudgetSchedule rows: ${scheds.length}`)
for (const s of scheds) {
  const ws = Array.isArray(s.windows) ? s.windows as any[] : []
  const cs = Array.isArray(s.campaigns) ? s.campaigns as any[] : []
  const ex = Array.isArray(s.excludeDates) ? s.excludeDates as any[] : []
  const la = (s.lastApplied ?? null) as any
  console.log(`  · ${s.id} "${s.name}" kind=${s.kind} type=${s.type} enabled=${s.enabled} tz=${s.timezone}`)
  console.log(`      windows=${ws.length} campaigns=${cs.length} exclude=${ex.length} autoRefill=${s.autoRefill} neverExpire=${s.neverExpire}`)
  console.log(`      start=${s.startDate?.toISOString().slice(0,10) ?? '—'} end=${s.endDate?.toISOString().slice(0,10) ?? '—'} lastEval=${s.lastEvaluatedAt?.toISOString() ?? 'NEVER'} lastApplied=${la ? Object.keys(la).length + ' campaigns' : 'null'}`)
  console.log(`      createdAt=${s.createdAt.toISOString()} createdBy=${s.createdBy ?? '—'}`)
  if (ws.length) console.log(`      windows sample: ${JSON.stringify(ws.slice(0,3))}`)
}

// 2. cron run history for ad-budget-schedule
const runs = await prisma.cronRun.findMany({ where: { jobName: 'ad-budget-schedule' }, orderBy: { startedAt: 'desc' }, take: 8 }).catch(() => [] as any[])
out(`ad-budget-schedule cron runs (latest 8): ${runs.length}`)
for (const r of runs as any[]) console.log(`  · ${r.startedAt?.toISOString?.() ?? r.startedAt} status=${r.status} summary=${r.outputSummary ?? r.errorMessage ?? '—'}`)

// 3. AdSpendCeiling
const ceil = await prisma.adSpendCeiling.count()
out(`AdSpendCeiling rows: ${ceil}`)

// 4. AdBudgetPlan
const plans = await prisma.adBudgetPlan.findMany({ orderBy: { month: 'desc' }, take: 12 })
out(`AdBudgetPlan rows: ${plans.length} (latest 12)`)
for (const p of plans) console.log(`  · ${p.month} ${p.marketplace}${p.tag ? '/'+p.tag : ''} €${(p.monthlyBudgetCents/100).toFixed(2)}/mo autoPacing=${p.autoPacing} stopOverSpend=${p.stopOverSpend} calendar=${Array.isArray(p.calendar)?(p.calendar as any[]).length:0} limits=${Array.isArray(p.campaignLimits)?(p.campaignLimits as any[]).length:0}`)

await prisma.$disconnect()
