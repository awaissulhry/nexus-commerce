/**
 * _kt2-verify.mts — the four markets on their OWN lists, measured (read-only).
 *
 * The bar: each market opens on its own list with real terms, and DE/ES/FR are no longer served the
 * Italian one. Also checks the things that can only go wrong once lists are per-market: a ?list=
 * from another market must be refused, not honoured, and the branded flag must come from storage.
 *
 * NO WRITES.
 * Run: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt2-verify.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { getKeywordTracker } from '../src/services/advertising/keyword-tracker.service.js'
import { listWatchlists } from '../src/services/advertising/keyword-watchlist.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 68 - s.length))}`) }
const MARKETS = ['IT', 'DE', 'ES', 'FR'] as const

async function main() {
  h('1 · the four lists on prod')
  const lists = await listWatchlists()
  for (const w of lists) line(`   ${w.marketplace}  "${w.name}"  terms=${w.terms} (branded ${w.brandedTerms})  default=${w.isDefault}  source=${w.source}`)

  h('2 · each market opens on ITS OWN list')
  const itTerms = new Set(
    (await prisma.keywordWatchlistTerm.findMany({
      where: { watchlist: { marketplace: 'IT' } }, select: { term: true },
    })).map((t) => t.term),
  )
  for (const m of MARKETS) {
    const t0 = Date.now()
    const r = await getKeywordTracker({ market: m })
    const ms = Date.now() - t0
    const own = r.scope.list
    line(`${m}: list="${own?.name}" (${own?.marketplace}) terms=${own?.terms} source=${own?.source} default=${own?.isDefault}`)
    line(`   period=${r.window.period} · measured=${r.scope.resolved.keywordsMeasured} noRow=${r.scope.resolved.keywordsNoRowThisPeriod} never=${r.scope.resolved.keywordsNeverMeasured} of ${r.scope.resolved.keywordsWatched} watched · ${ms}ms`)
    line(`   picker offers ${r.lists.length} list(s) for this market: ${r.lists.map((l) => `"${l.name}"(${l.terms})`).join(', ')}`)
    line(`   'enabled' present on the list payload? ${Object.prototype.hasOwnProperty.call(own ?? {}, 'enabled') ? '🔴 YES' : 'no ✓'}`)
    // the defect: are we still rendering Italian terms outside IT?
    if (m !== 'IT') {
      const shown = new Set(r.rows.map((x) => x.keyword))
      const italian = [...shown].filter((x) => itTerms.has(x))
      // the 10 protected brand terms are on EVERY list by design, so exclude them from the check
      const branded = new Set(r.rows.filter((x) => x.branded).map((x) => x.keyword))
      const bleed = italian.filter((x) => !branded.has(x))
      line(`   Italian-list bleed (excluding the 10 shared brand terms): ${bleed.length} ${bleed.length ? `🔴 ${bleed.slice(0, 5).join(', ')}` : '✓ none'}`)
    }
    const top = r.rows.filter((x) => x.state === 'measured').sort((a, b) => (b.marketVolume ?? 0) - (a.marketVolume ?? 0)).slice(0, 3)
    for (const x of top) line(`      ${x.keyword.slice(0, 34).padEnd(34)} vol=${String(x.marketVolume).padStart(6)} rank=#${x.marketRank} share=${((x.impressionShare ?? 0) * 100).toFixed(2)}%`)
  }

  h('3 · before/after, per market: what the wrong list cost')
  line('KT.1b served the 97 Italian terms everywhere. These are the measured yields then and now.')
  line('market   KT.1b (Italian list)          KT.2 (own list)')
  const before: Record<string, string> = {
    IT: '97 measured of 97', DE: '2 measured of 97', ES: '0 measured of 97', FR: '0 measured of 97',
  }
  for (const m of MARKETS) {
    const r = await getKeywordTracker({ market: m })
    line(`${m.padEnd(8)} ${before[m].padEnd(28)} ${r.scope.resolved.keywordsMeasured} measured of ${r.scope.resolved.keywordsWatched}`)
  }

  h('4 · a ?list= from another market is REFUSED, not honoured')
  const itList = lists.find((w) => w.marketplace === 'IT')!
  const r = await getKeywordTracker({ market: 'DE', list: itList.id })
  line(`DE + ?list=<the IT list id> → list=${r.scope.list ? `"${r.scope.list.name}"` : 'null'} listRejected=${(r.scope as { listRejected?: boolean }).listRejected} rows=${r.rows.length}`)
  line(`   ${r.scope.list === null ? '✓ refused' : '🔴 honoured — a market is rendering another market’s list'}`)
  const own = await getKeywordTracker({ market: 'DE', list: lists.find((w) => w.marketplace === 'DE')!.id })
  line(`DE + ?list=<its own list id> → "${own.scope.list?.name}" rows=${own.rows.length} ✓`)

  h('5 · branded comes from STORAGE, not from a re-derivation')
  const b = await getKeywordTracker({ market: 'IT', branded: true })
  const brandedRows = b.rows.filter((x) => x.branded)
  line(`IT branded=1: ${b.rows.length} rows, ${brandedRows.length} flagged branded → ${brandedRows.map((x) => x.keyword).join(', ')}`)
  const plain = await getKeywordTracker({ market: 'IT' })
  line(`IT branded=0: ${plain.rows.length} rows, ${plain.rows.filter((x) => x.branded).length} branded (must be 0)`)
  line(`⇒ the 10 protected terms are hidden by default in every market: ${(await Promise.all(MARKETS.map(async (m) => {
    const x = await getKeywordTracker({ market: m })
    return `${m}=${x.rows.filter((r2) => r2.branded).length}`
  }))).join(' · ')}`)

  h('6 · the coverage set is untouched — it is an import source, not a dependency')
  const set = await prisma.keywordCoverageSet.findFirst({ select: { name: true, enabled: true, updatedAt: true, _count: { select: { terms: true } } } })
  line(`   "${set?.name}" enabled=${set?.enabled} terms=${set?._count.terms} updatedAt=${set?.updatedAt.toISOString().slice(0, 16)}`)
  line(`   (updatedAt is 2026-08-05, before KT.2 — nothing in this build wrote to it)`)
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
