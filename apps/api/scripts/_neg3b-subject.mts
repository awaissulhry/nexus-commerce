/**
 * NEG.3b — verify the approved probe subject, and re-derive the eligible set. READ-ONLY.
 *
 * The brief names `kolchoz carrere` in `IT-AIRMESH-SP-Competitor-Phrase` and says 241 subjects meet
 * the criteria — and tells me to re-derive rather than trust it. This does that, and prints why
 * each criterion holds for the named subject so the choice is auditable rather than asserted.
 *
 * The five criteria, and the reason each one matters:
 *   1. campaign is on the live-write allowlist  — otherwise the gate refuses and Amazon is never
 *      contacted (the wall NEG.3's stage 2 hit)
 *   2. the TERM is dead: 0 impressions AND 0 orders in 120 days — this replaces "the campaign is
 *      paused" as the safety property, because the allowlist makes inert campaigns unreachable
 *   3. more than one negation of the term exists — so pausing this one never unblocks the term
 *   4. the row is ENABLED and confirmed at Amazon — there must be something there to change
 *   5. not orphaned, not already retired
 */
import '../src/env.js'
const { normaliseNegTerm } = await import('../src/services/advertising/negatives.service.js')
const { default: prisma } = await import('../src/db.js')

const NAMED = 'kolchoz carrere'
const int = (n: number) => n.toLocaleString('en-IE')
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)
let failures = 0
const check = (l: string, ok: boolean, d = '') => { if (!ok) failures++; console.log(`  ${ok ? '✓' : '✗ FAIL'}  ${l}${d ? ` — ${d}` : ''}`) }

console.log('\n═══ NEG.3b — the probe subject ═══\n')

// ── the state this session inherits, re-measured rather than trusted ──────────────────────────
h('1 · Inherited state, re-measured')
const total = await prisma.adTarget.count({ where: { isNegative: true } })
const archived = await prisma.adTarget.count({ where: { isNegative: true, status: 'ARCHIVED' } })
const orphans = await prisma.adTarget.count({ where: { orphanedAt: { not: null } } })
const retired = await prisma.adTarget.count({ where: { isNegative: true, retiredAt: { not: null } } })
const allowOn = await prisma.campaign.count({ where: { liveBidWritesEnabled: true } })
const allowOff = await prisma.campaign.count({ where: { liveBidWritesEnabled: false } })
console.log(`  negatives ${int(total)} · ARCHIVED ${int(archived)} · retiredAt set ${int(retired)}`)
console.log(`  🔴 orphanedAt across ALL targets: ${int(orphans)}`)
console.log(`  campaigns allowlisted ${int(allowOn)} · not ${int(allowOff)}`)
check('the brief\'s 2,058 still holds', total === 2058, `measured ${total}`)
check('🔴 orphanedAt is 0 — the invariant this whole fix exists to protect', orphans === 0, `measured ${orphans}`)

// ── the eligible set ──────────────────────────────────────────────────────────────────────────
h('2 · Re-deriving the eligible set from the five criteria')
const since120 = new Date(Date.now() - 120 * 86400_000)
const traffic = new Map(
  (await prisma.amazonAdsSearchTerm.groupBy({ by: ['query'], where: { date: { gte: since120 } }, _sum: { impressions: true, orders7d: true, clicks: true } }))
    .map((r) => [normaliseNegTerm(r.query), { impr: r._sum.impressions ?? 0, orders: r._sum.orders7d ?? 0, clicks: r._sum.clicks ?? 0 }]),
)
const negs = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: {
    id: true, expressionValue: true, expressionType: true, status: true, externalTargetId: true,
    negativeLevel: true, orphanedAt: true, retiredAt: true,
    adGroup: { select: { id: true, name: true, externalAdGroupId: true, campaign: { select: { id: true, name: true, status: true, marketplace: true, liveBidWritesEnabled: true } } } },
  },
})
const spread = new Map<string, number>()
for (const n of negs) { const k = normaliseNegTerm(n.expressionValue); spread.set(k, (spread.get(k) ?? 0) + 1) }

const dead = (t: string) => { const x = traffic.get(t); return !x || (x.impr === 0 && x.orders === 0) }
const eligible = negs.filter((n) => {
  const k = normaliseNegTerm(n.expressionValue)
  return n.adGroup?.campaign?.liveBidWritesEnabled === true
    && dead(k)
    && (spread.get(k) ?? 0) > 1
    && String(n.status) === 'ENABLED'
    && n.externalTargetId != null
    && n.orphanedAt == null
    && n.retiredAt == null
})
console.log(`  eligible subjects: ${int(eligible.length)}   (the brief says 241)`)
check('there is at least one eligible subject', eligible.length > 0)

// 🔴 The claim that made the old plan impossible, re-checked: is any inert-campaign negative
// writable? If this is ever non-zero the safety model changes back and this session's premise
// needs revisiting.
const inertAndWritable = negs.filter((n) => n.adGroup?.campaign?.liveBidWritesEnabled === true && n.adGroup?.campaign?.status !== 'ENABLED')
console.log(`  negatives that are BOTH allowlisted AND in a non-ENABLED campaign: ${int(inertAndWritable.length)}`)
check('still zero — "safe because inert" remains impossible, which is why the term must be dead instead', inertAndWritable.length === 0)

// ── the named subject ─────────────────────────────────────────────────────────────────────────
h(`3 · The approved subject: 「${NAMED}」`)
const named = eligible.filter((n) => normaliseNegTerm(n.expressionValue) === NAMED)
console.log(`  eligible rows for this term: ${int(named.length)} · total negations of it: ${int(spread.get(NAMED) ?? 0)}`)
const t = traffic.get(NAMED)
console.log(`  120d traffic: ${t ? JSON.stringify(t) : 'NO ROW AT ALL in the search-term report'}`)

const subject = named.find((n) => n.adGroup?.campaign?.name === 'IT-AIRMESH-SP-Competitor-Phrase') ?? named[0]
if (!subject) {
  console.log('  ✗ the named subject does not qualify — falling back to the eligible list')
} else {
  console.log(`\n  id=${subject.id}`)
  console.log(`  externalTargetId=${subject.externalTargetId}`)
  console.log(`  expressionValue=「${subject.expressionValue}」  expressionType=${subject.expressionType}  level=${subject.negativeLevel}`)
  console.log(`  ad group "${subject.adGroup?.name}" (ext ${subject.adGroup?.externalAdGroupId})`)
  console.log(`  campaign "${subject.adGroup?.campaign?.name}" · ${subject.adGroup?.campaign?.status} · ${subject.adGroup?.campaign?.marketplace} · allowlisted=${subject.adGroup?.campaign?.liveBidWritesEnabled}`)
  console.log('\n  criteria:')
  check('    1 · campaign is on the live-write allowlist', subject.adGroup?.campaign?.liveBidWritesEnabled === true)
  check('    2 · the term is dead — 0 impressions AND 0 orders in 120 days', dead(NAMED), JSON.stringify(t ?? {}))
  check('    3 · more than one negation exists, so pausing this one unblocks nothing', (spread.get(NAMED) ?? 0) > 1, `${spread.get(NAMED)} negations`)
  check('    4 · the row is ENABLED and confirmed at Amazon', String(subject.status) === 'ENABLED' && subject.externalTargetId != null)
  check('    5 · not orphaned, not already retired', subject.orphanedAt == null && subject.retiredAt == null)
  console.log(`\n  → pausing it leaves ${int((spread.get(NAMED) ?? 1) - 1)} negations still blocking 「${NAMED}」`)
  console.log(`  → NO configuration change is required: the campaign is already allowlisted and stays so.`)
}

h('4 · Alternates named in the brief')
for (const alt of ['violent life', 'giacca moto donna']) {
  const rows = eligible.filter((n) => normaliseNegTerm(n.expressionValue) === alt)
  const at = traffic.get(alt)
  console.log(`  「${alt}」 eligible rows ${rows.length} · total negations ${spread.get(alt) ?? 0} · 120d ${at ? JSON.stringify(at) : 'no row'}${rows[0] ? ` · e.g. ${rows[0].adGroup?.campaign?.name}` : ''}`)
}

h('5 · Ten more eligible subjects, so the choice is visibly not cherry-picked')
for (const e of eligible.slice(0, 10)) {
  console.log(`  ${e.id} 「${e.expressionValue}」 · ${e.adGroup?.campaign?.name} · ${spread.get(normaliseNegTerm(e.expressionValue))} negations`)
}

console.log(`\n${failures === 0 ? '✅ the subject qualifies on all five criteria' : `❌ ${failures} check(s) failed`}\n`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
