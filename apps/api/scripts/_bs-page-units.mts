/** BS page study — unit probe. Is AdvertisingActionLog.payload*.dailyBudget euros or cents,
 *  and is it the same for every writer? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const rows = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_BUDGET_UPDATE' },
  select: { entityId: true, userId: true, createdAt: true, payloadBefore: true, payloadAfter: true },
  orderBy: { createdAt: 'desc' },
})
const num = (p: unknown, k = 'dailyBudget'): number | null => {
  const v = (p as Record<string, unknown> | null)?.[k]
  return v == null ? null : Number(v)
}
const byWriter = new Map<string, number[]>()
for (const r of rows) {
  const a = num(r.payloadAfter); if (a == null) continue
  const k = r.userId ?? 'null'
  ;(byWriter.get(k) ?? byWriter.set(k, []).get(k)!).push(a)
}
console.log(`\npayloadAfter.dailyBudget, per writer (raw values):`)
for (const [w, vs] of byWriter) {
  const s = [...vs].sort((a, b) => a - b)
  console.log(`  ${w.slice(0, 42).padEnd(42)} n=${String(s.length).padStart(5)} min=${s[0]} p50=${s[Math.floor(s.length / 2)]} max=${s[s.length - 1]} integers=${vs.every((v) => Number.isInteger(v))}`)
}

// The decisive check: for campaigns whose budget has NOT been written since the
// last log row, the newest payloadAfter must equal Campaign.dailyBudget in SOME unit.
const camps = await prisma.campaign.findMany({ select: { id: true, name: true, dailyBudget: true } })
const cby = new Map(camps.map((c) => [c.id, c]))
const newest = new Map<string, { after: number; at: Date; u: string | null }>()
for (const r of rows) { if (!newest.has(r.entityId)) { const a = num(r.payloadAfter); if (a != null) newest.set(r.entityId, { after: a, at: r.createdAt, u: r.userId }) } }
let matchEuro = 0, matchCent = 0, matchNeither = 0
const misses: string[] = []
for (const [cid, v] of newest) {
  const c = cby.get(cid); if (!c) continue
  const cur = Number(c.dailyBudget ?? 0)
  if (Math.abs(v.after - cur) < 0.005) matchEuro++
  else if (Math.abs(v.after / 100 - cur) < 0.005) matchCent++
  else { matchNeither++; if (misses.length < 12) misses.push(`    ${String(c.name).slice(0, 30).padEnd(30)} log.after=${v.after}  Campaign.dailyBudget=${cur}  writer=${String(v.u).slice(0, 34)}`) }
}
console.log(`\nnewest log value vs Campaign.dailyBudget (${newest.size} campaigns with a log row):`)
console.log(`  equal as EUROS: ${matchEuro} · equal as CENTS: ${matchCent} · neither: ${matchNeither}`)
for (const m of misses) console.log(m)

// And check chain consistency: does write N's payloadBefore equal write N-1's payloadAfter?
const perCamp = new Map<string, Array<{ b: number | null; a: number | null; at: Date; u: string | null }>>()
for (const r of rows) {
  const arr = perCamp.get(r.entityId) ?? []
  arr.push({ b: num(r.payloadBefore), a: num(r.payloadAfter), at: r.createdAt, u: r.userId })
  perCamp.set(r.entityId, arr)
}
let chainOk = 0, chainBreak = 0
const breaks: string[] = []
for (const [cid, arr] of perCamp) {
  const asc = [...arr].reverse()
  for (let i = 1; i < asc.length; i++) {
    const prev = asc[i - 1], cur = asc[i]
    if (prev.a == null || cur.b == null) continue
    if (Math.abs(prev.a - cur.b) < 0.005) chainOk++
    else { chainBreak++; if (breaks.length < 10) breaks.push(`    ${String(cby.get(cid)?.name ?? cid).slice(0, 26).padEnd(26)} ${prev.at.toISOString().slice(5, 16)} after=${prev.a} → ${cur.at.toISOString().slice(5, 16)} before=${cur.b}  (${String(prev.u).slice(-8)} → ${String(cur.u).slice(-8)})`) }
  }
}
console.log(`\naudit chain: consecutive writes where before == previous after: ${chainOk} · mismatched: ${chainBreak}`)
for (const b of breaks) console.log(b)

await prisma.$disconnect()
