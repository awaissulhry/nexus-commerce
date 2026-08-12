/**
 * _sqp2-reader.mts — SQP.2 Phase E: three reader options, measured, for RD to choose between.
 * READ-ONLY. No Amazon call, no write. 🔴 It specifies and measures; it ships nothing.
 *
 * `sqpImpressionShareForAsins` takes `rows[0].startDate` as "latest" and sums ONLY that week, so the
 * week is picked by whichever single ASIN has the freshest row and every laggard is silently dropped.
 * Measured: 20 of 45 campaigns are steered by exactly one ASIN, and on average 10% of a campaign's
 * ASINs contribute. This measures what each candidate fix would actually do.
 *
 * Option A — MINIMUM CONTRIBUTORS: return null unless at least N of the campaign's ASINs are present
 *            in the chosen week. Refuses to answer on a thin basis rather than answering badly.
 * Option B — WINDOW: pool the last N weeks instead of the single latest week. Answers more often, at
 *            the cost of mixing weeks — which is the thing the KT page spent KT.1b removing.
 * Option C — RECENCY GUARD (what the RD study asked for): return null if the chosen week is older
 *            than N days, so a stale number cannot masquerade as a current one.
 *
 * The fourth column is the one that decides how much any of this matters: what `ad-rank-defend`
 * DOES with a null. Answered from the code, not inferred — see §D.
 *
 * Run:
 *   cd apps/api && railway run --service "@nexus/api" env -u REDIS_URL \
 *     NEXUS_AMAZON_ADS_QUOTA_MODE=off npx tsx scripts/_sqp2-reader.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { sqpImpressionShareForAsins } from '../src/services/advertising/sqp.service.js'
import { biasBand, computeStep } from '../src/services/advertising/rank-controller.js'
import { toSpec, applyTargetOverrides } from '../src/jobs/ad-rank-defend.job.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 74 - s.length))}`) }
const d10 = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '—')
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const pctS = (v: number | null) => (v == null ? 'null' : `${(v * 100).toFixed(3)}%`)

interface Row { marketplace: string; asin: string; startDate: number; brand: number; total: number }

async function main() {
  const dbRows = await prisma.searchQueryPerformance.findMany({
    select: { marketplace: true, asin: true, startDate: true, impressionsBrand: true, impressionsTotal: true },
  })
  const pool: Row[] = dbRows.filter((r) => r.asin).map((r) => ({
    marketplace: r.marketplace, asin: r.asin!, startDate: +r.startDate,
    brand: r.impressionsBrand, total: r.impressionsTotal,
  }))

  const groups = await prisma.rankScheduleGroup.findMany({
    select: { id: true, name: true, marketplace: true, enabled: true, defaultTargetKey: true, targetOverrides: true,
      schedules: { select: { campaignId: true, enabled: true, defaultTargetKey: true, targetOverrides: true } } },
  })
  const allCampIds = [...new Set(groups.flatMap((g) => g.schedules.map((s) => s.campaignId)))]
  const camps = await prisma.campaign.findMany({ where: { id: { in: allCampIds } }, select: { id: true, name: true, marketplace: true } })
  const campById = new Map(camps.map((c) => [c.id, c]))
  const ads = await prisma.adProductAd.findMany({
    where: { adGroup: { campaignId: { in: allCampIds } }, status: 'ENABLED' },
    select: { asin: true, adGroup: { select: { campaignId: true } } },
  })
  const asinsByCampaign = new Map<string, Set<string>>()
  for (const a of ads) {
    const cid = a.adGroup?.campaignId
    if (!cid || !a.asin) continue
    const s = asinsByCampaign.get(cid) ?? new Set<string>(); s.add(a.asin); asinsByCampaign.set(cid, s)
  }

  /** the current reader, re-implemented (validated against the real one in _sqp2-gate.mts §C) */
  const current = (mkt: string, asins: string[]) => {
    const set = new Set(asins)
    const rows = pool.filter((r) => r.marketplace === mkt && set.has(r.asin))
    if (!rows.length) return { share: null as number | null, week: null as number | null, contributing: 0 }
    const latest = Math.max(...rows.map((r) => r.startDate))
    let brand = 0, total = 0
    const seen = new Set<string>()
    for (const r of rows) { if (r.startDate !== latest) continue; brand += r.brand; total += r.total; seen.add(r.asin) }
    return { share: total > 0 ? brand / total : null, week: latest, contributing: seen.size }
  }
  /** Option B — pool the last N weeks. */
  const windowed = (mkt: string, asins: string[], weeks: number) => {
    const set = new Set(asins)
    const rows = pool.filter((r) => r.marketplace === mkt && set.has(r.asin))
    if (!rows.length) return { share: null as number | null, contributing: 0 }
    const distinct = [...new Set(rows.map((r) => r.startDate))].sort((a, b) => b - a).slice(0, weeks)
    const keep = new Set(distinct)
    let brand = 0, total = 0
    const seen = new Set<string>()
    for (const r of rows) { if (!keep.has(r.startDate)) continue; brand += r.brand; total += r.total; seen.add(r.asin) }
    return { share: total > 0 ? brand / total : null, contributing: seen.size }
  }

  const rows: Array<{ camp: string; mkt: string; asins: number; cur: ReturnType<typeof current> }> = []
  for (const c of camps) {
    const asins = [...(asinsByCampaign.get(c.id) ?? [])]
    const mkt = c.marketplace ?? ''
    if (!asins.length || !mkt) continue
    rows.push({ camp: c.name, mkt, asins: asins.length, cur: current(mkt, asins) })
  }
  const signalled = rows.filter((r) => r.cur.share != null)

  h('the baseline — the reader as it stands')
  line(`campaigns with ASINs: ${rows.length} · with a share: ${signalled.length} · null: ${rows.length - signalled.length}`)
  line(`steered by exactly 1 ASIN: ${signalled.filter((r) => r.cur.contributing === 1).length} · by ≤3: ${signalled.filter((r) => r.cur.contributing <= 3).length}`)
  line(`mean fraction of a campaign's ASINs contributing: ${(signalled.reduce((a, r) => a + r.cur.contributing / r.asins, 0) / signalled.length * 100).toFixed(0)}%`)
  const weekAges = signalled.map((r) => Math.floor((Date.now() - r.cur.week!) / 86_400_000))
  line(`age of the week each signal comes from: min ${Math.min(...weekAges)}d · max ${Math.max(...weekAges)}d`)

  h('Option A · MINIMUM CONTRIBUTORS — refuse to answer on a thin basis')
  line(`${pad('N', 3)} ${pad('keep a signal', 14)} ${pad('go null', 8)} ${pad('mean contrib', 13)} what it costs`)
  for (const n of [1, 2, 3, 5]) {
    const keep = signalled.filter((r) => r.cur.contributing >= n)
    const lost = signalled.length - keep.length
    const mc = keep.length ? (keep.reduce((a, r) => a + r.cur.contributing / r.asins, 0) / keep.length * 100).toFixed(0) : '—'
    line(`${pad(n, 3)} ${pad(`${keep.length} of ${signalled.length}`, 14)} ${pad(lost, 8)} ${pad(`${mc}%`, 13)} ${n === 1 ? 'no change — today\'s behaviour' : `${lost} campaigns stop having an opinion`}`)
  }
  line()
  line('⇒ N=2 already drops most of them, because the newest week is the thin one. The honest reading is')
  line('  that this option mostly converts a bad number into no number — which is correct, but it is a')
  line('  COVERAGE fix disguised as a reader fix: the basis is thin because the feed is thin.')

  h('Option B · WINDOW — pool the last N weeks instead of the single latest')
  line(`${pad('weeks', 6)} ${pad('with a signal', 14)} ${pad('mean contrib', 13)} ${pad('median |Δ| vs now', 18)}`)
  for (const w of [1, 2, 4, 6]) {
    const vals = rows.map((r) => {
      const asins = [...(asinsByCampaign.get(camps.find((c) => c.name === r.camp)!.id) ?? [])]
      return { r, w: windowed(r.mkt, asins, w) }
    })
    const withSig = vals.filter((v) => v.w.share != null)
    const deltas = vals.filter((v) => v.w.share != null && v.r.cur.share != null).map((v) => Math.abs(v.w.share! - v.r.cur.share!))
    deltas.sort((a, b) => a - b)
    const med = deltas.length ? deltas[Math.floor(deltas.length / 2)] : null
    const mc = withSig.length ? (withSig.reduce((a, v) => a + v.w.contributing / v.r.asins, 0) / withSig.length * 100).toFixed(0) : '—'
    line(`${pad(w, 6)} ${pad(`${withSig.length} of ${rows.length}`, 14)} ${pad(`${mc}%`, 13)} ${pad(med != null ? `${(med * 100).toFixed(3)}pp` : '—', 18)}`)
  }
  line()
  line('⇒ A window raises the contributing fraction and moves the value materially, which is exactly')
  line('  why it is NOT free: it reintroduces the mixed-week average that KT.1b spent a session')
  line('  removing from the page ("one period per view"). If RD takes this, the number needs a label')
  line('  saying it spans N weeks, or the two surfaces will disagree about what "share" means.')

  h('Option C · RECENCY GUARD — null when the chosen week is older than N days')
  line(`${pad('N days', 7)} ${pad('keep a signal', 14)} ${pad('go null', 8)}`)
  for (const days of [14, 21, 28, 42]) {
    const keep = signalled.filter((r) => (Date.now() - r.cur.week!) / 86_400_000 <= days)
    line(`${pad(days, 7)} ${pad(`${keep.length} of ${signalled.length}`, 14)} ${pad(signalled.length - keep.length, 8)}`)
  }
  line()
  line(`⇒ Every signal today comes from a week ${Math.min(...weekAges)}-${Math.max(...weekAges)} days old, and NEXUS_SQP_LOOKBACK=2 means`)
  line('  the feed can never be fresher than ~11 days + the week length. A guard tighter than ~21 days')
  line('  would null everything permanently; one at 28-42 days changes nothing today. So this option is')
  line('  a guard against a FUTURE stall, not a fix for the current basis.')

  h('§D · 🔴 what ad-rank-defend does with a null — read from the code, not inferred')
  const targets = await prisma.rankTarget.findMany()
  const byKey = new Map(targets.map((t) => [t.key, t]))
  line('computeStep (rank-controller.ts:170) in order: pause → below floor → !canChase → allOut →')
  line('loss → **IS branch (needs targetIS AND achievedIS non-null)** → ACOS branch → hold.')
  line('So a null does NOT mean "hold": it SKIPS the IS branch and falls through to the ACOS branch,')
  line('which RAISES when ACOS is under 80% of cap. A null is not neutral — it can push.')
  line()
  line('But that is unreachable today. Per campaign, with the real spec:')
  let reach = 0, notReach = 0
  for (const g of groups) {
    for (const s of g.schedules) {
      const c = campById.get(s.campaignId); if (!c) continue
      const tk = s.defaultTargetKey ?? g.defaultTargetKey ?? null
      const t = tk ? byKey.get(tk) : null
      if (!t) { notReach++; continue }
      let spec = applyTargetOverrides(toSpec(t as any), (g.targetOverrides ?? {}) as any, (s.targetOverrides ?? {}) as any)
      const band = biasBand(spec)
      const canChase = !!spec.allOut || band.ceiling > band.floor
      if (canChase && !spec.allOut && spec.targetISPct != null) reach++; else notReach++
    }
  }
  line(`  campaigns where the IS branch is REACHABLE: ${reach}`)
  line(`  campaigns where it is not               : ${notReach}`)
  line(reach === 0
    ? '🔴 ZERO. So every option above changes a number that no campaign reads, and the reader fix is\n  worth nothing on its own — `maxBiasPct` has to be set on a RankTarget first. That ordering is the\n  finding: the reader is not the critical path, the BAND is.'
    : `${reach} campaigns would feel a reader change.`)

  h('recommendation for RD — measured, not preferred')
  line('1. The band comes first. With maxBiasPct null on all five RankTargets, no reader change and no')
  line('   feed change can move a bid. Nothing else in this list matters until that is decided.')
  line('2. Then Option A at N=2 as the SAFETY property — a one-ASIN basis should not steer a bid, and')
  line('   refusing to answer is the honest failure. It needs the ACOS-branch fall-through to be')
  line('   reviewed at the same time, because null is not neutral (§D).')
  line('3. Option B only with an explicit "spans N weeks" label, or the KT page and the engine will')
  line('   mean different things by "share".')
  line('4. Option C at 28 days as a stall alarm. It changes nothing today, which is the point.')

  h('control')
  line(`SearchQueryPerformance ${pool.length} rows · campaigns ${camps.length} · groups ${groups.length} · RankTargets ${targets.length}`)
  // The market must come from the CAMPAIGN. The first version hard-coded 'IT' while camps[0] is a DE
  // campaign, so it compared DE's ASINs measured in IT against the same ASINs measured in DE and
  // printed 0.155% vs 0.965% as a mismatch. Both numbers were right; the COMPARISON was wrong. A
  // spot-check needs the same scope on both sides or it manufactures a discrepancy out of nothing.
  let checked = 0, mism = 0
  for (const c of camps.slice(0, 6)) {
    const asins = [...(asinsByCampaign.get(c.id) ?? [])]
    const mkt = c.marketplace ?? ''
    if (!asins.length || !mkt) continue
    const real = await sqpImpressionShareForAsins(mkt, asins)
    const local = rows.find((r) => r.camp === c.name && r.mkt === mkt)?.cur.share ?? null
    const same = (real == null && local == null) || (real != null && local != null && Math.abs(real - local) < 1e-9)
    checked++; if (!same) mism++
    line(`  ${padr(c.name.slice(0, 34), 36)} ${padr(mkt, 4)} real ${pad(pctS(real), 9)} vs local ${pad(pctS(local), 9)} ${same ? 'ok' : 'MISMATCH'}`)
  }
  line(`spot-checked ${checked} campaigns against the real function - mismatches ${mism}`)
  line(mism === 0 ? 'the local reader matches; _sqp2-gate.mts SecC validated all 45 the same way' : 'fix before trusting anything above')
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
