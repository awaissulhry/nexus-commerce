/**
 * _sqp2-gate.mts — SQP.2 Phase B, the gate report. READ-ONLY: no Amazon call, no write.
 *
 * Answers §6's eight questions by COMPUTING each one, never estimating:
 *
 *  · the share every campaign reads today — via the real `sqpImpressionShareForAsins`;
 *  · the share it would read after the staged rows land — via a simulator that is first PROVED to
 *    reproduce the real function on today's data, so the projection inherits its credibility from a
 *    check rather than from my assertion;
 *  · what `ad-rank-defend` actually DOES with each, by running the real `computeStep` on the real
 *    effective spec (`toSpec` + `applyTargetOverrides`) — because the brief's premise here is the
 *    one `docs/2026-08-11-rd-rank-dayparting-page.md` §0 already corrected, and inferring it again
 *    would reproduce the error.
 *
 * Run:
 *   cd apps/api && railway run --service "@nexus/api" env -u REDIS_URL \
 *     NEXUS_AMAZON_ADS_QUOTA_MODE=off npx tsx scripts/_sqp2-gate.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { sqpImpressionShareForAsins } from '../src/services/advertising/sqp.service.js'
import { chooseViewPeriod, KT_LOOKBACK_DAYS, SQP_COMPLETENESS_RATIO, SQP_BASELINE_PERIODS } from '../src/services/advertising/keyword-tracker.service.js'
import { biasBand, computeStep, type RankTargetSpec } from '../src/services/advertising/rank-controller.js'
import { toSpec, applyTargetOverrides } from '../src/jobs/ad-rank-defend.job.js'

const OUT = join(import.meta.dirname, '_sqp2-staged')
const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 74 - s.length))}`) }
const d10 = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '—')
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const pctS = (v: number | null) => (v == null ? 'null' : `${(v * 100).toFixed(3)}%`)

interface Row { marketplace: string; asin: string; startDate: number; brand: number; total: number; searchQuery: string }

/**
 * A faithful re-implementation of `sqpImpressionShareForAsins`, so a HYPOTHETICAL row pool can be
 * scored. Validated against the real function below before any projection is believed.
 * The real one: rows for these ASINs ordered by startDate desc, take 3000, latest = rows[0].startDate,
 * sum impressionsBrand/impressionsTotal over that week only, null when total is 0 or there are no rows.
 */
function simulateShare(pool: Row[], marketplace: string, asins: string[]): { share: number | null; week: number | null; contributing: number; truncated: boolean } {
  const set = new Set(asins)
  const rows = pool.filter((r) => r.marketplace === marketplace && set.has(r.asin))
  if (!rows.length) return { share: null, week: null, contributing: 0, truncated: false }
  rows.sort((a, b) => b.startDate - a.startDate)
  const truncated = rows.length > 3000
  const kept = rows.slice(0, 3000)
  const latest = kept[0].startDate
  let brand = 0, total = 0
  const seen = new Set<string>()
  for (const r of kept) { if (r.startDate !== latest) continue; brand += r.brand; total += r.total; seen.add(r.asin) }
  return { share: total > 0 ? Math.max(0, Math.min(1, brand / total)) : null, week: latest, contributing: seen.size, truncated }
}

async function main() {
  // ── load the DB pool ──────────────────────────────────────────────────────────────────────────
  const dbRows = await prisma.searchQueryPerformance.findMany({
    select: { marketplace: true, asin: true, startDate: true, impressionsBrand: true, impressionsTotal: true, searchQuery: true, reportPeriod: true },
  })
  const pool: Row[] = dbRows.filter((r) => r.asin).map((r) => ({
    marketplace: r.marketplace, asin: r.asin!, startDate: +r.startDate,
    brand: r.impressionsBrand, total: r.impressionsTotal, searchQuery: r.searchQuery,
  }))
  line(`DB rows loaded: ${pool.length}`)

  // ── load the staged rows and build the post-upsert pool ───────────────────────────────────────
  h('§A · what the staged documents would change')
  const manifestPath = join(OUT, 'manifest.ndjson')
  if (!existsSync(manifestPath)) { line('🔴 no manifest — run _sqp2-stage.mts first'); return }
  const manifest = readFileSync(manifestPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  line(`staged reports: ${manifest.length} · with rows: ${manifest.filter((m: any) => m.rowCount > 0).length} · empty: ${manifest.filter((m: any) => m.rowCount === 0).length}`)

  /** key exactly as the upsert does: (marketplace, reportPeriod, startDate, searchQuery, asin) */
  const key = (mkt: string, wk: number, q: string, a: string) => `${mkt}|WEEK|${wk}|${q}|${a}`
  const dbByKey = new Map<string, Row>()
  for (const r of dbRows) {
    if (!r.asin) continue
    dbByKey.set(key(r.marketplace, +r.startDate, r.searchQuery, r.asin), {
      marketplace: r.marketplace, asin: r.asin, startDate: +r.startDate,
      brand: r.impressionsBrand, total: r.impressionsTotal, searchQuery: r.searchQuery,
    })
  }

  const staged: Row[] = []
  let stagedRowTotal = 0
  for (const m of manifest as any[]) {
    if (m.rowCount === 0) continue
    const f = join(OUT, `${m.reportId}.ndjson`)
    if (!existsSync(f)) continue
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      if (!l.trim()) continue
      const r = JSON.parse(l)
      // `ingestSqp` does `row.asin || asin` — the requested ASIN is the fallback. Replicate exactly.
      const asin = r.asin || m.asin
      if (!asin) continue
      staged.push({
        marketplace: m.marketplace, asin, startDate: +new Date(`${m.startDate}T00:00:00Z`),
        brand: r.impressionsBrand, total: r.impressionsTotal, searchQuery: r.searchQuery,
      })
      stagedRowTotal++
    }
  }
  const creates: Row[] = [], updatesChanged: Array<{ before: Row; after: Row }> = [], updatesSame: Row[] = []
  for (const s of staged) {
    const k = key(s.marketplace, s.startDate, s.searchQuery, s.asin)
    const before = dbByKey.get(k)
    if (!before) creates.push(s)
    else if (before.brand !== s.brand || before.total !== s.total) updatesChanged.push({ before, after: s })
    else updatesSame.push(s)
  }
  line(`staged rows parsed: ${stagedRowTotal}`)
  line(`  would CREATE new stored rows      : ${creates.length}`)
  line(`  would UPDATE and CHANGE the values: ${updatesChanged.length}`)
  line(`  would UPDATE with identical values: ${updatesSame.length}`)
  const periodsTouched = [...new Set(staged.map((s) => d10(new Date(s.startDate))))].sort()
  line(`  periods touched: ${periodsTouched.join(', ')}`)
  line(periodsTouched.length === 1 && periodsTouched[0] === '2026-07-26'
    ? '  ✓ ONLY the 07-26 week — no other period is touched (stop condition clear)'
    : `  🔴 STOP CONDITION — more than the 07-26 week would change: ${periodsTouched.join(', ')}`)
  // 🔴 Keyed by (market, PERIOD). Keyed by market alone, this table added FR's 15 creates — which
  // belong to the 07-19 week — to FR's 07-26 count and reported 07-26 growing from 1 row to 16.
  // It does not: 07-26 gains nothing. A per-market rollup of a per-period fact invents the number
  // the whole gate turns on, which is the one place this probe must not be sloppy.
  const perKey = new Map<string, { creates: number; updates: number; same: number; asins: Set<string> }>()
  const bump = (mkt: string, wk: number, field: 'creates' | 'updates' | 'same', asin: string) => {
    const k = `${mkt}|${d10(new Date(wk))}`
    const e = perKey.get(k) ?? { creates: 0, updates: 0, same: 0, asins: new Set<string>() }
    e[field]++; e.asins.add(asin); perKey.set(k, e)
  }
  for (const c of creates) bump(c.marketplace, c.startDate, 'creates', c.asin)
  for (const u of updatesChanged) bump(u.after.marketplace, u.after.startDate, 'updates', u.after.asin)
  for (const u of updatesSame) bump(u.marketplace, u.startDate, 'same', u.asin)
  line()
  line(`${padr('mkt', 5)} ${padr('week', 12)} ${pad('creates', 8)} ${pad('changes', 8)} ${pad('identical', 10)} ${pad('stored now', 11)} ${pad('after', 7)}`)
  for (const [k, e] of [...perKey].sort()) {
    const [mkt, wk] = k.split('|')
    const now = pool.filter((r) => r.marketplace === mkt && d10(new Date(r.startDate)) === wk).length
    line(`${padr(mkt, 5)} ${padr(wk, 12)} ${pad(e.creates, 8)} ${pad(e.updates, 8)} ${pad(e.same, 10)} ${pad(now, 11)} ${pad(now + e.creates, 7)}`)
  }
  const sevenTwentySix = [...perKey].filter(([k]) => k.endsWith('2026-07-26'))
  line()
  line(`⇒ the 07-26 week specifically: ${sevenTwentySix.reduce((a, [, e]) => a + e.creates, 0)} new rows, ${sevenTwentySix.reduce((a, [, e]) => a + e.updates, 0)} changed, ${sevenTwentySix.reduce((a, [, e]) => a + e.same, 0)} already identical.`)

  const after: Row[] = [...pool]
  {
    const idx = new Map<string, number>()
    after.forEach((r, i) => idx.set(key(r.marketplace, r.startDate, r.searchQuery, r.asin), i))
    for (const s of staged) {
      const k = key(s.marketplace, s.startDate, s.searchQuery, s.asin)
      const at = idx.get(k)
      if (at == null) { idx.set(k, after.length); after.push(s) } else after[at] = s
    }
  }
  line()
  line(`pool after upsert: ${after.length} rows (from ${pool.length})`)

  // ── the campaigns and their real effective specs ───────────────────────────────────────────────
  h('§B · the 45 campaigns, their effective specs, and whether the SQP share is even READ')
  const groups = await prisma.rankScheduleGroup.findMany({
    select: { id: true, name: true, marketplace: true, enabled: true, defaultTargetKey: true, targetOverrides: true,
      schedules: { select: { campaignId: true, enabled: true, defaultTargetKey: true, lastApplied: true, targetOverrides: true, windows: true } } },
    orderBy: { name: 'asc' },
  })
  const targets = await prisma.rankTarget.findMany()
  const targetByKey = new Map(targets.map((t) => [t.key, t]))
  line(`RankTarget rows: ${targets.length}`)
  line(`${padr('target key', 20)} ${pad('floor', 6)} ${pad('ceil', 6)} ${pad('allOut', 7)} ${pad('canChase', 9)} ${pad('targetIS', 9)} ${pad('acosCap', 8)} reads the SQP share?`)
  for (const t of targets) {
    const spec = toSpec(t as any)
    const { floor, ceiling } = biasBand(spec)
    const canChase = !!spec.allOut || ceiling > floor
    // The IS branch is only reached when canChase AND not allOut (all-out returns before it).
    const readsIS = canChase && !spec.allOut && spec.targetISPct != null
    line(`${padr(t.key, 20)} ${pad(floor, 6)} ${pad(ceiling, 6)} ${pad(String(!!spec.allOut), 7)} ${pad(String(canChase), 9)} ${pad(spec.targetISPct ?? '—', 9)} ${pad(spec.acosCapPct ?? '—', 8)} ${readsIS ? '🔴 YES' : canChase ? 'no — all-out ignores IS and ACoS' : 'no — !canChase returns first'}`)
  }

  const allCampIds = [...new Set(groups.flatMap((g) => g.schedules.map((s) => s.campaignId)))]
  const camps = await prisma.campaign.findMany({ where: { id: { in: allCampIds } }, select: { id: true, name: true, marketplace: true, status: true } })
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

  // ── the simulator must first reproduce the real function ──────────────────────────────────────
  h('§C · 🔴 validating the simulator against the real function on TODAY\'s data')
  let checked = 0, mismatch = 0, truncatedAny = false
  for (const c of camps) {
    const asins = [...(asinsByCampaign.get(c.id) ?? [])]
    const mkt = c.marketplace ?? ''
    if (!asins.length || !mkt) continue
    const real = await sqpImpressionShareForAsins(mkt, asins)
    const sim = simulateShare(pool, mkt, asins)
    if (sim.truncated) truncatedAny = true
    checked++
    const same = (real == null && sim.share == null) || (real != null && sim.share != null && Math.abs(real - sim.share) < 1e-9)
    if (!same) { mismatch++; line(`  🔴 ${padr(c.name.slice(0, 40), 42)} real ${pctS(real)} vs sim ${pctS(sim.share)}`) }
  }
  line(`campaigns checked: ${checked} · mismatches: ${mismatch} · any pool hit the take:3000 cap: ${truncatedAny}`)
  line(mismatch === 0
    ? '✓ the simulator reproduces the real function EXACTLY on every campaign. Its projection below inherits that.'
    : '🔴 SIMULATOR DISAGREES — every projected number below is untrustworthy. Fix before reading on.')
  if (mismatch > 0) return

  // ── the per-campaign delta, and the real controller decision on each side ─────────────────────
  h('§D · per campaign: the share now, after, and what the engine DOES with each')
  interface Res {
    group: string; camp: string; mkt: string; enabled: boolean; targetKey: string | null
    readsIS: boolean; canChase: boolean; nowShare: number | null; afterShare: number | null
    nowWeek: string; afterWeek: string; nowContrib: number; afterContrib: number; asins: number
    actNow: string; actAfter: string; pctNow: number; pctAfter: number; reasonAfter: string
  }
  const res: Res[] = []
  for (const g of groups) {
    for (const s of g.schedules) {
      const c = campById.get(s.campaignId); if (!c) continue
      const asins = [...(asinsByCampaign.get(c.id) ?? [])]
      const mkt = c.marketplace ?? g.marketplace ?? ''
      const tk = s.defaultTargetKey ?? g.defaultTargetKey ?? null
      const t = tk ? targetByKey.get(tk) : null
      let spec: RankTargetSpec | null = t ? toSpec(t as any) : null
      if (spec) spec = applyTargetOverrides(spec, (g.targetOverrides ?? {}) as any, (s.targetOverrides ?? {}) as any)
      const band = spec ? biasBand(spec) : null
      const canChase = !!spec && (!!spec.allOut || (band!.ceiling > band!.floor))
      const readsIS = canChase && !!spec && !spec.allOut && spec.targetISPct != null

      const nowS = simulateShare(pool, mkt, asins)
      const aftS = simulateShare(after, mkt, asins)

      // The real controller, on the real spec, at the CURRENT placement %. currentPct is unknown
      // without a live campaign read, so both sides are evaluated at the same currentPct = floor —
      // which is where a !canChase target provably sits, and is the neutral choice for the rest.
      const cur = band?.floor ?? 0
      const mk = (share: number | null) => spec
        ? computeStep(spec, { currentPct: cur, achievedISFraction: share, achievedAcosFraction: null, lossDetected: false })
        : { action: 'n/a', nextPct: cur, reason: 'no target resolved' }
      const dNow = mk(nowS.share), dAft = mk(aftS.share)

      res.push({
        group: g.name, camp: c.name, mkt, enabled: g.enabled && s.enabled, targetKey: tk,
        readsIS, canChase, nowShare: nowS.share, afterShare: aftS.share,
        nowWeek: d10(nowS.week ? new Date(nowS.week) : null), afterWeek: d10(aftS.week ? new Date(aftS.week) : null),
        nowContrib: nowS.contributing, afterContrib: aftS.contributing, asins: asins.length,
        actNow: dNow.action, actAfter: dAft.action, pctNow: dNow.nextPct, pctAfter: dAft.nextPct, reasonAfter: dAft.reason,
      })
    }
  }

  const moved = res.filter((r) => (r.nowShare ?? -1) !== (r.afterShare ?? -1))
  const gained = res.filter((r) => r.nowShare == null && r.afterShare != null)
  const lost = res.filter((r) => r.nowShare != null && r.afterShare == null)
  const decisionChanged = res.filter((r) => r.actNow !== r.actAfter || r.pctNow !== r.pctAfter)

  line(`${padr('campaign', 34)} ${padr('mkt', 4)} ${pad('en', 3)} ${padr('target', 15)} ${pad('readsIS', 8)} ${pad('now', 9)} ${pad('after', 9)} ${pad('contrib', 12)} ${pad('act', 6)}`)
  for (const r of res.filter((x) => (x.nowShare ?? -1) !== (x.afterShare ?? -1) || x.readsIS).slice(0, 40)) {
    line(`${padr(r.camp.slice(0, 33), 34)} ${padr(r.mkt, 4)} ${pad(r.enabled ? 'y' : 'n', 3)} ${padr(r.targetKey ?? '—', 15)} ${pad(r.readsIS ? '🔴 YES' : 'no', 8)} ${pad(pctS(r.nowShare), 9)} ${pad(pctS(r.afterShare), 9)} ${pad(`${r.nowContrib}→${r.afterContrib} of ${r.asins}`, 12)} ${pad(r.actNow === r.actAfter ? r.actNow : `${r.actNow}→${r.actAfter}`, 6)}`)
  }

  h('§E · the gate answers')
  line(`1 · campaigns under a rank-schedule group        : ${res.length} (${res.filter((r) => r.enabled).length} in an enabled group + enabled schedule)`)
  line(`    with a share today / null today             : ${res.filter((r) => r.nowShare != null).length} / ${res.filter((r) => r.nowShare == null).length}`)
  line(`2 · share after the staged rows land            : computed, not projected (simulator validated, §C)`)
  line(`3 · campaigns whose share MOVES                 : ${moved.length}`)
  line(`      up: ${moved.filter((r) => (r.afterShare ?? 0) > (r.nowShare ?? 0)).length} · down: ${moved.filter((r) => (r.afterShare ?? 0) < (r.nowShare ?? 0)).length}`)
  const biggest = [...moved].sort((a, b) => Math.abs((b.afterShare ?? 0) - (b.nowShare ?? 0)) - Math.abs((a.afterShare ?? 0) - (a.nowShare ?? 0)))[0]
  if (biggest) line(`      largest mover: ${biggest.camp} (${biggest.mkt}) ${pctS(biggest.nowShare)} → ${pctS(biggest.afterShare)}`)
  line(`4 · null → value: ${gained.length} · value → null: ${lost.length}`)
  const oneAsin = res.filter((r) => r.nowShare != null && r.nowContrib <= 1).length
  const oneAsinAfter = res.filter((r) => r.afterShare != null && r.afterContrib <= 1).length
  line(`5 · steered by ONE ASIN: ${oneAsin} today → ${oneAsinAfter} after`)
  line(`    steered by ≤3 ASINs: ${res.filter((r) => r.nowShare != null && r.nowContrib <= 3).length} today → ${res.filter((r) => r.afterShare != null && r.afterContrib <= 3).length} after`)
  line(`    mean contributing ASINs: ${(res.filter((r) => r.nowShare != null).reduce((a, r) => a + r.nowContrib / r.asins, 0) / Math.max(1, res.filter((r) => r.nowShare != null).length) * 100).toFixed(0)}% → ${(res.filter((r) => r.afterShare != null).reduce((a, r) => a + r.afterContrib / r.asins, 0) / Math.max(1, res.filter((r) => r.afterShare != null).length) * 100).toFixed(0)}%`)
  line()
  line(`6 · 🔴 WHAT THE ENGINE DOES — computed by running the real computeStep on the real specs:`)
  line(`      campaigns whose CONTROLLER DECISION changes: ${decisionChanged.length}`)
  line(`      campaigns that even READ the share (readsIS): ${res.filter((r) => r.readsIS).length}`)
  line(`      campaigns where !canChase returns first     : ${res.filter((r) => !r.canChase).length}`)
  if (decisionChanged.length) {
    for (const r of decisionChanged.slice(0, 20)) line(`      ${padr(r.camp.slice(0, 34), 36)} ${r.actNow}@${r.pctNow}% → ${r.actAfter}@${r.pctAfter}%  ${r.reasonAfter.slice(0, 60)}`)
  } else {
    line('      ⇒ NONE. Not one campaign changes what it does, because the share is discarded before')
    line('        it is read (docs/2026-08-11-rd-rank-dayparting-page.md §0). Collecting is inert.')
  }

  // ── the KT completeness gate ───────────────────────────────────────────────────────────────────
  h('§F · does 07-26 pass the KT completeness gate after this?')
  line(`gate constants: KT_LOOKBACK_DAYS=${KT_LOOKBACK_DAYS} · SQP_COMPLETENESS_RATIO=${SQP_COMPLETENESS_RATIO} · SQP_BASELINE_PERIODS=${SQP_BASELINE_PERIODS}`)
  line('Using the REAL `chooseViewPeriod`, not a re-implementation — the gate is its own definition.')
  line(`${padr('mkt', 4)} ${pad('07-26 now', 10)} ${pad('after', 7)} ${padr('period chosen NOW', 20)} ${padr('period chosen AFTER', 20)} verdict`)
  for (const mkt of ['IT', 'DE', 'ES', 'FR']) {
    const count = (src: Row[]) => {
      const m = new Map<number, number>()
      for (const r of src) if (r.marketplace === mkt) m.set(r.startDate, (m.get(r.startDate) ?? 0) + 1)
      return [...m.entries()].map(([t, rows]) => ({ start: new Date(t), rows }))
    }
    const before = chooseViewPeriod(count(pool))
    const aft = chooseViewPeriod(count(after))
    const n0 = count(pool).find((p) => d10(p.start) === '2026-07-26')?.rows ?? 0
    const n1 = count(after).find((p) => d10(p.start) === '2026-07-26')?.rows ?? 0
    const accepted0 = d10(before.start) === '2026-07-26'
    const accepted1 = d10(aft.start) === '2026-07-26'
    const verdict = accepted1 && !accepted0 ? '🔴 07-26 NOW ACCEPTED — the page moves a week forward'
      : accepted1 && accepted0 ? 'accepted before and after'
      : !accepted1 && !accepted0 ? `still rejected (needs ≥${aft.threshold.toFixed(0)}, has ${n1})`
      : '⚠ regressed'
    line(`${padr(mkt, 4)} ${pad(n0, 10)} ${pad(n1, 7)} ${padr(`${d10(before.start)} (${before.reason})`, 20)} ${padr(`${d10(aft.start)} (${aft.reason})`, 20)} ${verdict}`)
    line(`     baseline median ${before.baselineRows} → ${aft.baselineRows} · threshold ${before.threshold.toFixed(1)} → ${aft.threshold.toFixed(1)}`)
  }

  h('control')
  line(`SearchQueryPerformance rows ${pool.length} (unchanged — this probe writes nothing)`)
  line(`staged manifest entries ${manifest.length} · staged files on disk ${readdirSync(OUT).filter((f) => f.endsWith('.ndjson') && f !== 'manifest.ndjson').length}`)
  line(`NEXUS_COVERAGE_ENGINE_MODE=${process.env.NEXUS_COVERAGE_ENGINE_MODE ?? 'unset ✓'} · enabled KeywordCoverageSets ${await prisma.keywordCoverageSet.count({ where: { enabled: true } })}`)
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
