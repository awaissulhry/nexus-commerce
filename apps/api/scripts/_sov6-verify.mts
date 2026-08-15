/**
 * _sov6-verify.mts — the freshness reckoning and the override, measured on prod (read-only).
 *
 * Four things the brief's §11 requires be demonstrated rather than asserted:
 *   1. The rejection line's facts, per market: which period was declined, its rows, the threshold,
 *      the shortfall, and the ASIN count that CAUSED it.
 *   2. `?period=` accepted — every share-derived number comes from the overridden week.
 *   3. `?period=` refused — malformed, and a week this market does not have. Never a silent fallback.
 *   4. The Δ under an override: which prior it picks, or that it has none.
 *
 * NO WRITES. Run from apps/api.
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { getShareOfVoice, SOV_MARKETS } from '../src/services/advertising/share-of-voice.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 74 - s.length))}`) }
const pct = (v: number | null | undefined) => (v == null ? 'null' : `${(v * 100).toFixed(4)}%`)

async function main() {
  h('1 · the rejection reckoning, per market')
  for (const m of SOV_MARKETS) {
    const r = await getShareOfVoice({ market: m, limit: 3000 })
    const rj = r.period.rejection
    line(`${m}: rendering ${r.period.asOf} (${r.period.ageDays}d, ${r.period.rows} rows, ${r.scope.resolved.queries} queries)`)
    if (!rj) { line('    no newer period was rejected — the line MUST NOT render ✅'); continue }
    line(`    DECLINED ${rj.asOf} (${rj.ageDays}d): ${rj.rows} of ${rj.threshold} rows = ${rj.pctOfBar}% of the bar, short by ${rj.shortBy}`)
    line(`    cause: ${rj.asins} ASINs against ${rj.chosenAsins} in the rendered week · ${rj.count} newer period(s) declined in total`)
    if (rj.others.length) line(`    also declined: ${rj.others.map((o) => `${o.asOf} (${o.rows} rows)`).join(' · ')}`)
  }

  h('2 · ?period= ACCEPTED — the whole page moves to the overridden week')
  for (const m of SOV_MARKETS) {
    const base = await getShareOfVoice({ market: m, limit: 3000 })
    const target = base.period.rejection?.asOf
    if (!target) { line(`${m}: nothing rejected to override to`); continue }
    const o = await getShareOfVoice({ market: m, period: target, limit: 3000 })
    line(`${m}: gate ${base.period.asOf} → override ${o.period.asOf} (${o.period.override.active})`)
    line(`    belowBar=${o.period.override.belowBar} pctOfBar=${o.period.override.pctOfBar}% asins=${o.period.override.asins} gateAsOf=${o.period.override.gateAsOf}`)
    line(`    rows on grid ${o.total} (was ${base.total}) · measured ${o.census.measured} (was ${base.census.measured})`)
    line(`    weighted share ${pct(o.shareSummary.weighted)} (was ${pct(base.shareSummary.weighted)}) — every share-derived number moved`)
    line(`    Δ prior: ${o.period.prior.asOf ?? 'NONE'} (${o.period.prior.reason}) gap ${o.period.prior.gapDays ?? '—'}d · delta-measured ${o.census.deltaMeasured} · no-prior ${o.census.deltaNoPrior}`)
    line(`    scope Δ: ${o.scopeDelta.deltaPt == null ? 'none — states why' : o.scopeDelta.deltaPt.toFixed(4) + 'pt on ' + o.scopeDelta.queries + ' in both'}`)
  }

  h('3 · ?period= REFUSED — never a silent fallback')
  for (const [label, val] of [['malformed', 'last-tuesday'], ['not a week this market has', '2020-01-06'], ['a real date, wrong market', '2026-07-26']] as const) {
    const r = await getShareOfVoice({ market: 'FR', period: val, limit: 50 })
    line(`FR ?period=${val} (${label}): active=${r.period.override.active} refused=${r.period.override.refused} → rendering ${r.period.asOf} (the gate's choice = ${r.period.override.gateAsOf})`)
  }

  h('4 · the periods the override may offer')
  for (const m of SOV_MARKETS) {
    const r = await getShareOfVoice({ market: m, limit: 50 })
    line(`${m}: ${r.period.available.slice(0, 5).map((p) => `${p.asOf}(${p.rows}r/${p.asins}a)`).join(' · ')}`)
  }
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
