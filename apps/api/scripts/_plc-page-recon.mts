/**
 * PLC.1 — reconcile the flag counts against the study before any UI is built. READ-ONLY.
 *
 * Three disagreements to explain, not to paper over:
 *   · evaluable 23 vs the study's 18
 *   · inverted 7 vs 8, and `IT-AIREON-SP-Auto` has left the list
 *   · decorative 33 vs 29, and the 4 GALE exceptions did not appear
 */
import '../src/env.js'

const { default: prisma } = await import('../src/db.js')
const {
  getPlacementGrid, PLC_MARKET_ALL, PLC_LANES, KEY_BY_LANE, laneMultipliers,
  INVERSION_MIN_CLICKS, specOfTarget, decorativeOf,
} = await import('../src/services/advertising/placement-grid.service.js')
const { biasBand } = await import('../src/services/advertising/rank-controller.js')
const { applyTargetOverrides, isGoalMode } = await import('../src/jobs/ad-rank-defend.job.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const H = (t: string) => console.log(`\n${'─'.repeat(84)}\n${t}\n${'─'.repeat(84)}`)

const ymd = (d: Date) => d.toISOString().slice(0, 10)
const today = new Date()
const end = ymd(today)
const s60 = new Date(today); s60.setUTCDate(s60.getUTCDate() - 59)
// The study ran on 2026-08-11 over 60 days → 2026-06-12 → 2026-08-11.
const STUDY_START = '2026-06-12'
const STUDY_END = '2026-08-11'

const base = {
  market: PLC_MARKET_ALL, line: null, portfolio: null, campaign: null,
  lane: 'all' as const, flag: 'all' as const, q: null, sort: null, dir: 'desc' as const,
}

console.log('\n═══ PLC.1 — reconciliation ═══')

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('A · Does the study\'s EXACT window reproduce the study\'s numbers?')

for (const [label, st, en] of [
  ["the study's own window", STUDY_START, STUDY_END],
  ['my 60d (slid 2 days later)', ymd(s60), end],
] as const) {
  const d = await getPlacementGrid({ ...base, preset: 'custom', start: st, end: en })
  const byC = new Map<string, (typeof d.rows)[number]>()
  for (const r of d.rows) if (!byC.has(r.campaignId)) byC.set(r.campaignId, r)
  console.log(`  ${pad(label, 30)} ${st}→${en}  evaluable ${d.flags.inverted.of}  inverted ${d.flags.inverted.n}`)
  if (st === STUDY_START) {
    for (const r of [...byC.values()].filter((x) => x.flags.inversion).sort((a, b) => a.name.localeCompare(b.name))) {
      const i = r.flags.inversion!
      console.log(`      ${pad(r.name, 32)} ${i.paidLaneKey} ${i.paidPct}% ${i.paidRoas.toFixed(2)} → ${i.bestLaneKey} ${i.bestPct}% ${i.bestRoas.toFixed(2)}`)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('B · The 23 evaluable — how many carry NO multiplier at all?')

const d = await getPlacementGrid({ ...base, preset: 'custom', start: STUDY_START, end: STUDY_END })
const byCampaign = new Map<string, (typeof d.rows)[number][]>()
for (const r of d.rows) { const l = byCampaign.get(r.campaignId) ?? []; l.push(r); byCampaign.set(r.campaignId, l) }
const evaluable = [...byCampaign.values()].filter((rs) => rs[0]!.flags.invertedEvaluable)
const noMultiplier = evaluable.filter((rs) => rs.every((r) => r.multiplierPct === 0))
console.log(`  evaluable: ${evaluable.length}`)
console.log(`  …of which carry NO multiplier on any lane: ${noMultiplier.length}`)
console.log(`  …so "≥2 lanes at ≥${INVERSION_MIN_CLICKS} clicks AND a non-zero multiplier" = ${evaluable.length - noMultiplier.length}`)
console.log(`\n  🔴 The study's own words: "restricting to campaigns with at least two lanes carrying`)
console.log(`     ≥20 clicks AND A NON-ZERO MULTIPLIER". The brief's pseudocode moved that condition`)
console.log(`     out of evaluability and into the verdict. THAT is the 23-vs-18 gap.`)
for (const rs of noMultiplier) console.log(`      no multiplier anywhere: ${rs[0]!.name}`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('C · The inverted rows whose "paying most" lane is itself at 0%')

for (const rs of [...byCampaign.values()].filter((x) => x[0]!.flags.inversion)) {
  const i = rs[0]!.flags.inversion!
  if (i.paidPct > 0) continue
  const mult = rs.map((r) => `${r.laneKey}=${r.multiplierPct}%/${r.clicks}c`).join(' ')
  console.log(`  🔴 ${pad(rs[0]!.name, 32)} claims "paying most into ${i.paidLaneKey} at ${i.paidPct}%"`)
  console.log(`     lanes: ${mult}`)
  console.log(`     → the multiplier is on a lane with too little traffic to score, so the claim`)
  console.log(`       "you pay most into the wrong lane" asserts something false.`)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('D · IT-AIREON-SP-Auto — why it left the list')

const air = await prisma.campaign.findFirst({
  where: { name: 'IT-AIREON-SP-Auto' },
  select: { id: true, name: true, dynamicBidding: true, externalCampaignId: true },
})
if (air) {
  const m = laneMultipliers(air.dynamicBidding)
  console.log(`  lanes NOW: ${PLC_LANES.map((l) => `${KEY_BY_LANE[l]}=${m[l]}%`).join(' · ')}`)
  console.log(`  the study measured: rest=45% (rest-of-search.biasPct), top=0%`)
  const rows = [...byCampaign.values()].find((rs) => rs[0]!.name === 'IT-AIREON-SP-Auto')
  if (rows) for (const r of rows) console.log(`    ${pad(r.laneKey, 8)} mult=${pad(`${r.multiplierPct}%`, 6)} clicks=${pad(String(r.clicks), 5)} roas=${r.roas?.toFixed(2) ?? '—'}`)
  const hist = await prisma.campaignBidHistory.findMany({
    where: { campaignId: air.id, field: { in: [...PLC_LANES] } },
    orderBy: { changedAt: 'desc' }, take: 6,
    select: { field: true, oldValue: true, newValue: true, changedAt: true, reason: true },
  })
  console.log(`  its last 6 placement writes:`)
  for (const h of hist) console.log(`    ${h.changedAt.toISOString()} ${pad(KEY_BY_LANE[h.field as (typeof PLC_LANES)[number]] ?? h.field, 8)} ${h.oldValue}→${h.newValue}  ${(h.reason ?? '').slice(0, 44)}`)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('E · decorative — is "ANY reachable target decorative" or "NONE can chase" the 29?')

const scheds = await prisma.adSchedule.findMany({
  where: { enabled: true },
  select: { campaignId: true, name: true, windows: true, defaultTargetKey: true, targetOverrides: true },
})
const goal = scheds.filter((s) => isGoalMode(s.windows, s.defaultTargetKey))
const targets = await prisma.rankTarget.findMany({
  select: {
    key: true, placement: true, targetISPct: true, acosCapPct: true, maxCpcCents: true,
    biasPct: true, pause: true, allOut: true, maxBiasPct: true, keepClimbing: true, lanes: true,
  },
})
const byKey = new Map(targets.map((t) => [t.key, specOfTarget(t)]))
let anyDecorative = 0, noneCanChase = 0
const exceptions: string[] = []
for (const s of goal) {
  const w = Array.isArray(s.windows) ? (s.windows as Array<{ targetKey?: string }>) : []
  const reachable = [...new Set([s.defaultTargetKey, ...w.map((x) => x?.targetKey)].filter((k): k is string => !!k))]
  const specs = reachable.map((k) => byKey.get(k)).filter((x): x is NonNullable<typeof x> => !!x)
    .map((sp) => applyTargetOverrides(sp, s.targetOverrides as Parameters<typeof applyTargetOverrides>[1]))
  const dec = decorativeOf(specs)
  const chaseable = specs.filter((sp) => sp.allOut || biasBand(sp).ceiling > biasBand(sp).floor)
  if (dec.length > 0) anyDecorative += 1
  if (dec.length > 0 && chaseable.length === 0) noneCanChase += 1
  if (chaseable.length > 0) {
    exceptions.push(`${s.name} — can chase: ${chaseable.map((sp) => `${sp.key}(floor ${biasBand(sp).floor}→ceiling ${biasBand(sp).ceiling})`).join(', ')}`)
  }
}
console.log(`  live goal-mode schedules: ${goal.length}`)
console.log(`  "ANY reachable target is decorative"  → ${anyDecorative}`)
console.log(`  "NONE of its targets can chase"       → ${noneCanChase}   ← the study's 29`)
console.log(`\n  the schedules that CAN chase (the study's 4 exceptions):`)
for (const e of exceptions) console.log(`    · ${e}`)

await prisma.$disconnect()
console.log('\n═══ done — read-only ═══\n')
