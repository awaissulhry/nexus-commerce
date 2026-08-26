/**
 * BID page study — 🔴 WHO IS THE BIDDER, per campaign. And the cadence.
 *
 * READ-ONLY. No writes, no mutations.
 *
 * "One bidder per campaign" is only a recommendation if the overlap is measured. This counts the
 * distinct writers that moved a bid inside each campaign in 60 days, and separately counts how
 * many DECLARED bidders (rules that can write + rank schedules bound to it) could reach it.
 * Also: the hour-of-day profile of every bid write, which is the cadence question's evidence.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { parseActor } = await import('../src/services/advertising/ads-changes.service.js')
const { resolveAutonomy, levelActs } = await import('../src/services/advertising/ads-autonomy.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const c2e = (c: number) => `€${(c / 100).toFixed(2)}`
const SINCE = new Date(Date.now() - 60 * 86_400_000)

console.log('\n═══ BID page — who is the bidder ═══\n')

// ── 0. keyword-only distribution, comparable with the tab study ─────────────
const kws = await prisma.adTarget.findMany({
  where: { kind: 'KEYWORD', isNegative: false, status: 'ENABLED' },
  select: { bidCents: true, suppressedFromBidCents: true },
})
const kb = kws.map((t) => t.bidCents).filter((b) => b > 0).sort((a, b) => a - b)
const at = (p: number) => kb[Math.min(kb.length - 1, Math.floor(kb.length * p))] ?? 0
console.log(`── ${int(kws.length)} ENABLED positive KEYWORDS (the tab study's population) ──`)
console.log(`  min ${c2e(at(0))} · p10 ${c2e(at(0.1))} · p25 ${c2e(at(0.25))} · median ${c2e(at(0.5))} · p75 ${c2e(at(0.75))} · p90 ${c2e(at(0.9))} · max ${c2e(at(1))}`)
const bucket = (f: (b: number) => boolean) => kb.filter(f).length
console.log(`  at ≤2¢ ${int(bucket((b) => b <= 2))} (${((bucket((b) => b <= 2) / kb.length) * 100).toFixed(1)}%) · 3–5¢ ${int(bucket((b) => b > 2 && b <= 5))} · 6–20¢ ${int(bucket((b) => b > 5 && b <= 20))} · 21–50¢ ${int(bucket((b) => b > 20 && b <= 50))} · 51–100¢ ${int(bucket((b) => b > 50 && b <= 100))} · >€1 ${int(bucket((b) => b > 100))}`)
console.log(`  carrying suppressedFromBidCents right now: ${int(kws.filter((t) => t.suppressedFromBidCents != null).length)}`)
console.log(`  ← the tab study measured 557 at 2¢ (28.1%) earlier today. Restate against this.`)

// ── 1. who wrote a bid inside each campaign, 60d ────────────────────────────
const logs = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: SINCE }, actionType: 'AD_BID_UPDATE' },
  select: { userId: true, entityId: true, entityType: true, createdAt: true, amazonResponseStatus: true },
})
const targetIds = [...new Set(logs.filter((l) => l.entityType === 'AD_TARGET').map((l) => l.entityId))]
const groupIds = [...new Set(logs.filter((l) => l.entityType === 'AD_GROUP').map((l) => l.entityId))]
const tRows = await prisma.adTarget.findMany({ where: { id: { in: targetIds } }, select: { id: true, adGroup: { select: { campaignId: true } } } })
const gRows = await prisma.adGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, campaignId: true } })
const campOf = new Map<string, string>()
for (const t of tRows) if (t.adGroup?.campaignId) campOf.set(t.id, t.adGroup.campaignId)
for (const g of gRows) campOf.set(g.id, g.campaignId)

const camps = await prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, status: true, liveBidWritesEnabled: true, minBidCents: true, maxBidCents: true } })
const cname = new Map(camps.map((c) => [c.id, c]))

type W = { rows: number; failed: number }
const perCamp = new Map<string, Map<string, W>>()
for (const l of logs) {
  const cid = campOf.get(l.entityId)
  if (!cid) continue
  const o = parseActor(l.userId)
  const key = `${o.origin.kind}:${o.origin.name}`
  if (!perCamp.has(cid)) perCamp.set(cid, new Map())
  const m = perCamp.get(cid)!
  const e = m.get(key) ?? { rows: 0, failed: 0 }
  e.rows++; if (l.amazonResponseStatus === 'FAILED') e.failed++
  m.set(key, e)
}
const dist = new Map<number, number>()
for (const [, m] of perCamp) dist.set(m.size, (dist.get(m.size) ?? 0) + 1)
console.log(`\n── campaigns that received a bid write in 60d: ${int(perCamp.size)} ──`)
console.log(`  distinct writers per campaign:`)
for (const [k, v] of [...dist].sort((a, b) => a[0] - b[0])) console.log(`    ${k} writer${k === 1 ? ' ' : 's'} → ${int(v)} campaign${v === 1 ? '' : 's'}`)
const multi = [...perCamp].filter(([, m]) => m.size > 1)
console.log(`\n  🔴 campaigns with MORE THAN ONE bid writer: ${int(multi.length)}`)
for (const [cid, m] of multi.sort((a, b) => b[1].size - a[1].size).slice(0, 12)) {
  const c = cname.get(cid)
  console.log(`    ${pad(c?.name ?? cid, 34)} ${pad(c?.marketplace ?? '—', 4)} ${m.size} writers: ${[...m].sort((a, b) => b[1].rows - a[1].rows).map(([k, v]) => `${k}(${int(v.rows)}${v.failed ? `,${v.failed}F` : ''})`).join('  ')}`)
}

// ── 2. DECLARED reach: how many things are ALLOWED to bid on each campaign ──
const BID_ACTIONS = ['bid_to_target_acos', 'bid_up', 'bid_down', 'lower_bid_to_floor', 'raise_bids_for_rank_defense']
const allRules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, dryRun: true, actions: true, scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true },
})
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? ''))
const bidRules = allRules.filter((r) => types(r.actions).some((t) => BID_ACTIONS.includes(t)))
const writingRules = bidRules.filter((r) => r.enabled && levelActs(resolveAutonomy(r as never)))
const unscopedWriters = writingRules.filter((r) => !r.scopeMarketplace && !r.scopePortfolioId && !r.scopeCampaignId && !r.scopeProductId)
console.log(`\n── DECLARED bidders ──`)
console.log(`  bid rules that can write : ${int(writingRules.length)}  ·  of those UNSCOPED (reach all 220): ${int(unscopedWriters.length)}`)

const scheds = await prisma.adSchedule.findMany({
  where: { enabled: true },
  select: { id: true, campaignId: true, groupId: true, defaultTargetKey: true, windows: true, lastApplied: true, lastEvaluatedAt: true },
})
const schedByCamp = new Map<string, number>()
for (const s of scheds) schedByCamp.set(s.campaignId, (schedByCamp.get(s.campaignId) ?? 0) + 1)
console.log(`  enabled AdSchedule rows : ${int(scheds.length)} across ${int(schedByCamp.size)} campaigns`)
console.log(`  campaigns with >1 enabled schedule: ${int([...schedByCamp.values()].filter((n) => n > 1).length)}`)
const enabledCamps = camps.filter((c) => c.status === 'ENABLED')
console.log(`\n  For an ENABLED campaign the declared bidders are:`)
console.log(`    ${int(unscopedWriters.length)} account-wide bid rules  +  its rank schedule (${int(schedByCamp.size)} of ${int(enabledCamps.length)} ENABLED campaigns have one)  +  ads-auto-bid (account-wide cron)  +  operators`)
const noSched = enabledCamps.filter((c) => !schedByCamp.has(c.id))
console.log(`    ENABLED campaigns with NO rank schedule: ${int(noSched.length)} — for these the ${int(unscopedWriters.length)} rules are the only declared bidder`)
console.log(`    ${noSched.slice(0, 8).map((c) => c.name).join(' · ')}`)

// ── 3. the cadence: hour-of-day profile of every bid write ──────────────────
const hours = new Array(24).fill(0) as number[]
const hoursOk = new Array(24).fill(0) as number[]
for (const l of logs) {
  // Rome is the operating clock for every schedule in this account.
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }).format(l.createdAt)) % 24
  hours[h]++
  if (l.amazonResponseStatus === 'SUCCESS') hoursOk[h]++
}
console.log(`\n── cadence: when bid writes actually happen (Europe/Rome), 60d ──`)
const maxH = Math.max(...hours)
for (let h = 0; h < 24; h++) {
  const bar = '█'.repeat(Math.round((hours[h] / Math.max(1, maxH)) * 44))
  console.log(`  ${String(h).padStart(2, '0')}:00 ${String(int(hours[h])).padStart(6)} ${bar}`)
}
const night = hours.slice(22).concat(hours.slice(0, 8)).reduce((a, b) => a + b, 0)
console.log(`\n  22:00–08:00 share: ${((night / logs.length) * 100).toFixed(1)}%  ← the suppress/restore cycle, not intraday optimisation`)

// distinct days a target was written on, i.e. real per-entity cadence
const perTargetDays = new Map<string, Set<string>>()
for (const l of logs) {
  const d = l.createdAt.toISOString().slice(0, 10)
  if (!perTargetDays.has(l.entityId)) perTargetDays.set(l.entityId, new Set())
  perTargetDays.get(l.entityId)!.add(d)
}
const writesPerTarget = new Map<string, number>()
for (const l of logs) writesPerTarget.set(l.entityId, (writesPerTarget.get(l.entityId) ?? 0) + 1)
const counts = [...writesPerTarget.values()].sort((a, b) => a - b)
const q = (p: number) => counts[Math.min(counts.length - 1, Math.floor(counts.length * p))] ?? 0
console.log(`\n  entities written: ${int(writesPerTarget.size)} · writes per entity over 60d — median ${q(0.5)} · p90 ${q(0.9)} · max ${q(1)}`)
const daysPerTarget = [...perTargetDays.values()].map((s) => s.size).sort((a, b) => a - b)
const dq = (p: number) => daysPerTarget[Math.min(daysPerTarget.length - 1, Math.floor(daysPerTarget.length * p))] ?? 0
console.log(`  distinct DAYS touched per entity — median ${dq(0.5)} · p90 ${dq(0.9)} · max ${dq(1)}`)
const multiPerDay = [...writesPerTarget].filter(([id, n]) => n / Math.max(1, perTargetDays.get(id)!.size) > 2.5).length
console.log(`  entities averaging >2.5 writes on the days they move: ${int(multiPerDay)}  ← anything above 2 is more than a floor+restore pair`)

await prisma.$disconnect()
