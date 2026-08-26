/** RA.3b — graduation reach + the pending queue (status is lowercase). READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveAutonomy } = await import('../src/services/advertising/ads-autonomy.js')
const { graduationCeiling, isLevelAllowed } = await import('../src/services/advertising/ads-graduation.js')
const { ruleCategory } = await import('../src/services/advertising/rule-category.js')

const NON_WRITING = new Set(['notify', 'alert_operator', 'log_only'])
const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, dryRun: true, autonomyLevel: true, actions: true, createdAt: true, evaluationCount: true, matchCount: true },
  orderBy: { name: 'asc' },
})
const protectionCount = await prisma.adKeywordProtection.count({ where: { mode: 'WHITELIST' } })
const typesOf = (r: { actions: unknown }) =>
  (Array.isArray(r.actions) ? r.actions : []).map((a) => String((a as { type?: unknown })?.type ?? '')).filter(Boolean)

console.log(`\n═══ A · DOES "AUTO" MEAN IT CAN WRITE? ═══  (protected terms: ${protectionCount})`)
const auto = rules.filter((r) => resolveAutonomy(r) === 'AUTO')
let autoWriting = 0
for (const r of auto) {
  const t = typesOf(r); const w = t.filter((x) => !NON_WRITING.has(x))
  if (w.length) autoWriting++
  console.log(`   ${w.length ? 'WRITES ' : 'notify '} ${r.name.slice(0, 46).padEnd(48)} ${t.join(', ')}`)
}
console.log(`→ ${autoWriting} of ${auto.length} AUTO rules carry an action that reaches Amazon.`)

console.log(`\n═══ B · WHAT A PROPOSE→AUTO FLIP WOULD ARM ═══`)
const propose = rules.filter((r) => resolveAutonomy(r) === 'PROPOSE')
let canReachAuto = 0, capped = 0
for (const r of propose) {
  const t = typesOf(r)
  const c = graduationCeiling({ actionTypes: t, hasKeywordProtections: protectionCount > 0 })
  const ok = isLevelAllowed('AUTO', c.maxLevel)
  if (ok) canReachAuto++; else capped++
  const days = Math.floor((Date.now() - r.createdAt.getTime()) / 86_400_000)
  const gate: string[] = []
  if (days < 14) gate.push(`age ${days}/14d`)
  if (r.evaluationCount < 10) gate.push(`evals ${r.evaluationCount}/10`)
  if (r.matchCount < 1) gate.push('0 matches')
  console.log(`   ${ok ? '→AUTO ok ' : `CAP ${c.maxLevel.padEnd(7)}`} ${ruleCategory(t).padEnd(9)} ${r.name.slice(0, 44).padEnd(46)} ${ok ? (gate.length ? `8-check gate would REFUSE: ${gate.join(', ')}` : '8-check gate open') : c.blockedBy ?? ''}`)
}
console.log(`→ of ${propose.length} PROPOSE rules: ${canReachAuto} may reach AUTO via the ceiling, ${capped} are capped below it.`)

console.log(`\n═══ C · THE 29 THAT RESOLVE OFF ═══`)
const off = rules.filter((r) => resolveAutonomy(r) === 'OFF')
console.log(`stored autonomyLevel on those ${off.length}:`, JSON.stringify(
  off.reduce<Record<string, number>>((m, r) => { const k = String(r.autonomyLevel ?? 'NULL'); m[k] = (m[k] ?? 0) + 1; return m }, {})))
console.log('→ no row stores OFF or OBSERVE; `enabled=false` is what carries "off" today.')

console.log(`\n═══ D · THE PENDING QUEUE ═══`)
const sugg = await prisma.adsRuleSuggestion.groupBy({ by: ['status'], _count: { _all: true } })
console.log('by status:', JSON.stringify(Object.fromEntries(sugg.map((s) => [s.status, s._count._all]))))
const o = await prisma.adsRuleSuggestion.findFirst({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
const n = await prisma.adsRuleSuggestion.findFirst({ where: { status: 'pending' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
const age = (d?: Date | null) => (d ? `${Math.floor((Date.now() - d.getTime()) / 86_400_000)}d old (${d.toISOString().slice(0, 10)})` : '—')
console.log(`oldest pending: ${age(o?.createdAt)}`)
console.log(`newest pending: ${age(n?.createdAt)}`)
const byRule = await prisma.adsRuleSuggestion.groupBy({ by: ['ruleId'], where: { status: 'pending' }, _count: { _all: true } })
for (const b of byRule.sort((x, y) => y._count._all - x._count._all).slice(0, 10)) {
  const nm = b.ruleId ? await prisma.automationRule.findUnique({ where: { id: b.ruleId }, select: { name: true, enabled: true, dryRun: true, autonomyLevel: true } }) : null
  console.log(`   ${String(b._count._all).padStart(4)} ← ${nm ? `[${resolveAutonomy(nm)}] ${nm.name}` : `(ruleId ${b.ruleId ?? 'null'} — rule deleted?)`}`)
}
const orphan = byRule.filter((b) => !b.ruleId).reduce((s, b) => s + b._count._all, 0)
if (orphan) console.log(`   ${orphan} pending rows carry a null ruleId.`)

console.log('\n(read-only — nothing was written)')
await prisma.$disconnect()
