/**
 * SOV page study — part E. READ-ONLY. Confirms the facts the SOV.0 prompt asserts, after
 * KT.1/KT.1b/KT.2 shipped and changed two of them (KeywordWatchlist replaced KeywordCoverageSet
 * as the list a page filters by; the SQP week may have rolled).
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const day = (d: Date) => d.toISOString().slice(0, 10)

console.log('\n═══ SOV page study — E: facts the SOV.0 prompt asserts ═══\n')

const lists = await prisma.keywordWatchlist.findMany({ select: { id: true, name: true, marketplace: true, isDefault: true, source: true, _count: { select: { terms: true } } } })
console.log(`KeywordWatchlist rows : ${lists.length}`)
for (const l of lists) console.log(`  ${l.marketplace} · ${l.name} · default=${l.isDefault} · source=${l.source} · ${l._count.terms} terms`)

const sets = await prisma.keywordCoverageSet.findMany({ select: { name: true, marketplace: true, enabled: true, _count: { select: { terms: true } } } })
console.log(`\nKeywordCoverageSet rows (the OLD list) : ${sets.length}`)
for (const s of sets) console.log(`  ${s.marketplace} · ${s.name} · enabled=${s.enabled} · ${s._count.terms} terms`)

const newest = await prisma.searchQueryPerformance.groupBy({ by: ['startDate'], _count: { _all: true }, orderBy: { startDate: 'desc' }, take: 3 })
console.log(`\nSQP newest periods:`)
for (const p of newest) console.log(`  ${day(p.startDate)} — ${int(p._count._all)} rows`)
const sqpAge = newest[0] ? Math.round((Date.now() - +newest[0].startDate) / 86_400_000) : null
console.log(`  age of newest: ${sqpAge}d`)

const st = await prisma.amazonAdsSearchTerm.findFirst({ orderBy: { date: 'desc' }, select: { date: true } })
console.log(`AmazonAdsSearchTerm latest date : ${st ? day(st.date) : '—'} (age ${st ? Math.round((Date.now() - +st.date) / 86_400_000) : '—'}d)`)

// the one real zero the prompt names as a fixture
const zero = await prisma.searchQueryPerformance.findMany({
  where: { marketplace: 'IT', impressionsTotal: { gt: 0 }, impressionsBrand: 0 },
  select: { searchQuery: true, startDate: true, impressionsTotal: true, searchQueryVolume: true },
  orderBy: { startDate: 'desc' }, take: 6,
})
console.log(`\nIT rows that are a REAL zero (market total > 0, ours = 0): ${zero.length} shown`)
for (const z of zero) console.log(`  ${day(z.startDate)} "${z.searchQuery}" market impr ${int(z.impressionsTotal)} vol ${int(z.searchQueryVolume)}`)

// scope reach, for the two-number contract
const camps = await prisma.campaign.groupBy({ by: ['marketplace'], _count: { _all: true } })
console.log(`\nCampaigns by market: ${camps.map((c) => `${c.marketplace}=${c._count._all}`).join(' · ')}`)
const withPortfolio = await prisma.campaign.count({ where: { portfolioId: { not: null } } })
const allCamps = await prisma.campaign.count()
console.log(`Campaigns carrying a portfolioId: ${int(withPortfolio)} of ${int(allCamps)}`)

await prisma.$disconnect()
console.log('\n═══ end E ═══\n')
