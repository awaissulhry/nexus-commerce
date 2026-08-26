/**
 * PLC page study — READ-ONLY. No writes, no mutations.
 *
 * Measures ONLY what is specific to the Placement page, or what the earlier studies
 * asserted and I actively doubt:
 *
 *  A. Ownership — which campaigns carrying a multiplier are actually GOVERNED by the
 *     rank engine, and which are unmanaged residue. (Doubted: study 3 implied the
 *     15,185 writes and the 145 non-zero campaigns are the same population.)
 *  B. Does the loop CHASE at all? biasBand() makes ceiling = biasPct when maxBiasPct
 *     is null, which would mean targetISPct is never read. (Doubted: study 5 says the
 *     engine "pushes bias upward" against a dead SQP feed.)
 *  C. CampaignBidHistory placement rows — the per-lane attribution substrate.
 *  D. AdvertisingActionLog placement writes: failures, blocks, null actors.
 *  E. AmazonAdsPlacementReport freshness + label vocabulary + topOfSearchIS coverage.
 *  F. The compounding set, by strategy.
 *  G. pins.
 *  H. Page-one: ASIN/campaign overlap per market.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : 'never')
const H = (t: string) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`)

const TOP = 'PLACEMENT_TOP'
const REST = 'PLACEMENT_REST_OF_SEARCH'
const PROD = 'PLACEMENT_PRODUCT_PAGE'
const LANES = [TOP, REST, PROD]
const SHORT: Record<string, string> = { [TOP]: 'Top', [REST]: 'Rest', [PROD]: 'Product' }

const since60 = new Date(Date.now() - 60 * 86_400_000)

console.log('\n═══ PLC page — ownership, chase, attribution, freshness ═══')
console.log(`now=${new Date().toISOString()}  60d window from ${day(since60)}`)

// ─────────────────────────────────────────────────────────────────────────────
H('B · The goal library — does ANY target chase? (biasBand: ceiling = maxBiasPct ?? biasPct)')

const targets = await prisma.rankTarget.findMany({ orderBy: { sortOrder: 'asc' } })
console.log(`RankTarget rows: ${targets.length}`)
console.log(
  `${pad('key', 18)} ${pad('placement', 10)} ${pad('bias', 6)} ${pad('maxBias', 8)} ${pad('IS%', 5)} ${pad('acos', 6)} ${pad('maxCpc', 7)} ${pad('allOut', 7)} ${pad('climb', 6)} ${pad('lanes', 6)} chases?`,
)
for (const t of targets) {
  const floor = t.biasPct ?? 0
  const ceiling = t.allOut ? (t.maxBiasPct ?? 900) : (t.maxBiasPct ?? floor)
  const chases = t.allOut || ceiling > floor
  const lanes = Array.isArray(t.lanes) ? (t.lanes as unknown[]).length : 0
  console.log(
    `${pad(t.key, 18)} ${pad(SHORT[t.placement] ?? t.placement, 10)} ${pad(String(t.biasPct ?? '—'), 6)} ${pad(String(t.maxBiasPct ?? 'null'), 8)} ${pad(String(t.targetISPct ?? '—'), 5)} ${pad(String(t.acosCapPct ?? '—'), 6)} ${pad(String(t.maxCpcCents ?? '—'), 7)} ${pad(String(t.allOut), 7)} ${pad(String(t.keepClimbing), 6)} ${pad(String(lanes), 6)} ${chases ? 'YES' : 'NO — pins at bias, targetIS NEVER READ'}`,
  )
}
console.log(`\ntargets with lanes[] set (blended multi-lane): ${targets.filter((t) => Array.isArray(t.lanes) && (t.lanes as unknown[]).length > 0).length}`)
console.log(`targets that can chase:                        ${targets.filter((t) => t.allOut || ((t.allOut ? (t.maxBiasPct ?? 900) : (t.maxBiasPct ?? (t.biasPct ?? 0))) > (t.biasPct ?? 0))).length}`)

// per-scope overrides could raise a ceiling or inject lanes — check both carriers
H('B2 · Do per-scope overrides raise a ceiling or inject lanes?')
const scheds = await prisma.adSchedule.findMany({
  select: { id: true, campaignId: true, name: true, enabled: true, windows: true, defaultTargetKey: true, targetOverrides: true, lastApplied: true, lastEvaluatedAt: true, groupId: true, timezone: true },
})
const plans = await prisma.productRankPlan.findMany()
console.log(`AdSchedule rows: ${scheds.length} (enabled ${scheds.filter((s) => s.enabled).length})`)
console.log(`ProductRankPlan rows: ${plans.length} (enabled ${plans.filter((p) => p.enabled).length})`)

let ovMaxBias = 0, ovLanes = 0, ovAny = 0
const ovDetail: string[] = []
for (const s of scheds) {
  const m = (s.targetOverrides ?? {}) as Record<string, Record<string, unknown>>
  for (const [k, o] of Object.entries(m)) {
    if (!o || typeof o !== 'object') continue
    ovAny++
    if (o.maxBiasPct != null) { ovMaxBias++; ovDetail.push(`sched ${s.name} · ${k} · maxBiasPct=${String(o.maxBiasPct)}`) }
    if (Array.isArray(o.lanes) && o.lanes.length) { ovLanes++; ovDetail.push(`sched ${s.name} · ${k} · lanes=${o.lanes.length}`) }
  }
}
for (const p of plans) {
  const m = (p.targetOverrides ?? {}) as Record<string, Record<string, unknown>>
  for (const [k, o] of Object.entries(m)) {
    if (!o || typeof o !== 'object') continue
    ovAny++
    if (o.maxBiasPct != null) { ovMaxBias++; ovDetail.push(`plan ${p.id} · ${k} · maxBiasPct=${String(o.maxBiasPct)}`) }
    if (Array.isArray(o.lanes) && o.lanes.length) { ovLanes++; ovDetail.push(`plan ${p.id} · ${k} · lanes=${o.lanes.length}`) }
  }
}
console.log(`target-override entries in total:      ${ovAny}`)
console.log(`  …that raise a ceiling (maxBiasPct):  ${ovMaxBias}`)
console.log(`  …that inject lanes[]:               ${ovLanes}`)
for (const d of ovDetail.slice(0, 20)) console.log(`    ${d}`)

// ─────────────────────────────────────────────────────────────────────────────
H('A · Ownership — who governs each campaign carrying a multiplier?')

const camps = await prisma.campaign.findMany({
  select: {
    id: true, name: true, marketplace: true, status: true, dynamicBidding: true, biddingStrategy: true,
    pinPlacement: true, pinBids: true, pinBudget: true, pinnedBy: true, liveBidWritesEnabled: true,
    externalCampaignId: true, adProduct: true,
  },
})
console.log(`campaigns: ${camps.length}`)

interface PB { placement: string; percentage: number }
const pbOf = (c: (typeof camps)[number]): PB[] => {
  const db = (c.dynamicBidding ?? {}) as { placementBidding?: PB[] }
  return Array.isArray(db.placementBidding) ? db.placementBidding : []
}
const laneOf = (c: (typeof camps)[number], l: string) => pbOf(c).find((x) => x.placement === l)?.percentage ?? 0
const carries = camps.filter((c) => LANES.some((l) => laneOf(c, l) > 0))
console.log(`campaigns with ANY non-zero multiplier: ${carries.length}`)

// goal-mode enabled schedules bind a campaign
const isGoal = (windows: unknown, dtk: string | null) =>
  !!dtk || (Array.isArray(windows) && windows.some((w) => w && typeof w === 'object' && (w as { targetKey?: string }).targetKey))
const schedGoverned = new Set(scheds.filter((s) => s.enabled && isGoal(s.windows, s.defaultTargetKey)).map((s) => s.campaignId))
console.log(`campaigns bound by an ENABLED goal-mode AdSchedule: ${schedGoverned.size}`)

// plan-governed campaigns resolve live; approximate via the plan's last summary
const planGoverned = new Set<string>()
for (const p of plans) {
  if (!p.enabled) continue
  const s = (p.lastSummary ?? {}) as { decisions?: Array<{ campaignId?: string }> }
  for (const d of s.decisions ?? []) if (d.campaignId) planGoverned.add(d.campaignId)
}
console.log(`campaigns named in an ENABLED plan's lastSummary:   ${planGoverned.size}`)

const governed = new Set([...schedGoverned, ...planGoverned])
const carriesGoverned = carries.filter((c) => governed.has(c.id))
const carriesOrphan = carries.filter((c) => !governed.has(c.id))
console.log(`\n  carrying a multiplier AND governed:   ${carriesGoverned.length}`)
console.log(`  carrying a multiplier, NOT governed:  ${carriesOrphan.length}   ← unmanaged residue`)
console.log(`  governed but carrying nothing:        ${[...governed].filter((id) => !carries.some((c) => c.id === id)).length}`)

const bucket = (n: number) => (n === 0 ? '0' : n < 50 ? '1-49' : n < 100 ? '50-99' : n < 200 ? '100-199' : '200+')
const orphanByStatus = new Map<string, number>()
for (const c of carriesOrphan) orphanByStatus.set(c.status, (orphanByStatus.get(c.status) ?? 0) + 1)
console.log(`  unmanaged by status: ${[...orphanByStatus].map(([k, v]) => `${k}=${v}`).join(' · ')}`)
console.log(`  unmanaged with the write gate OPEN:   ${carriesOrphan.filter((c) => c.liveBidWritesEnabled).length}`)
console.log(`  unmanaged, ENABLED, gate open:        ${carriesOrphan.filter((c) => c.liveBidWritesEnabled && c.status === 'ENABLED').length}`)
console.log(`  unmanaged Top bucket: ${[...new Map(carriesOrphan.map((c) => [bucket(laneOf(c, TOP)), 0])).keys()].join(',')}`)
const ub = new Map<string, number>()
for (const c of carriesOrphan) { const b = bucket(laneOf(c, TOP)); ub.set(b, (ub.get(b) ?? 0) + 1) }
console.log(`  unmanaged by Top%: ${[...ub].sort().map(([k, v]) => `${k}:${v}`).join(' · ')}`)

// ─────────────────────────────────────────────────────────────────────────────
H('C · CampaignBidHistory — the per-lane attribution substrate')

const hist = await prisma.campaignBidHistory.findMany({
  where: { field: { in: LANES }, changedAt: { gte: since60 } },
  select: { campaignId: true, entityId: true, field: true, oldValue: true, newValue: true, changedAt: true, changedBy: true, reason: true },
  orderBy: { changedAt: 'desc' },
})
console.log(`placement rows in CampaignBidHistory, 60d: ${int(hist.length)}`)
if (hist.length === 0) {
  console.log('  ⚠ ZERO — verify before reporting. Checking the table lifetime…')
  const anyRow = await prisma.campaignBidHistory.count()
  const anyPlacement = await prisma.campaignBidHistory.count({ where: { field: { in: LANES } } })
  console.log(`  CampaignBidHistory total rows (all fields, all time): ${int(anyRow)}`)
  console.log(`  …of which placement fields (all time):                ${int(anyPlacement)}`)
  const oldest = await prisma.campaignBidHistory.findFirst({ where: { field: { in: LANES } }, orderBy: { changedAt: 'asc' }, select: { changedAt: true } })
  const newest = await prisma.campaignBidHistory.findFirst({ where: { field: { in: LANES } }, orderBy: { changedAt: 'desc' }, select: { changedAt: true } })
  console.log(`  placement history spans: ${day(oldest?.changedAt)} → ${day(newest?.changedAt)}`)
} else {
  const byLane = new Map<string, number>()
  for (const h of hist) byLane.set(h.field, (byLane.get(h.field) ?? 0) + 1)
  console.log(`  by lane: ${LANES.map((l) => `${SHORT[l]}=${int(byLane.get(l) ?? 0)}`).join(' · ')}`)
  console.log(`  distinct campaigns touched: ${new Set(hist.map((h) => h.campaignId ?? h.entityId)).size}`)
  const actorClass = (a: string) =>
    a.startsWith('automation:rank-defend') ? 'automation:rank-defend-*'
      : a.startsWith('automation:rank-plan') ? 'automation:rank-plan-*'
        : a.startsWith('automation:tos') ? 'automation:tos-optimizer'
          : a.startsWith('automation:') ? 'automation:other'
            : a === 'system' ? 'system (UNATTRIBUTED)' : a.startsWith('user:') ? 'user:*' : a
  const byActor = new Map<string, number>()
  for (const h of hist) byActor.set(actorClass(h.changedBy), (byActor.get(actorClass(h.changedBy)) ?? 0) + 1)
  console.log('  by actor class:')
  for (const [k, v] of [...byActor].sort((a, b) => b[1] - a[1])) console.log(`    ${pad(k, 30)} ${int(v)}`)
  const noReason = hist.filter((h) => !h.reason).length
  console.log(`  rows with NO reason: ${int(noReason)} (${((noReason / hist.length) * 100).toFixed(1)}%)`)
  let up = 0, down = 0, same = 0
  for (const h of hist) {
    const o = Number(h.oldValue ?? 0), n = Number(h.newValue ?? 0)
    if (n > o) up++; else if (n < o) down++; else same++
  }
  console.log(`  direction: raises ${int(up)} · cuts ${int(down)} · no-change ${int(same)}`)
  const last = new Map<string, (typeof hist)[number]>()
  for (const h of hist) { const k = h.campaignId ?? h.entityId; if (!last.has(k)) last.set(k, h) }
  console.log(`  campaigns with a placement change in 60d: ${last.size}`)
  console.log(`  …of the ${carries.length} carrying a multiplier, ${carries.filter((c) => last.has(c.id)).length} were touched; ${carries.filter((c) => !last.has(c.id)).length} were NOT`)
  const byDay = new Map<string, number>()
  for (const h of hist) byDay.set(day(h.changedAt), (byDay.get(day(h.changedAt)) ?? 0) + 1)
  const days = [...byDay].sort()
  console.log(`  active days: ${days.length}; most recent 7: ${days.slice(-7).map(([d, n]) => `${d.slice(5)}=${n}`).join(' ')}`)
  console.log('\n  most recent 8 rows:')
  for (const h of hist.slice(0, 8)) {
    console.log(`    ${day(h.changedAt)} ${pad(SHORT[h.field] ?? h.field, 8)} ${pad(`${h.oldValue ?? '—'}→${h.newValue}`, 12)} ${pad(actorClass(h.changedBy), 26)} ${(h.reason ?? '(no reason)').slice(0, 60)}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
H('D · AdvertisingActionLog — placement writes, failures, blocks, null actors')

const logs = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'update_placement_bidding', createdAt: { gte: since60 } },
  select: { id: true, userId: true, entityId: true, amazonResponseStatus: true, createdAt: true, payloadAfter: true, evidence: true },
})
console.log(`update_placement_bidding rows, 60d: ${int(logs.length)}`)
const st = new Map<string, number>()
for (const l of logs) st.set(String(l.amazonResponseStatus ?? 'null'), (st.get(String(l.amazonResponseStatus ?? 'null')) ?? 0) + 1)
console.log(`  by status: ${[...st].map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
const nullActor = logs.filter((l) => !l.userId || l.userId === 'system').length
console.log(`  null / 'system' actor: ${int(nullActor)}`)
const modeOf = (p: unknown) => String((p as { mode?: unknown })?.mode ?? '?')
const md = new Map<string, number>()
for (const l of logs) md.set(modeOf(l.payloadAfter), (md.get(modeOf(l.payloadAfter)) ?? 0) + 1)
console.log(`  by push mode: ${[...md].map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
const tk = new Map<string, number>()
for (const l of logs) { const k = String((l.evidence as { targetKey?: unknown })?.targetKey ?? '(none)'); tk.set(k, (tk.get(k) ?? 0) + 1) }
console.log(`  by targetKey evidence: ${[...tk].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`  distinct campaigns:    ${new Set(logs.map((l) => l.entityId)).size}`)

// ─────────────────────────────────────────────────────────────────────────────
H('E · AmazonAdsPlacementReport — freshness, label vocabulary, topOfSearchIS coverage')

const labels = await prisma.amazonAdsPlacementReport.groupBy({ by: ['placement'], _count: { _all: true }, _max: { date: true } })
console.log('distinct `placement` values (Amazon REPORT labels, not the API enums):')
for (const l of labels.sort((a, b) => b._count._all - a._count._all)) {
  console.log(`  ${pad(l.placement, 32)} rows=${pad(int(l._count._all), 10)} latest=${day(l._max.date)}`)
}
const newestRep = await prisma.amazonAdsPlacementReport.findFirst({ orderBy: { date: 'desc' }, select: { date: true, createdAt: true } })
console.log(`\nnewest report date: ${day(newestRep?.date)}  (ingested ${day(newestRep?.createdAt)})`)
const ageDays = newestRep?.date ? Math.round((Date.now() - newestRep.date.getTime()) / 86_400_000) : null
console.log(`age of the newest placement data: ${ageDays} day(s)`)
const last14 = new Date(Date.now() - 14 * 86_400_000)
const perDay = await prisma.amazonAdsPlacementReport.groupBy({ by: ['date'], where: { date: { gte: last14 } }, _count: { _all: true } })
console.log(`rows per day, last 14: ${perDay.sort((a, b) => +a.date - +b.date).map((r) => `${day(r.date).slice(5)}=${r._count._all}`).join(' ')}`)
const isRows = await prisma.amazonAdsPlacementReport.groupBy({
  by: ['placement'], where: { topOfSearchIS: { not: null }, date: { gte: since60 } }, _count: { _all: true },
})
console.log(`topOfSearchIS non-null rows by label, 60d: ${isRows.map((r) => `${r.placement}=${int(r._count._all)}`).join(' · ') || '(none)'}`)
const isCamps = await prisma.amazonAdsPlacementReport.findMany({
  where: { topOfSearchIS: { not: null }, date: { gte: since60 } }, select: { campaignId: true }, distinct: ['campaignId'],
})
console.log(`campaigns with ANY topOfSearchIS in 60d: ${isCamps.length}`)

// join coverage: report campaignId is EXTERNAL
const repCampIds = await prisma.amazonAdsPlacementReport.findMany({ where: { date: { gte: since60 } }, select: { campaignId: true }, distinct: ['campaignId'] })
const extToLocal = new Map(camps.filter((c) => c.externalCampaignId).map((c) => [c.externalCampaignId!, c]))
const joined = repCampIds.filter((r) => extToLocal.has(r.campaignId)).length
console.log(`report campaigns 60d: ${repCampIds.length}; joinable to a local Campaign: ${joined}; orphan: ${repCampIds.length - joined}`)
console.log(`local campaigns carrying a multiplier with NO placement report row in 60d: ${carries.filter((c) => !c.externalCampaignId || !repCampIds.some((r) => r.campaignId === c.externalCampaignId)).length}`)

// ─────────────────────────────────────────────────────────────────────────────
H('F · The compounding set — strategy × Top multiplier')

const grid = new Map<string, number>()
for (const c of camps) {
  const top = laneOf(c, TOP)
  const b = top === 0 ? '0' : top < 50 ? '1-49' : top < 100 ? '50-99' : top < 200 ? '100-199' : top < 300 ? '200-299' : '300+'
  const k = `${c.biddingStrategy ?? 'null'}|${b}`
  grid.set(k, (grid.get(k) ?? 0) + 1)
}
console.log(`${pad('strategy', 20)} ${['0', '1-49', '50-99', '100-199', '200-299', '300+'].map((b) => pad(b, 9)).join('')}`)
for (const s of [...new Set(camps.map((c) => c.biddingStrategy ?? 'null'))]) {
  console.log(`${pad(s, 20)} ${['0', '1-49', '50-99', '100-199', '200-299', '300+'].map((b) => pad(String(grid.get(`${s}|${b}`) ?? 0), 9)).join('')}`)
}
const upDown = camps.filter((c) => c.biddingStrategy === 'AUTO_FOR_SALES')
console.log(`\nAUTO_FOR_SALES (up-and-down): ${upDown.length}`)
console.log(`  …with Top > 0:    ${upDown.filter((c) => laneOf(c, TOP) > 0).length}`)
console.log(`  …with Top > 100:  ${upDown.filter((c) => laneOf(c, TOP) > 100).length}`)
console.log(`  …ENABLED + gate open + Top>0: ${upDown.filter((c) => laneOf(c, TOP) > 0 && c.status === 'ENABLED' && c.liveBidWritesEnabled).length}`)
const heavy = camps.filter((c) => laneOf(c, TOP) >= 100)
console.log(`\ncampaigns at Top >= 100%: ${heavy.length}`)
console.log(`  ENABLED: ${heavy.filter((c) => c.status === 'ENABLED').length} · gate open: ${heavy.filter((c) => c.liveBidWritesEnabled).length} · ENABLED+open: ${heavy.filter((c) => c.status === 'ENABLED' && c.liveBidWritesEnabled).length}`)
console.log(`  governed by the rank engine: ${heavy.filter((c) => governed.has(c.id)).length} · unmanaged: ${heavy.filter((c) => !governed.has(c.id)).length}`)
console.log('\n  live ones (ENABLED):')
for (const c of heavy.filter((x) => x.status === 'ENABLED').sort((a, b) => laneOf(b, TOP) - laneOf(a, TOP)).slice(0, 12)) {
  console.log(`    ${pad(c.name, 40)} ${pad(c.marketplace ?? '—', 4)} Top=${pad(String(laneOf(c, TOP)), 5)} Rest=${pad(String(laneOf(c, REST)), 5)} Prod=${pad(String(laneOf(c, PROD)), 5)} ${pad(c.biddingStrategy ?? '—', 18)} gate=${c.liveBidWritesEnabled ? 'OPEN' : 'shut'} ${governed.has(c.id) ? 'GOVERNED' : 'unmanaged'}`)
}

// ─────────────────────────────────────────────────────────────────────────────
H('G · Pins')
console.log(`pinPlacement: ${camps.filter((c) => c.pinPlacement).length} · pinBids: ${camps.filter((c) => c.pinBids).length} · pinBudget: ${camps.filter((c) => c.pinBudget).length}`)
console.log(`any pin set:  ${camps.filter((c) => c.pinPlacement || c.pinBids || c.pinBudget).length}`)
const pinLog = await prisma.advertisingActionLog.count({ where: { actionType: 'set_campaign_authority_pins' } })
console.log(`set_campaign_authority_pins audit rows (all time): ${pinLog}   ← has the pin UI ever been used?`)

// ─────────────────────────────────────────────────────────────────────────────
H('H · Page one — how many of our own ASINs / campaigns share a market')

const ads = await prisma.adProductAd.findMany({
  where: { adGroup: { campaign: { status: 'ENABLED' } } },
  select: { asin: true, status: true, adGroup: { select: { campaignId: true } } },
})
const campByMkt = new Map(camps.map((c) => [c.id, c.marketplace ?? '—']))
const asinsByMkt = new Map<string, Set<string>>()
const campsByAsinMkt = new Map<string, Set<string>>()
for (const a of ads) {
  const cid = a.adGroup?.campaignId
  if (!cid || !a.asin) continue
  const mk = campByMkt.get(cid) ?? '—'
  const s = asinsByMkt.get(mk) ?? new Set<string>(); s.add(a.asin); asinsByMkt.set(mk, s)
  const k = `${mk}|${a.asin}`
  const cs = campsByAsinMkt.get(k) ?? new Set<string>(); cs.add(cid); campsByAsinMkt.set(k, cs)
}
console.log('distinct ENABLED-campaign ASINs per market:')
for (const [mk, s] of [...asinsByMkt].sort((a, b) => b[1].size - a[1].size)) console.log(`  ${pad(mk, 6)} ${s.size}`)
const multi = [...campsByAsinMkt].filter(([, s]) => s.size > 1)
console.log(`\n(ASIN × market) pairs advertised by MORE THAN ONE enabled campaign: ${multi.length} of ${campsByAsinMkt.size}`)
const dist = new Map<number, number>()
for (const [, s] of campsByAsinMkt) dist.set(s.size, (dist.get(s.size) ?? 0) + 1)
console.log(`  campaigns-per-(ASIN×market): ${[...dist].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}→${v}`).join(' · ')}`)

// lane spread among the campaigns that share an ASIN — can two of ours hold different lanes today?
let sameLaneProfile = 0, differentLaneProfile = 0
for (const [, s] of multi) {
  const profiles = new Set([...s].map((cid) => {
    const c = camps.find((x) => x.id === cid)
    return c ? LANES.map((l) => laneOf(c, l)).join('/') : '?'
  }))
  if (profiles.size === 1) sameLaneProfile++; else differentLaneProfile++
}
console.log(`  of those, identical lane profiles: ${sameLaneProfile} · differing: ${differentLaneProfile}`)

await prisma.$disconnect()
console.log('\n═══ done — read-only ═══\n')
