/**
 * BUD.1 — the poll cursor, proven, plus a re-verification of the census this page will render.
 *
 * Bid's cursor is `{ targetsAt, loggedAt, n }` because an inbound resync moves the value and
 * writes no audit row. Budget needs the same question asked of ITS spine:
 *
 *   1. Does `Campaign.updatedAt` actually move when a budget moves?  (if not, it is not a cursor)
 *   2. How often does it move WITHOUT a budget moving?               (if always, the banner is noise)
 *   3. Does the audit log move without `Campaign.updatedAt`?         (the PENDING / repeat case)
 *   4. Does a rules-view number move with neither?                   (a refusal is not a write)
 *
 * READ-ONLY. No writes, no mutations.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveAutonomy } = await import('../src/services/advertising/ads-autonomy.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 19).replace('T', ' ') : '—')
const now = Date.now()
const H24 = new Date(now - 86_400_000)
const H6 = new Date(now - 6 * 3_600_000)
const D7 = new Date(now - 7 * 86_400_000)

console.log(`\n════ BUD.1 cursor probe · ${new Date().toISOString()} ════`)

// ── 1 · the four cursor candidates, right now ────────────────────────────────────────────────
const budgetRules = (await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, dryRun: true, autonomyLevel: true, trigger: true, actions: true, conditions: true, maxExecutionsPerDay: true, maxValueCentsEur: true, scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true, evaluationCount: true, matchCount: true, executionCount: true, lastExecutedAt: true },
})).filter((r) => (Array.isArray(r.actions) ? r.actions : []).some((a) => String((a as { type?: unknown })?.type ?? '') === 'adjust_ad_budget'))
const ruleIds = budgetRules.map((r) => r.id)

const [campNewest, campN, logNewest, logN, execNewest] = await Promise.all([
  prisma.campaign.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true, name: true } }),
  prisma.campaign.count(),
  prisma.advertisingActionLog.findFirst({ where: { actionType: 'AD_BUDGET_UPDATE' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  prisma.advertisingActionLog.count({ where: { actionType: 'AD_BUDGET_UPDATE' } }),
  prisma.automationRuleExecution.findFirst({ where: { ruleId: { in: ruleIds } }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } }),
])
console.log(`\n── 1 · cursor candidates ──`)
console.log(`  campaignsAt  max(Campaign.updatedAt)                    = ${iso(campNewest?.updatedAt)}   (${campNewest?.name?.slice(0, 40) ?? ''})`)
console.log(`  loggedAt     max(log.createdAt AD_BUDGET_UPDATE)        = ${iso(logNewest?.createdAt)}`)
console.log(`  execAt       max(exec.startedAt for budget rules)       = ${iso(execNewest?.startedAt)}`)
console.log(`  n            Campaign.count()                          = ${campN}      (AD_BUDGET_UPDATE rows ever: ${logN})`)
const spreadMin = campNewest && logNewest ? Math.round(Math.abs(+campNewest.updatedAt - +logNewest.createdAt) / 60000) : null
console.log(`  → campaignsAt vs loggedAt drift right now: ${spreadMin} min`)

// ── 2 · does Campaign.updatedAt move when a budget moves? ────────────────────────────────────
const logs24 = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_BUDGET_UPDATE', createdAt: { gte: H24 } },
  select: { entityId: true, createdAt: true, userId: true, payloadBefore: true, payloadAfter: true, amazonResponseStatus: true },
  orderBy: { createdAt: 'desc' },
})
const touchedIds = [...new Set(logs24.map((l) => l.entityId))]
const touched = await prisma.campaign.findMany({
  where: { id: { in: touchedIds } },
  select: { id: true, name: true, updatedAt: true, dailyBudget: true, status: true, liveBidWritesEnabled: true },
})
const byId = new Map(touched.map((c) => [c.id, c]))
let movedWith = 0
let notMoved = 0
for (const id of touchedIds) {
  const c = byId.get(id)
  const newestLog = logs24.find((l) => l.entityId === id)!
  if (c && +c.updatedAt >= +newestLog.createdAt - 5000) movedWith++
  else notMoved++
}
console.log(`\n── 2 · did Campaign.updatedAt move with the write? (last 24h) ──`)
console.log(`  campaigns with an AD_BUDGET_UPDATE row : ${touchedIds.length}`)
console.log(`  ...whose Campaign.updatedAt is >= that row : ${movedWith}`)
console.log(`  ...whose Campaign.updatedAt is BEHIND it   : ${notMoved}   ${notMoved > 0 ? '🔴 the log moves without the local row' : ''}`)

// ── 3 · how noisy is Campaign.updatedAt on its own? ──────────────────────────────────────────
const campMoved24 = await prisma.campaign.count({ where: { updatedAt: { gte: H24 } } })
const campMoved6 = await prisma.campaign.count({ where: { updatedAt: { gte: H6 } } })
console.log(`\n── 3 · Campaign.updatedAt noise ──`)
console.log(`  campaigns whose row changed in 24h : ${campMoved24} of ${campN}`)
console.log(`  ...in the last 6h                  : ${campMoved6}`)
console.log(`  campaigns with a BUDGET write in 24h: ${touchedIds.length}`)
console.log(`  → moved for some other reason      : ${campMoved24 - touchedIds.length}`)

// ── 4 · the repeat write: same payloadBefore twice in a row ──────────────────────────────────
const logs7 = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_BUDGET_UPDATE', createdAt: { gte: D7 } },
  select: { entityId: true, createdAt: true, payloadBefore: true, payloadAfter: true, amazonResponseStatus: true, userId: true },
  orderBy: { createdAt: 'asc' },
})
const bud = (v: unknown) => { const o = v as Record<string, unknown> | null; const x = o?.dailyBudget; return typeof x === 'number' ? x : null }
const seq = new Map<string, Array<{ at: Date; b: number | null; a: number | null }>>()
for (const l of logs7) {
  if (!seq.has(l.entityId)) seq.set(l.entityId, [])
  seq.get(l.entityId)!.push({ at: l.createdAt, b: bud(l.payloadBefore), a: bud(l.payloadAfter) })
}
let repeats = 0
let chainBreaks = 0
for (const rows of seq.values()) {
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].b === rows[i - 1].b && rows[i].a === rows[i - 1].a) repeats++
    if (rows[i].b !== rows[i - 1].a) chainBreaks++
  }
}
const pending = logs7.filter((l) => l.amazonResponseStatus === 'PENDING').length
console.log(`\n── 4 · the repeat-write loop (7 days, ${logs7.length} rows) ──`)
console.log(`  consecutive rows with IDENTICAL before→after : ${repeats}`)
console.log(`  rows whose before != previous after (chain break) : ${chainBreaks}`)
console.log(`  PENDING rows : ${pending}`)

// ── 5 · the census this page will render ─────────────────────────────────────────────────────
const enabled = await prisma.campaign.findMany({
  where: { status: 'ENABLED' },
  select: { id: true, name: true, marketplace: true, dailyBudget: true, liveBidWritesEnabled: true, updatedAt: true },
})
const b = (c: { dailyBudget: unknown }) => Number(c.dailyBudget)
const atFloor = enabled.filter((c) => b(c) <= 1)
const above = enabled.filter((c) => b(c) > 1)
const aboveGateOpen = above.filter((c) => c.liveBidWritesEnabled)
console.log(`\n── 5 · census (ENABLED campaigns) ──`)
console.log(`  ENABLED                       : ${enabled.length}`)
console.log(`  at or below the €1 floor      : ${atFloor.length}`)
console.log(`  above €1                      : ${above.length}`)
console.log(`  above €1 AND gate open        : ${aboveGateOpen.length}   ← what a trim can still move`)
console.log(`  above €1 but gate CLOSED      : ${above.length - aboveGateOpen.length}`)
console.log(`  gate open across all ENABLED  : ${enabled.filter((c) => c.liveBidWritesEnabled).length}`)
console.log(`  total daily budget (ENABLED)  : €${enabled.reduce((s, c) => s + b(c), 0).toFixed(2)}`)

// ── 6 · euros, not cents ─────────────────────────────────────────────────────────────────────
let asEuros = 0
let asCents = 0
let compared = 0
for (const l of logs24) {
  const c = byId.get(l.entityId)
  const after = bud(l.payloadAfter)
  if (!c || after == null) continue
  compared++
  if (Math.abs(after - Number(c.dailyBudget)) < 0.02) asEuros++
  if (Math.abs(after / 100 - Number(c.dailyBudget)) < 0.02) asCents++
}
console.log(`\n── 6 · payloadAfter.dailyBudget units (newest row per campaign vs live value) ──`)
console.log(`  compared ${compared} · matches as EUROS ${asEuros} · matches if divided by 100 ${asCents}`)

// ── 7 · the writers, last 24h ────────────────────────────────────────────────────────────────
const writers = new Map<string, { n: number; up: number; down: number }>()
for (const l of logs24) {
  const k = String(l.userId ?? 'null')
  const w = writers.get(k) ?? { n: 0, up: 0, down: 0 }
  w.n++
  const bb = bud(l.payloadBefore); const aa = bud(l.payloadAfter)
  if (bb != null && aa != null) { if (aa > bb) w.up++; else if (aa < bb) w.down++ }
  writers.set(k, w)
}
console.log(`\n── 7 · budget writers, last 24h (${logs24.length} rows) ──`)
for (const [k, w] of [...writers].sort((x, y) => y[1].n - x[1].n)) console.log(`  ${pad(k, 46)} ${pad(String(w.n), 5)} ↓${w.down} ↑${w.up}`)

// ── 8 · the rules, with their EFFECTIVE level ────────────────────────────────────────────────
console.log(`\n── 8 · adjust_ad_budget rules (${budgetRules.length}) ──`)
for (const r of budgetRules) {
  const lvl = resolveAutonomy({ enabled: r.enabled, dryRun: r.dryRun, autonomyLevel: r.autonomyLevel })
  const acts = (Array.isArray(r.actions) ? r.actions : []).map((a) => { const o = a as Record<string, unknown>; return `${o.type}${o.percent != null ? ` ${o.percent}%` : ''}` }).join(' + ')
  const scope = [r.scopeMarketplace && `mkt=${r.scopeMarketplace}`, r.scopePortfolioId && 'pf', r.scopeCampaignId && 'camp', r.scopeProductId && 'prod'].filter(Boolean).join(',') || 'ACCOUNT-WIDE'
  console.log(`  ${pad(r.name, 42)} lvl=${pad(lvl, 8)} enabled=${r.enabled ? 'Y' : 'n'} trig=${pad(r.trigger, 30)} cap=${pad(String(r.maxExecutionsPerDay ?? '—'), 5)} scope=${scope}`)
  console.log(`      actions: ${acts}`)
  console.log(`      evals=${r.evaluationCount} matches=${r.matchCount} execs=${r.executionCount} lastExec=${iso(r.lastExecutedAt)}`)
}

// ── 9 · is the daily cap enforced? both predicates, today ────────────────────────────────────
const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0)
console.log(`\n── 9 · maxExecutionsPerDay, today (since ${iso(dayStart)}) ──`)
for (const r of budgetRules.filter((x) => x.maxExecutionsPerDay != null)) {
  const [a] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT COUNT(*)::bigint AS n FROM "AutomationRuleExecution" WHERE "ruleId" = $1 AND "startedAt" >= $2 AND NOT ("errorMessage" = 'DAILY_CAP_EXCEEDED')`, r.id, dayStart)
  const [c] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT COUNT(*)::bigint AS n FROM "AutomationRuleExecution" WHERE "ruleId" = $1 AND "startedAt" >= $2 AND ("errorMessage" IS DISTINCT FROM 'DAILY_CAP_EXCEEDED')`, r.id, dayStart)
  const all = await prisma.automationRuleExecution.count({ where: { ruleId: r.id, startedAt: { gte: dayStart } } })
  console.log(`  ${pad(r.name, 42)} cap=${pad(String(r.maxExecutionsPerDay), 4)} asWritten=${pad(String(a?.n), 5)} isDistinct=${pad(String(c?.n), 5)} allRows=${pad(String(all), 5)} ${r.maxExecutionsPerDay != null && Number(a?.n ?? 0) >= r.maxExecutionsPerDay ? 'would trip' : '🔴 open'}`)
}

// ── 10 · outcomes for the rules view: evaluated / matched / wrote / refused, 7d ───────────────
console.log(`\n── 10 · execution outcomes, 7 days ──`)
for (const r of budgetRules) {
  const rows = await prisma.automationRuleExecution.groupBy({
    by: ['status', 'errorMessage'], where: { ruleId: r.id, startedAt: { gte: D7 } }, _count: { _all: true },
  })
  if (!rows.length) { console.log(`  ${pad(r.name, 42)} — no executions in 7 days`); continue }
  const parts = rows.sort((x, y) => y._count._all - x._count._all).map((x) => `${x.status}${x.errorMessage ? `/${x.errorMessage.slice(0, 22)}` : ''}=${x._count._all}`)
  console.log(`  ${pad(r.name, 42)} ${parts.join(' · ')}`)
}

// ── 11 · log vs live divergence: the incomplete history ──────────────────────────────────────
let diverged = 0
const divergedRows: string[] = []
for (const [id, rows] of seq) {
  const c = byId.get(id) ?? (await prisma.campaign.findUnique({ where: { id }, select: { name: true, dailyBudget: true } }).then((x) => x ? { name: x.name, dailyBudget: x.dailyBudget } : null))
  if (!c) continue
  const last = rows[rows.length - 1]
  if (last.a != null && Math.abs(last.a - Number(c.dailyBudget)) > 0.02) {
    diverged++
    if (divergedRows.length < 8) divergedRows.push(`  ${pad(c.name.slice(0, 44), 44)} log says €${last.a.toFixed(2)} · Campaign says €${Number(c.dailyBudget).toFixed(2)}`)
  }
}
console.log(`\n── 11 · campaigns whose newest log row disagrees with the live value ──`)
console.log(`  ${diverged} of ${seq.size} campaigns with a write in 7 days`)
for (const l of divergedRows) console.log(l)

await prisma.$disconnect()
