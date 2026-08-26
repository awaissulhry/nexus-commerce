/**
 * _kt-verify-kt7.mts — verify KT.6's close-out and its most important new finding (read-only).
 *
 *   A. The suppression hazard: how many targets bid at suppression level, and how many carry the
 *      flag? KT.6 reported 561 at <=3c with only 420 flagged — 141 silently suppressed.
 *   B. Close-out: the two new tables at 0 rows, maxBiasPct still null, write gate still 82.
 *   C. The DAILY_CAP_EXCEEDED NULL-exclusion bug and where the 693,704 actually lives.
 *   D. What the change log and undo surfaces already hold, so KT.7 reuses rather than rebuilds.
 *
 * NO WRITES. Run from apps/api:
 *   NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt-verify-kt7.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 62 - s.length))}`) }

async function main() {
  // ── A · the suppression hazard ───────────────────────────────────────────
  h('A · Suppressed targets — flagged vs silent')
  const all = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false } })
  const low = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, bidCents: { lte: 3 } } })
  const flagged = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, suppressedFromBidCents: { not: null } } })
  const lowFlagged = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, bidCents: { lte: 3 }, suppressedFromBidCents: { not: null } } })
  const lowUnflagged = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, bidCents: { lte: 3 }, suppressedFromBidCents: null } })
  const flaggedNotLow = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, bidCents: { gt: 3 }, suppressedFromBidCents: { not: null } } })
  line(`positive KEYWORD targets: ${all}`)
  line(`  bidCents <= 3 (suppression level): ${low}`)
  line(`  suppressedFromBidCents set (flagged): ${flagged}`)
  line(`  <=3c AND flagged:   ${lowFlagged}`)
  line(`  <=3c AND NOT flagged: ${lowUnflagged}   ← a raise here silently switches delivery back on`)
  line(`  flagged but bid > 3c: ${flaggedNotLow}  ← flag set, bid already restored?`)
  const byBid = await prisma.adTarget.groupBy({
    by: ['bidCents'], _count: { _all: true },
    where: { kind: 'KEYWORD', isNegative: false, bidCents: { lte: 5 } },
    orderBy: { bidCents: 'asc' },
  })
  line(`  bid distribution at/below 5c: ${byBid.map((r) => `${r.bidCents}c→${r._count._all}`).join(' · ')}`)

  // ── B · close-out ────────────────────────────────────────────────────────
  h('B · KT.6 close-out — is anything armed?')
  for (const model of ['adSpendCeiling', 'keywordBidProposal'] as const) {
    try {
      const n = await (prisma as unknown as Record<string, { count: () => Promise<number> }>)[model].count()
      line(`  ${model}: ${n} rows`)
    } catch (e) { line(`  ${model}: MODEL MISSING (${(e as Error).message.slice(0, 60)})`) }
  }
  const rt = await prisma.rankTarget.findMany()
  line(`  RankTarget.maxBiasPct NULL on ${rt.filter((t) => (t as unknown as Record<string, unknown>).maxBiasPct == null).length} of ${rt.length}`)
  const writable = await prisma.campaign.count({ where: { liveBidWritesEnabled: true } as never })
  line(`  liveBidWritesEnabled: ${writable} of ${await prisma.campaign.count()}`)
  try {
    const q = await (prisma as unknown as { outboundSyncQueue: { count: (a?: unknown) => Promise<number> } }).outboundSyncQueue.count()
    line(`  OutboundSyncQueue: ${q} rows`)
  } catch (e) { line(`  OutboundSyncQueue: ${(e as Error).message.slice(0, 50)}`) }

  // ── C · the NULL-exclusion bug and where 693,704 lives ───────────────────
  h('C · DAILY_CAP_EXCEEDED — the NULL-exclusion bug, and the real table')
  const since = new Date(Date.now() - 60 * 864e5)
  const execTotal = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: since } } })
  const execCap = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: since }, errorMessage: 'DAILY_CAP_EXCEEDED' } })
  const execNotCapWrong = await prisma.automationRuleExecution.count({ where: { startedAt: { gte: since }, NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' } } })
  const execNotCapRight = await prisma.automationRuleExecution.count({
    where: { startedAt: { gte: since }, OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }] },
  })
  line(`AutomationRuleExecution, last 60d: ${execTotal}`)
  line(`  errorMessage = 'DAILY_CAP_EXCEEDED': ${execCap}`)
  line(`  NOT: { errorMessage: 'X' }              → ${execNotCapWrong}   ← EXCLUDES NULL rows (the bug)`)
  line(`  OR: [null, { not: 'X' }]                → ${execNotCapRight}   ← the correct complement`)
  line(`  the gap between them (rows with a NULL errorMessage): ${execNotCapRight - execNotCapWrong}`)

  // ── D · what the change/undo surfaces already hold ───────────────────────
  h('D · The change log and undo surfaces that already exist')
  const logTotal = await prisma.advertisingActionLog.count()
  const log60 = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: since } } })
  line(`AdvertisingActionLog: ${logTotal} rows total · ${log60} in the last 60d`)
  const byType = await prisma.advertisingActionLog.groupBy({
    by: ['actionType'], _count: { _all: true }, where: { createdAt: { gte: since } },
  }).catch(() => null)
  if (byType) line(`  by actionType (60d): ${byType.sort((a, b) => b._count._all - a._count._all).slice(0, 10).map((r) => `${r.actionType}=${r._count._all}`).join(' · ')}`)
  const recent = await prisma.advertisingActionLog.findMany({ orderBy: { createdAt: 'desc' }, take: 3 })
  for (const r of recent) {
    const o = r as unknown as Record<string, unknown>
    line(`  latest: ${String(o.actionType)} ${String(o.entityType ?? '')} ${o.createdAt instanceof Date ? o.createdAt.toISOString() : ''} actor=${String(o.actor ?? o.userId ?? '—')}`)
  }
  line()
  line('routes that already exist (from grep — do not rebuild):')
  line('  GET  /advertising/changes                          advertising.routes.ts:7359')
  line('  GET  /advertising/changes.csv                      :7385')
  line('  GET  /advertising/changes/:actionLogId/undo-preview :7430')
  line('  POST /advertising/changes/:actionLogId/undo         :7437   ← per-CHANGE window (rollbackWindowMsFor)')
  line('  POST /advertising/actions/:executionId/rollback              ← per-EXECUTION, flat 24h')

  line(); line('done — nothing was written.')
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
