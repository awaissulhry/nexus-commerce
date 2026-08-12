/**
 * _kt4-verify.mts — the KT.4 term payload on prod, on the shapes that must survive (read-only).
 * Run: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt4-verify.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { getKeywordTerm } from '../src/services/advertising/keyword-term.service.js'
const line=(s='')=>console.log(s); const h=(s:string)=>{line();line(`━━━ ${s} ${'━'.repeat(Math.max(0,64-s.length))}`)}
const eur=(c:number)=>`€${(c/100).toFixed(2)}`
async function show(label:string,market:string,kw:string){
  const t0=Date.now(); const r=await getKeywordTerm({market,keyword:kw}); const ms=Date.now()-t0
  line(`${label}  "${kw}" (${ms}ms)`)
  line(`   header: ${r.header?`vol ${r.header.marketVolume} · #${r.header.marketRank} · share ${(r.header.share*100).toFixed(3)}%${r.header.shareBound?` · bound ≤${(r.header.shareBound*100).toFixed(3)}%`:''} · ${r.header.asinsOnQuery} ASIN(s) · best ${r.header.bestAsin}`:'no row in the chosen week'}`)
  line(`   period ${r.period} (${r.periodAgeDays}d, truncated=${r.periodTruncated})`)
  line(`   series: ${r.series.points.length} buckets · ${r.series.shareWeeks} with share · gaps=${r.series.hasGaps} · line? ${r.series.shareWeeks>=3?'YES':'NO — dated point(s) only'}`)
  line(`           share ends ${r.series.lastShareWeek} · spend ends ${r.series.lastSpendWeek} · share trails by ${r.series.shareTrailsSpendByDays}d`)
  const spans=r.series.points.filter(p=>p.share!=null).map(p=>p.week)
  line(`           share weeks: ${spans.join(' → ')||'(none)'}`)
  line(`   ASINs: ${r.asins.length}${r.asins.length?` · best ${(r.asins[0].share*100).toFixed(3)}% · worst ${(r.asins[r.asins.length-1].share*100).toFixed(3)}% · advertised-on-term ${r.asins.filter(a=>a.advertisedOnTerm).length}/${r.asins.length} · named ${r.asins.filter(a=>a.name).length}`:''}`)
  line(`   bid: ${r.bid.unbid?'🔴 NO CAMPAIGN BIDS THIS TERM':`${r.bid.campaigns} campaigns · ${r.bid.adGroups} ad groups · ${r.bid.matchTypes.join('/')}`}`)
  if(r.bidCampaigns.length) line(`        widest campaign: "${r.bidCampaigns[0].name}" ${r.bidCampaigns[0].adGroupCount} ad groups ${r.bidCampaigns[0].matchTypes.join('/')} · bids ${eur(r.bidCampaigns[0].adGroups[0].minBidCents)}–${eur(r.bidCampaigns[0].adGroups[0].maxBidCents)}`)
  line(`   funnel: cart-add weeks ${r.funnel.cartAddWeeks} · purchase weeks ${r.funnel.purchaseWeeks} of ${r.funnel.totalWeeks}`)
  return r
}
async function main(){
  h('the shapes §9 demands')
  await show('IT 9-week, 10-ASIN, 12-campaign','IT','giacca moto estiva uomo')
  await show('IT 53-CAMPAIGN case','IT','giacca moto')
  await show('DE 10-ASIN','DE','motorrad jacke herren')
  await show('ES widest','ES','chaqueta moto hombre invierno')
  await show('FR','FR','veste moto homme')
  h('an UNBID IT term (64 of 97) and a ONE-WEEK term (19 of 97)')
  const wl=await prisma.keywordWatchlist.findFirst({where:{marketplace:'IT',isDefault:true},select:{terms:{select:{term:true,isBranded:true}}}})
  const terms=(wl?.terms??[]).filter(t=>!t.isBranded).map(t=>t.term.toLowerCase())
  const tg=await prisma.adTarget.findMany({where:{isNegative:false,expressionValue:{in:terms},adGroup:{campaign:{marketplace:'IT'}}},select:{expressionValue:true}})
  const bid=new Set(tg.map(t=>t.expressionValue.toLowerCase()))
  const unbid=terms.filter(t=>!bid.has(t))
  line(`unbid IT terms: ${unbid.length}`)
  if(unbid.length) await show('IT UNBID','IT',unbid[0])
  const asins=[...new Set((await prisma.adProductAd.findMany({where:{asin:{not:null},adGroup:{campaign:{marketplace:'IT'}}},select:{asin:true}})).map(a=>a.asin!))]
  const rows=await prisma.searchQueryPerformance.findMany({where:{marketplace:'IT',searchQuery:{in:terms},asin:{in:asins}},select:{searchQuery:true,startDate:true}})
  const per=new Map<string,Set<number>>()
  for(const r of rows){const k=r.searchQuery.toLowerCase();const s=per.get(k)??new Set<number>();s.add(+r.startDate);per.set(k,s)}
  const single=[...per.entries()].filter(([,s])=>s.size===1)
  line(`IT terms with exactly ONE week: ${single.length}`)
  if(single.length) await show('IT ONE WEEK (no line)','IT',single[0][0])
  const gappy=[...per.entries()].find(([,s])=>{const w=[...s].sort((a,b)=>a-b);return w.slice(1).some((x,i)=>Math.round((x-w[i])/86400000)>7)})
  if(gappy) await show('IT WITH A GAP','IT',gappy[0])
}
main().then(()=>prisma.$disconnect()).catch(async e=>{console.error(e);await prisma.$disconnect();process.exit(1)})
