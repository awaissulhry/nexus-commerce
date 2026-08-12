/**
 * _sov0-weeks.mts — run the SHIPPED service against prod, and prove three things (read-only).
 *
 *   1. `?weeks=` moves pixels. §3.0's law: a control earns its place only if some pixel changes
 *      when you move it. With ONE period rendered, the only thing a history bound can change is
 *      WHICH period — so this prints `asOf` and the census at 4 / 8 / 13 weeks in all four markets.
 *   2. `asOf` is ONE value per view, by construction, in every market and under a portfolio and a
 *      campaign. Asserted from the service's own output, not from a hand-written query.
 *   3. The four blank-states, with the named row that demonstrates each.
 *
 * NO WRITES.
 * Run from apps/api: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_sov0-weeks.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { getShareOfVoice, SOV_MARKETS, SOV_WEEKS } from '../src/services/advertising/share-of-voice.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 72 - s.length))}`) }

async function main() {
  h('1 · does ?weeks= move anything? asOf + census at 4 / 8 / 13')
  for (const m of SOV_MARKETS) {
    for (const w of SOV_WEEKS) {
      const t0 = Date.now()
      const r = await getShareOfVoice({ market: m, weeks: w })
      line(`${m} weeks=${String(w).padEnd(2)} → asOf ${r.period.asOf} (${r.period.ageDays}d) reason=${r.period.reason}${r.period.truncated ? ' TRUNCATED' : ''} rows=${r.period.rows}/${r.period.baselineRows} thr=${r.period.threshold} · grid ${r.total} rows (measured ${r.census.measured}, zeros ${r.census.realZeros}) · ${Date.now() - t0}ms`)
    }
  }

  h('2 · ONE asOf per view — every market, plus a portfolio and a campaign')
  const campaigns = await prisma.campaign.findMany({ where: { status: { not: 'ARCHIVED' } }, select: { id: true, name: true, marketplace: true, portfolioId: true } })
  const views: Array<{ label: string; args: Parameters<typeof getShareOfVoice>[0] }> = SOV_MARKETS.map((m) => ({ label: `${m} · market`, args: { market: m } }))
  const itPf = [...new Set(campaigns.filter((c) => c.marketplace === 'IT').map((c) => c.portfolioId).filter((x): x is string => !!x))]
  if (itPf[0]) views.push({ label: `IT · portfolio ${itPf[0]}`, args: { market: 'IT', portfolio: itPf[0] } })
  if (itPf[1]) views.push({ label: `IT · portfolio ${itPf[1]}`, args: { market: 'IT', portfolio: itPf[1] } })
  const itCamp = campaigns.find((c) => c.marketplace === 'IT')
  if (itCamp) views.push({ label: `IT · campaign "${itCamp.name}"`, args: { market: 'IT', campaign: itCamp.id } })
  const deLine = await prisma.product.findFirst({ where: { parentId: null }, select: { id: true, sku: true } })
  if (deLine) views.push({ label: `IT · line ${deLine.sku}`, args: { market: 'IT', line: deLine.id } })

  let worst = 0
  for (const v of views) {
    const r = await getShareOfVoice({ ...v.args, limit: 2000 })
    // the DISTINCT asOf a measured row can carry. One period per view ⇒ 1, by construction.
    const distinct = new Set(r.rows.filter((x) => x.state === 'measured').map(() => r.period.asOf))
    worst = Math.max(worst, distinct.size)
    line(`${v.label.padEnd(46)} boundBy=${r.scope.boundBy} campaigns=${r.scope.resolved.campaigns}/${r.scope.resolved.campaignsInMarket} asins=${r.scope.resolved.asins} (SQP this period ${r.scope.resolved.asinsWithSqpRows}, ever ${r.scope.resolved.asinsWithSqpRowsEver})`)
    line(`${''.padEnd(46)} asOf=${r.period.asOf} DISTINCT=${distinct.size} · total ${r.total} · measured ${r.census.measured} notCovered ${r.census.notCovered} noRow ${r.census.noRowThisPeriod} never ${r.census.neverMeasured} zeros ${r.census.realZeros} noMktTotal ${r.census.noMarketTotal}`)
  }
  line()
  line(`MAX distinct asOf across every view tested: ${worst}  ${worst === 1 ? '✅' : '🔴 FAIL'}`)

  h('3 · the four blank-states, with a named row for each')
  const demos: Array<{ label: string; args: Parameters<typeof getShareOfVoice>[0] }> = [
    { label: 'IT · market (the default view)', args: { market: 'IT' } },
    { label: 'IT · the curated watchlist', args: { market: 'IT', list: null } },
    { label: 'IT · portfolio with NO Brand Analytics coverage', args: { market: 'IT', portfolio: '190601227863497' } },
    { label: 'IT · portfolio WITH coverage', args: { market: 'IT', portfolio: '255127157311072' } },
    { label: 'DE · the bid-keyword watchlist', args: { market: 'DE' } },
  ]
  const itList = await prisma.keywordWatchlist.findFirst({ where: { marketplace: 'IT', isDefault: true }, select: { id: true } })
  const deList = await prisma.keywordWatchlist.findFirst({ where: { marketplace: 'DE', isDefault: true }, select: { id: true } })
  if (itList) demos[1].args.list = itList.id
  if (deList) demos[4].args.list = deList.id
  for (const d of demos) {
    const r = await getShareOfVoice({ ...d.args, limit: 2000 })
    line(`${d.label} — ${r.total} rows`)
    for (const st of ['measured', 'not-covered', 'no-row-this-period', 'never-measured'] as const) {
      const hit = r.rows.filter((x) => x.state === st)
      const ex = hit[0]
      line(`    ${st.padEnd(19)} ${String(hit.length).padStart(4)}${ex ? `  e.g. "${ex.query}" share=${ex.share === null ? 'null' : (ex.share * 100).toFixed(2) + '%'} mktImpr=${ex.marketImpressions} ours=${ex.ourImpressions} vol=${ex.marketVolume} rank=${ex.marketRank}${ex.lastSeen ? ` lastSeen=${ex.lastSeen}` : ''}` : ''}`)
    }
    const zero = r.rows.find((x) => x.state === 'measured' && x.share === 0)
    line(`    REAL ZERO           ${String(r.census.realZeros).padStart(4)}${zero ? `  e.g. "${zero.query}" mktImpr=${zero.marketImpressions} vol=${zero.marketVolume}` : '  — none in this view'}`)
  }

  h('4 · facets, freshness, and the two-number reach sentence')
  const r = await getShareOfVoice({ market: 'IT' })
  line(`branded ${r.facets.branded} · asinLike ${r.facets.asinLike} · lists ${r.facets.byList.map((l) => `${l.name}(${l.terms})`).join(', ')}`)
  line(`freshness: SQP ${r.freshness.sqp.latest} (${r.freshness.sqp.ageDays}d) · ads ${r.freshness.ads.latest} (${r.freshness.ads.ageDays}d)`)
  line(`reach: ${r.scope.market} · ${r.scope.resolved.campaigns} of ${r.scope.resolved.campaignsInMarket} campaigns · ${r.scope.resolved.asinsWithSqpRowsEver} of ${r.scope.resolved.asins} ASINs have Brand Analytics rows`)
  line(`branded=1 check: ${(await getShareOfVoice({ market: 'IT', branded: true })).total} rows vs ${r.total} at the default`)
  line(`kind=all check:  ${(await getShareOfVoice({ market: 'IT', kind: 'all' })).total} rows vs ${r.total} at kind=keyword`)
  const p1 = await getShareOfVoice({ market: 'IT', limit: 50, offset: 0 })
  const p2 = await getShareOfVoice({ market: 'IT', limit: 50, offset: 50 })
  const overlap = p1.rows.filter((a) => p2.rows.some((b) => b.query === a.query)).length
  line(`paging: page1 ${p1.rows.length} + page2 ${p2.rows.length}, overlap ${overlap}, total stable ${p1.total === p2.total}`)
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
