/**
 * NEG.8 — the record, measured before anything is built. READ-ONLY.
 *
 * 🔴 The headline this section exists to render: `protectConverting` refusals carry the TERM, the
 * ORDER COUNT and the SALES, and they live inside `AutomationRuleExecution.actionResults` JSON —
 * not in `AdvertisingActionLog`. Nothing on any screen has ever shown them, and they are the proof
 * that NEG.0's fix paid for itself.
 *
 * 🔴 And the null trap, which has already produced one broken counter with a 230,032-row blind
 * spot: in SQL `NOT(x = 'X')` is NULL — not true — when x IS NULL. Every exclusion filter over a
 * nullable column is measured here both ways.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)

console.log('\n═══ NEG.8 — the record ═══\n')

// ── 1 · the ledger base ───────────────────────────────────────────────────────────────────────
h('1 · AdvertisingActionLog, AD_TARGET rows')
const logs = await prisma.advertisingActionLog.findMany({
  where: { entityType: 'AD_TARGET' },
  select: { id: true, actionType: true, entityId: true, userId: true, executionId: true, evidence: true, createdAt: true, amazonResponseStatus: true },
  orderBy: { createdAt: 'desc' },
})
console.log(`  AD_TARGET action logs: ${int(logs.length)}`)
const byType = new Map<string, number>()
for (const l of logs) byType.set(l.actionType, (byType.get(l.actionType) ?? 0) + 1)
for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`    ${t.padEnd(34)} ${int(n)}`)

// 🔴 the ledger must show NEGATIVE targets only — a positive keyword must never appear
const targetIds = [...new Set(logs.map((l) => l.entityId))]
const targets = await prisma.adTarget.findMany({
  where: { id: { in: targetIds } },
  select: { id: true, isNegative: true, expressionValue: true },
})
const isNeg = new Map(targets.map((t) => [t.id, t.isNegative]))

/**
 * 🔴 THE JOIN CANNOT BE THE ONLY FILTER. A local-only retirement DELETES the AdTarget row, so the
 * two `retire_negative` logs — the richest evidence in the whole ledger, with a real user id and a
 * full note — point at targets that no longer exist. Filtering on `isNegative === true` drops
 * exactly the rows that record a removal.
 *
 * So: the action type decides where it is unambiguous, and the join only arbitrates the two types
 * that can be either.
 */
const NEG_ACTIONS = new Set(['create_negative_keyword', 'create_negative_product_target', 'retire_negative'])
const POS_ACTIONS = new Set(['create_keyword', 'push_keyword', 'create_target'])
const AMBIGUOUS = new Set(['AD_ENTITY_STATE_UPDATE', 'AD_BID_UPDATE'])
const belongsHere = (l: { actionType: string; entityId: string }) =>
  NEG_ACTIONS.has(l.actionType) || (AMBIGUOUS.has(l.actionType) && isNeg.get(l.entityId) === true)

const negLogs = logs.filter(belongsHere)
const posLogs = logs.filter((l) => POS_ACTIONS.has(l.actionType) || (AMBIGUOUS.has(l.actionType) && isNeg.get(l.entityId) === false))
const unknown = logs.filter((l) => !isNeg.has(l.entityId))
const droppedByJoin = logs.filter((l) => NEG_ACTIONS.has(l.actionType) && !isNeg.has(l.entityId))
console.log(`  → negative ${int(negLogs.length)} · positive ${int(posLogs.length)} · target no longer exists ${int(unknown.length)}`)
console.log(`  🔴 a ledger filtered by actionType alone would show ${int(posLogs.length)} positive-keyword rows on a negatives page`)
console.log(`  🔴 a ledger filtered by the isNegative JOIN alone would DROP ${int(droppedByJoin.length)} negative rows whose target was deleted:`)
for (const l of droppedByJoin) console.log(`       ${l.createdAt.toISOString().slice(0, 10)} ${l.actionType} by ${l.userId ?? '—'}${l.evidence ? ' (WITH evidence)' : ''}`)

h('1b · evidence, and the cutover')
const withEv = negLogs.filter((l) => l.evidence != null)
console.log(`  negative logs carrying evidence: ${int(withEv.length)} of ${int(negLogs.length)}`)
for (const [t] of byType) {
  const rows = negLogs.filter((l) => l.actionType === t)
  if (!rows.length) continue
  const ev = rows.filter((l) => l.evidence != null).length
  const oldest = rows[rows.length - 1]?.createdAt.toISOString().slice(0, 10)
  const newest = rows[0]?.createdAt.toISOString().slice(0, 10)
  console.log(`    ${t.padEnd(34)} ${String(ev).padStart(4)}/${String(rows.length).padEnd(5)} with evidence · ${oldest} → ${newest}`)
}

h('1c · actor vocabulary — four values, never a blank')
const actor = (l: { userId: string | null; executionId: string | null }) => {
  if (l.userId?.startsWith('automation:')) return 'engine'
  if (l.userId) return 'user'
  if (l.executionId) return 'actor-not-recorded'
  return 'unattributed'
}
const byActor = new Map<string, number>()
for (const l of negLogs) byActor.set(actor(l), (byActor.get(actor(l)) ?? 0) + 1)
for (const [a, n] of [...byActor].sort((x, y) => y[1] - x[1])) console.log(`    ${a.padEnd(22)} ${int(n)}`)
const negatives = await prisma.adTarget.count({ where: { isNegative: true } })
const loggedNegatives = new Set(negLogs.map((l) => l.entityId)).size
console.log(`  🔴 ${int(negatives - loggedNegatives)} of ${int(negatives)} negatives have NO log at all — unattributed as a FACT, never a blank`)

// ── 2 · 🔴 protection refusals, with the money ────────────────────────────────────────────────
h('2 · 🔴 protectConverting refusals — the valuable ones')
const execs = await prisma.automationRuleExecution.findMany({
  where: { startedAt: { gte: new Date(Date.now() - 60 * 86400_000) } },
  orderBy: { startedAt: 'desc' },
  take: 4000,
  select: { actionResults: true, startedAt: true, ruleId: true },
})
type Refusal = { term: string; orders: number; salesCents: number; market: string | null; at: Date }
const refusals: Refusal[] = []
for (const e of execs) {
  for (const a of (Array.isArray(e.actionResults) ? (e.actionResults as Array<Record<string, unknown>>) : [])) {
    const out = (a?.output ?? {}) as Record<string, unknown>
    if (out.refusedBy !== 'protectConverting') continue
    const ev = (out.evidence ?? {}) as Record<string, unknown>
    refusals.push({
      term: String(ev.term ?? out.keyword ?? '—'),
      orders: Number(ev.orders ?? 0),
      salesCents: Number(ev.salesCents ?? 0),
      market: ev.marketplace ? String(ev.marketplace) : null,
      at: e.startedAt,
    })
  }
}
console.log(`  refusals found in a ${int(execs.length)}-execution sample: ${int(refusals.length)}`)
const byTerm = new Map<string, Refusal & { times: number }>()
for (const r of refusals) {
  const prev = byTerm.get(r.term)
  if (prev) prev.times++
  else byTerm.set(r.term, { ...r, times: 1 })
}
for (const r of [...byTerm.values()].sort((a, b) => b.salesCents - a.salesCents)) {
  console.log(`    ${r.term.padEnd(40)} ${r.orders} orders · ${eur(r.salesCents).padStart(9)} ${r.market ?? ''} · refused ${r.times}×`)
}
const withOrders = [...byTerm.values()].filter((r) => r.orders > 0)
console.log(`  🔴 ${withOrders.length} distinct terms refused while EARNING — total sales on those terms ${eur(withOrders.reduce((a, r) => a + r.salesCents, 0))}`)
console.log(`     (that is what the terms MADE, never what was "saved" — the saving is unknowable)`)

// ── 3 · 🔴 the null-safe cap count ────────────────────────────────────────────────────────────
h('3 · 🔴 cap refusals, and the counter that cannot see them')
const since = new Date(Date.now() - 60 * 86400_000)
const nullErr = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: since }, errorMessage: null } })
const brokenClause = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: since }, NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' } } })
const nullSafe = await prisma.automationRuleExecution.count({
  where: { startedAt: { gte: since }, OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }] },
})
const capRows = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: since }, errorMessage: 'DAILY_CAP_EXCEEDED' } })
const total = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: since } } })
console.log(`  executions in 60d              ${int(total)}`)
console.log(`  errorMessage IS NULL           ${int(nullErr)}`)
console.log(`  DAILY_CAP_EXCEEDED             ${int(capRows)}`)
console.log(`  NOT(errorMessage='DAILY…')     ${int(brokenClause)}   ← the counter at automation-rule.service.ts:573`)
console.log(`  null-safe OR form              ${int(nullSafe)}   ← what it should be`)
console.log(`  🔴 blind spot: ${int(nullSafe - brokenClause)} rows the broken clause cannot see`)

// ── 4 · gate denials — no table ───────────────────────────────────────────────────────────────
h('4 · gate denials')
console.log('  `logGateDeny` (ads-write-gate.ts:358) calls logger.warn and nothing else.')
console.log('  🔴 There is NO table. A count cannot be produced and must not be invented — the page')
console.log('     can only show denials an EXECUTION happened to record in its own actionResults.')
const denialsInExec = execs.filter((e) => JSON.stringify(e.actionResults).includes('Write gate denied')).length
console.log(`  executions whose actionResults mention a gate denial: ${int(denialsInExec)}`)

// ── 5 · alert_operator ────────────────────────────────────────────────────────────────────────
h('5 · alert_operator')
const { readFileSync } = await import('node:fs')
const handlers = readFileSync('src/services/advertising/automation-action-handlers.ts', 'utf8')
const alertBlock = handlers.slice(handlers.indexOf('ACTION_HANDLERS.alert_operator'), handlers.indexOf('ACTION_HANDLERS.alert_operator') + 700)
console.log(`  calls notifyAutomation: ${alertBlock.includes('notifyAutomation') ? 'yes' : '🔴 NO — it only logger.warn()s'}`)
const rulesWithAlert = await prisma.automationRule.count({ where: { domain: 'advertising' } })
console.log(`  🔴 the action named "alert operator" does not reach the bell, the feed or the inbox.`)

// ── 6 · retirements ───────────────────────────────────────────────────────────────────────────
h('6 · retirements through Nexus')
const retired = await prisma.adTarget.count({ where: { retiredAt: { not: null } } })
const orphaned = await prisma.adTarget.count({ where: { isNegative: true, orphanedAt: { not: null } } })
const reviews = await prisma.adNegativeReview.count()
console.log(`  AdTarget.retiredAt set   ${int(retired)}`)
console.log(`  orphaned negatives       ${int(orphaned)}   (NEG.3's trap — non-zero must page someone)`)
console.log(`  AdNegativeReview rows    ${int(reviews)}`)

await prisma.$disconnect()
console.log('\n═══ done ═══\n')
