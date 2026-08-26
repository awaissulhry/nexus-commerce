/**
 * NEG page study — the measurements the TAB study did not make, plus the three claims I doubt.
 *
 * READ-ONLY. No writes, no mutations.
 *
 * Doubted claims, all from docs/2026-08-11-neg-negative-targeting-study.md:
 *   D1  "no UI lists a negative anywhere"  — two per-campaign grids exist; do they remove?
 *   D2  "the whitelist is a going-forward gate"  — is it even that? matchType was backfilled
 *       to EXACT/PREFIX and the POST route cannot set CONTAINS.
 *   D3  "0 rollbacks" — measured on a table that may simply never be written for a negative.
 *
 * New questions this study needs answered:
 *   Q1  did the negatives ever reach Amazon (externalTargetId), and are any orphaned/archived?
 *   Q2  is any negative attributable — an action log, a reason, evidence — at all?
 *   Q3  how wide is a term's spread across ad groups (sizes "bulk remove by term")?
 *   Q4  conflict detection: sized at real thresholds, at the AD GROUP grain
 *   Q5  n-grams: is the wasteful-gram surface already covered by existing negatives?
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 76 - s.length))}`)

console.log('\n═══ NEG — page study, audit pass ═══\n')

// ── 1. The protections, in full ───────────────────────────────────────────────
h('1 · AdKeywordProtection — every row, every field')
const prot = await prisma.adKeywordProtection.findMany({ orderBy: [{ mode: 'asc' }, { term: 'asc' }] })
console.log(`rows: ${prot.length}`)
console.log(`${pad('mode', 10)} ${pad('term', 26)} ${pad('matchType', 10)} ${pad('isPrefix', 9)} ${pad('mkt', 5)} ${pad('camp', 6)} ${pad('createdBy', 18)} created`)
for (const p of prot) {
  console.log(`${pad(p.mode, 10)} ${pad(p.term, 26)} ${pad(String(p.matchType ?? 'NULL'), 10)} ${pad(String(p.isPrefix), 9)} ${pad(p.marketplace ?? 'all', 5)} ${pad(p.campaignId ? 'yes' : 'all', 6)} ${pad(p.createdBy ?? '—', 18)} ${p.createdAt.toISOString().slice(0, 10)}`)
}
const byMatch = new Map<string, number>()
for (const p of prot) byMatch.set(String(p.matchType ?? 'NULL'), (byMatch.get(String(p.matchType ?? 'NULL')) ?? 0) + 1)
console.log(`\nmatchType distribution: ${[...byMatch].map(([k, v]) => `${k}=${v}`).join(' · ')}`)
console.log('(the gate supports CONTAINS; the POST route does not accept it and the migration backfilled EXACT/PREFIX)')

// ── 2. The base, in full ──────────────────────────────────────────────────────
h('2 · The negatives — what they are and whether they ever reached Amazon')
const negs = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: {
    id: true, kind: true, expressionType: true, expressionValue: true, negativeLevel: true,
    externalTargetId: true, status: true, orphanedAt: true, orphanReason: true,
    lastSyncedAt: true, lastSyncStatus: true, lastSyncError: true, createdAt: true,
    adGroup: { select: { id: true, name: true, campaign: { select: { id: true, name: true, marketplace: true, status: true, targetingType: true } } } },
  },
})
console.log(`total negatives: ${int(negs.length)}`)

const tally = (rows: typeof negs, f: (r: typeof negs[number]) => string) => {
  const m = new Map<string, number>()
  for (const r of rows) m.set(f(r), (m.get(f(r)) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1])
}
console.log(`kind:          ${tally(negs, (r) => r.kind).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`expressionType:${tally(negs, (r) => r.expressionType).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`negativeLevel: ${tally(negs, (r) => String(r.negativeLevel ?? 'NULL')).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`status:        ${tally(negs, (r) => String(r.status)).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`market:        ${tally(negs, (r) => String(r.adGroup?.campaign?.marketplace ?? '?')).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`campaign state:${tally(negs, (r) => String(r.adGroup?.campaign?.status ?? '?')).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)

const noExt = negs.filter((n) => !n.externalTargetId)
console.log(`\nexternalTargetId NULL (never confirmed at Amazon): ${int(noExt.length)} of ${int(negs.length)}`)
console.log(`  of those, by level: ${tally(noExt, (r) => String(r.negativeLevel ?? 'NULL')).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`  of those, by type:  ${tally(noExt, (r) => r.expressionType).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
const orph = negs.filter((n) => n.orphanedAt)
console.log(`orphanedAt set: ${int(orph.length)}`)
for (const o of orph.slice(0, 10)) console.log(`  "${o.expressionValue}" ${o.expressionType} @ ${o.adGroup?.campaign?.name ?? '?'} — ${o.orphanReason ?? ''}`)
console.log(`lastSyncStatus: ${tally(negs, (r) => String(r.lastSyncStatus ?? 'never-pushed')).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
const failed = negs.filter((n) => n.lastSyncStatus === 'FAILED')
for (const f of failed.slice(0, 10)) console.log(`  FAILED "${f.expressionValue}" @ ${f.adGroup?.campaign?.name ?? '?'} — ${(f.lastSyncError ?? '').slice(0, 160)}`)

// ── 3. D1: has anyone ever archived / paused a negative? ──────────────────────
h('3 · D1 — the per-campaign grids exist. Has a negative ever been retired through one?')
const nonEnabled = negs.filter((n) => n.status !== 'ENABLED')
console.log(`negatives not ENABLED: ${int(nonEnabled.length)} (${tally(nonEnabled, (r) => String(r.status)).map(([k, v]) => `${k}=${v}`).join(' · ')})`)
for (const n of nonEnabled.slice(0, 15)) {
  console.log(`  ${pad(String(n.status), 9)} "${pad(n.expressionValue, 34)}" ${pad(n.expressionType, 16)} ext=${n.externalTargetId ? 'yes' : 'NO '} sync=${n.lastSyncStatus ?? '—'} @ ${n.adGroup?.campaign?.name ?? '?'}`)
}
const negIds = new Set(negs.map((n) => n.id))
const stateLogs = await prisma.advertisingActionLog.findMany({
  where: { entityType: 'AD_TARGET', actionType: 'AD_ENTITY_STATE_UPDATE' },
  select: { id: true, entityId: true, userId: true, actionType: true, payloadBefore: true, payloadAfter: true, amazonResponseStatus: true, rolledBackAt: true, createdAt: true },
  orderBy: { createdAt: 'desc' }, take: 4000,
})
const negStateLogs = stateLogs.filter((l) => negIds.has(l.entityId))
console.log(`\nAD_ENTITY_STATE_UPDATE logs on AD_TARGET: ${int(stateLogs.length)} — of which on a NEGATIVE: ${int(negStateLogs.length)}`)
for (const l of negStateLogs.slice(0, 15)) {
  const b = l.payloadBefore as Record<string, unknown>; const a = l.payloadAfter as Record<string, unknown>
  console.log(`  ${l.createdAt.toISOString().slice(0, 16)} ${pad(String(l.userId ?? '—'), 22)} ${String(b?.status)}→${String(a?.status)} amazon=${l.amazonResponseStatus ?? 'null'}`)
}

// ── 4. Q2: is any negative attributable? ──────────────────────────────────────
h('4 · Q2 — attribution: does a negative carry an author, a reason, evidence?')
const createLogs = await prisma.advertisingActionLog.findMany({
  where: { actionType: { in: ['create_negative_keyword', 'create_negative_product_target'] } },
  select: { id: true, entityId: true, userId: true, actionType: true, payloadAfter: true, evidence: true, executionId: true, amazonResponseStatus: true, createdAt: true },
  orderBy: { createdAt: 'desc' },
})
console.log(`create_negative_* action logs, all time: ${int(createLogs.length)}`)
const attributed = new Set(createLogs.map((l) => l.entityId))
const covered = negs.filter((n) => attributed.has(n.id)).length
console.log(`negatives WITH an action-log row: ${int(covered)} of ${int(negs.length)} (${((covered / Math.max(1, negs.length)) * 100).toFixed(1)}%)`)
const withEvidence = createLogs.filter((l) => l.evidence != null).length
console.log(`those logs carrying evidence (WHY): ${int(withEvidence)}`)
console.log(`by writer: ${tally(createLogs as never, (l: never) => String((l as { userId?: string }).userId ?? 'null')).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`amazonResponseStatus on those logs: ${tally(createLogs as never, (l: never) => String((l as { amazonResponseStatus?: string }).amazonResponseStatus ?? 'null')).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
const rolled = await prisma.advertisingActionLog.count({ where: { rolledBackAt: { not: null } } })
console.log(`\nD3 — AdvertisingActionLog rows EVER rolled back (all types, all time): ${int(rolled)}`)

// ── 5. Q3: spread — how many ad groups negate the same term? ──────────────────
h('5 · Q3 — spread per term (sizes "bulk remove by term")')
const byTerm = new Map<string, typeof negs>()
for (const n of negs) {
  const k = n.expressionValue.toLowerCase().trim()
  const arr = byTerm.get(k) ?? []
  arr.push(n); byTerm.set(k, arr)
}
const spreads = [...byTerm.entries()].map(([t, rows]) => ({ term: t, rows: rows.length, adGroups: new Set(rows.map((r) => r.adGroup?.id)).size, campaigns: new Set(rows.map((r) => r.adGroup?.campaign?.id)).size }))
  .sort((a, b) => b.rows - a.rows)
console.log(`distinct negated terms: ${int(spreads.length)} across ${int(negs.length)} rows`)
const buckets = { '1': 0, '2-5': 0, '6-20': 0, '21-50': 0, '51+': 0 }
for (const s of spreads) {
  if (s.rows === 1) buckets['1']++
  else if (s.rows <= 5) buckets['2-5']++
  else if (s.rows <= 20) buckets['6-20']++
  else if (s.rows <= 50) buckets['21-50']++
  else buckets['51+']++
}
console.log(`rows per term: ${Object.entries(buckets).map(([k, v]) => `${k}→${v} terms`).join(' · ')}`)
console.log(`\ntop 12 by spread:`)
for (const s of spreads.slice(0, 12)) console.log(`  ${pad(s.term, 40)} rows=${pad(String(s.rows), 5)} adGroups=${pad(String(s.adGroups), 5)} campaigns=${s.campaigns}`)

// ── 6. Q4 + D2: the whitelist audit, BOTH directions, all three match modes ───
h('6 · The whitelist audit — what CONTAINS would catch vs what the stored matchType catches')
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const wl = prot.filter((p) => p.mode === 'WHITELIST')
type Hit = { term: string; prot: string; mode: string; camp: string; ag: string; level: string; mkt: string }
const hitsBy = { EXACT: [] as Hit[], PREFIX: [] as Hit[], CONTAINS: [] as Hit[] }
for (const n of negs) {
  const t = norm(n.expressionValue)
  for (const p of wl) {
    const pt = norm(p.term)
    const rec: Hit = {
      term: n.expressionValue, prot: p.term, mode: String(p.matchType ?? (p.isPrefix ? 'PREFIX' : 'EXACT')),
      camp: n.adGroup?.campaign?.name ?? '?', ag: n.adGroup?.name ?? '?',
      level: String(n.negativeLevel ?? '?'), mkt: String(n.adGroup?.campaign?.marketplace ?? '?'),
    }
    if (t === pt) hitsBy.EXACT.push(rec)
    if (t.startsWith(pt)) hitsBy.PREFIX.push(rec)
    if (t.includes(pt)) hitsBy.CONTAINS.push(rec)
  }
}
console.log(`negatives contradicting a whitelisted term, by match semantics:`)
console.log(`  EXACT    ${int(hitsBy.EXACT.length)}`)
console.log(`  PREFIX   ${int(hitsBy.PREFIX.length)}`)
console.log(`  CONTAINS ${int(hitsBy.CONTAINS.length)}   ← the tab study's 132`)
// what the CURRENT stored config would actually block, going forward
const wouldBlock = hitsBy.CONTAINS.filter((x) => {
  const p = wl.find((q) => q.term === x.prot)!
  const mode = String(p.matchType ?? (p.isPrefix ? 'PREFIX' : 'EXACT'))
  const t = norm(x.term), pt = norm(p.term)
  return mode === 'CONTAINS' ? t.includes(pt) : mode === 'PREFIX' ? t.startsWith(pt) : t === pt
})
console.log(`\nOf those ${int(hitsBy.CONTAINS.length)}, the gate AS CONFIGURED TODAY would refuse: ${int(wouldBlock.length)}`)
console.log(`→ the other ${int(hitsBy.CONTAINS.length - wouldBlock.length)} could be re-negated tomorrow with no denial.`)

// classify: brand campaign vs funnel campaign
const isBrandCamp = (c: string) => /brand/i.test(c)
const isFunnelCamp = (c: string) => /auto|catalog|category|competitor|generic/i.test(c)
const brandHits = hitsBy.CONTAINS.filter((x) => isBrandCamp(x.camp))
const funnelHits = hitsBy.CONTAINS.filter((x) => !isBrandCamp(x.camp) && isFunnelCamp(x.camp))
const otherHits = hitsBy.CONTAINS.filter((x) => !isBrandCamp(x.camp) && !isFunnelCamp(x.camp))
console.log(`\nclassified by the campaign the negative sits in:`)
console.log(`  in a campaign whose NAME says "brand"     → ${int(brandHits.length)}   (hard to defend)`)
console.log(`  in an auto/category/competitor campaign   → ${int(funnelHits.length)}   (standard funnel architecture)`)
console.log(`  everything else                          → ${int(otherHits.length)}`)
console.log(`\nthe hard-to-defend ones, in full:`)
for (const x of brandHits.slice(0, 40)) console.log(`  "${pad(x.term, 28)}" ⊃ ${pad(x.prot, 10)} ${pad(x.level, 9)} ${pad(x.mkt, 3)} ${x.camp}`)

// ── 7. Q4: conflict detection, sized ──────────────────────────────────────────
h('7 · Conflict detection — negated here, earning there (30d and 60d)')
for (const windowDays of [30, 60]) {
  const since = new Date(Date.now() - windowDays * 86400_000)
  const terms = [...byTerm.keys()]
  // one grouped read over the window, then join in memory
  const st = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query'],
    where: { date: { gte: since }, query: { in: terms.slice(0, 3000) } },
    _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
  })
  const rows = st.map((r) => ({
    q: r.query,
    impr: r._sum.impressions ?? 0,
    clicks: r._sum.clicks ?? 0,
    cost: Math.round(Number(r._sum.costMicros ?? 0n) / 10000),
    orders: r._sum.orders7d ?? 0,
    sales: r._sum.sales7dCents ?? 0,
    negIn: byTerm.get(r.q.toLowerCase().trim())?.length ?? 0,
  }))
  const converting = rows.filter((r) => r.orders > 0).sort((a, b) => b.sales - a.sales)
  const clicking = rows.filter((r) => r.orders === 0 && r.clicks > 0)
  const dark = terms.filter((t) => !rows.some((r) => r.q.toLowerCase().trim() === t))
  console.log(`\n${windowDays}d — negated terms with ANY search-term activity: ${int(rows.length)} of ${int(terms.length)}`)
  console.log(`  converting elsewhere (orders>0): ${int(converting.length)}  · clicks but no orders: ${int(clicking.length)}  · no activity at all: ${int(dark.length)}`)
  if (converting.length) {
    console.log(`  total sales on negated-but-converting terms: ${eur(converting.reduce((s, r) => s + r.sales, 0))} on ${eur(converting.reduce((s, r) => s + r.cost, 0))} spend`)
    console.log(`  top:`)
    for (const c of converting.slice(0, 15)) {
      const acos = c.sales > 0 ? ((c.cost / c.sales) * 100).toFixed(0) : '—'
      console.log(`    ${pad(c.q, 40)} negIn=${pad(String(c.negIn), 4)} impr=${pad(int(c.impr), 8)} orders=${pad(String(c.orders), 4)} sales=${pad(eur(c.sales), 10)} acos=${acos}%`)
    }
  }
}

// ── 8. Q5: n-grams vs the negatives we already hold ───────────────────────────
h('8 · n-grams — is the wasteful-gram surface already covered by our negatives?')
const { analyzeNgrams } = await import('../src/services/advertising/ads-ngram.service.js')
const ng = await analyzeNgrams({ windowDays: 60 })
console.log(`window ${ng.windowDays}d · wasteful grams returned: ${ng.wasteful.length} · winning: ${ng.winning.length}`)
const negTermSet = new Set([...byTerm.keys()])
let coveredGrams = 0
console.log(`\ntop 20 wasteful grams — spend, and whether ANY negative already holds that exact gram:`)
for (const g of ng.wasteful.slice(0, 20)) {
  const held = negTermSet.has(g.gram)
  // also: is the gram CONTAINED in any negated phrase?
  const containedIn = [...negTermSet].filter((t) => t.includes(g.gram)).length
  if (held) coveredGrams++
  console.log(`  ${pad(g.gram, 34)} n=${g.n} spend=${pad(eur(g.costCents), 10)} clicks=${pad(int(g.clicks), 6)} terms=${pad(int(g.terms), 5)} negatedExactly=${held ? 'YES' : 'no '} inNegatedPhrases=${containedIn}`)
}
const wasteTotal = ng.wasteful.reduce((s, g) => s + g.costCents, 0)
console.log(`\nwasteful-gram spend, 60d, top 50 grams: ${eur(wasteTotal)} (grams overlap — this is not additive)`)

// ── 9. proposals waiting on this tab ──────────────────────────────────────────
h('9 · The proposal queue for negation')
const sugg = await prisma.adsRuleSuggestion.findMany({
  select: { id: true, status: true, actionType: true, createdAt: true },
  orderBy: { createdAt: 'desc' }, take: 2000,
})
const negSugg = sugg.filter((s) => /negat|harvest/i.test(String(s.actionType ?? '')))
console.log(`AdsRuleSuggestion rows read: ${int(sugg.length)}`)
console.log(`  by status:    ${tally(sugg as never, (s: never) => String((s as { status?: string }).status)).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`  negation/harvest suggestions: ${int(negSugg.length)} — ${tally(negSugg as never, (s: never) => String((s as { status?: string }).status)).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`  actionTypes: ${tally(sugg as never, (s: never) => String((s as { actionType?: string }).actionType ?? '—')).slice(0, 12).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)

console.log('\n═══ done — read-only, nothing changed ═══\n')
await prisma.$disconnect()
