/**
 * NEG.5 — reconcile my 128 against the study's 132 and `_neg-page-conflict.mts`. READ-ONLY.
 *
 * 🔴 A disagreement with the study is a FINDING, not something to tune away. This script
 * reproduces the study's predicate verbatim (`_neg-study.mts:71-83`) alongside the gate's, so the
 * difference has a cause on the record rather than an apology.
 *
 * Two candidate causes, both testable here:
 *   1. the study matches on WHOLE WORDS (`v.split(/\s+/).includes(t)`), which is a fourth
 *      semantics the gate does not implement — not CONTAINS, not PREFIX, not EXACT;
 *   2. the study has **no `break`**, so one negation containing two protected terms is pushed
 *      onto `violations` twice.
 */
import '../src/env.js'
const { normaliseNegTerm } = await import('../src/services/advertising/negatives.service.js')
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)
let failures = 0
const assert = (label: string, got: unknown, want: unknown) => {
  const ok = String(got) === String(want)
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '🔴'} ${label}: got ${got}${ok ? '' : ` — expected ${want}`}`)
}

console.log('\n═══ NEG.5 — reconciliation ═══\n')

const negs = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: {
    id: true, expressionValue: true, status: true, externalTargetId: true, negativeLevel: true,
    adGroup: { select: { id: true, name: true, campaign: { select: { id: true, name: true, status: true } } } },
  },
})
const whitelist = await prisma.adKeywordProtection.findMany({ where: { mode: 'WHITELIST' } })
console.log(`  base: ${int(negs.length)} negatives · ${int(whitelist.length)} whitelisted terms`)
console.log(`  🔴 the study measured 2,059 on 2026-08-11; the base is now ${int(negs.length)}`)

// ── A · the study's predicate, verbatim ───────────────────────────────────────────────────────
h('A · `_neg-study.mts:71-83` reproduced verbatim')
const studyViolations: Array<{ term: string; neg: string; id: string }> = []
for (const n of negs) {
  const v = (n.expressionValue ?? '').toLowerCase()
  for (const p of whitelist) {
    const t = p.term.toLowerCase()
    const hit = p.isPrefix ? v.startsWith(t) : v.split(/\s+/).includes(t) || v === t
    if (hit) studyViolations.push({ term: p.term, neg: n.expressionValue ?? '', id: n.id })
  }
}
console.log(`  study count (pairs, no break): ${int(studyViolations.length)}   ← the doc's "132"`)
console.log(`  study count, DISTINCT negations: ${int(new Set(studyViolations.map((v) => v.id)).size)}`)

// ── B · the gate's predicate ──────────────────────────────────────────────────────────────────
h('B · `ads-write-gate.ts:322-327` — the semantics that actually binds')
const covers = (mode: string, negTerm: string, protTerm: string): boolean => {
  if (mode === 'CONTAINS') return negTerm.includes(protTerm)
  if (mode === 'PREFIX') return negTerm.startsWith(protTerm)
  return negTerm === protTerm
}
type Pair = { negId: string; protTerm: string; negTerm: string; campaign: string }
const gatePairs: Pair[] = []
for (const n of negs) {
  const key = normaliseNegTerm(n.expressionValue ?? '')
  if (!key) continue
  for (const p of whitelist) {
    const t = normaliseNegTerm(p.term)
    const mode = p.matchType ?? (p.isPrefix ? 'PREFIX' : 'EXACT')
    if (t && covers(mode, key, t)) {
      gatePairs.push({ negId: n.id, protTerm: p.term, negTerm: key, campaign: n.adGroup?.campaign?.name ?? '—' })
    }
  }
}
const gateDistinct = new Set(gatePairs.map((p) => p.negId))
console.log(`  gate semantics · PAIRS (negation × protected term): ${int(gatePairs.length)}`)
console.log(`  gate semantics · DISTINCT negations:                ${int(gateDistinct.size)}`)

// ── C · the multi-term negations — the whole difference ───────────────────────────────────────
h('C · negations that contradict MORE THAN ONE protected term')
const byNeg = new Map<string, Pair[]>()
for (const p of gatePairs) byNeg.set(p.negId, [...(byNeg.get(p.negId) ?? []), p])
const multi = [...byNeg.values()].filter((v) => v.length > 1)
console.log(`  ${int(multi.length)} negations hit 2+ protected terms:`)
for (const m of multi) {
  console.log(`    "${m[0].negTerm}" → ${m.map((x) => x.protTerm).join(' + ')}   [${m[0].campaign}]`)
}
console.log(`\n  🔴 ${int(gateDistinct.size)} distinct + ${int(gatePairs.length - gateDistinct.size)} second hits = ${int(gatePairs.length)} pairs.`)
console.log(`     A count grouped BY PROTECTED TERM sums to the PAIR count, not the distinct count.`)
console.log(`     The headline must say which it is, or the group sizes will not add up on screen.`)

// ── D · classification ────────────────────────────────────────────────────────────────────────
h('D · classification — the 54 / 45 / 33 the brief expects')
/** A campaign is a brand campaign when its name says so. Both naming conventions live here:
 *  `IT-AIREON-SP-Brand-Broad` and `GALE | IT | Broad | Brand`. */
const isBrandCampaign = (name: string) => /brand/i.test(name)
/** The line a campaign belongs to, read off its own name. */
const LINES = ['aireon', 'airmesh', 'gale', 'moss', 'misano', 'regal', 'ventra', 'xavia']
const lineOf = (name: string): string | null => {
  const n = name.toLowerCase()
  for (const l of LINES) if (n.includes(l)) return l
  return null
}
const classify = (p: Pair, campaignName: string): 'own-line-brand' | 'other-line-brand' | 'non-brand' => {
  if (!isBrandCampaign(campaignName)) return 'non-brand'
  const line = lineOf(campaignName)
  const prot = normaliseNegTerm(p.protTerm).replace(/\s+/g, '')
  return line && prot === line ? 'own-line-brand' : 'other-line-brand'
}
const counts = { 'own-line-brand': 0, 'other-line-brand': 0, 'non-brand': 0 }
for (const p of gatePairs) counts[classify(p, p.campaign)]++
console.log(`  over PAIRS  (${int(gatePairs.length)}):`)
console.log(`    own-line brand    ${String(counts['own-line-brand']).padStart(3)}   (brief: 54)`)
console.log(`    other-line brand  ${String(counts['other-line-brand']).padStart(3)}   (brief: 45)`)
console.log(`    non-brand         ${String(counts['non-brand']).padStart(3)}   (brief: 33)`)

const dCounts = { 'own-line-brand': 0, 'other-line-brand': 0, 'non-brand': 0 }
for (const [, pairs] of byNeg) {
  // one negation gets ONE class: the most serious it earns, own-line first.
  const classes = pairs.map((p) => classify(p, p.campaign))
  const cls = classes.includes('own-line-brand') ? 'own-line-brand'
    : classes.includes('other-line-brand') ? 'other-line-brand' : 'non-brand'
  dCounts[cls]++
}
console.log(`  over DISTINCT negations (${int(gateDistinct.size)}):`)
console.log(`    own-line brand    ${String(dCounts['own-line-brand']).padStart(3)}`)
console.log(`    other-line brand  ${String(dCounts['other-line-brand']).padStart(3)}`)
console.log(`    non-brand         ${String(dCounts['non-brand']).padStart(3)}`)

h('E · assertions')
assert('the brief\'s 132 is the STUDY predicate\'s pair count', studyViolations.length, 132)
assert('the gate predicate over pairs', gatePairs.length, 132)
assert('the gate predicate over distinct negations', gateDistinct.size, 128)
assert('pairs − distinct = the multi-term negations', gatePairs.length - gateDistinct.size, multi.length)
assert('own-line brand (pairs)', counts['own-line-brand'], 54)
assert('other-line brand (pairs)', counts['other-line-brand'], 45)
assert('non-brand (pairs)', counts['non-brand'], 33)
if (gatePairs.length === 0) { failures++; console.log('  🔴 EMPTY — an assertion over an empty list is not a pass') }

console.log(`\n${failures === 0 ? '✓ all assertions passed' : `🔴 ${failures} assertion(s) FAILED`}`)
await prisma.$disconnect()
