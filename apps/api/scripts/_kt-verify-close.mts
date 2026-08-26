/**
 * _kt-verify-close.mts — verify KT.7's close-out, and size the SQP cadence-for-coverage trade.
 *
 *   A. KT.7 close-out: the two tables, the suppression write-back, the guardrails.
 *   B. The write loop's own record: KT.7's four writes and their reversals, at Amazon.
 *   C. The cadence hypothesis: is SQP weekly data fetched nightly, and what would a cadence
 *      change buy in ASIN coverage?
 *   D. Report-request volume per day — who else is using the 61 of 65?
 *
 * NO WRITES. Run from apps/api:
 *   NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt-verify-close.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 62 - s.length))}`) }
const d10 = (d: Date) => new Date(d).toISOString().slice(0, 10)

async function main() {
  // ── A · close-out ────────────────────────────────────────────────────────
  h('A · KT.7 close-out')
  for (const m of ['adSpendCeiling', 'keywordBidProposal', 'sqpReportRequest'] as const) {
    try {
      const n = await (prisma as unknown as Record<string, { count: () => Promise<number> }>)[m].count()
      line(`  ${m}: ${n} rows`)
    } catch (e) { line(`  ${m}: ${(e as Error).message.slice(0, 60)}`) }
  }
  const rt = await prisma.rankTarget.findMany()
  line(`  RankTarget.maxBiasPct NULL on ${rt.filter((t) => (t as unknown as Record<string, unknown>).maxBiasPct == null).length} of ${rt.length}`)
  line(`  liveBidWritesEnabled: ${await prisma.campaign.count({ where: { liveBidWritesEnabled: true } as never })} of ${await prisma.campaign.count()}`)
  line(`  minBidCents set: ${await prisma.campaign.count({ where: { minBidCents: { not: null } } as never })}`)
  const low = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, bidCents: { lte: 3 } } })
  const flagged = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, bidCents: { lte: 3 }, suppressedFromBidCents: { not: null } } })
  line(`  targets at <=3c: ${low} · of which flagged: ${flagged} · still silent: ${low - flagged}`)

  // ── B · the write loop's record ──────────────────────────────────────────
  h('B · Operator writes today, and their reversals')
  const since = new Date(Date.now() - 36 * 3600e3)
  const logs = await prisma.advertisingActionLog.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' }, take: 400,
  })
  const rows = logs.map((l) => l as unknown as Record<string, unknown>)
  const operator = rows.filter((r) => !String(r.actor ?? r.userId ?? '').startsWith('automation:'))
  const automation = rows.filter((r) => String(r.actor ?? r.userId ?? '').startsWith('automation:'))
  line(`last 36h: ${rows.length} action-log rows · operator ${operator.length} · automation ${automation.length}`)
  for (const r of operator.slice(0, 12)) {
    line(`  ${r.createdAt instanceof Date ? r.createdAt.toISOString() : ''} ${String(r.actionType)} ${String(r.entityType ?? '')} actor=${String(r.actor ?? r.userId ?? '—')}`)
  }
  const actors = new Map<string, number>()
  for (const r of rows) { const a = String(r.actor ?? r.userId ?? '—'); actors.set(a, (actors.get(a) ?? 0) + 1) }
  line(`distinct actors in 36h: ${[...actors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([a, n]) => `${a}=${n}`).join(' · ')}`)

  // ── C · the cadence hypothesis ───────────────────────────────────────────
  h('C · Is SQP weekly data fetched nightly?')
  const sqp = await prisma.searchQueryPerformance.findMany({
    select: { marketplace: true, startDate: true, searchQuery: true, asin: true, ingestedAt: true, updatedAt: true },
  })
  const weeks = [...new Set(sqp.map((r) => +r.startDate))].sort((a, b) => b - a)
  line(`stored weeks: ${weeks.length} · newest ${d10(new Date(weeks[0]))} (${Math.round((Date.now() - weeks[0]) / 864e5)}d old)`)
  line()
  line('week        rows  distinct ingest DAYS  first ingest   last ingest   (a week re-fetched N days)')
  for (const w of weeks.slice(0, 6)) {
    const rs = sqp.filter((r) => +r.startDate === w)
    const days = new Set(rs.map((r) => d10(r.ingestedAt))).size
    const ts = rs.map((r) => +r.ingestedAt).sort((a, b) => a - b)
    line(`${d10(new Date(w))} ${String(rs.length).padStart(6)}  ${String(days).padStart(19)}  ${d10(new Date(ts[0]))}    ${d10(new Date(ts[ts.length - 1]))}`)
  }
  // how many rows were ever UPDATED after first insert? (updatedAt > ingestedAt means a re-fetch changed something)
  const changed = sqp.filter((r) => +r.updatedAt - +r.ingestedAt > 1000).length
  line(`rows whose updatedAt is later than ingestedAt (a re-fetch changed them): ${changed} of ${sqp.length}`)
  line('  → if this is ~0, re-fetching the same week produces nothing and the nightly cadence is waste')

  // ── D · who is using the report capacity? ────────────────────────────────
  h('D · Report volume per day, by job')
  const since14 = new Date(Date.now() - 14 * 864e5)
  const runs = await prisma.cronRun.groupBy({
    by: ['jobName'], _count: { _all: true },
    where: { startedAt: { gte: since14 } },
  })
  const reportish = runs.filter((r) => /report|ingest|sqp|kiosk|metrics|brand|tos|export/i.test(r.jobName))
  line('cron runs in the last 14 days for report-shaped jobs (runs, not reports):')
  for (const r of reportish.sort((a, b) => b._count._all - a._count._all).slice(0, 14)) {
    line(`  ${r.jobName.padEnd(34)} ${String(r._count._all).padStart(5)} runs · ${(r._count._all / 14).toFixed(1)}/day`)
  }
  const sqpRuns = await prisma.cronRun.findMany({ where: { jobName: 'sqp-ingest' }, orderBy: { startedAt: 'desc' }, take: 6 })
  line()
  for (const r of sqpRuns) {
    const dur = r.finishedAt ? Math.round((+r.finishedAt - +r.startedAt) / 1000) : null
    line(`  sqp-ingest ${new Date(r.startedAt).toISOString()} ${r.status} ${dur != null ? `${dur}s` : '—'} ${r.outputSummary ?? ''}${r.errorMessage ? ` [${r.errorMessage}]` : ''}`)
  }

  line(); line('done — nothing was written.')
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
