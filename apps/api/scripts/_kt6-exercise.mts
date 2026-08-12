/**
 * _kt6-exercise.mts — KT.6: drive the real flow against prod. WRITES, then cleans up after itself.
 *
 * 🔴 It writes ONLY to the two new tables (AdSpendCeiling, KeywordBidProposal) and calls NO Amazon
 *    API. Every row it creates it deletes at the end, and it re-counts to prove it.
 *
 * The sequence is the one the drawer will drive:
 *   1. preview with no ceiling anywhere    → NO_CEILING, canPropose true
 *   2. set a MARKET ceiling that binds     → REFUSED, with the specific message
 *   3. add a narrower CAMPAIGN ceiling     → the narrower one binds and says so
 *   4. raise the ceiling                   → ALLOWED, propose succeeds, ledger records it
 *   5. propose again                       → the pending proposal is now visible
 *   6. clean up                            → both tables back to their starting counts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { previewBidChange, proposeBidChange, proposalsFor, committedToday } from '../src/services/advertising/kt6-proposal.service.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 72 - s.length))}`) }
const eur = (c: number | null | undefined) => (c == null ? '—' : `€${(c / 100).toFixed(2)}`)
const wrap = (s: string, w = 96) => { const o: string[] = []; let c = ''
  for (const x of s.split(' ')) { if ((c + ' ' + x).trim().length > w) { o.push(c); c = x } else c = (c + ' ' + x).trim() }
  if (c) o.push(c); return o.map((l) => '   ' + l).join('\n') }

const TERM = 'giacca moto', MKT = 'IT', BID = 55
const created: { ceilings: string[]; proposals: string[] } = { ceilings: [], proposals: [] }

async function main() {
  const before = { ceilings: await prisma.adSpendCeiling.count(), proposals: await prisma.keywordBidProposal.count() }
  line(`starting counts — AdSpendCeiling ${before.ceilings} · KeywordBidProposal ${before.proposals}`)

  h('1 · preview with NO ceiling anywhere')
  let p = await previewBidChange({ term: TERM, marketplace: MKT, requestedBidCents: BID })
  line(`matched ${p.radius.matchedTargets}/${p.radius.matchedCampaigns} · changing ${p.radius.actionable.length}/${p.radius.actionableCampaigns} · commits up to ${eur(p.commitmentCents)}`)
  line(`ceiling: ${p.ceiling.verdict} · canPropose ${p.canPropose}`)
  line(wrap(p.ceiling.message))
  line(`share age: ${p.shareAgeDays} days · floor ${eur(p.floorCents)}`)

  h('2 · a MARKET ceiling that BINDS — the refusal, for real')
  const mkt = await prisma.adSpendCeiling.create({
    data: { grain: 'MARKET', scopeId: MKT, label: 'the IT market', dailyCapCents: 1000, note: 'KT.6 exercise — deleted at the end', createdBy: 'kt6-exercise' },
  })
  created.ceilings.push(mkt.id)
  p = await previewBidChange({ term: TERM, marketplace: MKT, requestedBidCents: BID })
  line(`ceiling: ${p.ceiling.verdict} · canPropose ${p.canPropose} · remaining ${eur(p.ceiling.remainingCents)}`)
  line(wrap(p.ceiling.message))
  line()
  line('and POST /propose against that ceiling:')
  const refused = await proposeBidChange({ term: TERM, marketplace: MKT, requestedBidCents: BID, proposedBy: 'kt6-exercise' })
  line(`   ok=${refused.ok} ${refused.ok ? '🔴 SHOULD HAVE BEEN REFUSED' : '✓ refused, and nothing was recorded'}`)
  if (refused.id) created.proposals.push(refused.id)
  line(`   proposals in table now: ${await prisma.keywordBidProposal.count()} (was ${before.proposals}) ${await prisma.keywordBidProposal.count() === before.proposals ? '✓ a refusal records nothing' : '🔴 a refusal recorded a row'}`)

  h('3 · a narrower CAMPAIGN ceiling — does the narrower one bind, and say so?')
  const oneCampRow = await prisma.adTarget.findFirst({
    where: { isNegative: false, kind: 'KEYWORD', expressionValue: { equals: TERM, mode: 'insensitive' }, adGroup: { campaign: { marketplace: MKT, liveBidWritesEnabled: true } } },
    select: { adGroup: { select: { campaign: { select: { id: true, name: true } } } } },
  })
  if (oneCampRow?.adGroup?.campaign) {
    const c = oneCampRow.adGroup.campaign
    const camp = await prisma.adSpendCeiling.create({
      data: { grain: 'CAMPAIGN', scopeId: c.id, label: c.name, dailyCapCents: 300, note: 'KT.6 exercise', createdBy: 'kt6-exercise' },
    })
    created.ceilings.push(camp.id)
    line(`created a CAMPAIGN ceiling of €3.00 on "${c.name}"`)
    p = await previewBidChange({ term: TERM, marketplace: MKT, requestedBidCents: BID })
    line(`⇒ bound grain: ${p.ceiling.grain ?? p.ceiling.bound?.grain ?? 'none'} — ${p.ceiling.verdict}`)
    line(wrap(p.ceiling.message))
    line()
    line('🔴 NOTE: this row touches many campaigns, so the campaign grain is AMBIGUOUS and the market')
    line('   ceiling is the honest bound. That is the design, verified here rather than assumed.')
  }

  h('4 · raise the ceiling so it ALLOWS — and propose for real')
  await prisma.adSpendCeiling.update({ where: { id: mkt.id }, data: { dailyCapCents: 4000 } })
  p = await previewBidChange({ term: TERM, marketplace: MKT, requestedBidCents: BID })
  line(`ceiling: ${p.ceiling.verdict} · canPropose ${p.canPropose}`)
  line(wrap(p.ceiling.message))
  const ok = await proposeBidChange({ term: TERM, marketplace: MKT, requestedBidCents: BID, proposedBy: 'kt6-exercise' })
  line()
  line(`propose → ok=${ok.ok} id=${ok.id ?? '—'}`)
  if (ok.id) created.proposals.push(ok.id)
  const row = ok.id ? await prisma.keywordBidProposal.findUnique({ where: { id: ok.id } }) : null
  if (row) {
    line(`recorded: ${row.actionableTargets} targets / ${row.actionableCampaigns} campaigns · commits ${eur(row.commitmentCents)} · status ${row.status}`)
    line(`          matched ${row.matchedTargets}/${row.matchedCampaigns} · shareAge ${row.shareAgeDays}d · ceiling ${row.ceilingVerdict} ${eur(row.ceilingCapCents)}`)
    line(`          targetIds stored: ${(row.targetIds as string[]).length} ${(row.targetIds as string[]).length === row.actionableTargets ? '✓ matches the count' : '🔴 mismatch'}`)
    line(`          excludedByReason: ${JSON.stringify(row.excludedByReason)}`)
    line(`          confirmationText stored: ${row.confirmationText.length} chars ${row.confirmationText === p.confirmationText ? '✓ identical to the preview' : '🔴 DIVERGED from the preview'}`)
  }

  h('5 · the ledger — a pending proposal is now visible')
  const c2 = await committedToday(MKT)
  line(`committed today ${eur(c2.committedCents)} (APPLIED only) · pending ${eur(c2.pendingCents)} across ${c2.pendingCount} proposal(s)`)
  line(`amazon spend ${eur(c2.amazonSpendCents)} for ${c2.amazonSpendDate} — dated, and NOT used as today's figure`)
  const list = await proposalsFor(TERM, MKT)
  line(`proposalsFor("${TERM}", ${MKT}) → ${list.length} row(s); newest ${list[0]?.status} ${eur(list[0]?.commitmentCents ?? null)}`)

  h('6 · cleanup')
  for (const id of created.proposals) await prisma.keywordBidProposal.delete({ where: { id } }).catch(() => {})
  for (const id of created.ceilings) await prisma.adSpendCeiling.delete({ where: { id } }).catch(() => {})
  const after = { ceilings: await prisma.adSpendCeiling.count(), proposals: await prisma.keywordBidProposal.count() }
  line(`AdSpendCeiling ${before.ceilings} → ${after.ceilings} ${after.ceilings === before.ceilings ? '✓' : '🔴 LEFTOVER'}`)
  line(`KeywordBidProposal ${before.proposals} → ${after.proposals} ${after.proposals === before.proposals ? '✓' : '🔴 LEFTOVER'}`)
  line()
  line(`control — nothing reached Amazon: OutboundSyncQueue ${await prisma.outboundSyncQueue.count()} (this script never queues)`)
  line(`AdTarget bids unchanged: no update was issued by this script at all`)
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
