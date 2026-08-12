/**
 * HV.3 — can a destination actually be RESOLVED? READ-ONLY, ZERO QUOTA.
 *
 * §4.2 offers three mechanisms and tells me to measure before building:
 *
 *   (a) by NAME       — `roleOf` in ads-keyword-funnel.service.ts:55
 *   (b) by PRODUCT    — the source ad group's ASINs → the manual keyword-targeted ad group for the
 *                       same product in the same market whose role is the match type being created
 *   (c) EXPLICIT      — a stored per-scope override
 *
 * The question that decides the build order: **for how many sources does (b) actually resolve?**
 * If it is a minority, the picker is the primary path and the resolver is the convenience.
 *
 * Also measures the §4.1 coupling — for each shipped candidate, whether the resolved destination
 * IS the source ad group, because that is exactly when `promotedElsewhere` is false and the
 * isolation negative never gets created.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
type Role = 'AUTO' | 'BROAD' | 'PHRASE' | 'EXACT'

console.log('\n═══ HV.3 — destination resolution coverage ═══\n')

// ── the graph ─────────────────────────────────────────────────────────────────
const adGroups = await prisma.adGroup.findMany({
  select: {
    id: true, name: true, externalAdGroupId: true, campaignId: true,
    campaign: { select: { id: true, name: true, marketplace: true, targetingType: true, status: true, maxBidCents: true, minBidCents: true } },
    targets: { select: { expressionType: true, isNegative: true } },
  },
})
const ads = await prisma.adProductAd.findMany({ where: { productId: { not: null } }, select: { productId: true, adGroupId: true } })
const products = await prisma.product.findMany({ select: { id: true, parentId: true, sku: true } })
const parentOf = new Map(products.map((p) => [p.id, p.parentId ?? p.id]))

console.log(`ad groups: ${int(adGroups.length)} · AdProductAd rows with a product: ${int(ads.length)} · products: ${int(products.length)}`)

/** `roleOf`, copied verbatim in behaviour from ads-keyword-funnel.service.ts:55 (name, then majority). */
function roleOf(name: string, targets: Array<{ expressionType: string; isNegative: boolean }>): Role | null {
  const n = (name || '').toUpperCase()
  if (n.includes('AUTO')) return 'AUTO'
  if (n.includes('EXACT')) return 'EXACT'
  if (n.includes('PHRASE')) return 'PHRASE'
  if (n.includes('BROAD')) return 'BROAD'
  const counts: Record<string, number> = {}
  for (const t of targets) { if (t.isNegative) continue; const e = t.expressionType.toUpperCase(); counts[e] = (counts[e] ?? 0) + 1 }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]
  return top === 'EXACT' || top === 'PHRASE' || top === 'BROAD' ? top : null
}

// ── (a) by name, over ALL ad groups ───────────────────────────────────────────
console.log('\n═══ (a) resolution BY NAME, across every ad group ═══\n')
const roleByAg = new Map<string, Role | null>()
const nameOnly = new Map<string, Role | null>()
for (const ag of adGroups) {
  roleByAg.set(ag.id, roleOf(ag.name, ag.targets))
  const n = (ag.name || '').toUpperCase()
  nameOnly.set(ag.id, n.includes('AUTO') ? 'AUTO' : n.includes('EXACT') ? 'EXACT' : n.includes('PHRASE') ? 'PHRASE' : n.includes('BROAD') ? 'BROAD' : null)
}
const tally = <T>(xs: T[]) => { const m = new Map<string, number>(); for (const x of xs) m.set(String(x), (m.get(String(x)) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]) }
console.log(`from the NAME alone:        ${tally([...nameOnly.values()]).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
console.log(`with the majority fallback: ${tally([...roleByAg.values()]).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
const unresolved = adGroups.filter((ag) => roleByAg.get(ag.id) == null)
console.log(`⇒ ${unresolved.length} of ${adGroups.length} ad groups have NO role even after the fallback`)

// ── (b) by product ────────────────────────────────────────────────────────────
// productLine → market → role → ad groups, restricted to MANUAL keyword-targeted campaigns.
console.log('\n═══ (b) resolution BY PRODUCT ═══\n')
const agById = new Map(adGroups.map((a) => [a.id, a]))
const linesOfAg = new Map<string, Set<string>>()      // adGroupId → set of product LINE ids
for (const a of ads) {
  if (!a.productId) continue
  const line = parentOf.get(a.productId) ?? a.productId
  const s = linesOfAg.get(a.adGroupId) ?? new Set<string>()
  s.add(line); linesOfAg.set(a.adGroupId, s)
}
console.log(`ad groups carrying at least one product: ${linesOfAg.size} of ${adGroups.length}`)

/** line|market|role → candidate destination ad groups (MANUAL campaigns only) */
const dest = new Map<string, string[]>()
for (const ag of adGroups) {
  const role = roleByAg.get(ag.id); if (!role || role === 'AUTO') continue
  if (ag.campaign?.targetingType !== 'MANUAL') continue       // never propose an auto campaign as a destination
  const mkt = ag.campaign?.marketplace ?? ''
  for (const line of linesOfAg.get(ag.id) ?? []) {
    const k = `${line}|${mkt}|${role}`
    dest.set(k, [...(dest.get(k) ?? []), ag.id])
  }
}
console.log(`(line × market × role) destination buckets: ${dest.size}`)

const resolveFor = (sourceAgId: string, role: Role): string[] => {
  const src = agById.get(sourceAgId); if (!src) return []
  const mkt = src.campaign?.marketplace ?? ''
  const out = new Set<string>()
  for (const line of linesOfAg.get(sourceAgId) ?? []) for (const id of dest.get(`${line}|${mkt}|${role}`) ?? []) out.add(id)
  return [...out]
}

console.log('\ncoverage across EVERY ad group that carries a product:')
console.log(`${pad('target role', 14)} ${pad('resolves', 10)} ${pad('of sources', 11)} ${pad('rate', 7)} ${pad('unique dest', 12)} ambiguous (>1)`)
for (const role of ['EXACT', 'PHRASE', 'BROAD'] as Role[]) {
  const sources = [...linesOfAg.keys()]
  const hits = sources.map((s) => resolveFor(s, role))
  const some = hits.filter((h) => h.length > 0).length
  const one = hits.filter((h) => h.length === 1).length
  const many = hits.filter((h) => h.length > 1).length
  console.log(`${pad(role, 14)} ${pad(String(some), 10)} ${pad(String(sources.length), 11)} ${pad(`${((some / sources.length) * 100).toFixed(0)}%`, 7)} ${pad(String(one), 12)} ${many}`)
}

// ── the shipped candidates ────────────────────────────────────────────────────
console.log('\n\n═══ the 8 shipped candidates — where would each one go? ═══\n')
const { getKeywordHarvest } = await import('../src/services/advertising/keyword-harvest.service.js')
const page = await getKeywordHarvest({ market: 'all' })
console.log(`candidates at the shipped criteria: ${page.census.candidates}\n`)
console.log(`${pad('term', 34)} ${pad('mkt', 4)} ${pad('source ad group', 26)} ${pad('srcRole', 8)} ${pad('→ EXACT dest', 30)} ${pad('same?', 6)} clamp`)
let sameCount = 0, elsewhereCount = 0, noneCount = 0
for (const r of page.rows) {
  const srcAg = r.adGroup.id ? agById.get(r.adGroup.id) : undefined
  const srcRole = srcAg ? roleByAg.get(srcAg.id) : null
  const want: Role = r.kind === 'product' ? 'EXACT' : 'EXACT'
  const hits = srcAg ? resolveFor(srcAg.id, want) : []
  const same = srcAg ? hits.includes(srcAg.id) : false
  const label = hits.length === 0 ? '(none)' : hits.length === 1 ? (agById.get(hits[0])?.name ?? '?') : `${hits.length} candidates`
  const destAg = hits.length ? agById.get(hits[0]) : undefined
  const clamp = destAg?.campaign?.maxBidCents ? `max €${(destAg.campaign.maxBidCents / 100).toFixed(2)}` : 'no max'
  if (hits.length === 0) noneCount++; else if (same && hits.length === 1) sameCount++; else elsewhereCount++
  console.log(`${pad(r.term, 34)} ${pad(r.market, 4)} ${pad(r.adGroup.name, 26)} ${pad(String(srcRole), 8)} ${pad(label, 30)} ${pad(same ? 'YES' : 'no', 6)} ${clamp}`)
}
console.log(`\n🔴 the §4.1 coupling, on today's candidates:`)
console.log(`   destination IS the source ad group → NO isolation negative would be created: ${sameCount}`)
console.log(`   destination is elsewhere          → the source WOULD be negated:            ${elsewhereCount}`)
console.log(`   no destination resolves           → not promotable at all:                  ${noneCount}`)

// ── the self-competition check (§4.3) ─────────────────────────────────────────
console.log('\n\n═══ §4.3 — would promoting create a SECOND exact keyword? ═══\n')
const positives = await prisma.adTarget.findMany({
  where: { isNegative: false, kind: 'KEYWORD' },
  select: { adGroupId: true, expressionType: true, expressionValue: true, externalTargetId: true },
})
const exactByTerm = new Map<string, string[]>()
for (const p of positives) {
  if (String(p.expressionType ?? '').toUpperCase().replace(/^_+/, '').replace(/^NEGATIVE_/, '') !== 'EXACT') continue
  const t = p.expressionValue.trim().toLowerCase()
  exactByTerm.set(t, [...(exactByTerm.get(t) ?? []), p.adGroupId])
}
console.log(`${pad('term', 34)} ${pad('exact already in', 18)} verdict relative to its destination`)
for (const r of page.rows) {
  const t = r.term.trim().toLowerCase()
  const holders = exactByTerm.get(t) ?? []
  const srcAg = r.adGroup.id ? agById.get(r.adGroup.id) : undefined
  const hits = srcAg ? resolveFor(srcAg.id, 'EXACT') : []
  const destIsHolder = hits.some((h) => holders.includes(h))
  const verdict = holders.length === 0 ? 'new — nothing exists'
    : destIsHolder ? 'ALREADY DONE at the destination'
    : hits.length === 0 ? 'no destination — not promotable'
    : `🔴 SECOND exact keyword (already in ${holders.length} other ad group${holders.length === 1 ? '' : 's'})`
  console.log(`${pad(r.term, 34)} ${pad(String(holders.length), 18)} ${verdict}`)
}

console.log('\n═══ done ═══\n')
await prisma.$disconnect()
