/**
 * _kt6-spend.mts — KT.6 §4: what can "spent today" actually be measured from? READ-ONLY.
 *
 * A ceiling that compares against a number nobody can compute is decoration. The operator's
 * refusal message quotes "€38.90 spent" — so before designing the ceiling, find the freshest
 * trustworthy per-campaign spend, and its LAG. Campaign.spend is already disqualified: an
 * unlabelled 30-day window.
 */
import '../src/env.js'
import prisma from '../src/db.js'
const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 70 - s.length))}`) }
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const eur = (c: number) => `€${(c / 100).toFixed(2)}`

async function main() {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0)
  h('AmazonAdsDailyPerformance — the source familySpendRecentCents uses')
  const latest = await prisma.amazonAdsDailyPerformance.findFirst({
    where: { entityType: 'CAMPAIGN' }, orderBy: { date: 'desc' }, select: { date: true },
  })
  line(`newest CAMPAIGN row: ${latest ? latest.date.toISOString().slice(0, 10) : 'none'}`)
  const lagDays = latest ? Math.round((+today - +latest.date) / 86_400_000) : null
  line(`lag behind today (${today.toISOString().slice(0, 10)}): ${lagDays} day(s)`)
  line(lagDays === 0 ? '✓ today has rows' : `🔴 today has NO rows — a "spent today" figure cannot come from here`)
  for (const d of [0, 1, 2, 3]) {
    const day = new Date(+today - d * 86_400_000)
    const agg = await prisma.amazonAdsDailyPerformance.aggregate({
      where: { entityType: 'CAMPAIGN', date: day }, _sum: { costMicros: true }, _count: { _all: true },
    })
    line(`  ${day.toISOString().slice(0, 10)}: ${pad(agg._count._all, 5)} rows · ${pad(eur(Math.round(Number(agg._sum.costMicros ?? 0n) / 10000)), 10)}`)
  }

  h('hourly? — the finer grain, if it exists')
  const hourly = await prisma.amazonAdsHourlyPerformance.findFirst({ orderBy: { hourStart: 'desc' }, select: { hourStart: true } }).catch(() => null)
  if (hourly) {
    const lagH = (Date.now() - +hourly.hourStart) / 3_600_000
    line(`newest hourly row: ${hourly.hourStart.toISOString().slice(0, 16)} — ${lagH.toFixed(1)}h old`)
    const sinceToday = await prisma.amazonAdsHourlyPerformance.aggregate({
      where: { hourStart: { gte: today } }, _sum: { costMicros: true }, _count: { _all: true },
    })
    line(`rows since 00:00 UTC today: ${sinceToday._count._all} · ${eur(Math.round(Number(sinceToday._sum.costMicros ?? 0n) / 10000))}`)
    line(lagH < 6 ? '✓ hourly is fresh enough to support a same-day ceiling' : '🔴 hourly is stale too')
  } else line('no AmazonAdsHourlyPerformance rows / model unavailable')

  h('per market, the freshest complete day')
  const camps = await prisma.campaign.findMany({ select: { id: true, marketplace: true, liveBidWritesEnabled: true } })
  const byId = new Map(camps.map((c) => [c.id, c]))
  for (const d of [1, 2]) {
    const day = new Date(+today - d * 86_400_000)
    const rows = await prisma.amazonAdsDailyPerformance.findMany({
      where: { entityType: 'CAMPAIGN', date: day }, select: { localEntityId: true, costMicros: true },
    })
    const perMkt = new Map<string, { cents: number; writ: number }>()
    for (const r of rows) {
      const c = r.localEntityId ? byId.get(r.localEntityId) : null
      if (!c?.marketplace) continue
      const e = perMkt.get(c.marketplace) ?? { cents: 0, writ: 0 }
      const cents = Math.round(Number(r.costMicros) / 10000)
      e.cents += cents; if (c.liveBidWritesEnabled) e.writ += cents
      perMkt.set(c.marketplace, e)
    }
    line(`${day.toISOString().slice(0, 10)} (${d}d ago): ${[...perMkt].sort().map(([m, e]) => `${m} ${eur(e.cents)} (writable ${eur(e.writ)})`).join(' · ')}`)
  }

  h('what a ceiling could therefore be compared against')
  line('The honest options, in order of freshness:')
  line('  1. hourly costMicros since 00:00 UTC — if the lag above is small')
  line('  2. yesterday\'s daily total as a PROXY, labelled as yesterday')
  line('  3. what KT.6 itself has authorised today (a nexus-side ledger, no Amazon lag at all)')
  line('🔴 Option 3 is the only one with zero lag, and it is the only one that answers the question')
  line('   the ceiling is actually for: "how much has THIS PAGE already committed today?"')
  line('   Amazon spend answers a different question and arrives a day late.')

  h('control')
  line(`AmazonAdsDailyPerformance rows total ${await prisma.amazonAdsDailyPerformance.count()}`)
  line(`campaigns ${camps.length} · writable ${camps.filter((c) => c.liveBidWritesEnabled).length}`)
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(String(e).slice(0, 400)); await prisma.$disconnect(); process.exit(1) })
