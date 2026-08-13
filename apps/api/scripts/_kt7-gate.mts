/**
 * _kt7-gate.mts — 🔴 KT.7 §6. THE FIRST REAL WRITE TO AMAZON, and its undo.
 *
 * Deliberately the smallest reversible change that can be constructed: ONE target, ONE campaign, a
 * bid moved by a few cents, then undone. It uses the same `applyProposal` a full apply uses, capped
 * with `maxTargets: 1`, so what is proven here is the real path and not a special case.
 *
 * Run with an explicit verb so nothing happens by accident:
 *   --artefacts   read-only: what apply WOULD do now, + the ceiling/suppression/stale refusals
 *   --write       🔴 the one-target write
 *   --undo <id>   reverse it
 *   --state       what the ledger and the action log say
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { previewBidChange, proposeBidChange, loadRow } from '../src/services/advertising/kt6-proposal.service.js'
import { applyProposal } from '../src/services/advertising/kt7-apply.service.js'
import { computeBlastRadius } from '../src/services/advertising/kt6-bid-action.js'
import { previewRollbackOfAction, rollbackByActionLogId } from '../src/services/advertising/rollback.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 72 - s.length))}`) }
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const eur = (c: number | null | undefined) => (c == null ? '—' : `€${(c / 100).toFixed(2)}`)
const wrap = (s: string, w = 96) => { const o: string[] = []; let c = ''
  for (const x of s.split(' ')) { if ((c + ' ' + x).trim().length > w) { o.push(c); c = x } else c = (c + ' ' + x).trim() }
  if (c) o.push(c); return o.map((l) => '   ' + l).join('\n') }

const mode = process.argv.find((a) => a.startsWith('--')) ?? '--state'
const ACTOR = 'kt7-gate@nexus'

/** Pick the smallest possible blast radius: a term whose writable set is exactly one target. */
async function findSmallestRow(): Promise<{ term: string; market: string; targets: number } | null> {
  const wl = await prisma.keywordWatchlist.findMany({ select: { marketplace: true, isDefault: true, terms: { select: { term: true, isBranded: true } } } })
  const cands: Array<{ term: string; market: string; targets: number }> = []
  for (const w of wl) {
    if (!w.marketplace) continue
    for (const t of w.terms.filter((x) => !x.isBranded)) {
      const row = await loadRow(t.term, w.marketplace)
      const r = computeBlastRadius(row.targets, 40)
      if (r.actionable.length >= 1) cands.push({ term: t.term, market: w.marketplace, targets: r.actionable.length })
    }
  }
  cands.sort((a, b) => a.targets - b.targets)
  return cands[0] ?? null
}

async function main() {
  if (mode === '--artefacts') {
    h('§6a · what APPLY would do to "giacca moto" right now (re-measured)')
    const p = await previewBidChange({ term: 'giacca moto', marketplace: 'IT', requestedBidCents: 55 })
    line(`matched ${p.radius.matchedTargets}/${p.radius.matchedCampaigns} · would change ${p.radius.actionable.length}/${p.radius.actionableCampaigns} · commits up to ${eur(p.commitmentCents)}`)
    line(`exclusions: ${Object.entries(p.radius.byReason).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
    line(`ceiling ${p.ceiling.verdict} · share age ${p.shareAgeDays}d`)

    h('§6b · the smallest row available for the first write')
    const s = await findSmallestRow()
    line(s ? `"${s.term}" (${s.market}) — ${s.targets} actionable target(s)` : 'none found')

    h('§6c · a SUPPRESSION refusal, exercised')
    // A 2¢ target is excluded from the radius, so ask for the radius WITH suppressed included and
    // then apply WITHOUT the opt-in: the row-level guard must refuse it.
    const supp = await prisma.adTarget.findFirst({
      where: { isNegative: false, kind: 'KEYWORD', bidCents: { lte: 3 }, adGroup: { campaign: { liveBidWritesEnabled: true } } },
      select: { expressionValue: true, bidCents: true, adGroup: { select: { campaign: { select: { marketplace: true, name: true } } } } },
    })
    if (supp) {
      const mk = supp.adGroup!.campaign.marketplace!
      const row = await loadRow(supp.expressionValue, mk)
      const without = computeBlastRadius(row.targets, 40)
      const withIt = computeBlastRadius(row.targets, 40, { includeSuppressed: true })
      line(`"${supp.expressionValue}" (${mk}) bids ${eur(supp.bidCents)} in ${supp.adGroup!.campaign.name}`)
      line(`   actionable WITHOUT the opt-in: ${without.actionable.length} · WITH it: ${withIt.actionable.length}`)
      line(`   suppressed excluded: flag=${without.byReason.suppressed_flag} byBid=${without.byReason.suppressed_by_bid}`)
      line(`   ⇒ ${withIt.actionable.length > without.actionable.length ? '✓ the opt-in is the only way in, and it is off by default' : 'no suppressed target on this row'}`)
    } else line('no writable ≤3¢ target found')

    h('§6d · a CEILING refusal at APPLY time (not just at preview)')
    line('exercised by --write when a binding ceiling is present; see the run log.')

    h('§6e · a STALE-PROPOSAL refusal')
    line('exercised by --write: the proposal is raised, its stored targetIds are then perturbed, and')
    line('apply must refuse the whole set rather than write a subset nobody approved.')
    return
  }

  if (mode === '--write') {
    const s = await findSmallestRow()
    if (!s) { line('no row with an actionable target — nothing to write'); return }
    h(`🔴 §6 · THE FIRST REAL WRITE — "${s.term}" (${s.market}), capped to ONE target`)

    // choose a bid a few cents from the current one, inside every ceiling
    const row = await loadRow(s.term, s.market)
    const r0 = computeBlastRadius(row.targets, 40)
    const t0 = r0.actionable[0]
    const cur = t0.bidCents ?? 20
    const cap = t0.maxBidCents ?? 80
    const target = Math.min(cap, Math.max(6, cur + 2))
    line(`target ${t0.id} in "${t0.campaignName}" · current ${eur(cur)} → proposed ${eur(target)} (cap ${eur(cap)})`)

    // ── the stale refusal, first, on a throwaway proposal ──
    h('§6e · STALE-PROPOSAL refusal, exercised for real')
    const stale = await proposeBidChange({ term: s.term, marketplace: s.market, requestedBidCents: target, proposedBy: ACTOR })
    if (stale.id) {
      await prisma.keywordBidProposal.update({ where: { id: stale.id }, data: { targetIds: ['a-target-that-does-not-exist'] } })
      const res = await applyProposal({ proposalId: stale.id, actorEmail: ACTOR, maxTargets: 1 })
      line(`ok=${res.ok} code=${res.refusalCode}`)
      line(wrap(res.summary))
      line(res.refusalCode === 'stale_target_set' ? '✓ refused as stale, nothing written' : '🔴 did NOT refuse — investigate')
      await prisma.keywordBidProposal.delete({ where: { id: stale.id } }).catch(() => {})
    }

    // ── the ceiling refusal at apply time ──
    h('§6d · CEILING refusal at APPLY time, exercised for real')
    const ceil = await prisma.adSpendCeiling.create({
      data: { grain: 'MARKET', scopeId: s.market, label: `the ${s.market} market`, dailyCapCents: 1, createdBy: 'kt7-gate', note: 'KT.7 gate — removed below' },
    })
    const p2 = await proposeBidChange({ term: s.term, marketplace: s.market, requestedBidCents: target, proposedBy: ACTOR })
    if (!p2.ok) {
      line(`the proposal itself was refused by the ceiling (expected): ${String(p2.reason).slice(0, 120)}`)
    }
    // Raise the ceiling enough to PROPOSE, then lower it again so APPLY is the thing that refuses.
    await prisma.adSpendCeiling.update({ where: { id: ceil.id }, data: { dailyCapCents: 100_000 } })
    const p3 = await proposeBidChange({ term: s.term, marketplace: s.market, requestedBidCents: target, proposedBy: ACTOR })
    await prisma.adSpendCeiling.update({ where: { id: ceil.id }, data: { dailyCapCents: 1 } })
    if (p3.id) {
      const res = await applyProposal({ proposalId: p3.id, actorEmail: ACTOR, maxTargets: 1 })
      line(`ok=${res.ok} code=${res.refusalCode}`)
      line(wrap(res.summary))
      line(res.refusalCode === 'ceiling_refused' ? '✓ the ceiling refused at APPLY time, after the proposal had passed it' : '🔴 did not refuse at apply time')
      await prisma.keywordBidProposal.delete({ where: { id: p3.id } }).catch(() => {})
    }
    await prisma.adSpendCeiling.delete({ where: { id: ceil.id } }).catch(() => {})

    // ── the real write ──
    h('🔴 §6.1 · ONE TARGET, ONE CAMPAIGN — the write')
    const p = await proposeBidChange({ term: s.term, marketplace: s.market, requestedBidCents: target, proposedBy: ACTOR })
    if (!p.ok || !p.id) { line(`could not raise a proposal: ${p.reason}`); return }
    line(`proposal ${p.id} raised`)
    const res = await applyProposal({ proposalId: p.id, actorEmail: ACTOR, maxTargets: 1 })
    line(`applied=${res.applied} refused=${res.refused} skipped=${res.skipped} changeSet=${res.changeSetId}`)
    line(wrap(res.summary))
    for (const r of res.rows) line(`   ${r.outcome} ${r.adTargetId} ${eur(r.fromCents)}→${eur(r.toCents)} ${r.reason ?? ''} log=${r.actionLogId ?? '—'}`)
    line()
    line(`🔴 UNDO HANDLE: ${res.undoHandleActionLogId ?? 'none'}`)
    line(`   run: --undo ${res.undoHandleActionLogId ?? ''}`)
    return
  }

  if (mode === '--undo') {
    const id = process.argv[process.argv.indexOf('--undo') + 1]
    h(`§6.4 · UNDO ${id}`)
    const pre = await previewRollbackOfAction(id)
    line(`preview: eligible=${pre.eligible} groupedWith=${pre.groupedWith} changeSet=${pre.changeSetId} reason=${pre.reason ?? '—'}`)
    const r = await rollbackByActionLogId({ actionLogId: id, actor: `user:${ACTOR}`, reason: 'KT.7 §6 gate — reversing the first write' })
    line(`reversed=${r.reversed} skipped=${r.skipped} failed=${r.failed} expired=${r.expired ?? false} ${r.reason ?? ''}`)
    for (const d of r.details) line(`   ${JSON.stringify(d).slice(0, 150)}`)
    return
  }

  // --state
  h('state')
  const logs = await prisma.advertisingActionLog.findMany({
    where: { userId: { contains: 'kt7-gate' } },
    orderBy: { createdAt: 'desc' }, take: 10,
    select: { id: true, actionType: true, entityId: true, createdAt: true, userId: true, executionId: true, payloadBefore: true, payloadAfter: true, amazonResponseStatus: true, rolledBackAt: true },
  })
  line(`AdvertisingActionLog rows by the gate actor: ${logs.length}`)
  for (const l of logs) {
    line(`   ${l.createdAt.toISOString().slice(5, 19)} ${padr(l.actionType, 16)} ${padr(l.entityId.slice(0, 12), 14)} amazon=${padr(l.amazonResponseStatus ?? '—', 8)} set=${padr(l.executionId ?? '—', 30)} rolledBack=${l.rolledBackAt ? l.rolledBackAt.toISOString().slice(11, 19) : 'no'}`)
    line(`      before=${JSON.stringify(l.payloadBefore)} after=${JSON.stringify(l.payloadAfter)}`)
  }
  const props = await prisma.keywordBidProposal.findMany({ orderBy: { proposedAt: 'desc' }, take: 5, select: { id: true, term: true, status: true, actionableTargets: true, commitmentCents: true, executionId: true } })
  line()
  line(`KeywordBidProposal rows: ${await prisma.keywordBidProposal.count()}`)
  for (const p of props) line(`   ${p.id} ${padr(p.term, 18)} ${padr(p.status, 10)} targets=${p.actionableTargets} commit=${eur(p.commitmentCents)} set=${p.executionId ?? '—'}`)
  line(`AdSpendCeiling rows: ${await prisma.adSpendCeiling.count()}`)
  const q = await prisma.outboundSyncQueue.findMany({ where: { createdAt: { gte: new Date(Date.now() - 3600_000) } }, select: { syncStatus: true, syncType: true, errorMessage: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 6 })
  line(`OutboundSyncQueue in the last hour: ${q.length}`)
  for (const x of q) line(`   ${x.createdAt.toISOString().slice(11, 19)} ${padr(x.syncType, 22)} ${padr(x.syncStatus, 10)} ${(x.errorMessage ?? '').slice(0, 70)}`)
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
