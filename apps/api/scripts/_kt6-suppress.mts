/**
 * _kt6-suppress.mts — KT.6: are the low bids on the widest row DELIBERATE suppressions?
 * READ-ONLY. The house rule is "no pause, suppress via ~€0.02 bids", so a "set the bid to €0.55"
 * control could silently un-suppress traffic someone switched off on purpose. That must be
 * measured before the control is designed, not discovered after it ships.
 */
import '../src/env.js'
import prisma from '../src/db.js'
const line = (s = '') => console.log(s)
const eur = (c: number | null) => (c == null ? 'null' : `€${(c / 100).toFixed(2)}`)
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

async function main() {
  const camps = await prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, liveBidWritesEnabled: true, maxBidCents: true } })
  const byId = new Map(camps.map((c) => [c.id, c]))
  const targets = await prisma.adTarget.findMany({
    where: { isNegative: false, kind: 'KEYWORD' },
    select: { id: true, expressionValue: true, bidCents: true, suppressedFromBidCents: true, baseBidFromCents: true, status: true, adGroup: { select: { campaignId: true } } },
  })
  const gm = targets.filter((t) => norm(t.expressionValue) === 'giacca moto' && byId.get(t.adGroup!.campaignId)?.marketplace === 'IT')
  const writ = gm.filter((t) => byId.get(t.adGroup!.campaignId)?.liveBidWritesEnabled)
  console.log(`giacca moto IT: ${gm.length} targets · ${writ.length} writable`)
  const supp = writ.filter((t) => t.suppressedFromBidCents != null)
  const base = writ.filter((t) => t.baseBidFromCents != null)
  console.log(`  with suppressedFromBidCents set : ${supp.length}  ⇒ ${supp.length ? 'DELIBERATELY SUPPRESSED' : 'none flagged as suppressed'}`)
  console.log(`  with baseBidFromCents set       : ${base.length}`)
  const buckets = new Map<string, number>()
  for (const t of writ) {
    const b = t.bidCents
    const k = b == null ? 'null' : b <= 3 ? '≤3¢ (suppression range)' : b <= 10 ? '4-10¢' : b <= 30 ? '11-30¢' : '>30¢'
    buckets.set(k, (buckets.get(k) ?? 0) + 1)
  }
  console.log(`  bid distribution: ${[...buckets].map(([k, v]) => `${k}=${v}`).join(' · ')}`)
  console.log()
  console.log('account-wide, positive keyword targets:')
  const allSupp = targets.filter((t) => t.suppressedFromBidCents != null)
  console.log(`  suppressedFromBidCents set on ${allSupp.length} of ${targets.length}`)
  const low = targets.filter((t) => (t.bidCents ?? 99) <= 3)
  console.log(`  bid ≤3¢ on ${low.length} · of those, flagged suppressed: ${low.filter((t) => t.suppressedFromBidCents != null).length}`)
  console.log()
  console.log(low.length > 0 && low.filter((t) => t.suppressedFromBidCents != null).length === 0
    ? '🔴 A ≤3¢ bid is NOT recorded as a suppression anywhere. So the page cannot distinguish\n   "deliberately switched off" from "genuinely bid low", and a raise would silently un-suppress.\n   The control must therefore treat ≤3¢ as suppressed-by-convention and EXCLUDE it by default,\n   naming the count — a guess in the safe direction, stated rather than hidden.'
    : '✓ suppression is recorded on the row; the control can key on suppressedFromBidCents')
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(String(e).slice(0, 300)); await prisma.$disconnect(); process.exit(1) })
