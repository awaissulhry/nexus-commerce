/**
 * _kt7-stop.mts — KT.7 §7 stop conditions + §3 re-measurement. READ-ONLY, no Amazon call.
 * Every one of these gates whether the apply path is safe to build at all.
 */
import '../src/env.js'
import prisma from '../src/db.js'
const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 72 - s.length))}`) }
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)

async function main() {
  h('§7 · STOP CONDITIONS')
  const rt = await prisma.rankTarget.findMany({ select: { key: true, maxBiasPct: true } })
  const set = rt.filter((t) => t.maxBiasPct != null)
  line(`1 · RankTarget.maxBiasPct set on ${set.length} of ${rt.length} — ${set.length === 0 ? '✓ still NULL; the rank engine cannot chase' : `🔴 SET on ${set.map((t) => t.key).join(',')} — STOP`}`)
  line(`2 · NEXUS_COVERAGE_ENGINE_MODE = ${process.env.NEXUS_COVERAGE_ENGINE_MODE ?? 'unset ✓'}`)
  const total = await prisma.campaign.count()
  const writ = await prisma.campaign.count({ where: { liveBidWritesEnabled: true } })
  const minSet = await prisma.campaign.count({ where: { minBidCents: { not: null } } })
  const maxSet = await prisma.campaign.count({ where: { maxBidCents: { not: null } } })
  line(`3 · liveBidWritesEnabled ${writ} of ${total} — ${writ === 82 && total === 220 ? '✓ unchanged' : '🔴 CHANGED — STOP'}`)
  line(`    minBidCents set on ${minSet} — ${minSet === 0 ? '✓ still no floor' : '🔴 a floor now exists — STOP'} · maxBidCents on ${maxSet}`)
  const pins = await prisma.campaign.count({ where: { OR: [{ pinBids: true }, { pinBudget: true }, { pinPlacement: true }] } })
  line(`    authority pins on ${pins} — ${pins === 0 ? '✓ none' : '🔴 pins exist; they deny BEFORE bounds'}`)

  h('§3.1 · the 2¢ / 141 picture — re-measured')
  const t = await prisma.adTarget.findMany({
    where: { isNegative: false, kind: 'KEYWORD' },
    select: { id: true, bidCents: true, suppressedFromBidCents: true },
  })
  const buckets = new Map<number, number>()
  for (const x of t) if ((x.bidCents ?? 999) <= 5) buckets.set(x.bidCents!, (buckets.get(x.bidCents!) ?? 0) + 1)
  line(`positive KEYWORD targets: ${t.length}`)
  line(`bids ≤5¢: ${[...buckets].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}c → ${v}`).join(' · ')}`)
  const flagged = t.filter((x) => x.suppressedFromBidCents != null)
  const at2 = t.filter((x) => x.bidCents === 2)
  const at2Flagged = at2.filter((x) => x.suppressedFromBidCents != null)
  const at2Unflagged = at2.filter((x) => x.suppressedFromBidCents == null)
  const flaggedAbove3 = flagged.filter((x) => (x.bidCents ?? 0) > 3)
  line(`suppressedFromBidCents set (flagged): ${flagged.length}`)
  line(`at 2¢: ${at2.length} · of those flagged ${at2Flagged.length} · 🔴 NOT flagged ${at2Unflagged.length}`)
  line(`flagged but bid > 3¢: ${flaggedAbove3.length}`)
  line(at2Unflagged.length === 141 ? '✓ the 141 is unchanged — the suppression decision rests on it' : `🔴 CHANGED: ${at2Unflagged.length}, not 141 — re-derive before designing`)

  h('§7.5 · is AdvertisingActionLog where the mutation path actually writes?')
  const totalLog = await prisma.advertisingActionLog.count()
  const since = new Date(Date.now() - 60 * 86_400_000)
  const recent = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: since } } })
  line(`AdvertisingActionLog: ${totalLog} total · ${recent} in 60d`)
  const byType = await prisma.advertisingActionLog.groupBy({
    by: ['actionType'], where: { createdAt: { gte: since } }, _count: { _all: true },
    orderBy: { _count: { actionType: 'desc' } }, take: 8,
  })
  line(`${padr('actionType', 30)} ${pad('rows', 7)}`)
  for (const r of byType) line(`${padr(r.actionType, 30)} ${pad(r._count._all, 7)}`)
  const newest = await prisma.advertisingActionLog.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { actionType: true, createdAt: true, userId: true, entityType: true, entityId: true, executionId: true, amazonResponseStatus: true },
  })
  line()
  line(`newest row: ${newest?.createdAt.toISOString().slice(0, 19)} ${newest?.actionType} entity=${newest?.entityType} actor(userId)=${newest?.userId ?? 'null'} exec=${newest?.executionId ?? 'null'} amazon=${newest?.amazonResponseStatus ?? 'null'}`)
  const bidUpdates24h = await prisma.advertisingActionLog.count({
    where: { actionType: 'AD_BID_UPDATE', createdAt: { gte: new Date(Date.now() - 86_400_000) } },
  })
  line(`AD_BID_UPDATE in the last 24h: ${bidUpdates24h} (~${Math.round(recent / 60)}/day across all types)`)

  h('KT.6 close-out still holds?')
  line(`KeywordBidProposal rows: ${await prisma.keywordBidProposal.count()} · AdSpendCeiling rows: ${await prisma.adSpendCeiling.count()}`)
  line(`OutboundSyncQueue rows: ${await prisma.outboundSyncQueue.count()}`)

  h('control — a wrong field must THROW')
  try {
    await (prisma.advertisingActionLog as never as { findFirst: (a: unknown) => Promise<unknown> }).findFirst({ select: { actorString: true } })
    line('🔴 selected a non-existent column without error — the query layer is not live')
  } catch (e) { line(`✓ threw as expected: ${String(e).slice(0, 80).replace(/\n/g, ' ')}`) }
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
