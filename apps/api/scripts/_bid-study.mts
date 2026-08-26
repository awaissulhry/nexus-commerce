/**
 * BID — Bid tab study. READ-ONLY: no writes, no mutations.
 *
 * 23,269 AD_BID_UPDATE rows in 60 days makes this the busiest write path in the account.
 * Study 6 found the budget rules ratcheting compoundingly to the floor; bid_down uses the same
 * "percent of the CURRENT value" shape, so the first question is whether the same thing is
 * happening to bids.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const c2e = (c: number) => `€${(c / 100).toFixed(2)}`

console.log('\n═══ BID — the busiest write path in the account ═══\n')

// ── 1. the rules ──────────────────────────────────────────────────────────────
const BID_ACTIONS = ['bid_to_target_acos', 'bid_up', 'bid_down', 'lower_bid_to_floor', 'raise_bids_for_rank_defense']
const all = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, trigger: true, actions: true, maxExecutionsPerDay: true, maxValueCentsEur: true, executionCount: true, lastExecutedAt: true },
})
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? ''))
const rules = all.filter((r) => types(r.actions).some((t) => BID_ACTIONS.includes(t)))
console.log(`Rules the tab lists: ${rules.length}`)
console.log(`${pad('rule', 42)} ${pad('on', 4)} ${pad('level', 8)} ${pad('trigger', 24)} ${pad('execs', 7)} ${pad('cap', 5)} action`)
for (const r of rules.sort((a, b) => b.executionCount - a.executionCount)) {
  const acts = (Array.isArray(r.actions) ? r.actions : []) as Array<Record<string, unknown>>
  const ba = acts.find((a) => BID_ACTIONS.includes(String(a.type)))
  const desc = ba ? `${ba.type}${ba.percent != null ? ` ${Number(ba.percent) > 0 ? '+' : ''}${ba.percent}%` : ''}${ba.floorCents != null ? ` floor ${ba.floorCents}¢` : ''}` : ''
  console.log(`${pad(r.name, 42)} ${pad(r.enabled ? 'ON' : '—', 4)} ${pad(String(r.autonomyLevel), 8)} ${pad(r.trigger, 24)} ${pad(int(r.executionCount), 7)} ${pad(String(r.maxExecutionsPerDay ?? '—'), 5)} ${desc}`)
}
const live = rules.filter((r) => r.enabled && r.autonomyLevel === 'AUTO')
console.log(`\n  enabled AND on AUTO (can write without asking): ${live.length}`)
for (const r of live) console.log(`     ${r.name}`)

// ── 2. the 23,269 writes ──────────────────────────────────────────────────────
const since = new Date(Date.now() - 60 * 86_400_000)
const logs = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: since }, actionType: 'AD_BID_UPDATE' },
  select: { userId: true, executionId: true, entityId: true, payloadBefore: true, payloadAfter: true, createdAt: true, amazonResponseStatus: true },
  orderBy: { createdAt: 'desc' },
})
console.log(`\n── AD_BID_UPDATE rows, 60d: ${int(logs.length)} ──`)
const byUser = new Map<string, number>()
for (const l of logs) byUser.set(String(l.userId ?? '(none)'), (byUser.get(String(l.userId ?? '(none)')) ?? 0) + 1)
for (const [u, n] of [...byUser].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${pad(u, 50)} ${int(n)}`)
const st = new Map<string, number>()
for (const l of logs) st.set(String(l.amazonResponseStatus ?? '—'), (st.get(String(l.amazonResponseStatus ?? '—')) ?? 0) + 1)
console.log(`  amazonResponseStatus: ${[...st].map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)

const bid = (v: unknown) => { const o = v as Record<string, unknown> | null; const x = o?.bidCents ?? o?.bid; return typeof x === 'number' ? x : null }
const moves = logs.map((l) => ({ b: bid(l.payloadBefore), a: bid(l.payloadAfter), at: l.createdAt, id: l.entityId }))
  .filter((m) => m.b != null && m.a != null) as Array<{ b: number; a: number; at: Date; id: string }>
const up = moves.filter((m) => m.a > m.b), down = moves.filter((m) => m.a < m.b), flat = moves.filter((m) => m.a === m.b)
console.log(`\n  readable before→after: ${int(moves.length)}`)
console.log(`    raises: ${int(up.length)}  ·  cuts: ${int(down.length)}  ·  NO CHANGE: ${int(flat.length)}`)
if (flat.length) console.log(`    ← a no-change write is the floor absorbing the cut, or a repeat of an unsettled write`)
console.log(`  distinct targets touched: ${int(new Set(moves.map((m) => m.id)).size)}`)

// ── 3. 🔴 is there a RATCHET? consecutive cuts on one target ─────────────────
const byTarget = new Map<string, Array<{ b: number; a: number; at: Date }>>()
for (const m of moves) {
  if (!byTarget.has(m.id)) byTarget.set(m.id, [])
  byTarget.get(m.id)!.push({ b: m.b, a: m.a, at: m.at })
}
const chains: Array<{ id: string; n: number; from: number; to: number; hours: number }> = []
for (const [id, arr] of byTarget) {
  const asc = [...arr].sort((x, y) => +x.at - +y.at)
  let run = 0, start = asc[0]?.b ?? 0, t0 = asc[0]?.at
  for (let i = 0; i < asc.length; i++) {
    if (asc[i].a < asc[i].b) { if (run === 0) { start = asc[i].b; t0 = asc[i].at } run++ }
    else { if (run >= 3) chains.push({ id, n: run, from: start, to: asc[i - 1].a, hours: (+asc[i - 1].at - +t0!) / 3_600_000 }); run = 0 }
  }
  if (run >= 3) chains.push({ id, n: run, from: start, to: asc[asc.length - 1].a, hours: (+asc[asc.length - 1].at - +t0!) / 3_600_000 })
}
chains.sort((a, b) => b.n - a.n)
console.log(`\n── 🔴 consecutive-cut chains (≥3 cuts in a row on one target): ${chains.length} ──`)
console.log(`${pad('  target', 30)} ${pad('cuts', 6)} ${pad('from', 8)} ${pad('to', 8)} over`)
for (const c of chains.slice(0, 12)) console.log(`${pad(`  ${c.id}`, 30)} ${pad(String(c.n), 6)} ${pad(c2e(c.from), 8)} ${pad(c2e(c.to), 8)} ${c.hours.toFixed(1)}h`)
if (chains.length) {
  const worst = chains[0]
  console.log(`\n  longest chain: ${worst.n} consecutive cuts, ${c2e(worst.from)} → ${c2e(worst.to)} in ${worst.hours.toFixed(1)}h`)
}

// ── 4. where the bids ended up ────────────────────────────────────────────────
const targets = await prisma.adTarget.findMany({
  where: { kind: 'KEYWORD', isNegative: false, status: 'ENABLED' },
  select: { bidCents: true, expressionValue: true, adGroup: { select: { campaign: { select: { name: true, marketplace: true, status: true, minBidCents: true, maxBidCents: true, liveBidWritesEnabled: true } } } } },
})
const bids = targets.map((t) => t.bidCents).filter((b) => b > 0).sort((a, b) => a - b)
const at = (p: number) => bids[Math.min(bids.length - 1, Math.floor(bids.length * p))] ?? 0
console.log(`\n── the ${int(targets.length)} ENABLED positive keywords, by bid ──`)
console.log(`  min ${c2e(at(0))} · p10 ${c2e(at(0.1))} · p25 ${c2e(at(0.25))} · median ${c2e(at(0.5))} · p75 ${c2e(at(0.75))} · p90 ${c2e(at(0.9))} · max ${c2e(at(1))}`)
const buckets: Array<[string, (b: number) => boolean]> = [
  ['at 2¢ (the suppression floor)', (b) => b <= 2],
  ['3–5¢', (b) => b > 2 && b <= 5],
  ['6–20¢', (b) => b > 5 && b <= 20],
  ['21–50¢', (b) => b > 20 && b <= 50],
  ['51–100¢', (b) => b > 50 && b <= 100],
  ['over €1.00', (b) => b > 100],
]
for (const [label, f] of buckets) {
  const n = bids.filter(f).length
  console.log(`  ${pad(label, 30)} ${String(int(n)).padStart(6)}  ${((n / Math.max(1, bids.length)) * 100).toFixed(1)}%`)
}

// ── 5. the bounds that should be restraining all this ─────────────────────────
const camps = await prisma.campaign.findMany({ select: { minBidCents: true, maxBidCents: true, pinBids: true, liveBidWritesEnabled: true, status: true } })
console.log(`\n── the per-campaign bid bounds (enforced in ads-write-gate.ts) ──`)
console.log(`  campaigns with minBidCents set : ${camps.filter((c) => c.minBidCents != null).length} of ${camps.length}`)
console.log(`  campaigns with maxBidCents set : ${camps.filter((c) => c.maxBidCents != null).length} of ${camps.length}`)
console.log(`  campaigns with pinBids (hands off): ${camps.filter((c) => c.pinBids).length}`)
console.log(`  write gate open                : ${camps.filter((c) => c.liveBidWritesEnabled).length}`)

await prisma.$disconnect()
