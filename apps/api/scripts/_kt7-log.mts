/**
 * _kt7-log.mts — KT.7 §6.3: does the scoped change log show the write, ATTRIBUTED? And the
 * "anything big" thresholds, measured rather than guessed. READ-ONLY.
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { loadRow, committedToday } from '../src/services/advertising/kt6-proposal.service.js'
import { listChanges } from '../src/services/advertising/ads-changes.service.js'
import { previewRollbackOfAction } from '../src/services/advertising/rollback.service.js'
const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 72 - s.length))}`) }
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const eur = (c: number | null) => (c == null ? '—' : `€${(c / 100).toFixed(2)}`)

async function main() {
  h('§6.3 · the scoped change log for the term that was written')
  const row = await loadRow('motorradjacke herren sommer', 'DE')
  const ids = row.targets.map((t) => t.id)
  line(`targets in scope: ${ids.length}`)
  const res = await listChanges({ entityIds: ids, entityType: 'AD_TARGET', from: new Date(Date.now() - 3 * 86_400_000), limit: 40 })
  line(`changes in 3 days: ${res.items.length}`)
  line(`${padr('when', 18)} ${padr('actor', 34)} ${padr('source', 10)} ${padr('field', 10)} ${pad('old', 7)} ${pad('new', 7)} undo`)
  const logRows = await prisma.advertisingActionLog.findMany({
    where: { entityType: 'AD_TARGET', entityId: { in: ids }, createdAt: { gte: new Date(Date.now() - 3 * 86_400_000) } },
    select: { id: true, entityId: true, createdAt: true },
  })
  const handleFor = new Map(logRows.map((l) => [`${l.entityId}|${Math.floor(l.createdAt.getTime() / 1000)}`, l.id]))
  for (const it of res.items.slice(0, 14)) {
    const hid = handleFor.get(`${it.entity.id}|${Math.floor(new Date(it.at).getTime() / 1000)}`) ?? it.undoActionLogId
    const u = hid ? await previewRollbackOfAction(hid).catch(() => null) : null
    line(`${padr(new Date(it.at).toISOString().slice(5, 19), 18)} ${padr((it.actor ?? '—').slice(0, 33), 34)} ${padr(it.source, 10)} ${padr(it.field, 10)} ${pad(it.oldValue ?? '—', 7)} ${pad(it.newValue ?? '—', 7)} ${u?.eligible ? `yes (set of ${u.groupedWith})` : (u?.reason ?? '—').slice(0, 34)}`)
  }
  const mine = res.items.filter((i) => i.source === 'operator' || (i.actor ?? '').startsWith('user:'))
  const engine = res.items.filter((i) => (i.actor ?? '').startsWith('automation:'))
  line()
  line(`⇒ operator rows ${mine.length} · engine rows ${engine.length} — ${mine.length > 0 && engine.length > 0 ? '✓ both present and distinguishable side by side' : mine.length > 0 ? 'operator rows only in this window' : 'engine rows only'}`)

  h('§4.3 · the ledger, now reversal-aware')
  for (const m of ['DE', 'IT']) {
    const c = await committedToday(m)
    line(`${m}: committed ${eur(c.committedCents)} · raw APPLIED sum ${eur(c.committedBeforeReversalsCents)} · pending ${eur(c.pendingCents)} (${c.pendingCount}) · amazon ${eur(c.amazonSpendCents)} for ${c.amazonSpendDate}`)
    if (c.committedCents !== c.committedBeforeReversalsCents) line(`   ⇒ 🔴 they differ by ${eur(c.committedBeforeReversalsCents - c.committedCents)} — that is a commitment that was undone, and the ceiling no longer counts it`)
  }

  h('§4.3 · "anything big" — thresholds, with the measurement behind each')
  const since = new Date(Date.now() - 30 * 86_400_000)
  const logs = await prisma.advertisingActionLog.findMany({
    where: { createdAt: { gte: since }, actionType: 'AD_BID_UPDATE', entityType: 'AD_TARGET' },
    select: { payloadBefore: true, payloadAfter: true, executionId: true, createdAt: true, userId: true },
    take: 30000,
  })
  const bid = (p: unknown) => { const o = p as Record<string, unknown> | null; const v = o?.bidCents; return typeof v === 'number' ? v : null }
  const deltas: number[] = []
  const pcts: number[] = []
  for (const l of logs) {
    const b = bid(l.payloadBefore), a = bid(l.payloadAfter)
    if (b == null || a == null || b === 0) continue
    deltas.push(Math.abs(a - b))
    pcts.push(Math.abs((a - b) / b) * 100)
  }
  const pctl = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] }
  line(`AD_BID_UPDATE on AD_TARGET in 30d: ${logs.length} · with both bids readable: ${deltas.length}`)
  line(`absolute bid change: p50 ${eur(pctl(deltas, 50))} · p90 ${eur(pctl(deltas, 90))} · p99 ${eur(pctl(deltas, 99))} · max ${eur(Math.max(...deltas))}`)
  line(`percentage change:   p50 ${pctl(pcts, 50).toFixed(0)}% · p90 ${pctl(pcts, 90).toFixed(0)}% · p99 ${pctl(pcts, 99).toFixed(0)}%`)
  // change-set sizes: how many targets one operation touches
  const sets = new Map<string, number>()
  for (const l of logs) if (l.executionId) sets.set(l.executionId, (sets.get(l.executionId) ?? 0) + 1)
  const sizes = [...sets.values()]
  line(`change sets in 30d: ${sets.size} · targets per set: p50 ${pctl(sizes, 50)} · p90 ${pctl(sizes, 90)} · max ${sizes.length ? Math.max(...sizes) : 0}`)
  const spend = await prisma.amazonAdsDailyPerformance.findFirst({ where: { entityType: 'CAMPAIGN' }, orderBy: { date: 'desc' }, select: { date: true } })
  let dayCents = 0
  if (spend) {
    const agg = await prisma.amazonAdsDailyPerformance.aggregate({ where: { entityType: 'CAMPAIGN', date: spend.date }, _sum: { costMicros: true } })
    dayCents = Math.round(Number(agg._sum.costMicros ?? 0n) / 10000)
  }
  line(`most recent published daily spend, all markets: ${eur(dayCents)} for ${spend?.date.toISOString().slice(0, 10)}`)
  line()
  line('PROPOSED thresholds — each anchored, and each meant to be OVERRIDDEN by the operator:')
  line(`  targets touched   ≥ ${Math.max(10, pctl(sizes, 90) || 10)}   (p90 of a real change set is ${pctl(sizes, 90)})`)
  line(`  euros committed   ≥ ${eur(Math.max(1000, Math.round(dayCents * 0.10)))}   (10% of the last published day's ${eur(dayCents)})`)
  // 🔴 percentage is the WRONG AXIS on this account, and the measurement says so loudly.
  const operatorLogs = logs.filter((l) => (l.userId ?? '').startsWith('user:'))
  const opPcts: number[] = []
  for (const l of operatorLogs) { const b = bid(l.payloadBefore), a = bid(l.payloadAfter); if (b && a) opPcts.push(Math.abs((a - b) / b) * 100) }
  line(`  bid change        🔴 NOT PROPOSED as a percentage. p90 across all writes is ${pctl(pcts, 90).toFixed(0)}%`)
  line(`                       and p99 is ${pctl(pcts, 99).toFixed(0)}%, because the suppress/restore cycle turns 2c into 42c`)
  line(`                       (+2000%) thousands of times a month. A threshold there would fire on`)
  line(`                       every restore and never on a real operator change. Operator-made writes`)
  line(`                       in 30d: ${operatorLogs.length}${opPcts.length ? ` (p90 ${pctl(opPcts, 90).toFixed(0)}%)` : ' — too few to anchor anything'}.`)
  line(`                       Use the ABSOLUTE change instead: p99 is ${eur(pctl(deltas, 99))}, so ≥ ${eur(Math.max(100, pctl(deltas, 99)))} is the honest anchor.`)
  line(`  campaigns reached ≥ 5`)
  line('🔴 A threshold nobody chose is a threshold nobody trusts, so these ship as DEFAULTS with the')
  line('   measurement printed beside each one, not as constants.')
  line(`   For scale: "giacca moto" at €0.55 commits €21.45 across 39 targets in 14 campaigns — which`)
  line(`   trips the target count and the campaign count, and not the euro figure.`)
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(String(e).slice(0, 400)); await prisma.$disconnect(); process.exit(1) })
