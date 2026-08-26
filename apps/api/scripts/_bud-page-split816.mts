/**
 * BUD.8 §2.1 — split the 58 at-floor campaigns BY CAUSE.
 *
 * The tab study §3 says "58 of 86 live campaigns now sit at €1 because of this", attributing the
 * floor to the two AUTO rules' compounding ratchet. BUD.1's basis doc repeated it. This measures
 * who actually did it, per campaign.
 *
 * Method: find the transition write — the row where payloadBefore > €1 and payloadAfter <= €1. That
 * is the write that put the campaign on the floor. Classify by its AUTHOR and its SHAPE:
 *
 *   · pacer   — a single write by budget-manager-cron dropping >2x straight to the floor
 *   · ratchet — reached via a compounding sequence: >=3 rule-authored cuts in the 72h before it
 *   · neither — no transition in the log at all (never above €1 while audited), or an odd shape
 *
 * Also captures, for §3.2, the value in force IMMEDIATELY BEFORE the flooring write — which is the
 * honest recovery anchor, unlike the all-time peak (a campaign-creation default, not an operator
 * decision).
 *
 * READ-ONLY.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const eur = (n: number) => `€${n.toFixed(2)}`
const bud = (v: unknown) => {
  const o = v as Record<string, unknown> | null
  const x = o?.dailyBudget ?? o?.budget
  return typeof x === 'number' ? x : null
}
const SWEEP = new Date('2026-08-05T02:00:00Z')
const SWEEP_END = new Date('2026-08-05T03:00:00Z')

const camps = await prisma.campaign.findMany({
  where: { status: 'ENABLED' },
  select: { id: true, name: true, marketplace: true, dailyBudget: true, budgetBaselineCents: true, liveBidWritesEnabled: true },
})
const atFloor = camps.filter((c) => Number(c.dailyBudget ?? 0) <= 1)

const logs = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_BUDGET_UPDATE', entityId: { in: atFloor.map((c) => c.id) } },
  select: { entityId: true, payloadBefore: true, payloadAfter: true, createdAt: true, userId: true },
  orderBy: { createdAt: 'asc' },
})
const byCamp = new Map<string, typeof logs>()
for (const l of logs) {
  const a = byCamp.get(l.entityId) ?? []
  a.push(l)
  byCamp.set(l.entityId, a)
}

type Cause = 'pacer' | 'ratchet' | 'neither'
interface Row {
  id: string; name: string; mkt: string; cause: Cause
  now: number; before: number | null; at: Date | null; by: string
  dropX: number | null; ruleCuts72h: number; inSweep: boolean; totalWrites: number
}
const rows: Row[] = []

for (const c of atFloor) {
  const mine = byCamp.get(c.id) ?? []
  const now = Number(c.dailyBudget ?? 0)
  // The transition to the floor: first row taking it from >€1 to <=€1.
  const t = mine.find((l) => (bud(l.payloadBefore) ?? 0) > 1 && (bud(l.payloadAfter) ?? 99) <= 1)
  if (!t) {
    rows.push({ id: c.id, name: c.name, mkt: c.marketplace ?? '—', cause: 'neither', now, before: null, at: null, by: '—', dropX: null, ruleCuts72h: 0, inSweep: false, totalWrites: mine.length })
    continue
  }
  const before = bud(t.payloadBefore)!
  const after = bud(t.payloadAfter)!
  const by = String(t.userId ?? '')
  const isPacer = by.includes('budget-manager-cron')
  const dropX = after > 0 ? before / after : null
  // Rule-authored cuts in the 72h before the transition — the compounding signature.
  const since = new Date(+t.createdAt - 72 * 3600_000)
  const ruleCuts72h = mine.filter((l) =>
    l.createdAt >= since && l.createdAt < t.createdAt
    && String(l.userId ?? '').startsWith('automation:')
    && !String(l.userId ?? '').includes('budget-manager-cron')
    && (bud(l.payloadAfter) ?? 0) < (bud(l.payloadBefore) ?? 0)).length

  const cause: Cause = isPacer && (dropX ?? 0) > 2 ? 'pacer' : ruleCuts72h >= 3 ? 'ratchet' : isPacer ? 'pacer' : 'neither'
  rows.push({
    id: c.id, name: c.name, mkt: c.marketplace ?? '—', cause, now, before, at: t.createdAt, by: isPacer ? 'pacer' : by.replace('automation:', 'rule:').slice(0, 18),
    dropX, ruleCuts72h, inSweep: t.createdAt >= SWEEP && t.createdAt < SWEEP_END, totalWrites: mine.length,
  })
}

const group = (c: Cause) => rows.filter((r) => r.cause === c)
console.log(`\n══ BUD.8 §2.1 — the ${atFloor.length} at-floor campaigns, split by cause ══\n`)
console.log(`  ${pad('cause', 10)} ${pad('n', 4)} ${pad('now/day', 10)} ${pad('pre-floor/day', 14)} what it means`)
for (const c of ['pacer', 'ratchet', 'neither'] as Cause[]) {
  const g = group(c)
  const now = g.reduce((s, r) => s + r.now, 0)
  const pre = g.reduce((s, r) => s + (r.before ?? r.now), 0)
  const what = c === 'pacer' ? 'one large write straight to €1 (budget-manager-cron)'
    : c === 'ratchet' ? 'compounding rule cuts (>=3 rule cuts in the 72h before)'
    : 'no transition in the log — never audited above €1'
  console.log(`  ${pad(c, 10)} ${pad(String(g.length), 4)} ${pad(eur(now), 10)} ${pad(eur(pre), 14)} ${what}`)
}
const inSweep = rows.filter((r) => r.inSweep)
console.log(`\n  floored inside the 2026-08-05 02:00–03:00 sweep : ${inSweep.length}`)
console.log(`  their combined pre-floor daily budget           : ${eur(inSweep.reduce((s, r) => s + (r.before ?? 0), 0))}`)

console.log(`\n── the ratchet victims, named (the study's claim applies to THESE) ──`)
for (const r of group('ratchet').sort((a, b) => (b.before ?? 0) - (a.before ?? 0))) {
  console.log(`  ${pad(r.name, 34)} ${pad(r.mkt, 3)} ${pad(eur(r.before ?? 0), 9)} → €1  ${r.ruleCuts72h} rule cuts in 72h · ${r.totalWrites} writes total · ${r.at?.toISOString().slice(0, 16)}`)
}

console.log(`\n── the pacer-floored, top 20 by pre-floor value ──`)
for (const r of group('pacer').sort((a, b) => (b.before ?? 0) - (a.before ?? 0)).slice(0, 20)) {
  console.log(`  ${pad(r.name, 34)} ${pad(r.mkt, 3)} ${pad(eur(r.before ?? 0), 9)} → €1  ${r.dropX ? `${r.dropX.toFixed(0)}x` : ''} ${r.inSweep ? '· in the 08-05 sweep' : `· ${r.at?.toISOString().slice(0, 10)}`}`)
}

const neither = group('neither')
if (neither.length) {
  console.log(`\n── neither (no proposal will be made for these) ──`)
  for (const r of neither) console.log(`  ${pad(r.name, 34)} ${pad(r.mkt, 3)} now ${eur(r.now)} · ${r.totalWrites} audit rows`)
}

// Per-market pre-floor totals — what a recovery would cost, before any plan cap.
console.log(`\n── recovery cost if every at-floor campaign returned to its pre-floor value ──`)
const mkts = [...new Set(rows.map((r) => r.mkt))].sort()
for (const m of mkts) {
  const g = rows.filter((r) => r.mkt === m && r.before != null)
  if (!g.length) continue
  console.log(`  ${pad(m, 4)} ${String(g.length).padStart(3)} campaigns  now ${pad(eur(g.reduce((s, r) => s + r.now, 0)), 9)} → pre-floor ${eur(g.reduce((s, r) => s + (r.before ?? 0), 0))}`)
}
console.log(`  ALL  ${String(rows.filter((r) => r.before != null).length).padStart(3)} campaigns  now ${pad(eur(rows.reduce((s, r) => s + r.now, 0)), 9)} → pre-floor ${eur(rows.reduce((s, r) => s + (r.before ?? r.now), 0))}`)

await prisma.$disconnect()
