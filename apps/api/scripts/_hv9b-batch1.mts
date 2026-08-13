/** HV.9b — choose batch 1: five DIVERSE rows. READ-ONLY (selection only, no pushes). */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const eur=(c:number)=>`€${(c/100).toFixed(2)}`
const rows = await prisma.$queryRaw<Array<{id:string;kw:string;mt:string;bid:number;mkt:string;camp:string;ag:string;created:Date}>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId" FROM "AdvertisingActionLog"
             WHERE "actionType"='create_keyword' AND "userId"='automation:auto-harvest' ORDER BY "entityId","createdAt" ASC)
  SELECT t.id, t."expressionValue" AS kw, t."expressionType" AS mt, t."bidCents" AS bid,
         c.marketplace AS mkt, c.name AS camp, g.name AS ag, t."createdAt" AS created
  FROM "AdTarget" t JOIN f ON f."entityId"=t.id
  JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE t."externalTargetId" IS NULL AND t."isNegative"=false
    AND t."expressionValue" !~* '^b0[a-z0-9]{8}$'
  ORDER BY c.marketplace, c.name, t."createdAt"`
console.log(`\n  pushable pool: ${rows.length}`)
const byMkt = new Map<string,typeof rows>(); for (const r of rows) { const a=byMkt.get(r.mkt)??[]; a.push(r); byMkt.set(r.mkt,a) }
console.log(`  by market: ${[...byMkt].map(([k,v])=>`${k}=${v.length}`).join(' · ')}`)
// diversity: both markets, distinct campaigns, and the widest bid spread available
/**
 * 🔴 Excluded from batch 1: the DE_Auto_Close copy of "motorradjacke 4xl".
 *
 * HV.9a promoted that term into DE_Exact_3_Keywords and negated it in DE_Auto_Close an hour ago.
 * Pushing the old local-only row would put the keyword back into the very ad group we just negated
 * it out of — bidding against the negative in the same breath. It belongs to HV.9c's cleanup.
 */
const EXCLUDE = new Set(['cmqxet8o80mzkln012bpn158f'])
const pick: typeof rows = []
const seenCamp = new Set<string>()
for (const mkt of [...byMkt.keys()]) for (const r of byMkt.get(mkt)!) {
  if (pick.length >= 6) break
  if (seenCamp.has(r.camp) || EXCLUDE.has(r.id)) continue
  seenCamp.add(r.camp); pick.push(r)
}
console.log(`\n═══ BATCH 1 — ${Math.min(5,pick.length)} rows, distinct campaigns across both markets ═══`)
for (const r of pick.slice(0,5)) console.log(`  ${r.mkt} ${String(r.kw).slice(0,30).padEnd(32)} ${String(r.mt).padEnd(7)} bid=${eur(r.bid).padStart(7)} created=${r.created.toISOString().slice(0,10)}\n     ${String(r.camp).slice(0,40)} › ${String(r.ag).slice(0,32)}\n     id=${r.id}`)
console.log(`\n  BATCH 1 IDS: ${JSON.stringify(pick.slice(0,5).map(r=>r.id))}`)
console.log(`\n  campaign maxBid ceilings for these campaigns:`)
for (const r of pick.slice(0,5)) {
  const c = await prisma.campaign.findFirst({ where:{ name:r.camp }, select:{ name:true, maxBidCents:true, status:true, externalCampaignId:true } }).catch(()=>null)
  console.log(`    ${String(r.camp).slice(0,38).padEnd(40)} maxBidCents=${(c as any)?.maxBidCents ?? 'null'} status=${c?.status} ext=${c?.externalCampaignId ? 'yes':'🔴 none'}`)
}
await prisma.$disconnect()
