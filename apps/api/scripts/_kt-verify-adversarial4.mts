import '../src/env.js'
import prisma from '../src/db.js'

const iso = (d: Date) => new Date(d).toISOString().slice(0, 10)
const J = (o: unknown) => console.log(JSON.stringify(o, null, 1))

async function main() {
  console.log('=== the 8 IT rows in the newest period 2026-07-26 (the period the rule PREFERS) ===')
  const p26 = await prisma.searchQueryPerformance.findMany({
    where: { marketplace: 'IT', startDate: new Date('2026-07-26T00:00:00Z') },
    select: { searchQuery: true, asin: true, impressionShare: true, searchQueryVolume: true, impressionsTotal: true, impressionsBrand: true, ingestedAt: true },
  })
  J(p26.map((r) => ({ q: r.searchQuery, asin: r.asin, share: Number(r.impressionShare), vol: r.searchQueryVolume, impTotal: r.impressionsTotal, impBrand: r.impressionsBrand, ingested: r.ingestedAt.toISOString() })))

  console.log('\n=== "giubbotto moto" IT — every stored period, every ASIN ===')
  const gm = await prisma.searchQueryPerformance.findMany({
    where: { marketplace: 'IT', searchQuery: 'giubbotto moto' },
    select: { startDate: true, asin: true, impressionShare: true, impressionsBrand: true, impressionsTotal: true, searchQueryVolume: true },
    orderBy: [{ startDate: 'desc' }],
  })
  const g = new Map<string, any[]>()
  for (const r of gm) g.set(iso(r.startDate), [...(g.get(iso(r.startDate)) ?? []), r])
  for (const [p, arr] of [...g.entries()].sort().reverse()) {
    const best = arr.reduce((a, b) => (Number(b.impressionShare) > Number(a.impressionShare) ? b : a))
    console.log(`${p}: ourAsinRows=${arr.length} bestShare=${(Number(best.impressionShare) * 100).toFixed(2)}% (asin ${best.asin}) sumOfOurs=${(arr.reduce((s, x) => s + Number(x.impressionShare), 0) * 100).toFixed(2)}% vol=${best.searchQueryVolume} impTotal=${best.impressionsTotal}`)
  }

  console.log('\n=== "pantaloni moto uomo estivi" IT — every stored period ===')
  const pm = await prisma.searchQueryPerformance.findMany({
    where: { marketplace: 'IT', searchQuery: 'pantaloni moto uomo estivi' },
    select: { startDate: true, asin: true, impressionShare: true, searchQueryVolume: true },
    orderBy: [{ startDate: 'desc' }],
  })
  const g2 = new Map<string, any[]>()
  for (const r of pm) g2.set(iso(r.startDate), [...(g2.get(iso(r.startDate)) ?? []), r])
  for (const [p, arr] of [...g2.entries()].sort().reverse()) {
    const best = arr.reduce((a, b) => (Number(b.impressionShare) > Number(a.impressionShare) ? b : a))
    console.log(`${p}: ourAsinRows=${arr.length} bestShare=${(Number(best.impressionShare) * 100).toFixed(2)}% (asin ${best.asin}) vol=${best.searchQueryVolume}`)
  }

  console.log('\n=== the share the page shows for terms whose ADVERTISED ASINs are 0% covered ===')
  for (const term of ['giacca moto 4 stagioni', 'giacca pelle uomo']) {
    const rows = await prisma.searchQueryPerformance.findMany({
      where: { marketplace: 'IT', searchQuery: term, startDate: new Date('2026-07-19T00:00:00Z') },
      select: { asin: true, impressionShare: true },
    })
    console.log(`${term}: SQP rows on 2026-07-19 =`, rows.map((r) => `${r.asin}:${(Number(r.impressionShare) * 100).toFixed(2)}%`).join(' '))
    const tg = await prisma.adTarget.findMany({
      where: { kind: 'KEYWORD', isNegative: false, expressionValue: term, adGroup: { campaign: { marketplace: 'IT' } } },
      select: { adGroupId: true, status: true, bidCents: true, adGroup: { select: { name: true, campaign: { select: { name: true } } } } },
    })
    const ads = await prisma.adProductAd.findMany({
      where: { adGroupId: { in: tg.map((t) => t.adGroupId) }, asin: { not: null } }, select: { asin: true },
    })
    console.log(`  we bid on it in ${tg.length} ad group(s): ${tg.map((t) => `${t.adGroup.campaign.name}/${t.adGroup.name}@${t.bidCents}c/${t.status}`).slice(0, 6).join(' · ')}`)
    console.log(`  ASINs advertised in those ad groups: ${[...new Set(ads.map((a) => a.asin))].sort().join(', ')}`)
  }

  console.log('\n=== IT: advertised-ASIN count the page PRINTS vs SQP-covered ASIN count ===')
  for (const m of ['IT', 'DE', 'ES', 'FR']) {
    const adv = new Set((await prisma.adProductAd.findMany({ where: { asin: { not: null }, adGroup: { campaign: { marketplace: m } } }, select: { asin: true } })).map((a) => a.asin!))
    const cov = new Set((await prisma.searchQueryPerformance.findMany({ where: { marketplace: m, asin: { not: null } }, select: { asin: true }, distinct: ['asin'] })).map((r) => r.asin!))
    const covRecent = new Set((await prisma.searchQueryPerformance.findMany({ where: { marketplace: m, asin: { not: null }, startDate: { gte: new Date('2026-07-19T00:00:00Z') } }, select: { asin: true }, distinct: ['asin'] })).map((r) => r.asin!))
    console.log(`${m}: page's resolution line prints "${adv.size} ASINs" · SQP ever covers ${cov.size} · SQP covers ${covRecent.size} in the weeks the grid actually reads`)
  }

  console.log('\n=== IT campaigns: portfolio coverage (the page only warns when a portfolio is PICKED) ===')
  const c = await prisma.campaign.findMany({ where: { marketplace: 'IT' }, select: { portfolioId: true } })
  console.log(`IT campaigns=${c.length} without portfolioId=${c.filter((x) => !x.portfolioId).length}`)
  const all = await prisma.campaign.findMany({ select: { portfolioId: true } })
  console.log(`ALL campaigns=${all.length} without portfolioId=${all.filter((x) => !x.portfolioId).length}`)

  await prisma.$disconnect()
}
main().catch(async (e) => { console.error('FATAL', e); await prisma.$disconnect(); process.exit(1) })
