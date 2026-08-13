/**
 * _kt7-suppression-shift.mts — 🔴 KT.7 stop condition: the 2¢/141 picture moved. What happened?
 * READ-ONLY. The brief measured 558 at 2¢ with 420 flagged; I measure 141 at 2¢ with 0 flagged.
 * Either ~417 suppressions were LIFTED, or the flag column was cleared, and those are very
 * different facts for an apply path that must not destroy the only copy of an original bid.
 */
import '../src/env.js'
import prisma from '../src/db.js'
const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 72 - s.length))}`) }
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const eur = (c: number | null) => (c == null ? 'null' : `€${(c / 100).toFixed(2)}`)

async function main() {
  h('1 · the flag, counted by the DATABASE not by JS (null vs zero discipline)')
  const notNull = await prisma.adTarget.count({ where: { isNegative: false, kind: 'KEYWORD', suppressedFromBidCents: { not: null } } })
  const isNull = await prisma.adTarget.count({ where: { isNegative: false, kind: 'KEYWORD', suppressedFromBidCents: null } })
  const all = await prisma.adTarget.count({ where: { isNegative: false, kind: 'KEYWORD' } })
  line(`suppressedFromBidCents NOT NULL: ${notNull} · IS NULL: ${isNull} · sum ${notNull + isNull} vs ${all} ${notNull + isNull === all ? '✓ accounts for every row' : '🔴 does not add up'}`)
  const baseNotNull = await prisma.adTarget.count({ where: { isNegative: false, kind: 'KEYWORD', baseBidFromCents: { not: null } } })
  line(`baseBidFromCents NOT NULL: ${baseNotNull}`)
  // negatives too — the flag might live on rows my filter excluded
  const anyKind = await prisma.adTarget.count({ where: { suppressedFromBidCents: { not: null } } })
  line(`suppressedFromBidCents NOT NULL across ALL AdTarget (any kind, incl. negatives): ${anyKind}`)

  h('2 · did ~417 bids go UP, or was only the flag cleared?')
  const dist = await prisma.adTarget.groupBy({
    by: ['bidCents'], where: { isNegative: false, kind: 'KEYWORD' }, _count: { _all: true },
    orderBy: { bidCents: 'asc' }, take: 14,
  })
  line(`lowest 14 distinct bids: ${dist.map((d) => `${d.bidCents}c→${d._count._all}`).join(' · ')}`)
  const under6 = await prisma.adTarget.count({ where: { isNegative: false, kind: 'KEYWORD', bidCents: { lte: 5 } } })
  line(`targets at ≤5¢ now: ${under6} (the brief measured 558+50 = 608)`)

  h('3 · what touched them — the action log, last 48h')
  const since = new Date(Date.now() - 48 * 3600_000)
  const rows = await prisma.advertisingActionLog.findMany({
    where: { createdAt: { gte: since }, entityType: 'AD_TARGET' },
    select: { actionType: true, userId: true, createdAt: true, entityId: true, payloadBefore: true, payloadAfter: true },
    orderBy: { createdAt: 'desc' }, take: 4000,
  })
  line(`AD_TARGET action-log rows in 48h: ${rows.length}`)
  const byActor = new Map<string, number>()
  for (const r of rows) byActor.set(r.userId ?? 'null', (byActor.get(r.userId ?? 'null') ?? 0) + 1)
  line(`by actor (top 8):`)
  for (const [a, n] of [...byActor].sort((x, y) => y[1] - x[1]).slice(0, 8)) line(`   ${pad(n, 6)}  ${a.slice(0, 70)}`)

  // Did anything RAISE a bid from 2c?
  const from2 = rows.filter((r) => {
    const b = r.payloadBefore as Record<string, unknown> | null
    const v = b && (b.bidCents ?? b.bid ?? (b as { before?: number }).before)
    return Number(v) === 2
  })
  line()
  line(`rows whose payloadBefore shows a bid of 2¢: ${from2.length}`)
  for (const r of from2.slice(0, 6)) {
    line(`   ${r.createdAt.toISOString().slice(5, 19)} ${padr(r.actionType, 18)} ${padr((r.userId ?? 'null').slice(0, 40), 42)} before=${JSON.stringify(r.payloadBefore).slice(0, 60)} after=${JSON.stringify(r.payloadAfter).slice(0, 60)}`)
  }

  h('4 · is a restore/suppression engine running?')
  const jobs = await prisma.cronRun.findMany({
    where: { startedAt: { gte: since }, OR: [{ jobName: { contains: 'suppress' } }, { jobName: { contains: 'restore' } }, { jobName: { contains: 'budget' } }, { jobName: { contains: 'retail' } }, { jobName: { contains: 'rank' } }] },
    select: { jobName: true, startedAt: true, status: true, outputSummary: true },
    orderBy: { startedAt: 'desc' }, take: 12,
  })
  for (const j of jobs) line(`   ${j.startedAt.toISOString().slice(5, 19)} ${padr(j.jobName, 26)} ${padr(j.status, 8)} ${(j.outputSummary ?? '').slice(0, 70)}`)

  h('5 · 🔴 the consequence for KT.7')
  line(`Targets at 2¢ with NO record of the bid they came from: ${await prisma.adTarget.count({ where: { isNegative: false, kind: 'KEYWORD', bidCents: 2, suppressedFromBidCents: null } })}`)
  line(`Targets at 2¢ WITH such a record: ${await prisma.adTarget.count({ where: { isNegative: false, kind: 'KEYWORD', bidCents: 2, suppressedFromBidCents: { not: null } } })}`)
  line()
  line('If the second number is 0, then EVERY 2¢ target is unrecoverable-if-raised, not just 141 of 558.')
  line('That strengthens rather than weakens the case for refusing the raise: there is no longer any')
  line('subset for which a raise is safe, so "record the pre-bid first" becomes the ONLY option that')
  line('does not lose data — or the refusal has to be unconditional.')
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
