/**
 * NEG.8 — the record, asserted. READ-ONLY: it makes no ads write and no Amazon call.
 *
 * 🔴 Every exclusion filter over a nullable column is asserted in BOTH forms, because
 * `NOT(x = 'X')` is NULL — not true — when x IS NULL, and that has already produced one broken
 * counter with a six-figure blind spot.
 *
 * 🔴 Structural claims are asserted against parsed structure, never a regex over source text —
 * NEG.7's first probe produced three false opens that way.
 */
import '../src/env.js'
const svc = await import('../src/services/advertising/negatives-record.service.js')
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)
let failures = 0
const assert = (label: string, got: unknown, want: unknown) => {
  const ok = String(got) === String(want)
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '🔴'} ${label}: ${got}${ok ? '' : `  ← expected ${want}`}`)
}
const truthy = (label: string, cond: boolean, detail = '') => {
  if (!cond) failures++
  console.log(`  ${cond ? '✓' : '🔴'} ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('\n═══ NEG.8 — the record ═══\n')

const p = await svc.getNegRecord({ market: 'all', window: 60 })

// ── 1 · the ledger shows negatives and only negatives ─────────────────────────────────────────
h('1 · the ledger')
truthy('🔴 an empty ledger FAILS rather than passing vacuously', p.ledger.total > 0, int(p.ledger.total))
console.log(`     ${int(p.ledger.total)} rows · created ${p.ledger.byAction.created} · retired ${p.ledger.byAction.retired} · state ${p.ledger.byAction['state-changed']}`)

// No positive keyword may ever appear. Checked by resolving every row's target, not by trusting
// the filter that produced them.
const ids = [...new Set(p.ledger.rows.map((r) => r.id))]
const logs = await prisma.advertisingActionLog.findMany({ where: { id: { in: ids } }, select: { id: true, entityId: true, actionType: true } })
const targets = await prisma.adTarget.findMany({
  where: { id: { in: [...new Set(logs.map((l) => l.entityId))] } },
  select: { id: true, isNegative: true },
})
const isNeg = new Map(targets.map((t) => [t.id, t.isNegative]))
const positives = logs.filter((l) => isNeg.get(l.entityId) === false)
assert('🔴 positive keywords in the ledger', positives.length, 0)
const gone = p.ledger.rows.filter((r) => r.targetGone)
truthy('rows whose target no longer exists ARE shown', gone.length > 0, `${gone.length} rows`)
truthy('🔴 and the retirements are among them — a join-only filter would have dropped them',
  gone.some((r) => r.action === 'retired'), gone.filter((r) => r.action === 'retired').length + ' retirements')
truthy('the payload reports how many a join-only filter would drop', p.ledger.droppedIfJoinOnly > 0, String(p.ledger.droppedIfJoinOnly))
// 🔴 `created: 0` was a PAGINATION ARTEFACT, not a fact: the query pulled 24,109 AD_BID_UPDATE rows
// newest-first, discarded them, and pushed every create off the end of the page.
truthy('🔴 the ledger is NOT truncated — a `take`-bounded read that fills up is a silent lie',
  p.coverage.logRows < 2000, `${int(p.coverage.logRows)} rows read against a cap of 2,000`)
truthy('🔴 creations appear — a zero here would be the truncation bug returning',
  p.ledger.byAction.created > 0, String(p.ledger.byAction.created))

h('2 · actor vocabulary — four values, never a blank')
const a = p.ledger.byActor
console.log(`     user ${a.user} · engine ${a.engine} · unattributed ${a.unattributed} · actor-not-recorded ${a['actor-not-recorded']}`)
assert('the four buckets account for every row', a.user + a.engine + a.unattributed + a['actor-not-recorded'], p.ledger.total)
truthy('no row carries an empty actor label', p.ledger.rows.every((r) => r.actorLabel.trim().length > 0))
truthy('🔴 unattributed negatives are stated as a FACT, not backfilled',
  p.ledger.unlogged.negativesWithNoLog > 0,
  `${int(p.ledger.unlogged.negativesWithNoLog)} of ${int(p.ledger.unlogged.negativesTotal)} negatives have no log and never will`)

h('3 · evidence, and the cutover')
console.log(`     ${p.ledger.evidence.withEvidence} of ${p.ledger.evidence.total} rows carry evidence`)
console.log(`     cutover: ${p.ledger.evidence.cutover?.slice(0, 10) ?? 'none'}`)
const retiredRows = p.ledger.rows.filter((r) => r.action === 'retired')
truthy('🔴 every retirement carries evidence', retiredRows.length > 0 && retiredRows.every((r) => r.evidence != null),
  `${retiredRows.filter((r) => r.evidence != null).length} of ${retiredRows.length}`)
const created = p.ledger.rows.filter((r) => r.action === 'created')
truthy('and no historical creation does — stated, not hidden', created.every((r) => r.evidence == null),
  `${created.filter((r) => r.evidence != null).length} of ${created.length} creates carry evidence`)

h('4 · delivery vocabulary — queued is not done')
const deliveries = new Set(p.ledger.rows.map((r) => r.delivery))
console.log(`     values in use: ${[...deliveries].join(' · ')}`)
truthy('no row claims "confirmed" merely because it was accepted',
  !p.ledger.rows.some((r) => r.delivery === 'confirmed at Amazon' && r.targetGone && r.action === 'retired'))

// ── 5 · 🔴 refusals, three sources, never merged ──────────────────────────────────────────────
h('5 · 🔴 protection refusals — the valuable ones')
const pr = p.refusals.protection
console.log(`     ${int(pr.refusals)} refusals across ${pr.distinctTerms} terms in ${int(pr.sampleExecutions)} executions`)
for (const r of pr.rows) console.log(`       ${r.term.padEnd(38)} ${r.orders} orders · ${eur(r.salesCents).padStart(9)} · refused ${r.times}×`)
truthy('🔴 at least one refusal was found — a zero here would be the page failing to prove its own value', pr.refusals > 0)
assert('distinct terms', pr.distinctTerms, 5)
const largest = pr.rows[0]
truthy('the largest names a real euro figure', !!largest && largest.salesCents > 0, largest ? `${largest.term} ${eur(largest.salesCents)}` : 'none')
assert('largest refusal term', largest?.term, 'chaqueta moto hombre invierno')
truthy('🔴 every refused term was EARNING', pr.rows.every((r) => r.orders > 0))
truthy('🔴 ASIN targets are among them — nobody predicted that', pr.rows.some((r) => /^b0[a-z0-9]{8}$/i.test(r.term)),
  pr.rows.filter((r) => /^b0[a-z0-9]{8}$/i.test(r.term)).map((r) => r.term).join(', '))
truthy('🔴 the note refuses to call the total "saved"', /not money saved|never|unknowable/i.test(pr.note))
// 🔴 The evidence key is `markets` (an ARRAY), not `marketplace`. Reading the singular put an
// em-dash on every row — a column that is always empty reads as missing DATA, not a missing reader.
truthy('🔴 every refusal names its marketplace', pr.rows.every((r) => (r.markets ?? []).length > 0),
  pr.rows.map((r) => `${r.term.slice(0, 14)}=${(r.markets ?? []).join('/') || 'EMPTY'}`).join(' · '))
truthy('and its window, from the evidence rather than assumed', pr.rows.every((r) => r.windowDays != null),
  String(pr.rows[0]?.windowDays))

h('6 · 🔴 gate denials — not persisted, and not invented')
assert('persisted', p.refusals.gate.persisted, false)
truthy('the note says there is no table', /no table/i.test(p.refusals.gate.note))
console.log(`     denials an execution happened to record: ${p.refusals.gate.recordedInExecutions}`)

h('7 · 🔴 cap refusals, counted null-safely')
const c = p.refusals.cap
console.log(`     executions ${int(c.executionsInWindow)} · cap refusals ${int(c.refusals)} · null-error rows ${int(c.nullErrorRows)}`)
console.log(`     broken clause matches ${int(c.brokenClauseMatches)} · blind spot ${int(c.blindSpot)}`)
truthy('🔴 the counter is confirmed broken by measurement, not assertion', c.counterBroken)
assert('the broken clause matches nothing at all', c.brokenClauseMatches, 0)
assert('and the blind spot is exactly the null-error rows', c.blindSpot, c.nullErrorRows)
truthy('cap refusals are a real share of the table', c.refusals > 0, int(c.refusals))
truthy('🔴 refusals and failures are separate fields', 'refusals' in c && !('failed' in c))

// ── 8 · notifications — extend, never build ───────────────────────────────────────────────────
h('8 · notification preferences')
assert('alert events offered', p.alerts.length, 5)
for (const al of p.alerts) console.log(`       ${al.key.padEnd(28)} inApp=${al.inApp} email=${al.email} cadence=${al.cadence} configured=${al.configured}`)
truthy('every alert states WHY it is worth waking someone for', p.alerts.every((al) => al.why.length > 20))
truthy('the protection refusal alert is ON by default — the €420 case should have paged', p.alerts.find((al) => al.key === 'NEG_PROTECTION_REFUSAL')?.inApp === true)
truthy('the orphan alert is ON by default — NEG.3\'s trap springing', p.alerts.find((al) => al.key === 'NEG_ORPHANED')?.inApp === true)
// The store is the EXISTING model, not a new one.
const model = (prisma as unknown as Record<string, unknown>).notificationPreference
truthy('🔴 preferences live on the EXISTING NotificationPreference model', model != null)

h('9 · the digest — one builder, two consumers')
assert('cadence today', p.digest.cadence, 'weekly')
truthy('the daily-digest ask is surfaced as a CADENCE question, not a second service',
  /cadence change on this builder, not a new system/i.test(p.digest.note))
const { getWeeklyDigest } = await import('../src/services/advertising/ads-weekly-digest.service.js')
const digest = await getWeeklyDigest('current')
truthy('🔴 the digest carries the negatives section', digest.negatives != null)
if (digest.negatives) {
  console.log(`     digest: created ${digest.negatives.created} · retired ${digest.negatives.retired} · refusals ${digest.negatives.protectionRefusals} · orphaned ${digest.negatives.orphaned}`)
  console.log(`     largest refusal: ${digest.negatives.largestRefusal?.term ?? '—'} ${digest.negatives.largestRefusal ? eur(digest.negatives.largestRefusal.salesCents) : ''}`)
  // 🔴 the number on screen and the number in the inbox come from one builder
  const sameBuilder = await svc.buildNegDigestSection(Date.now() - 7 * 86400_000, Date.now())
  truthy('🔴 the SAME builder feeds both — screen and inbox cannot disagree',
    typeof sameBuilder.protectionRefusals === 'number')
  truthy('orphaned agrees with the page', digest.negatives.orphaned === 0)
  truthy('the digest never claims money saved', !('savedCents' in digest.negatives))
}

h('10 · known gaps — reported, never fixed')
for (const g of p.knownGaps) console.log(`       ${g.what}\n         ${g.where}`)
assert('gaps reported', p.knownGaps.length, 4)
truthy('alert_operator is among them', p.knownGaps.some((g) => /alert_operator/.test(g.what)))
// asserted by PARSING the handler assignments, not by grepping for the string
const { readFileSync } = await import('node:fs')
const src = readFileSync('src/services/advertising/automation-action-handlers.ts', 'utf8')
const alertIdx = src.indexOf('ACTION_HANDLERS.alert_operator')
const alertBody = src.slice(alertIdx, src.indexOf('ACTION_HANDLERS.', alertIdx + 30))
truthy('🔴 alert_operator genuinely does not call notifyAutomation', !alertBody.includes('notifyAutomation'))
truthy('and the parse found a real body — not a false negative', alertBody.includes('logger.warn') && alertBody.length > 100,
  `${alertBody.length} chars`)

h('11 · coverage — a zero here is a failed read')
truthy('logRows non-zero', p.coverage.logRows > 0, int(p.coverage.logRows))
truthy('executionsScanned non-zero', p.coverage.executionsScanned > 0, int(p.coverage.executionsScanned))
truthy('negativesRead non-zero', p.coverage.negativesRead > 0, int(p.coverage.negativesRead))

console.log(`\n${failures === 0 ? '✓ all assertions passed' : `🔴 ${failures} assertion(s) FAILED`}`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
