/**
 * BUD — verify the two zeros from _bud-page-state816: "0 budget writes in 72h" and
 * "0 cap refusals in 7d". A swallowed error and a moved record both read exactly like zero.
 * READ-ONLY.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const now = Date.now()

// ── A. is the action log alive at all, or is the whole table quiet? ──────────
const byType = await prisma.advertisingActionLog.groupBy({
  by: ['actionType'],
  where: { createdAt: { gte: new Date(now - 3 * 86_400_000) } },
  _count: { _all: true },
})
console.log(`\n══ A · AdvertisingActionLog, ALL actionTypes, 72h ══`)
if (!byType.length) console.log(`  🔴 the whole table is quiet for 72h — this is not a budget finding`)
for (const t of byType.sort((a, b) => b._count._all - a._count._all).slice(0, 12)) console.log(`     ${pad(t.actionType, 34)} ${t._count._all}`)
const newest = await prisma.advertisingActionLog.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true, actionType: true, userId: true } })
console.log(`  newest row of ANY type: ${newest?.createdAt.toISOString().slice(0, 16)}  ${newest?.actionType}  ${newest?.userId}`)
const newestBudget = await prisma.advertisingActionLog.findFirst({ where: { actionType: 'AD_BUDGET_UPDATE' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, userId: true, payloadBefore: true, payloadAfter: true } })
console.log(`  newest AD_BUDGET_UPDATE: ${newestBudget?.createdAt.toISOString().slice(0, 16)}  ${newestBudget?.userId}`)

// ── B. did budgets move WITHOUT an audit row? Campaign.updatedAt vs the log ──
const camps = await prisma.campaign.findMany({
  where: { status: 'ENABLED' },
  select: { id: true, name: true, dailyBudget: true, updatedAt: true, budgetBaselineCents: true },
})
const movedRecently = camps.filter((c) => c.updatedAt.getTime() > now - 3 * 86_400_000)
console.log(`\n══ B · Campaign.updatedAt in 72h (a budget can move with no audit row) ══`)
console.log(`  ENABLED campaigns touched in 72h: ${movedRecently.length} of ${camps.length}`)
for (const c of movedRecently.slice(0, 10)) console.log(`     ${pad(c.name, 40)} €${Number(c.dailyBudget ?? 0).toFixed(2).padStart(7)}  updated ${c.updatedAt.toISOString().slice(0, 16)}`)

// ── C. are the rules even running? ──────────────────────────────────────────
const all = await prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { id: true, name: true, actions: true } })
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? ''))
const budgetRules = all.filter((r) => types(r.actions).some((t) => t === 'adjust_ad_budget'))
const ex = await prisma.automationRuleExecution.groupBy({
  by: ['ruleId', 'status'],
  where: { startedAt: { gte: new Date(now - 3 * 86_400_000) } },
  _count: { _all: true },
})
console.log(`\n══ C · executions, ALL advertising rules, 72h ══`)
console.log(`  total execution rows: ${ex.reduce((a, e) => a + e._count._all, 0)}`)
for (const r of budgetRules) {
  const mine = ex.filter((e) => e.ruleId === r.id)
  if (!mine.length) { console.log(`     ${pad(r.name, 40)} — no executions in 72h`); continue }
  console.log(`     ${pad(r.name, 40)} ${mine.map((m) => `${m.status}=${m._count._all}`).join(' · ')}`)
}
const newestEx = await prisma.automationRuleExecution.findFirst({ orderBy: { startedAt: 'desc' }, select: { startedAt: true, status: true, errorMessage: true } })
console.log(`  newest execution of ANY rule: ${newestEx?.startedAt.toISOString().slice(0, 16)} ${newestEx?.status} ${newestEx?.errorMessage ?? ''}`)

// ── D. where do refusals live NOW? every distinct errorMessage, 7d ───────────
const errs = await prisma.automationRuleExecution.groupBy({
  by: ['errorMessage'],
  where: { startedAt: { gte: new Date(now - 7 * 86_400_000) }, NOT: { errorMessage: null } },
  _count: { _all: true },
})
console.log(`\n══ D · every non-null errorMessage, 7d — where a refusal is recorded now ══`)
if (!errs.length) console.log(`  none`)
for (const e of errs.sort((a, b) => b._count._all - a._count._all).slice(0, 15)) console.log(`     ${pad(String(e.errorMessage), 52)} ${e._count._all}`)

// ── E. the A7 spend-ceiling refusal record — does that table exist and hold rows? ──
for (const model of ['adWriteRefusal', 'adSpendCeiling', 'advertisingWriteRefusal', 'adGateRefusal'] as const) {
  const client = prisma as unknown as Record<string, { count?: () => Promise<number> }>
  if (client[model]?.count) {
    const n = await client[model].count!().catch(() => -1)
    console.log(`  prisma.${model}.count() = ${n}`)
  }
}

// ── F. the outbound queue — did writes reach Amazon, or stall? ───────────────
const q = await prisma.outboundSyncQueue.groupBy({
  by: ['syncStatus'],
  where: { createdAt: { gte: new Date(now - 7 * 86_400_000) } },
  _count: { _all: true },
}).catch((e) => { console.log(`  outboundSyncQueue groupBy failed: ${(e as Error).message.slice(0, 120)}`); return [] })
console.log(`\n══ F · OutboundSyncQueue, 7d (BUD.1: syncStatus is the truth, not amazonResponseStatus) ══`)
for (const s of q) console.log(`     ${pad(String(s.syncStatus), 20)} ${s._count._all}`)

await prisma.$disconnect()
