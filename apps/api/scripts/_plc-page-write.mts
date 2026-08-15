/**
 * PLC.3 — everything the write path will do, WITHOUT writing anything.
 *
 * 🔴 READ-ONLY. No writes, no mutations. This is the session's safety gate: the gate is open on 82
 * of 220 campaigns and 40 unmanaged ones are ENABLED with it open, so the merge, the refusal
 * classification and the effective-bid arithmetic are all proven here before one PATCH is sent.
 *
 * It imports the service's own exported functions, so what it prints is what the endpoint computes.
 *
 * Run from apps/api:
 *   NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_plc-page-write.mts
 */
import '../src/env.js'

const { default: prisma } = await import('../src/db.js')
const { previewPlacementBulk, laneMultipliers, PLC_LANES, KEY_BY_LANE, PLC_MARKET_ALL } =
  await import('../src/services/advertising/placement-grid.service.js')
const { buildManualAdjustments, currentLanes, isNoOp, resolveMaxBaseBidByCampaign } =
  await import('../src/services/advertising/ads-placement-manual.js')
const { strategyHeadroom } = await import('../src/services/advertising/rank-controller.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const H = (t: string) => console.log(`\n${'─'.repeat(86)}\n${t}\n${'─'.repeat(86)}`)
let pass = true
const check = (label: string, got: unknown, want: unknown) => {
  const ok = got === want
  if (!ok) pass = false
  console.log(`  ${ok ? '✅' : '🔴'} ${pad(label, 50)} got ${pad(String(got), 10)} expected ${want}`)
}

console.log('\n═══ PLC.3 — the write path, proven without writing ═══')
console.log(`now=${new Date().toISOString()}`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('1 · 🔴 The merge, against REAL stored profiles — one lane in, three lanes out')

const carrying = await prisma.campaign.findMany({
  where: { NOT: { dynamicBidding: { equals: null } } },
  select: { id: true, name: true, dynamicBidding: true },
  take: 400,
})
type PB = { placement: string; percentage: number }
const pbOf = (c: { dynamicBidding: unknown }) =>
  ((c.dynamicBidding as { placementBidding?: PB[] })?.placementBidding) ?? []

let checkedProfiles = 0, wouldErase = 0, mergePreserved = 0
const eraseExamples: string[] = []
for (const c of carrying) {
  const existing = pbOf(c)
  const cur = currentLanes(existing)
  const nonZero = PLC_LANES.filter((l) => cur[l] > 0)
  if (nonZero.length < 2) continue      // only profiles where an erase would be visible
  checkedProfiles += 1
  // The lane a bulk would set — pick one the campaign already carries something on, so the naive
  // payload would demonstrably erase at least one other.
  const lane = nonZero[0]!
  const merged = buildManualAdjustments(existing, lane, 60)
  const mergedMap = Object.fromEntries(merged.map((a) => [a.placement, a.percentage]))
  const others = PLC_LANES.filter((l) => l !== lane)
  const preserved = others.every((l) => mergedMap[l] === cur[l])
  if (preserved) mergePreserved += 1
  // What the naive one-lane payload would have done:
  const erased = others.filter((l) => cur[l] > 0)
  if (erased.length > 0) {
    wouldErase += 1
    if (eraseExamples.length < 4) {
      eraseExamples.push(`${pad(c.name, 34)} naive [${KEY_BY_LANE[lane]}=60] would zero ${erased.map((l) => `${KEY_BY_LANE[l]}=${cur[l]}%`).join(' + ')}`)
    }
  }
}
console.log(`  campaigns with ≥2 non-zero lanes: ${checkedProfiles}`)
check('merge preserved the untouched lanes on ALL', mergePreserved, checkedProfiles)
console.log(`\n  🔴 the naive one-lane payload would have erased a live lane on ${wouldErase} of them:`)
for (const e of eraseExamples) console.log(`     ${e}`)
console.log(`  every merged profile carries all three lanes: ${
  carrying.every((c) => buildManualAdjustments(pbOf(c), PLC_LANES[0]!, 10).filter((a) => (PLC_LANES as readonly string[]).includes(a.placement)).length === 3) ? '✅' : '🔴'}`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('2 · The max-base-bid lift agrees with the engine\'s inline derivation')

const ids = carrying.slice(0, 220).map((c) => c.id)
const lifted = await resolveMaxBaseBidByCampaign(ids)
// The engine's block, re-derived here from `ad-rank-defend.job.ts:537-556` for comparison only.
const engine = new Map<string, number>()
{
  const [agRows, agIndex] = await Promise.all([
    prisma.adGroup.groupBy({ by: ['campaignId'], where: { campaignId: { in: ids } }, _max: { defaultBidCents: true, suppressedFromBidCents: true } }),
    prisma.adGroup.findMany({ where: { campaignId: { in: ids } }, select: { id: true, campaignId: true } }),
  ])
  for (const r of agRows) {
    const v = Math.max(r._max.defaultBidCents ?? 0, r._max.suppressedFromBidCents ?? 0)
    if (v > 0) engine.set(r.campaignId, v)
  }
  const byAg = new Map(agIndex.map((g) => [g.id, g.campaignId]))
  const tg = await prisma.adTarget.groupBy({ by: ['adGroupId'], where: { adGroup: { campaignId: { in: ids } }, isNegative: false }, _max: { bidCents: true, suppressedFromBidCents: true } })
  for (const r of tg) {
    const cid = byAg.get(r.adGroupId); if (!cid) continue
    const v = Math.max(r._max.bidCents ?? 0, r._max.suppressedFromBidCents ?? 0)
    if (v > (engine.get(cid) ?? 0)) engine.set(cid, v)
  }
}
const disagree = ids.filter((id) => (lifted.get(id) ?? null) !== (engine.get(id) ?? null))
check('campaigns compared', ids.length, ids.length)
check('lift disagrees with the engine on', disagree.length, 0)
console.log(`  (the job still holds its own inline copy — swapping it for this function is the §4 hand-off)`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('3 · The preview — the headline action, previewed and not run')

const preview = await previewPlacementBulk({
  market: 'IT', line: null, portfolio: null, campaign: null,
  lane: 'rest', pct: 60, flag: 'all', status: 'enabled',
})
console.log(`  "Set Rest of Search to 60% on every ENABLED campaign in IT"\n`)
console.log(`  scope: ${preview.scope.market} · ${preview.scope.boundBy} · ${preview.scope.campaigns} campaigns in scope`)
console.log(`  will write:        ${preview.counts.willWrite}`)
console.log(`  …engine reverts:   ${preview.counts.revertedByEngine}  ← within ~15 min, and the operator must choose it`)
console.log(`  skipped:           ${Object.entries(preview.counts.skipped).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
console.log(`  compounding created: ${preview.counts.compoundingCreated}`)
check('willWrite + every skip === rows', preview.counts.willWrite + Object.values(preview.counts.skipped).reduce((a, b) => a + b, 0), preview.rows.length)

console.log(`\n  ${pad('campaign', 32)} ${pad('owner', 10)} ${pad('current', 22)} ${pad('proposed', 22)} ${pad('eff.bid', 18)} verdict`)
for (const r of preview.rows.slice(0, 12)) {
  const cur = `${r.current.top}/${r.current.rest}/${r.current.product}`
  const nxt = `${r.proposed.top}/${r.proposed.rest}/${r.proposed.product}`
  const eff = r.effectiveBidBefore == null ? 'no base bid' : `${eur(r.effectiveBidBefore)} → ${eur(r.effectiveBidAfter!)}`
  const verdict = r.skip ? `skip: ${r.skip}` : r.revertedByEngine ? '🔴 WRITES, then the engine reverts it' : 'writes'
  console.log(`  ${pad(r.name, 32)} ${pad(r.owner, 10)} ${pad(cur, 22)} ${pad(nxt, 22)} ${pad(eff, 18)} ${verdict}`)
}
console.log(`\n  the payload's own note: "${preview.note}"`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('4 · The effective-bid arithmetic, checked by hand on one row')

const sample = preview.rows.find((r) => r.maxBaseBidCents != null && r.skip == null) ?? preview.rows.find((r) => r.maxBaseBidCents != null)
if (sample) {
  const hr = strategyHeadroom(sample.biddingStrategy)
  const want = Math.round(sample.maxBaseBidCents! * (1 + preview.pct / 100) * hr)
  console.log(`  ${sample.name}`)
  console.log(`    highest live base bid      ${eur(sample.maxBaseBidCents!)}`)
  console.log(`    strategy                   ${sample.biddingStrategy} → headroom ${hr}×  (imported from rank-controller, never retyped)`)
  console.log(`    base × (1 + ${preview.pct}%) × ${hr}      = ${eur(want)}`)
  check('preview\'s effectiveBidAfter', sample.effectiveBidAfter, want)
} else {
  console.log('  (no row in this scope carries a base bid)')
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('5 · Who is actually safe to write to — and the one campaign this session will use')

const all = await prisma.campaign.findMany({
  select: {
    id: true, name: true, status: true, marketplace: true, dynamicBidding: true,
    pinPlacement: true, liveBidWritesEnabled: true, externalCampaignId: true,
  },
})
const { resolveOwnership } = await import('../src/services/advertising/placement-grid.service.js')
const own = await resolveOwnership()
const governed = (id: string) => own.byCampaign.has(id)
const carryingAny = (c: (typeof all)[number]) => { const m = laneMultipliers(c.dynamicBidding); return PLC_LANES.some((l) => m[l] > 0) }

console.log(`  campaigns                                  ${all.length}`)
console.log(`  gate OPEN (liveBidWritesEnabled)           ${all.filter((c) => c.liveBidWritesEnabled).length}`)
console.log(`  pinned on placement                        ${all.filter((c) => c.pinPlacement).length}`)
console.log(`  governed by an engine                      ${[...own.byCampaign.keys()].length}`)
console.log(`  ENABLED + gate open + unmanaged            ${all.filter((c) => c.status === 'ENABLED' && c.liveBidWritesEnabled && !governed(c.id)).length}  ← the live blast radius`)

/**
 * 🔴 The safest possible real write: PAUSED (so it spends nothing at Amazon whatever happens),
 * unmanaged (so no engine overwrites it and the value is genuinely observable), carrying a
 * multiplier on ≥2 lanes (so the merge has something to preserve and an erase would be visible),
 * and with an external id (so the push is real rather than local-only).
 */
const candidates = all.filter((c) =>
  c.status === 'PAUSED' && !governed(c.id) && !c.pinPlacement && c.liveBidWritesEnabled
  && !!c.externalCampaignId && carryingAny(c)
  && PLC_LANES.filter((l) => laneMultipliers(c.dynamicBidding)[l] > 0).length >= 2)
console.log(`\n  PAUSED · unmanaged · unpinned · gate open · ≥2 lanes carrying · has an Amazon id: ${candidates.length}`)

/**
 * 🔴 …and that number is ZERO, because of a fact worth its own paragraph:
 *
 * **Every one of the 133 PAUSED campaigns has `liveBidWritesEnabled = false`.** Not most — all.
 * So a placement write to any paused campaign is refused at `campaign_allowlist` before Amazon is
 * ever called, and "test it on something paused" — the obvious safety instinct, and the one PLC.3's
 * brief specified — is not available on this account.
 *
 * It is the substrate spec's own §5.5 footgun seen from the other side: re-enabling a PAUSED
 * campaign does not re-allowlist it. Here the population never left the allowlist because it never
 * entered it.
 *
 * The consequence for testing a real write: the only writable campaigns are ENABLED ones. So the
 * safety property has to come from DELIVERY rather than from status — a live campaign that has
 * served nothing for 30 days has nothing at stake either.
 */
const paused = all.filter((c) => c.status === 'PAUSED')
console.log(`  🔴 PAUSED campaigns: ${paused.length} · with the gate OPEN: ${paused.filter((c) => c.liveBidWritesEnabled).length}`)
console.log(`     → a paused campaign cannot be written to at all; every one refuses at campaign_allowlist.`)
console.log(`     → so a real-write test must use an ENABLED campaign, and take its safety from DELIVERY.`)

const live = all.filter((c) => c.status === 'ENABLED' && c.liveBidWritesEnabled && !governed(c.id) && !c.pinPlacement && c.externalCampaignId)
const spendBy = new Map<string, number>()
const imprBy = new Map<string, number>()
{
  const { getPlacementGrid, PLC_MARKET_ALL: ALL } = await import('../src/services/advertising/placement-grid.service.js')
  const g = await getPlacementGrid({ market: ALL, line: null, portfolio: null, campaign: null, preset: 'last30', start: null, end: null, lane: 'all', flag: 'all', q: null, sort: null, dir: 'desc' })
  for (const r of g.rows) {
    spendBy.set(r.campaignId, (spendBy.get(r.campaignId) ?? 0) + r.spendCents)
    imprBy.set(r.campaignId, (imprBy.get(r.campaignId) ?? 0) + r.impressions)
  }
}
const dormant = live
  .map((c) => ({ c, spend: spendBy.get(c.id) ?? 0, impr: imprBy.get(c.id) ?? 0 }))
  .filter((x) => x.spend === 0 && x.impr === 0)
  .sort((a, b) => (laneMultipliers(b.c.dynamicBidding)[PLC_LANES[1]!] - laneMultipliers(a.c.dynamicBidding)[PLC_LANES[1]!]))
console.log(`\n  ENABLED · gate open · unmanaged · unpinned · €0.00 spend AND 0 impressions in 30 days: ${dormant.length}`)
for (const x of dormant.slice(0, 6)) {
  const m = laneMultipliers(x.c.dynamicBidding)
  console.log(`    ${pad(x.c.name, 34)} ${pad(x.c.marketplace ?? '—', 4)} ${PLC_LANES.map((l) => `${KEY_BY_LANE[l]}=${m[l]}%`).join(' ')}   id=${x.c.id}`)
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('6 · A campaign already at the target value is a no-op, not a write')

const noOps = all.filter((c) => isNoOp(pbOf(c), PLC_LANES[1]!, 0)).length
console.log(`  campaigns already at Rest = 0: ${noOps} — a bulk to 0 would write ${all.length - noOps}, not ${all.length}`)
console.log(`  (30% of the ENGINE's own history rows are writes of 0 over an already-absent lane —`)
console.log(`   study §4.5. A manual bulk must not add to that pile.)`)

await prisma.$disconnect()
console.log(`\n═══ ${pass ? 'ALL CHECKS PASSED' : '🔴 A CHECK FAILED — do not write'} — read-only, nothing written ═══\n`)
