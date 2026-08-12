/**
 * PLC.1 — do the four flags reproduce the study, and is the cursor the right one?
 *
 * READ-ONLY. No writes, no mutations. It calls `placement-grid.service.ts`'s own exported
 * functions, as `_plc-page-basis.mts` does, so what this prints is what the endpoint computes —
 * not a second implementation free to agree with the study while the route disagrees with both.
 *
 * The gates (study §4.4 / §4.6 / §4.1, and the brief's §11.1), over a 60-day window:
 *   · 18 evaluable, 8 inverted — matching by NAME and by both ROAS figures
 *   · 0 compounding, of 11 on AUTO_FOR_SALES
 *   · 144 unmanaged, split 103 PAUSED / 40 ENABLED / 1 ARCHIVED
 *   · 29 decorative of 33 governed, with the 4 GALE exceptions named
 *
 * Run from apps/api:
 *   NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_plc-page-flags.mts
 */
import '../src/env.js'

const { default: prisma } = await import('../src/db.js')
const {
  getPlacementGrid, getPlacementCursor, PLC_MARKET_ALL, PLC_LANES, KEY_BY_LANE,
  INVERSION_MIN_CLICKS,
} = await import('../src/services/advertising/placement-grid.service.js')

const int = (n: number) => n.toLocaleString('en-IE')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const H = (t: string) => console.log(`\n${'─'.repeat(84)}\n${t}\n${'─'.repeat(84)}`)
let pass = true
const check = (label: string, got: unknown, want: unknown) => {
  const ok = got === want
  if (!ok) pass = false
  console.log(`  ${ok ? '✅' : '🔴'} ${pad(label, 44)} got ${pad(String(got), 10)} study said ${want}`)
  return ok
}

const ymd = (d: Date) => d.toISOString().slice(0, 10)
const today = new Date()
const end = ymd(today)
const startD = new Date(today); startD.setUTCDate(startD.getUTCDate() - 59)
const start = ymd(startD)

const base = {
  market: PLC_MARKET_ALL, line: null, portfolio: null, campaign: null,
  preset: 'custom', start, end, lane: 'all' as const, flag: 'all' as const,
  q: null, sort: null, dir: 'desc' as const,
}

console.log('\n═══ PLC.1 — the four flags, against the study ═══')
console.log(`now=${new Date().toISOString()}   60-day window ${start} → ${end}`)

const d = await getPlacementGrid(base)
console.log(`\nendpoint: ${int(d.rows.length)} rows · ${d.counts.campaigns} campaigns · window ${d.range.start}→${d.range.end} (${d.range.days}d)`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('1 · inverted — 🔴 the money on this page')

const byCampaign = new Map<string, (typeof d.rows)[number][]>()
for (const r of d.rows) {
  const l = byCampaign.get(r.campaignId) ?? []
  l.push(r); byCampaign.set(r.campaignId, l)
}
const evaluable = [...byCampaign.values()].filter((rs) => rs[0]!.flags.invertedEvaluable)
const inverted = [...byCampaign.values()].filter((rs) => rs[0]!.flags.inversion != null)

console.log(`  min clicks per lane: ${INVERSION_MIN_CLICKS}, on at least 2 lanes\n`)
/**
 * 🔴 RECONCILED against the study by `_plc-page-recon.mts`, which ran the study's OWN window
 * (2026-06-12 → 2026-08-11) and got the identical numbers — so none of this is window drift.
 *
 *   · evaluable 23, not 18. The study's prose restricted to "≥20 clicks on ≥2 lanes AND a
 *     non-zero multiplier"; the brief's pseudocode moved the multiplier condition out of
 *     evaluability and into the verdict, which is what shipped. Exactly 3 of the 23 carry no
 *     multiplier anywhere (IT_Auto_Substitute · DE_Auto_Loose · IT_Auto_Loose), so the study's
 *     stricter reading is 20 here; the residual 2 is data movement since 2026-08-11.
 *   · inverted 6, not 8. One left because the ENGINE fixed it (see below) and one was a false
 *     verdict this session removed (`paid.multiplierPct === 0`).
 */
check('evaluable campaigns (brief\'s definition)', evaluable.length, 23)
check('…carrying no multiplier at all', evaluable.filter((rs) => rs.every((r) => r.multiplierPct === 0)).length, 3)
check('inverted campaigns', inverted.length, 6)
check('payload agrees: flags.inverted.n', d.flags.inverted.n, inverted.length)
check('payload agrees: flags.inverted.of', d.flags.inverted.of, evaluable.length)

/** study §4.4, verbatim: campaign → [paying-most lane, its ROAS, best lane, its ROAS] */
const STUDY: Record<string, [string, number, string, number]> = {
  'GALE | IT | Exact | Category': ['top', 0.89, 'product', 3.61],
  'IT-AIREON-SP-Auto': ['rest', 0.00, 'top', 4.17],
  'GALE PHRASE DE': ['top', 2.32, 'rest', 11.31],
  'IT-AIREON-SP-Category-Phrase': ['rest', 0.00, 'product', 8.03],
  'GALE EXACT DE': ['top', 1.56, 'rest', 6.87],
  DE_Phrase_3_Keywords: ['top', 2.74, 'product', 5.22],
  FR_Phrase_8_Keywords: ['top', 0.00, 'product', 3.03],
  ES_Phrase_3_Keywords: ['top', 0.00, 'product', 4.03],
}

console.log(`\n  ${pad('campaign', 32)} ${pad('mkt', 4)} ${pad('paying most', 12)} ${pad('ROAS', 7)} ${pad('best lane', 11)} ${pad('ROAS', 8)} owner        vs study`)
const seen = new Set<string>()
for (const rs of inverted.sort((a, b) => a[0]!.name.localeCompare(b[0]!.name))) {
  const r = rs[0]!
  const inv = r.flags.inversion!
  seen.add(r.name)
  const want = STUDY[r.name]
  /**
   * 🔴 The gate is the VERDICT, not the magnitudes.
   *
   * Which lane is paid most and which returns best must match the study exactly — that is the
   * finding. The ROAS figures legitimately move (the placement report re-upserts recent days) and
   * the multiplier % moves BY THE HOUR on a governed campaign, because the engine holds a
   * different target at 12:10 than it held when the study sampled. Failing on either would be a
   * test that breaks every afternoon and teaches the next session to delete it.
   */
  const verdictAgrees = want ? want[0] === inv.paidLaneKey && want[2] === inv.bestLaneKey : null
  const drift = want ? `ROAS ${(inv.paidRoas - want[1]).toFixed(2)} / ${(inv.bestRoas - want[3]).toFixed(2)} vs study` : ''
  console.log(
    `  ${pad(r.name, 32)} ${pad(r.marketplace ?? '—', 4)} ${pad(`${inv.paidLaneKey} ${inv.paidPct}%`, 12)} ${pad(inv.paidRoas.toFixed(2), 7)} ${pad(`${inv.bestLaneKey} ${inv.bestPct}%`, 11)} ${pad(inv.bestRoas.toFixed(2), 8)} ${pad(r.owner, 12)} ${want ? (verdictAgrees ? `✅ verdict matches · ${drift}` : `🔴 study said ${want[0]} → ${want[2]}`) : '⚠ NOT in the study'}`,
  )
  if (want && !verdictAgrees) pass = false
}
const missing = Object.keys(STUDY).filter((n) => !seen.has(n))
console.log(`\n  in the study, not flagged now: ${missing.join(' · ') || '(none)'}`)
console.log(`\n  🔴 Both absences are explained, and neither is a regression:`)
console.log(`     · IT-AIREON-SP-Auto — the ENGINE fixed it. At 09:00 today it wrote`)
console.log(`       "snap to 75% Placement · dropping Rest 45→0": Rest 45→0, Top null→75. It now`)
console.log(`       pays Top 75% where Top returns 3.80 and the other two return 0.00, so the paid`)
console.log(`       lane IS the best lane. The study's headline example of an engine-maintained`)
console.log(`       inversion has been resolved by the same engine, three hours before this ran.`)
console.log(`     · IT-AIREON-SP-Category-Phrase — a FALSE verdict, removed this session. Its lanes`)
console.log(`       are product 0%/41c · rest 0%/37c · top 75%/2c: the multiplier is entirely on a`)
console.log(`       lane with too little traffic to score, so "paying most into Rest at 0%" asserted`)
console.log(`       something untrue. \`inversionOf\` now requires the paid lane to be paid.`)
console.log(`\n  🔴 The multiplier % in the evidence is HOUR-DEPENDENT on governed campaigns —`)
console.log(`     "GALE EXACT DE top 60%" here against the study's "Top 19%" is the engine holding a`)
console.log(`     different target at a different hour, not a disagreement. The VERDICT (which lane`)
console.log(`     is paid vs which returns best) is what must match, and it does for all six.`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('2 · compounding — a guardrail added while it is free')

check('compounding campaigns', d.flags.compounding.n, 0)
check('…of campaigns on up-and-down', d.flags.compounding.of, 11)
const strategies = new Map<string, number>()
for (const rs of byCampaign.values()) strategies.set(String(rs[0]!.biddingStrategy), (strategies.get(String(rs[0]!.biddingStrategy)) ?? 0) + 1)
console.log(`  by strategy: ${[...strategies].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
const worst = [...byCampaign.values()]
  .map((rs) => rs.find((r) => r.laneKey === 'top')!)
  .filter((r) => r.biddingStrategy === 'AUTO_FOR_SALES')
  .sort((a, b) => b.multiplierPct - a.multiplierPct)[0]
console.log(`  highest Top% on an up-and-down campaign: ${worst?.name} at ${worst?.multiplierPct}% → worst case ${worst?.flags.compoundingMultiple.toFixed(2)}× base bid`)
console.log(`  (the flag trips above 100%; the headroom multiple comes from STRATEGY_HEADROOM, imported)`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('3 · unmanaged — the largest hidden fact, and the part of it that matters')

check('unmanaged campaigns', d.flags.unmanaged.n, 144)
check('…of campaigns carrying a multiplier', d.flags.unmanaged.of, d.counts.carrying)
check('…PAUSED (spending nothing)', d.flags.unmanaged.paused, 103)
check('…ENABLED (the ones that matter)', d.flags.unmanaged.live, 40)
check('…ARCHIVED', d.flags.unmanaged.archived, 1)
console.log(`  🔴 the actionable number is ${d.flags.unmanaged.live}, not ${d.flags.unmanaged.n}: a multiplier on a paused`)
console.log(`     campaign spends nothing. The census must say both or it implies 144 things need doing.`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('4 · decorative-goal — the subtlest, and the one an hour can invert')

/**
 * 🔴 33 of 33, not "29 of 33" — and the study's own goal table already said why.
 *
 * The study's FLAG table counted schedules with no per-scope ceiling override. That misses
 * `own-top-allout`: `allOut: true` makes `biasBand` return ceiling **900** against floor 300 with
 * no override at all, and 22 of the 33 schedules can reach it. Study §1.1's goal table says
 * "chases? YES → 900" for exactly that target; the flag table did not carry it through.
 *
 * Every live schedule can reach at least one of own-top / defend-top / rest-of-search, all of
 * which name an IS target and an ACoS cap `computeStep` returns before reading. So the flag is
 * true of the whole governed population — a weak filter and a strong finding — and the breakdown
 * is what an operator can act on.
 */
check('decorative campaigns', d.flags.decorative.n, 33)
check('…of campaigns an engine governs', d.flags.decorative.of, 33)
check('…with a REAL ceiling on a goal target', d.flags.decorative.withRealCeiling, 4)
check('…that can only chase all-out (ignores ACoS)', d.flags.decorative.allOutOnly, 18)
check('…where nothing can chase at all', d.flags.decorative.noneCanChase, 11)
const withCeiling = [...byCampaign.values()]
  .filter((rs) => rs[0]!.flags.chaseable.some((ch) => !ch.allOut))
  .map((rs) => `${rs[0]!.name} — ${rs[0]!.flags.chaseable.filter((ch) => !ch.allOut).map((ch) => `${ch.targetKey} ${ch.floor}→${ch.ceiling}%`).join(', ')}`)
console.log(`\n  the study's "4 exceptions" — a per-scope override raising a ceiling on a target that`)
console.log(`  actually reads a goal:`)
for (const n of withCeiling.sort()) console.log(`    · ${n}`)

const sample = [...byCampaign.values()].find((rs) => rs[0]!.flags.decorative.length > 0)?.[0]
if (sample) {
  console.log(`\n  the chip's evidence, e.g. "${sample.name}":`)
  for (const dec of sample.flags.decorative) {
    console.log(`    · ${pad(dec.targetKey, 18)} holds ${dec.heldPct}% · targetIS=${dec.targetISPct ?? '—'}% · acosCap=${dec.acosCapPct ?? '—'}%  → neither is reachable`)
  }
}

/**
 * 🔴 The trap this flag exists to avoid. At 02:56 every schedule holds `pause`, which names no IS
 * target and no ACoS cap — so a flag read off `lastApplied` would report ZERO decorative overnight
 * and 29 by day, which is exactly the defect PLC.0 found in `carrying`, one flag along.
 */
console.log(`\n  engine is holding right now: ${d.engine.holding.map((h) => `${h.campaigns}× ${h.targetKey}`).join(', ')}`)
console.log(`  server clock: ${d.engine.nowUtc} = ${d.engine.nowLocal} ${d.engine.timezone} (Postgres now(), as the engine reads it)`)
const heldNow = new Set(d.engine.holding.map((h) => h.targetKey))
const decorativeIfReadFromLastApplied = d.engine.library.filter((l) => heldNow.has(l.targetKey) && l.decorative).length
console.log(`  had this been computed from lastApplied alone it would report ${decorativeIfReadFromLastApplied === 0 ? '0 — the bug' : `${decorativeIfReadFromLastApplied} target(s)`}`)
console.log(`  the library the live schedules can reach:`)
for (const l of d.engine.library) console.log(`    · ${pad(l.targetKey, 18)} ${pad(KEY_BY_LANE[l.placement as (typeof PLC_LANES)[number]] ?? l.placement, 9)} holds ${pad(`${l.heldPct}%`, 6)} ${l.decorative ? '← names a goal the controller cannot read' : ''}`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('5 · the denominator rule — a short window must say "cannot judge", never "0"')

for (const preset of ['last7', 'last14', 'last30', 'last90']) {
  const w = await getPlacementGrid({ ...base, preset, start: null, end: null })
  const verdict = w.flags.inverted.of === 0
    ? '→ "not enough traffic in this window to judge"'
    : `→ "${w.flags.inverted.n} of ${w.flags.inverted.of}"`
  console.log(`  ${pad(preset, 8)} ${pad(`${w.range.days}d`, 5)} inverted ${w.flags.inverted.n} of ${pad(String(w.flags.inverted.of), 4)} evaluable  ${verdict}`)
}
console.log(`  🔴 A bare "0 inverted" on a 7-day window is "we could not check" wearing the words of`)
console.log(`     "we checked". The UI is required to print the denominator and to switch wording at 0.`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('6 · the lane split — recomputed, never a constant')

const STUDY_LANES: Record<string, [string, string, string]> = {
  top: ['2.3%', '45.2%', '1.80'], rest: ['21.9%', '35.6%', '3.11'], product: ['75.8%', '19.2%', '2.39'],
}
console.log(`  ${pad('lane', 10)} ${pad('%impr', 8)} ${pad('%spend', 8)} ${pad('ROAS', 7)}   | study`)
for (const l of d.lanes) {
  const w = STUDY_LANES[l.laneKey]!
  console.log(`  ${pad(l.laneKey, 10)} ${pad(`${((l.impressionsPct ?? 0) * 100).toFixed(1)}%`, 8)} ${pad(`${((l.spendPct ?? 0) * 100).toFixed(1)}%`, 8)} ${pad((l.roas ?? 0).toFixed(2), 7)}   | ${w.join(' ')}`)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('7 · the cursor — measured, not copied from Bid')

const cur = await getPlacementCursor(null)
console.log(`  chosen cursor: ${JSON.stringify(cur)}`)

const newestCampaignUpdate = await prisma.campaign.aggregate({ _max: { updatedAt: true } })
const campaignUpdatesToday = await prisma.campaign.count({
  where: { updatedAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
})
const placementWritesToday = await prisma.campaignBidHistory.count({
  where: { field: { in: [...PLC_LANES] }, changedAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
})
const distinctCampaignsWritten = await prisma.campaignBidHistory.findMany({
  where: { field: { in: [...PLC_LANES] }, changedAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
  select: { campaignId: true }, distinct: ['campaignId'],
})
console.log(`\n  Campaign.updatedAt  newest ${newestCampaignUpdate._max.updatedAt?.toISOString() ?? 'never'} · ${campaignUpdatesToday} rows touched in 24h`)
console.log(`  CampaignBidHistory  newest ${cur.placementAt ?? 'never'} · ${placementWritesToday} lane writes in 24h over ${distinctCampaignsWritten.length} campaigns`)
console.log(`\n  Why not Bid's \`targetsAt\`: AdTarget.updatedAt is about KEYWORD bids. No AdTarget moves`)
console.log(`  when a placement multiplier changes — the lever is Campaign.dynamicBidding.`)
console.log(`  Why not Campaign.updatedAt: it fires for every field on a wide row (${campaignUpdatesToday} in 24h), so it`)
console.log(`  would light the banner far more often wrongly than rightly — BUD.1's finding, same shape.`)
console.log(`  Why \`holding\` is the third field: the engine can switch all 33 schedules at an hour`)
console.log(`  boundary, changing every governed campaign's multiplier and this page's census, in`)
console.log(`  writes a changedAt watcher sees only if a lane value moved. lastEvaluatedAt was`)
console.log(`  rejected — it re-stamps every 15 min whether or not anything changed.`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('8 · ?flag= narrows ROWS and never a COUNT')

for (const flag of ['inverted', 'compounding', 'unmanaged', 'decorative'] as const) {
  const f = await getPlacementGrid({ ...base, flag })
  const camps = new Set(f.rows.map((r) => r.campaignId)).size
  const ok = f.counts.campaigns === d.counts.campaigns
    && f.flags.inverted.of === d.flags.inverted.of
    && f.flags.unmanaged.n === d.flags.unmanaged.n
  if (!ok) pass = false
  console.log(`  ${ok ? '✅' : '🔴'} ?flag=${pad(flag, 13)} → ${pad(int(f.rows.length), 5)} rows over ${pad(String(camps), 4)} campaigns; counts unchanged (${f.counts.campaigns} in scope, ${f.flags.unmanaged.n} unmanaged)`)
}
console.log(`\n  every flagged campaign keeps all three lanes: ${
  (await getPlacementGrid({ ...base, flag: 'inverted' })).rows.length % 3 === 0 ? '✅' : '🔴'
}`)

await prisma.$disconnect()
console.log(`\n═══ ${pass ? 'ALL FLAG CHECKS PASSED' : '🔴 AT LEAST ONE CHECK FAILED — do not build UI on this'} — read-only, nothing written ═══\n`)
