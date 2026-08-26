/**
 * _kt-verify-floor.mts — price the coverage floor SQP.4 handed over (read-only).
 *
 *   A. Where the feed stands now, per week per market, with ASIN counts.
 *   B. The gate today: which period it picks, and by how much the newest week misses.
 *   C. An ASIN floor at 3 / 5 / 8: which period would each market then read, and how old.
 *   D. The vacuity claim: once the baseline holds only cron-fed weeks, does every week pass?
 *
 * NO WRITES. Run from apps/api:
 *   NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt-verify-floor.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 62 - s.length))}`) }
const d10 = (d: Date) => new Date(d).toISOString().slice(0, 10)
const MARKETS = ['IT', 'DE', 'ES', 'FR']
const RATIO = 0.5, LOOKBACK = 42
const med = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

async function main() {
  const sqp = await prisma.searchQueryPerformance.findMany({
    select: { marketplace: true, startDate: true, searchQuery: true, asin: true, ingestedAt: true },
  })
  const now = Date.now()
  const age = (t: number) => Math.round((now - t) / 864e5)

  // ── A · the feed now ─────────────────────────────────────────────────────
  h('A · Stored weeks — rows and distinct ASINs per market')
  const weeks = [...new Set(sqp.map((r) => +r.startDate))].sort((a, b) => b - a)
  line(`total rows: ${sqp.length}`)
  line('week          age   ' + MARKETS.map((m) => `${m} rows/ASINs`.padStart(14)).join(''))
  for (const w of weeks.slice(0, 7)) {
    const cells = MARKETS.map((m) => {
      const rs = sqp.filter((r) => r.marketplace === m && +r.startDate === w)
      const a = new Set(rs.map((r) => r.asin).filter(Boolean)).size
      return `${rs.length}/${a}`.padStart(14)
    }).join('')
    line(`${d10(new Date(w))}  ${String(age(w)).padStart(4)}d${cells}`)
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  type Cand = { start: number; rows: number; asins: number }
  const candidates = (m: string): Cand[] => {
    const ps = [...new Set(sqp.filter((r) => r.marketplace === m).map((r) => +r.startDate))].sort((a, b) => b - a)
    return ps.map((p) => {
      const rs = sqp.filter((r) => r.marketplace === m && +r.startDate === p)
      return { start: p, rows: rs.length, asins: new Set(rs.map((r) => r.asin).filter(Boolean)).size }
    })
  }
  const pick = (m: string, opts: { asinFloor?: number; asOf?: number } = {}) => {
    const at = opts.asOf ?? now
    const cs = candidates(m)
    const inWin = cs.filter((c) => (at - c.start) / 864e5 <= LOOKBACK)
    for (const c of inWin) {
      const i = cs.findIndex((x) => x.start === c.start)
      const baseline = cs.slice(i + 1, i + 5).map((x) => x.rows)
      const threshold = RATIO * med(baseline)
      const ratioOk = c.rows >= threshold
      const floorOk = opts.asinFloor == null ? false : c.asins >= opts.asinFloor
      if (opts.asinFloor == null ? ratioOk : (ratioOk || floorOk)) {
        return { ...c, threshold, reason: ratioOk ? 'ratio' : 'floor', trunc: false }
      }
    }
    const f = inWin[0] ?? cs[0]
    return f ? { ...f, threshold: 0, reason: 'fallback', trunc: true } : null
  }

  // ── B · the gate today ───────────────────────────────────────────────────
  h('B · The gate as it stands (ratio 0.5, lookback 42d)')
  for (const m of MARKETS) {
    const p = pick(m)
    const cs = candidates(m)
    const newest = cs[0]
    const i = 0
    const baseline = cs.slice(i + 1, i + 5).map((x) => x.rows)
    const need = RATIO * med(baseline)
    line(`${m}: picks ${p ? d10(new Date(p.start)) : '—'} (${p ? age(p.start) : '—'}d, ${p?.rows} rows, ${p?.asins} ASINs${p?.trunc ? ', TRUNCATED' : ''})`)
    line(`    newest week ${d10(new Date(newest.start))}: ${newest.rows} rows / ${newest.asins} ASINs · needs ${need.toFixed(0)} · short by ${Math.max(0, Math.ceil(need - newest.rows))}`)
  }

  // ── C · an ASIN floor ────────────────────────────────────────────────────
  h('C · With an absolute ASIN floor — which period would each market read?')
  for (const floor of [3, 5, 8]) {
    line(`floor >= ${floor} ASINs:`)
    for (const m of MARKETS) {
      const p = pick(m, { asinFloor: floor })
      line(`  ${m}: ${p ? d10(new Date(p.start)) : '—'} (${p ? age(p.start) : '—'}d) via ${p?.reason}${p?.trunc ? ' — TRUNCATED, page shows the banner' : ''} · ${p?.rows} rows / ${p?.asins} ASINs`)
    }
  }

  // ── D · vacuity ──────────────────────────────────────────────────────────
  h('D · Does the gate go vacuous once only cron-fed weeks remain?')
  line('A week is "cron-fed" here if it was first ingested after the async split (2026-08-12).')
  const cronCut = Date.parse('2026-08-09T00:00:00Z')
  for (const m of MARKETS) {
    const cs = candidates(m)
    const cronWeeks = cs.filter((c) => {
      const rs = sqp.filter((r) => r.marketplace === m && +r.startDate === c.start)
      return Math.min(...rs.map((r) => +r.ingestedAt)) >= cronCut
    })
    line(`${m}: ${cronWeeks.length} cron-fed weeks — ${cronWeeks.map((c) => `${d10(new Date(c.start))}(${c.rows}r/${c.asins}a)`).join(' · ') || 'none'}`)
    if (cronWeeks.length >= 2) {
      const newest = cronWeeks[0]
      const base = cronWeeks.slice(1, 5).map((x) => x.rows)
      line(`    if the baseline held ONLY these: threshold ${(RATIO * med(base)).toFixed(1)} vs ${newest.rows} rows → ${newest.rows >= RATIO * med(base) ? '🔴 PASSES' : 'fails'}`)
    }
  }
  // simulate the backfill ageing out
  h('D2 · Simulated: the gate on 2026-09-06, when the backfill weeks have aged out')
  const future = Date.parse('2026-09-06T00:00:00Z')
  for (const m of MARKETS) {
    const p = pick(m, { asOf: future })
    const cs = candidates(m).filter((c) => (future - c.start) / 864e5 <= LOOKBACK)
    line(`${m}: in-window weeks on 06 Sep: ${cs.map((c) => `${d10(new Date(c.start))}(${c.rows}r/${c.asins}a)`).join(' · ') || 'none'}`)
    line(`    gate would pick ${p ? d10(new Date(p.start)) : '—'} via ${p?.reason}${p?.trunc ? ' (TRUNCATED)' : ''}`)
    const withFloor = pick(m, { asOf: future, asinFloor: 5 })
    line(`    with a >=5 ASIN floor: ${withFloor ? d10(new Date(withFloor.start)) : '—'} via ${withFloor?.reason}${withFloor?.trunc ? ' (TRUNCATED)' : ''}`)
  }

  line(); line('done — nothing was written.')
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
