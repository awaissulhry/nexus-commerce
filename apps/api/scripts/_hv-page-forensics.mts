/**
 * HV page study — forensics. READ-ONLY: no writes, no mutations.
 *
 * Re-measures three claims from docs/2026-08-11-hv-keyword-harvest-study.md that I doubt after
 * reading the code, plus the things that study could not have known:
 *   1. "promote_to_exact calls createKeywordLocal with NO existence check" — H.1 (2026-06-23)
 *      added one. So WHEN were the 256 duplicate rows written? Before or after the guard?
 *   2. the ASIN-as-keyword rows — which ad group, when, and who wrote them
 *   3. does a graduated keyword get a source negative? (H.3 isolation only fires with a destination)
 *   4. the engines' own run records (CronRun uses jobName/outputSummary, not name/result)
 *   5. auto-targeting search terms: what matchType do they actually carry?
 *   6. promote_to_exact's dry-run outputs — what did it propose, 400 ticks deep?
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const H1_SHIPPED = new Date('2026-06-23T00:00:00Z') // commit a105edcd9 — "H.1 — idempotent"
const now = Date.now()

console.log('\n═══ HV page — forensics ═══\n')

// ── 1. the duplicates, dated against the H.1 guard ────────────────────────────
console.log('═══ 1 · the 256 phantom keywords — before or after the idempotence guard? ═══\n')
const pos = await prisma.adTarget.findMany({
  where: { kind: 'KEYWORD', isNegative: false },
  select: { id: true, adGroupId: true, expressionType: true, expressionValue: true, externalTargetId: true, createdAt: true, bidCents: true, status: true, lastSyncStatus: true },
})
console.log(`positive KEYWORD AdTarget rows: ${int(pos.length)}`)
const groups = new Map<string, typeof pos>()
for (const t of pos) {
  const k = `${t.adGroupId}|${t.expressionType.toUpperCase()}|${t.expressionValue.trim().toLowerCase()}`
  const g = groups.get(k) ?? []
  g.push(t); groups.set(k, g)
}
const dupGroups = [...groups.entries()].filter(([, g]) => g.length > 1)
const redundant = dupGroups.reduce((n, [, g]) => n + g.length - 1, 0)
console.log(`exact-duplicate groups (same ad group · same match type · same text, case-insensitive): ${dupGroups.length}`)
console.log(`redundant rows (group size − 1): ${int(redundant)}\n`)

let afterGuard = 0, beforeGuard = 0
const dupDates: Date[] = []
for (const [, g] of dupGroups) for (const t of g) { dupDates.push(t.createdAt); if (t.createdAt >= H1_SHIPPED) afterGuard++; else beforeGuard++ }
dupDates.sort((a, b) => a.getTime() - b.getTime())
console.log(`rows inside a duplicate group, by creation date vs H.1 (2026-06-23):`)
console.log(`  BEFORE the guard shipped: ${int(beforeGuard)}`)
console.log(`  AFTER  the guard shipped: ${int(afterGuard)}   ← if 0, the guard holds and the phantoms are legacy`)
console.log(`  earliest ${dupDates[0]?.toISOString().slice(0, 10)} · latest ${dupDates[dupDates.length - 1]?.toISOString().slice(0, 10)}`)

// distribution of the whole positive population by date, to see whether ANY writing is recent
const byMonth = new Map<string, number>()
for (const t of pos) { const m = t.createdAt.toISOString().slice(0, 7); byMonth.set(m, (byMonth.get(m) ?? 0) + 1) }
console.log(`\nall positive keywords by creation month: ${[...byMonth.entries()].sort().map(([m, n]) => `${m}=${n}`).join(' · ')}`)

console.log(`\ntop duplicate groups:`)
console.log(`${pad('keyword', 34)} ${pad('match', 7)} ${pad('rows', 5)} ${pad('with amazon id', 14)} ${pad('created', 22)} ad group`)
const agById = new Map((await prisma.adGroup.findMany({ select: { id: true, name: true, campaign: { select: { name: true } } } })).map((a) => [a.id, `${a.campaign?.name ?? '?'} › ${a.name}`]))
for (const [k, g] of dupGroups.sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
  const [agId, mt, text] = k.split('|')
  const dates = g.map((t) => t.createdAt).sort((a, b) => a.getTime() - b.getTime())
  const span = `${dates[0].toISOString().slice(0, 10)}→${dates[dates.length - 1].toISOString().slice(0, 10)}`
  console.log(`${pad(text, 34)} ${pad(mt, 7)} ${pad(String(g.length), 5)} ${pad(String(g.filter((t) => t.externalTargetId).length), 14)} ${pad(span, 22)} ${(agById.get(agId) ?? agId).slice(0, 44)}`)
}

// ── 2. ASINs written as keywords ──────────────────────────────────────────────
console.log('\n\n═══ 2 · ASINs stored as KEYWORD targets ═══\n')
const isAsin = (q: string) => /^b0[a-z0-9]{8}$/i.test(q.trim())
const asinKw = pos.filter((t) => isAsin(t.expressionValue))
console.log(`positive KEYWORD rows whose text is an ASIN: ${asinKw.length}`)
if (asinKw.length) {
  const byVal = new Map<string, typeof asinKw>()
  for (const t of asinKw) { const v = t.expressionValue.toLowerCase(); const g = byVal.get(v) ?? []; g.push(t); byVal.set(v, g) }
  console.log(`${pad('asin', 14)} ${pad('rows', 5)} ${pad('w/ amazon id', 12)} ${pad('created', 24)} ad groups`)
  for (const [v, g] of [...byVal.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const d = g.map((t) => t.createdAt).sort((a, b) => a.getTime() - b.getTime())
    console.log(`${pad(v, 14)} ${pad(String(g.length), 5)} ${pad(String(g.filter((t) => t.externalTargetId).length), 12)} ${pad(`${d[0].toISOString().slice(0, 10)}→${d[d.length - 1].toISOString().slice(0, 10)}`, 24)} ${new Set(g.map((t) => agById.get(t.adGroupId) ?? t.adGroupId)).size}`)
  }
  const after = asinKw.filter((t) => t.createdAt >= H1_SHIPPED).length
  console.log(`\nASIN-as-keyword rows created AFTER H.5 (ASIN routing) shipped 2026-06-23: ${after}`)
  // who wrote them, per the audit log
  const ids = asinKw.map((t) => t.id)
  const logs = await prisma.advertisingActionLog.findMany({ where: { entityType: 'AD_TARGET', entityId: { in: ids } }, select: { userId: true, executionId: true, actionType: true, createdAt: true } })
  const byWriter = new Map<string, number>()
  for (const l of logs) byWriter.set(l.executionId ? `rule-execution` : (l.userId ?? '(no userId)'), (byWriter.get(l.executionId ? 'rule-execution' : (l.userId ?? '(no userId)')) ?? 0) + 1)
  console.log(`audit rows for those targets: ${logs.length} — writers: ${[...byWriter.entries()].map(([w, n]) => `${w}=${n}`).join(' · ')}`)
}

// ── 3. does a graduation get a source negative? ───────────────────────────────
console.log('\n\n═══ 3 · promotion without isolation ═══\n')
const negs = await prisma.adTarget.findMany({ where: { kind: 'KEYWORD', isNegative: true }, select: { adGroupId: true, expressionValue: true, expressionType: true, negativeLevel: true } })
const negByText = new Map<string, number>()
for (const n of negs) { const v = n.expressionValue.trim().toLowerCase(); negByText.set(v, (negByText.get(v) ?? 0) + 1) }
const exactPos = pos.filter((t) => t.expressionType.toUpperCase() === 'EXACT')
const exactTexts = [...new Set(exactPos.map((t) => t.expressionValue.trim().toLowerCase()))]
const withNeg = exactTexts.filter((v) => negByText.has(v)).length
console.log(`distinct EXACT keyword texts: ${int(exactTexts.length)}`)
console.log(`  of those, also negated SOMEWHERE: ${int(withNeg)} (${Math.round((withNeg / Math.max(1, exactTexts.length)) * 100)}%)`)
console.log(`  never negated anywhere:          ${int(exactTexts.length - withNeg)}`)
console.log(`total negative KEYWORD rows: ${int(negs.length)} · scope: ${[...new Map(negs.map((n) => [n.negativeLevel ?? '(null)', 0])).keys()].join(' / ')}`)
const negScope = new Map<string, number>()
for (const n of negs) negScope.set(n.negativeLevel ?? '(null)', (negScope.get(n.negativeLevel ?? '(null)') ?? 0) + 1)
console.log(`negativeLevel: ${[...negScope.entries()].map(([s, n]) => `${s}=${n}`).join(' · ')}`)

// ── 4. the engines' own run records ───────────────────────────────────────────
console.log('\n\n═══ 4 · engine run records ═══\n')
for (const jobName of ['ads-auto-harvest', 'ads-coverage-engine', 'advertising-rule-evaluator', 'ads-v1-export-ingest']) {
  const runs = await prisma.cronRun.findMany({ where: { jobName }, orderBy: { startedAt: 'desc' }, take: 6, select: { startedAt: true, finishedAt: true, status: true, outputSummary: true, errorMessage: true } })
  const total = await prisma.cronRun.count({ where: { jobName } })
  console.log(`${jobName}: ${total} runs total${runs.length ? '' : ' — NONE RECORDED'}`)
  for (const r of runs) console.log(`  ${r.startedAt.toISOString().slice(0, 16)} ${pad(r.status, 9)} ${(r.outputSummary ?? r.errorMessage ?? '').slice(0, 130)}`)
}

// ── 5. what matchType do auto-targeting search terms carry? ───────────────────
console.log('\n\n═══ 5 · the auto-targeting blind spot ═══\n')
const camps = await prisma.campaign.findMany({ select: { externalCampaignId: true, targetingType: true, name: true } })
const targByExt = new Map(camps.filter((c) => c.externalCampaignId).map((c) => [c.externalCampaignId!, c.targetingType]))
const mt = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['matchType', 'campaignId'],
  where: { date: { gte: new Date(now - 60 * 86_400_000) } },
  _count: { _all: true }, _sum: { orders7d: true },
})
const cell = new Map<string, { rows: number; orders: number }>()
for (const r of mt) {
  const tt = targByExt.get(r.campaignId) ?? '(unknown campaign)'
  const k = `${tt}|${r.matchType ?? 'NULL'}`
  const c = cell.get(k) ?? { rows: 0, orders: 0 }
  c.rows += r._count._all; c.orders += r._sum.orders7d ?? 0
  cell.set(k, c)
}
console.log(`search-term rows (60d) by campaign targetingType × matchType:`)
console.log(`${pad('targetingType', 18)} ${pad('matchType', 34)} ${pad('rows', 8)} orders`)
for (const [k, v] of [...cell.entries()].sort((a, b) => b[1].rows - a[1].rows)) {
  const [tt, m] = k.split('|')
  const seen = ['BROAD', 'PHRASE', 'NULL'].includes(m)
  console.log(`${pad(tt, 18)} ${pad(`${m}${seen ? '' : '  ← INVISIBLE to promote_to_exact'}`, 34)} ${pad(int(v.rows), 8)} ${int(v.orders)}`)
}

// ── 6. promote_to_exact's dry-run proposals ───────────────────────────────────
console.log('\n\n═══ 6 · what promote_to_exact proposed, 400 ticks deep ═══\n')
const migRule = await prisma.automationRule.findFirst({ where: { domain: 'advertising', name: { contains: 'match-type migration' } }, select: { id: true, name: true, actions: true, conditions: true, enabled: true, autonomyLevel: true, maxExecutionsPerDay: true } })
if (migRule) {
  console.log(`rule: ${migRule.name} · enabled=${migRule.enabled} · level=${migRule.autonomyLevel} · cap/day=${migRule.maxExecutionsPerDay}`)
  console.log(`actions:    ${JSON.stringify(migRule.actions).slice(0, 400)}`)
  console.log(`conditions: ${JSON.stringify(migRule.conditions).slice(0, 400)}`)
  const ex = await prisma.automationRuleExecution.findMany({ where: { ruleId: migRule.id }, orderBy: { startedAt: 'desc' }, take: 300, select: { startedAt: true, status: true, actionResults: true, triggerData: true } })
  const queries = new Map<string, number>()
  let promoteResults = 0, okCount = 0
  for (const e of ex) {
    for (const a of (Array.isArray(e.actionResults) ? e.actionResults : []) as Array<Record<string, unknown>>) {
      if (a.type !== 'promote_to_exact') continue
      promoteResults++
      if (a.ok === true) okCount++
      const q = String((a.output as Record<string, unknown> | undefined)?.query ?? '')
      if (q) queries.set(q, (queries.get(q) ?? 0) + 1)
    }
  }
  console.log(`\n${ex.length} executions examined · ${promoteResults} promote_to_exact results · ${okCount} ok`)
  console.log(`distinct queries proposed: ${queries.size}`)
  console.log([...queries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([q, n]) => `  ${pad(q, 50)} proposed ${n}×`).join('\n'))
  if (ex.length) console.log(`\nexecution window: ${ex[ex.length - 1].startedAt.toISOString().slice(0, 16)} → ${ex[0].startedAt.toISOString().slice(0, 16)}`)
}

// ── 7. how often does each harvest rule actually tick? ────────────────────────
console.log('\n\n═══ 7 · tick cadence of the harvest rules ═══\n')
const hv = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, actions: true, enabled: true, maxExecutionsPerDay: true },
})
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? ''))
for (const r of hv.filter((x) => types(x.actions).some((t) => ['promote_to_exact', 'harvest_and_negate'].includes(t)))) {
  const ex = await prisma.automationRuleExecution.findMany({ where: { ruleId: r.id }, orderBy: { startedAt: 'desc' }, take: 60, select: { startedAt: true, status: true } })
  if (ex.length < 2) { console.log(`${pad(r.name, 44)} ${ex.length} executions`); continue }
  const gaps: number[] = []
  for (let i = 1; i < ex.length; i++) gaps.push((ex[i - 1].startedAt.getTime() - ex[i].startedAt.getTime()) / 60000)
  gaps.sort((a, b) => a - b)
  const stat = await prisma.automationRuleExecution.groupBy({ by: ['status'], where: { ruleId: r.id }, _count: { _all: true } })
  console.log(`${pad(r.name, 44)} enabled=${r.enabled ? 'Y' : 'N'} cap/d=${r.maxExecutionsPerDay ?? '—'} median gap ${Math.round(gaps[Math.floor(gaps.length / 2)])} min · newest ${ex[0].startedAt.toISOString().slice(0, 16)}`)
  console.log(`     all executions ever: ${stat.map((s) => `${s.status}=${int(s._count._all)}`).join(' · ')}`)
}

await prisma.$disconnect()
console.log('\n═══ done ═══\n')
