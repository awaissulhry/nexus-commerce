/** HV.9a — did write 2's negative reach Amazon despite returning no id? READ-ONLY. */
import '../src/env.js'
const { listNegativeKeywords } = await import('../src/services/advertising/ads-api-client.js')
const ctx = { profileId: '1132205598741194', region: 'EU' as const }   // FR
const negs = await listNegativeKeywords(ctx, { campaignIds: ['242957913137679'] })  // FR_Exact_8_Keywords
console.log(`\n═══ negatives at Amazon in FR_Exact_8_Keywords: ${negs.length} ═══`)
for (const n of negs as any[]) console.log(`  id=${n.keywordId} "${n.keywordText}" ${n.matchType} state=${n.state} ag=${n.adGroupId ?? '(campaign)'}`)
const hit = (negs as any[]).filter(n => String(n.keywordText ?? '').toLowerCase().includes('homolog'))
console.log(`\n  🔴 matching "homolog": ${hit.length}`)
process.exit(0)
