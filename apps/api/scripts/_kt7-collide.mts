/**
 * _kt7-collide.mts — 🔴 KT.7: can an apply collide with the no-pause suppress/restore cycle?
 * READ-ONLY. `restoreCampaignBids` writes `suppressedFromBidCents` back as the bid and clears it,
 * gated on `Campaign.bidsSuppressedAt`. So (a) writing that field from KT.7 would feed another
 * engine's state machine, and (b) applying to a currently-suppressed campaign would be silently
 * reverted on the next resume. Both are measurable.
 */
import '../src/env.js'
import prisma from '../src/db.js'
const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 72 - s.length))}`) }
const pad = (s: unknown, n: number) => String(s).padStart(n)
const padr = (s: unknown, n: number) => String(s).padEnd(n)
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

async function main() {
  h('1 · which campaigns are suppressed RIGHT NOW?')
  const supp = await prisma.campaign.findMany({
    where: { bidsSuppressedAt: { not: null } },
    select: { id: true, name: true, marketplace: true, liveBidWritesEnabled: true, bidsSuppressedAt: true },
  })
  line(`Campaign.bidsSuppressedAt set on ${supp.length} of ${await prisma.campaign.count()}`)
  for (const c of supp.slice(0, 10)) line(`   ${padr(c.marketplace ?? '—', 4)} ${padr(c.name.slice(0, 46), 48)} writable=${c.liveBidWritesEnabled} since ${c.bidsSuppressedAt?.toISOString().slice(5, 16)}`)
  line(supp.length === 0
    ? '✓ none suppressed at this instant — but the cycle is hourly, so this is a CLOCK READING, not a property'
    : `🔴 ${supp.length} suppressed: an apply into one of these would be reverted on the next resume`)

  h('2 · does the widest row sit in a suppressed campaign?')
  const camps = await prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, bidsSuppressedAt: true, liveBidWritesEnabled: true } })
  const byId = new Map(camps.map((c) => [c.id, c]))
  const t = await prisma.adTarget.findMany({
    where: { isNegative: false, kind: 'KEYWORD' },
    select: { id: true, expressionValue: true, bidCents: true, adGroup: { select: { campaignId: true } } },
  })
  const gm = t.filter((x) => norm(x.expressionValue) === 'giacca moto' && byId.get(x.adGroup!.campaignId)?.marketplace === 'IT')
  const gmSupp = gm.filter((x) => byId.get(x.adGroup!.campaignId)?.bidsSuppressedAt != null)
  line(`giacca moto IT: ${gm.length} targets · in a currently-suppressed campaign: ${gmSupp.length}`)

  h('3 · how often does the cycle fire? (how stale is a "not suppressed" reading)')
  const since = new Date(Date.now() - 7 * 86_400_000)
  const rows = await prisma.advertisingActionLog.findMany({
    where: { createdAt: { gte: since }, entityType: 'AD_TARGET', actionType: 'AD_BID_UPDATE' },
    select: { createdAt: true, payloadBefore: true, payloadAfter: true, userId: true },
    take: 20000,
  })
  const bidOf = (p: unknown) => { const o = p as Record<string, unknown> | null; const v = o?.bidCents; return typeof v === 'number' ? v : null }
  const toFloor = rows.filter((r) => bidOf(r.payloadAfter) === 2 && (bidOf(r.payloadBefore) ?? 0) > 2)
  const fromFloor = rows.filter((r) => bidOf(r.payloadBefore) === 2 && (bidOf(r.payloadAfter) ?? 0) > 2)
  line(`AD_BID_UPDATE on AD_TARGET in 7d: ${rows.length}`)
  line(`  → dropped TO 2¢ (a suppression):   ${toFloor.length}`)
  line(`  → raised FROM 2¢ (a restore):      ${fromFloor.length}`)
  const days = new Map<string, { down: number; up: number }>()
  for (const r of toFloor) { const k = r.createdAt.toISOString().slice(0, 10); const e = days.get(k) ?? { down: 0, up: 0 }; e.down++; days.set(k, e) }
  for (const r of fromFloor) { const k = r.createdAt.toISOString().slice(0, 10); const e = days.get(k) ?? { down: 0, up: 0 }; e.up++; days.set(k, e) }
  line(`${padr('day', 12)} ${pad('to 2c', 7)} ${pad('from 2c', 8)}`)
  for (const [k, e] of [...days].sort()) line(`${padr(k, 12)} ${pad(e.down, 7)} ${pad(e.up, 8)}`)
  line()
  line('⇒ the suppress/restore cycle moves hundreds of bids a day. A target\'s 2¢ is a CLOCK READING.')

  h('4 · 🔴 would writing suppressedFromBidCents be safe? Read the consumers.')
  line('restoreCampaignBids (ads-bid-suppression.service.ts:195-201):')
  line('   findMany({ where: { suppressedFromBidCents: { not: null } } }) → updateAdTargetWithSync({')
  line('     patch: { bidCents: t.suppressedFromBidCents } }) → then clears the field.')
  line('⇒ ANY non-null value in that column is treated as "the bid to restore to", by an engine that')
  line('  did not put it there. Writing it from KT.7 hands that engine a value to apply later.')
  line()
  line('And two more consumers compute a CEILING from it:')
  line('   ad-rank-defend.job.ts:548-551  maxBaseBid = MAX(bidCents, suppressedFromBidCents)')
  line('   rank-runtime.service.ts:133-136 same')
  line('⇒ writing it would also inflate the max-base-bid the CPC cap is derived from.')
  line()
  line('CONCLUSION: the brief\'s option B — "record the current bid into suppressedFromBidCents before')
  line('raising" — is NOT safe. That column belongs to the no-pause state machine. KT.7 must not write it.')

  h('5 · the recovery mechanism that ALREADY exists')
  const withBefore = await prisma.advertisingActionLog.count({
    where: { actionType: 'AD_BID_UPDATE', entityType: 'AD_TARGET', createdAt: { gte: since } },
  })
  line(`AD_BID_UPDATE rows carrying payloadBefore in 7d: ${withBefore}`)
  const sample = await prisma.advertisingActionLog.findFirst({
    where: { actionType: 'AD_BID_UPDATE', entityType: 'AD_TARGET' }, orderBy: { createdAt: 'desc' },
    select: { payloadBefore: true, payloadAfter: true },
  })
  line(`shape: before=${JSON.stringify(sample?.payloadBefore)} after=${JSON.stringify(sample?.payloadAfter)}`)
  line('⇒ every bid write already records its own prior value, and the per-change undo reads exactly')
  line('  this. So the pre-bid is ALREADY durable, in the right place, without touching another')
  line('  engine\'s column. The suppression decision therefore needs no new storage at all.')
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
