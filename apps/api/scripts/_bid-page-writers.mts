/**
 * BID page study — WHO writes bids, what the cut-chains actually are, and what failed.
 *
 * READ-ONLY. No writes, no mutations.
 *
 * The tab study established 23,269 AD_BID_UPDATE rows / 614 targets / 865 FAILED and a
 * "19 consecutive cuts, €0.38 → €0.02 over 433h" chain. It did NOT establish what MADE the
 * chain: the actor id was truncated and the reason was never read. `CampaignBidHistory` carries
 * `reason` per field change and is the spine of the change feed, so the chain is answerable.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { parseActor } = await import('../src/services/advertising/ads-changes.service.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const c2e = (c: number) => `€${(c / 100).toFixed(2)}`
const SINCE = new Date(Date.now() - 60 * 86_400_000)

console.log('\n═══ BID page — who writes the bids ═══\n')

// ── 1. every bid write in 60d, classified by ORIGIN not by raw actor string ──
const logs = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: SINCE }, actionType: 'AD_BID_UPDATE' },
  select: { id: true, userId: true, executionId: true, entityId: true, entityType: true, payloadBefore: true, payloadAfter: true, createdAt: true, amazonResponseStatus: true, evidence: true, outboundQueueId: true },
  orderBy: { createdAt: 'desc' },
})
console.log(`AD_BID_UPDATE rows, 60d: ${int(logs.length)}`)

const byKind = new Map<string, { rows: number; names: Map<string, number> }>()
for (const l of logs) {
  const { source, origin } = parseActor(l.userId)
  const k = `${source}/${origin.kind}`
  if (!byKind.has(k)) byKind.set(k, { rows: 0, names: new Map() })
  const e = byKind.get(k)!
  e.rows++
  e.names.set(origin.name, (e.names.get(origin.name) ?? 0) + 1)
}
console.log(`\n── by ORIGIN CLASS (parseActor — the change feed's own classifier) ──`)
for (const [k, v] of [...byKind].sort((a, b) => b[1].rows - a[1].rows)) {
  console.log(`  ${pad(k, 24)} ${String(int(v.rows)).padStart(8)}   distinct origins: ${v.names.size}`)
}

console.log(`\n── entityType split (a keyword bid vs an ad-group default bid) ──`)
const byEnt = new Map<string, number>()
for (const l of logs) byEnt.set(l.entityType, (byEnt.get(l.entityType) ?? 0) + 1)
for (const [k, v] of [...byEnt].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(k, 20)} ${int(v)}`)

console.log(`\n── executionId set (a rule execution produced it)? ──`)
console.log(`  rows WITH executionId: ${int(logs.filter((l) => l.executionId).length)}`)
console.log(`  rows WITH evidence   : ${int(logs.filter((l) => l.evidence != null).length)}  ← ADX A2 "why", per row`)

// ── 2. the 865 failures — what actually went wrong ───────────────────────────
const st = new Map<string, number>()
for (const l of logs) st.set(String(l.amazonResponseStatus ?? '(null)'), (st.get(String(l.amazonResponseStatus ?? '(null)')) ?? 0) + 1)
console.log(`\n── amazonResponseStatus ──`)
for (const [k, v] of [...st].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(k, 12)} ${int(v)}`)

const failed = logs.filter((l) => l.amazonResponseStatus === 'FAILED')
console.log(`\n── the ${int(failed.length)} FAILED bid writes: who, and why ──`)
const failByOrigin = new Map<string, number>()
for (const f of failed) {
  const { origin, source } = parseActor(f.userId)
  const k = `${source}/${origin.kind}:${origin.name}`
  failByOrigin.set(k, (failByOrigin.get(k) ?? 0) + 1)
}
for (const [k, v] of [...failByOrigin].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${pad(k, 56)} ${int(v)}`)

// the error text lives on AdMutation (delivery), joined by entity+field, and on OutboundSyncQueue
const failedEntities = [...new Set(failed.map((f) => f.entityId))]
console.log(`  distinct entities that failed: ${int(failedEntities.length)}`)
const muts = await prisma.adMutation.findMany({
  where: { entityId: { in: failedEntities.slice(0, 500) }, field: { in: ['bid', 'defaultBid'] }, state: 'FAILED' },
  select: { entityId: true, lastError: true, attempts: true, state: true, createdAt: true },
  orderBy: { createdAt: 'desc' }, take: 2000,
})
const errBuckets = new Map<string, number>()
for (const m of muts) {
  const e = (m.lastError ?? '(no error recorded)').slice(0, 90)
  errBuckets.set(e, (errBuckets.get(e) ?? 0) + 1)
}
console.log(`\n  AdMutation FAILED rows for those entities: ${int(muts.length)}`)
for (const [k, v] of [...errBuckets].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${String(int(v)).padStart(5)}  ${k}`)

// and the queue's own view
const q = await prisma.outboundSyncQueue.groupBy({
  by: ['syncStatus'],
  where: { syncType: 'AD_BID_UPDATE', createdAt: { gte: SINCE } },
  _count: { _all: true },
})
console.log(`\n  OutboundSyncQueue AD_BID_UPDATE, 60d: ${q.map((r) => `${r.syncStatus}=${int(r._count._all)}`).join(' · ')}`)

// ── 3. 🔴 the cut chains — WHO made them and WHY ─────────────────────────────
const bidOf = (v: unknown): number | null => {
  const o = v as Record<string, unknown> | null
  const x = o?.bidCents ?? o?.bid
  return typeof x === 'number' ? x : null
}
type Mv = { b: number; a: number; at: Date; id: string; actor: string | null; logId: string }
const moves: Mv[] = []
for (const l of logs) {
  const b = bidOf(l.payloadBefore), a = bidOf(l.payloadAfter)
  if (b == null || a == null) continue
  moves.push({ b, a, at: l.createdAt, id: l.entityId, actor: l.userId, logId: l.id })
}
const byTarget = new Map<string, Mv[]>()
for (const m of moves) { if (!byTarget.has(m.id)) byTarget.set(m.id, []); byTarget.get(m.id)!.push(m) }

type Chain = { id: string; n: number; from: number; to: number; hours: number; steps: Mv[] }
const chains: Chain[] = []
for (const [id, arr] of byTarget) {
  const asc = [...arr].sort((x, y) => +x.at - +y.at)
  let run: Mv[] = []
  const close = () => { if (run.length >= 3) chains.push({ id, n: run.length, from: run[0].b, to: run[run.length - 1].a, hours: (+run[run.length - 1].at - +run[0].at) / 3_600_000, steps: run }); run = [] }
  for (const m of asc) { if (m.a < m.b) run.push(m); else close() }
  close()
}
chains.sort((a, b) => b.n - a.n)
console.log(`\n── 🔴 consecutive-cut chains (≥3): ${int(chains.length)} ──`)

const worst = chains[0]
if (worst) {
  console.log(`\n  LONGEST: target ${worst.id} — ${worst.n} cuts, ${c2e(worst.from)} → ${c2e(worst.to)} over ${worst.hours.toFixed(0)}h`)
  const t = await prisma.adTarget.findUnique({
    where: { id: worst.id },
    select: { expressionValue: true, expressionType: true, bidCents: true, suppressedFromBidCents: true, baseBidFromCents: true, status: true, adGroup: { select: { name: true, campaign: { select: { id: true, name: true, marketplace: true, minBidCents: true, maxBidCents: true, liveBidWritesEnabled: true, bidsSuppressedAt: true, bidsSuppressedFloorCents: true } } } } },
  })
  console.log(`  keyword: "${t?.expressionValue}" [${t?.expressionType}] · campaign ${t?.adGroup?.campaign?.name} (${t?.adGroup?.campaign?.marketplace})`)
  console.log(`  today  : bid ${c2e(t?.bidCents ?? 0)} · suppressedFrom ${t?.suppressedFromBidCents ?? '—'} · baseBidFrom ${t?.baseBidFromCents ?? '—'} · status ${t?.status}`)
  console.log(`  bounds : min ${t?.adGroup?.campaign?.minBidCents ?? '—'} max ${t?.adGroup?.campaign?.maxBidCents ?? '—'} · gate ${t?.adGroup?.campaign?.liveBidWritesEnabled ? 'OPEN' : 'closed'} · campaign suppressed ${t?.adGroup?.campaign?.bidsSuppressedAt ? 'YES @' + t.adGroup.campaign.bidsSuppressedFloorCents + 'c' : 'no'}`)
  console.log(`\n  every step, with actor + the REASON the writer recorded:`)
  const hist = await prisma.campaignBidHistory.findMany({
    where: { entityId: worst.id, field: { in: ['bid', 'defaultBid'] } },
    orderBy: { changedAt: 'asc' }, select: { changedAt: true, oldValue: true, newValue: true, changedBy: true, reason: true },
  })
  const near = (at: Date) => hist.find((h) => Math.abs(+h.changedAt - +at) < 5_000)
  for (const s of worst.steps) {
    const h = near(s.at)
    const o = parseActor(s.actor)
    console.log(`    ${s.at.toISOString().slice(0, 16).replace('T', ' ')}  ${pad(c2e(s.b), 7)}→${pad(c2e(s.a), 7)}  ${pad(`${o.origin.kind}:${o.origin.name}`, 34)}  ${(h?.reason ?? '(no reason recorded)').slice(0, 60)}`)
  }
}

// how many chains, by the origin that made the FIRST cut
console.log(`\n  chains by the origin that opened them:`)
const chainOrigin = new Map<string, number>()
for (const c of chains) {
  const o = parseActor(c.steps[0].actor)
  chainOrigin.set(`${o.origin.kind}:${o.origin.name}`, (chainOrigin.get(`${o.origin.kind}:${o.origin.name}`) ?? 0) + 1)
}
for (const [k, v] of [...chainOrigin].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${pad(k, 40)} ${int(v)}`)

// how many chains ENDED at or under 5c, i.e. effectively off
const toFloor = chains.filter((c) => c.to <= 5)
console.log(`\n  chains ending at ≤5¢ (effectively off): ${int(toFloor.length)} of ${int(chains.length)} · distinct targets ${int(new Set(toFloor.map((c) => c.id)).size)}`)

// ── 4. the reverse: RAISE chains, so the picture is symmetric ────────────────
const upChains: Chain[] = []
for (const [id, arr] of byTarget) {
  const asc = [...arr].sort((x, y) => +x.at - +y.at)
  let run: Mv[] = []
  const close = () => { if (run.length >= 3) upChains.push({ id, n: run.length, from: run[0].b, to: run[run.length - 1].a, hours: (+run[run.length - 1].at - +run[0].at) / 3_600_000, steps: run }); run = [] }
  for (const m of asc) { if (m.a > m.b) run.push(m); else close() }
  close()
}
upChains.sort((a, b) => b.n - a.n)
console.log(`\n── consecutive-RAISE chains (≥3): ${int(upChains.length)} ──`)
for (const c of upChains.slice(0, 5)) console.log(`  ${pad(c.id, 28)} ${String(c.n).padStart(3)} raises ${c2e(c.from)} → ${c2e(c.to)} over ${c.hours.toFixed(0)}h`)

// ── 5. CampaignBidHistory: the spine, and what share of it is bids ───────────
const cbhTotal = await prisma.campaignBidHistory.count({ where: { changedAt: { gte: SINCE } } })
const cbhBid = await prisma.campaignBidHistory.count({ where: { changedAt: { gte: SINCE }, field: { in: ['bid', 'defaultBid'] } } })
console.log(`\n── CampaignBidHistory 60d: ${int(cbhTotal)} rows · bid/defaultBid ${int(cbhBid)} ──`)
const reasons = await prisma.campaignBidHistory.groupBy({
  by: ['reason'], where: { changedAt: { gte: SINCE }, field: { in: ['bid', 'defaultBid'] } },
  _count: { _all: true }, orderBy: { _count: { reason: 'desc' } }, take: 15,
})
console.log(`  the reasons writers actually record:`)
for (const r of reasons) console.log(`    ${String(int(r._count._all)).padStart(7)}  ${(r.reason ?? '(null)').slice(0, 78)}`)

await prisma.$disconnect()
