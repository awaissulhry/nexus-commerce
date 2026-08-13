/**
 * HV.9a — READ-ONLY check at Amazon. Did anything land from the interrupted write?
 * Run with:  railway run npx tsx scripts/_hv9a-amazon-check.mts
 * Calls only listKeywords / listNegativeKeywords. It writes NOTHING.
 */
import '../src/env.js'
const { adsMode, listKeywords, listNegativeKeywords } = await import('../src/services/advertising/ads-api-client.js')
console.log(`\n  adsMode=${adsMode()}`)
const PROFILE = '2009298984696893'        // DE
const DEST_CAMP = '274979860749057'       // DE_Exact_3_Keywords
const SRC_CAMP  = '115625353077718'       // DE_Auto_Close
const ctx = { profileId: PROFILE, region: 'EU' as const }

const kws = await listKeywords(ctx, { campaignIds: [DEST_CAMP, SRC_CAMP] })
console.log(`\n═══ positive keywords at Amazon in the two campaigns: ${kws.length} ═══`)
for (const k of kws as any[]) {
  const hit = String(k.keywordText ?? '').toLowerCase().includes('4xl')
  if (hit) console.log(`  ✅ MATCH  id=${k.keywordId} "${k.keywordText}" ${k.matchType} state=${k.state} bid=${k.bid} camp=${k.campaignId} ag=${k.adGroupId}`)
}
console.log(`  keywords containing "4xl": ${(kws as any[]).filter(k=>String(k.keywordText??'').toLowerCase().includes('4xl')).length}`)

const negs = await listNegativeKeywords(ctx, { campaignIds: [SRC_CAMP] })
console.log(`\n═══ negatives at Amazon in DE_Auto_Close: ${negs.length} ═══`)
for (const n of negs as any[]) {
  if (String(n.keywordText ?? '').toLowerCase().includes('4xl')) console.log(`  🔴 MATCH  id=${n.keywordId} "${n.keywordText}" ${n.matchType} state=${n.state}`)
}
console.log(`  negatives containing "4xl": ${(negs as any[]).filter(n=>String(n.keywordText??'').toLowerCase().includes('4xl')).length}`)
// Open Redis handles from the queue module keep the process alive under `railway run`; the reads
// are done, so exit explicitly rather than hanging for ten minutes.
process.exit(0)
