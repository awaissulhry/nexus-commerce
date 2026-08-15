/**
 * RT.2 — the metronome probe. Run BEFORE any cursor endpoint is written.
 *
 * The cursor contract's one hard rule is that each page's cursor watches fields MEASURED to move
 * when that page's subject moves. The failure mode it guards against is a column a cron re-stamps
 * unconditionally: a cursor over one of those fires forever, and a banner that always cries wolf
 * is worse than no banner — it teaches the operator to ignore the one that matters.
 *
 * This prints, for each candidate field, how many rows it touched in the last N minutes. Anything
 * approaching the whole population is a metronome and is disqualified.
 *
 * Run twice, ~20 minutes apart, at an hour with no window boundary:
 *   NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_rt-cursor-probe.mts
 */
import prisma from '../src/db.js'

const MIN = 60_000
const since = (m: number) => new Date(Date.now() - m * MIN)
const pct = (n: number, of: number) => (of > 0 ? `${((n / of) * 100).toFixed(0)}%` : '—')

async function main() {
  const out: Array<[string, string]> = []

  // ── apply-rules: is Campaign.updatedAt the 20-minute metronome the design claims? ──
  const campaigns = await prisma.campaign.count()
  const campTouched = await prisma.campaign.count({ where: { updatedAt: { gte: since(25) } } })
  out.push(['campaign.updatedAt in 25min', `${campTouched} of ${campaigns} (${pct(campTouched, campaigns)})`])
  // The fingerprint fields the design proposes instead.
  const [managed, bounded, suppressed] = await Promise.all([
    prisma.campaign.count({ where: { liveBidWritesEnabled: true } }),
    prisma.campaign.count({ where: { OR: [{ minBidCents: { not: null } }, { maxBidCents: { not: null } }] } }),
    prisma.campaign.count({ where: { NOT: { bidsSuppressedAt: null } } }).catch(() => -1),
  ])
  out.push(['  ↳ managed / bounded / suppressed', `${managed} / ${bounded} / ${suppressed}`])

  // ── automations: is AutomationRule.updatedAt the 15-minute metronome? ──
  const rules = await prisma.automationRule.count({ where: { domain: 'advertising' } })
  const rulesTouched = await prisma.automationRule.count({ where: { domain: 'advertising', updatedAt: { gte: since(20) } } })
  out.push(['automationRule.updatedAt in 20min', `${rulesTouched} of ${rules} (${pct(rulesTouched, rules)})`])
  // 🔴 The field that decides whether `actedAt` can ship: any automation:* actor writing most
  // ticks makes the ledger cursor a metronome.
  const actors = await prisma.advertisingActionLog.groupBy({
    by: ['userId'], where: { createdAt: { gte: since(24 * 60) } }, _count: { _all: true },
  })
  const top = actors.filter((a) => (a.userId ?? '').startsWith('automation:'))
    .sort((a, b) => b._count._all - a._count._all).slice(0, 4)
  out.push(['  ↳ top automation actors / 24h', top.map((a) => `${a.userId}=${a._count._all}`).join(' · ') || 'none'])
  out.push(['  ↳ VERDICT actedAt', top.some((a) => a._count._all >= 96) ? '🔴 METRONOME — drop it' : '✅ safe to ship'])

  // ── dayparting: AdSchedule.updatedAt vs the lastApplied tally ──
  const scheds = await prisma.adSchedule.count({ where: { enabled: true } })
  const schedTouched = await prisma.adSchedule.count({ where: { enabled: true, updatedAt: { gte: since(20) } } })
  out.push(['adSchedule.updatedAt in 20min', `${schedTouched} of ${scheds} (${pct(schedTouched, scheds)})`])
  // The anti-metronome the design proposes: a version row is written only on a MEANINGFUL change.
  const versions = await prisma.rankScheduleVersion.count({ where: { createdAt: { gte: since(24 * 60) } } })
  out.push(['  ↳ rankScheduleVersion rows / 24h', String(versions)])

  // ── keyword-harvest: AdTarget.updatedAt (the ~2h v1-sync re-stamp) vs the feed ──
  const positives = await prisma.adTarget.count({ where: { isNegative: false } })
  const posTouched = await prisma.adTarget.count({ where: { isNegative: false, updatedAt: { gte: since(3 * 60) } } })
  out.push(['adTarget.updatedAt in 3h', `${posTouched} of ${positives} (${pct(posTouched, positives)})`])
  const feed = await prisma.amazonAdsSearchTerm.aggregate({ _max: { date: true, createdAt: true }, _count: { _all: true } })
  out.push(['  ↳ searchTerm max(date) / max(createdAt)', `${feed._max.date?.toISOString().slice(0, 10)} / ${feed._max.createdAt?.toISOString()}`])

  // ── negatives: the schema says updatedAt is an ingest stamp; retiredAt is ours ──
  const negs = await prisma.adTarget.groupBy({ by: ['status'], where: { isNegative: true }, _count: { _all: true } })
  out.push(['negatives by status', negs.map((n) => `${n.status}=${n._count._all}`).join(' · ')])
  const negRetired = await prisma.adTarget.aggregate({ where: { isNegative: true }, _max: { retiredAt: true, updatedAt: true } })
  out.push(['  ↳ max(retiredAt) / max(updatedAt)', `${negRetired._max.retiredAt?.toISOString() ?? 'null'} / ${negRetired._max.updatedAt?.toISOString() ?? 'null'}`])

  // ── budget-schedules: does the table hold anything at all? ──
  const bs = await prisma.budgetSchedule.count()
  out.push(['budgetSchedule rows', `${bs}${bs === 0 ? '  ← ship NO cursor' : ''}`])

  const w = Math.max(...out.map(([k]) => k.length))
  console.log('\n=== RT.2 cursor probe · ' + new Date().toISOString() + ' ===')
  for (const [k, v] of out) console.log(k.padEnd(w) + '  ' + v)
  console.log()
}

await main()
await prisma.$disconnect()
