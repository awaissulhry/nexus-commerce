/**
 * RD — Rank & Dayparting Schedules tab study. READ-ONLY: no writes, no mutations.
 *
 * This is the section's most developed tab and the only one whose engine writes to Amazon
 * continuously (`ad-rank-defend`, 6,261 runs, and the 15,185 placement writes measured in the
 * Placement study). The question here is not "does it work" but "is it hitting what it aims at,
 * and can an operator tell".
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')

console.log('\n═══ RD — Rank & Dayparting ═══\n')

// ── 1. the authoring layer ────────────────────────────────────────────────────
const groups = await prisma.rankScheduleGroup.findMany({
  select: {
    id: true, name: true, marketplace: true, timezone: true, enabled: true, windows: true,
    defaultTargetKey: true, portfolioId: true, createdAt: true, updatedAt: true,
    _count: { select: { schedules: true, versions: true, events: true } },
  },
  orderBy: [{ enabled: 'desc' }, { name: 'asc' }],
})
console.log(`RankScheduleGroup: ${groups.length}  (enabled ${groups.filter((g) => g.enabled).length})`)
console.log(`${pad('group', 46)} ${pad('on', 4)} ${pad('mkt', 4)} ${pad('camps', 6)} ${pad('wins', 5)} ${pad('baseline', 16)} ${pad('vers', 5)} ${pad('evts', 5)} updated`)
for (const g of groups) {
  const w = Array.isArray(g.windows) ? g.windows.length : 0
  console.log(`${pad(g.name, 46)} ${pad(g.enabled ? 'ON' : '—', 4)} ${pad(g.marketplace ?? '—', 4)} ${pad(String(g._count.schedules), 6)} ${pad(String(w), 5)} ${pad(g.defaultTargetKey ?? '—', 16)} ${pad(String(g._count.versions), 5)} ${pad(String(g._count.events), 5)} ${g.updatedAt.toISOString().slice(0, 10)}`)
}

// ── 2. the execution layer ────────────────────────────────────────────────────
const scheds = await prisma.adSchedule.findMany({
  select: { id: true, campaignId: true, name: true, enabled: true, groupId: true, windows: true, defaultTargetKey: true, lastApplied: true, lastEvaluatedAt: true, targetOverrides: true },
})
console.log(`\nAdSchedule (per-campaign execution rows): ${scheds.length}  (enabled ${scheds.filter((s) => s.enabled).length})`)
console.log(`  bound to a group : ${scheds.filter((s) => s.groupId).length}`)
console.log(`  orphaned         : ${scheds.filter((s) => !s.groupId).length}`)
const evaluated = scheds.filter((s) => s.lastEvaluatedAt)
console.log(`  evaluated ever   : ${evaluated.length}`)
if (evaluated.length) {
  const newest = evaluated.map((s) => s.lastEvaluatedAt!.getTime()).sort((a, b) => b - a)[0]
  console.log(`  most recent tick : ${new Date(newest).toISOString().slice(0, 16)}`)
}
const applied = new Map<string, number>()
for (const s of scheds) applied.set(String(s.lastApplied ?? 'null'), (applied.get(String(s.lastApplied ?? 'null')) ?? 0) + 1)
console.log(`  lastApplied      : ${[...applied].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
const withOverrides = scheds.filter((s) => s.targetOverrides && Object.keys(s.targetOverrides as object).length > 0)
console.log(`  with per-campaign target overrides: ${withOverrides.length}`)

// ── 3. the goals themselves ───────────────────────────────────────────────────
const targets = await prisma.rankTarget.findMany({ orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }] })
console.log(`\nRankTarget (the goal library): ${targets.length}`)
console.log(`${pad('key', 20)} ${pad('placement', 26)} ${pad('IS%', 5)} ${pad('ACoS', 6)} ${pad('maxCPC', 8)} ${pad('bias', 6)} ${pad('allOut', 7)} ${pad('pause', 6)} lanes`)
for (const t of targets) {
  console.log(`${pad(t.key, 20)} ${pad(t.placement, 26)} ${pad(t.targetISPct != null ? `${t.targetISPct}%` : '—', 5)} ${pad(t.acosCapPct != null ? `${t.acosCapPct}%` : '—', 6)} ${pad(t.maxCpcCents != null ? `€${(t.maxCpcCents / 100).toFixed(2)}` : '—', 8)} ${pad(t.biasPct != null ? `${t.biasPct}%` : '—', 6)} ${pad(t.allOut ? 'YES' : '—', 7)} ${pad(t.pause ? 'yes' : '—', 6)} ${Array.isArray(t.lanes) ? (t.lanes as unknown[]).length : '—'}`)
}
const unbounded = targets.filter((t) => t.allOut && t.maxCpcCents == null)
console.log(`\n  🔴 all-out targets with NO CPC ceiling (truly unbounded): ${unbounded.length}`)
for (const t of unbounded) console.log(`     ${t.key} — "${t.name}"`)

// ── 4. events and versions — the two governance objects ───────────────────────
const [events, versions] = await Promise.all([
  prisma.rankScheduleEvent.findMany({ select: { name: true, startsAt: true, endsAt: true, enabled: true, group: { select: { name: true } } }, orderBy: { startsAt: 'desc' }, take: 10 }),
  prisma.rankScheduleVersion.count(),
])
console.log(`\nRankScheduleEvent (dated overrides — the Black Friday object): ${events.length ? '' : '0'}`)
for (const e of events) console.log(`  ${pad(e.name, 30)} ${e.startsAt.toISOString().slice(0, 10)} → ${e.endsAt.toISOString().slice(0, 10)}  enabled=${e.enabled}  [${e.group.name}]`)
console.log(`RankScheduleVersion (plan-edit history): ${versions}`)
const templates = await prisma.rankScheduleTemplate.count()
console.log(`RankScheduleTemplate (saved plans): ${templates}`)

// ── 5. IS THE ENGINE HITTING ITS TARGET? ──────────────────────────────────────
const since = new Date(Date.now() - 30 * 86_400_000)
const campIds = [...new Set(scheds.filter((s) => s.enabled).map((s) => s.campaignId))]
const camps = await prisma.campaign.findMany({
  where: { id: { in: campIds } },
  select: { id: true, name: true, marketplace: true, status: true, externalCampaignId: true, liveBidWritesEnabled: true, dynamicBidding: true },
})
const extIds = camps.map((c) => c.externalCampaignId).filter(Boolean) as string[]
const tos = await prisma.amazonAdsPlacementReport.groupBy({
  by: ['campaignId'],
  where: { date: { gte: since }, campaignId: { in: extIds }, topOfSearchIS: { not: null } },
  _avg: { topOfSearchIS: true }, _count: { _all: true },
})
const tosBy = new Map(tos.map((t) => [t.campaignId, { avg: Number(t._avg.topOfSearchIS ?? 0), n: t._count._all }]))

// resolve each enabled schedule's baseline target
const tByKey = new Map(targets.map((t) => [t.key, t]))
console.log(`\n── are the enabled schedules hitting their impression-share goal? (30d) ──`)
console.log(`${pad('campaign', 44)} ${pad('mkt', 4)} ${pad('baseline', 15)} ${pad('goal', 6)} ${pad('actual', 7)} ${pad('days', 5)} gate`)
let hit = 0, miss = 0, noData = 0
for (const s of scheds.filter((x) => x.enabled)) {
  const c = camps.find((x) => x.id === s.campaignId)
  if (!c) continue
  const key = s.defaultTargetKey ?? groups.find((g) => g.id === s.groupId)?.defaultTargetKey ?? null
  const t = key ? tByKey.get(key) : undefined
  const goal = t?.targetISPct ?? null
  const act = c.externalCampaignId ? tosBy.get(c.externalCampaignId) : undefined
  if (!act) { noData++; continue }
  const actual = act.avg * 100
  if (goal != null) { if (actual >= goal) hit++; else miss++ }
  console.log(`${pad(c.name, 44)} ${pad(c.marketplace ?? '—', 4)} ${pad(key ?? '—', 15)} ${pad(goal != null ? `${goal}%` : '—', 6)} ${pad(`${actual.toFixed(1)}%`, 7)} ${pad(String(act.n), 5)} ${c.liveBidWritesEnabled ? 'open' : 'CLOSED'}`)
}
console.log(`\n  hitting goal: ${hit}  ·  short of goal: ${miss}  ·  no placement data: ${noData}`)

// ── 6. the engines ────────────────────────────────────────────────────────────
const crons = await prisma.cronRun.groupBy({
  by: ['jobName'],
  where: { jobName: { in: ['ad-rank-defend', 'ad-dayparting', 'top-of-search-defense'] } },
  _count: { _all: true }, _max: { startedAt: true },
})
console.log(`\n── the engines ──`)
for (const n of ['ad-rank-defend', 'ad-dayparting', 'top-of-search-defense']) {
  const c = crons.find((x) => x.jobName === n)
  console.log(`  ${pad(n, 24)} ${c ? `runs=${String(int(c._count._all)).padStart(7)}  last=${c._max.startedAt?.toISOString().slice(0, 16)}` : 'NEVER RUN'}`)
}

await prisma.$disconnect()
