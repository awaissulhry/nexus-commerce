/**
 * _kt3-verify.mts — the KT.3 payload on prod (read-only).
 * Run: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt3-verify.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { getKeywordTracker } from '../src/services/advertising/keyword-tracker.service.js'
const line = (s='')=>console.log(s)
const h = (s:string)=>{line();line(`━━━ ${s} ${'━'.repeat(Math.max(0,64-s.length))}`)}
const eur=(c:number)=>`€${(c/100).toFixed(2)}`

async function show(label:string,q:Parameters<typeof getKeywordTracker>[0]){
  const t0=Date.now(); const r=await getKeywordTracker(q); const ms=Date.now()-t0
  const withD=r.rows.filter(x=>x.deltaPP!=null)
  const withS=r.rows.filter(x=>(x.spendCents??0)>0)
  const wide=withD.filter(x=>(x.deltaGapDays??0)>7)
  line(`${label} (${ms}ms)`)
  line(`   rows ${r.rows.length} · Δ ${withD.length} (of which >7d gap: ${wide.length}) · spend>0 ${withS.length} · total ${eur(withS.reduce((a,x)=>a+(x.spendCents??0),0))}`)
  line(`   orders in the share week: ${r.rows.reduce((a,x)=>a+(x.orders??0),0)}  ← why Orders is not a column`)
  const tos=(r as {topOfSearch?:{avgShare:number;campaignsWithReading:number;campaignsInScope:number;asOf:string|null}}).topOfSearch
  line(`   topOfSearch: ${tos?`${(tos.avgShare*100).toFixed(2)}% across ${tos.campaignsWithReading} of ${tos.campaignsInScope} campaigns (to ${tos.asOf})`:'none'}`)
  const viol=withD.filter(x=>Math.abs(x.deltaPP!)>Math.max(x.impressionShare??0,x.priorShare??0)*100+1e-9)
  line(`   stop condition — Δ exceeding its share: ${viol.length===0?'✓ none':`🔴 ${viol.length}`}`)
  for(const x of withD.sort((a,b)=>Math.abs(b.deltaPP!)-Math.abs(a.deltaPP!)).slice(0,3))
    line(`      ${x.keyword.slice(0,30).padEnd(30)} ${(x.priorShare!*100).toFixed(2)}% → ${(x.impressionShare!*100).toFixed(2)}%  ${x.deltaPP!>=0?'+':''}${x.deltaPP!.toFixed(2)}pp · ${x.deltaGapDays}d`)
  const noD=r.rows.filter(x=>x.state==='measured'&&x.deltaPP==null)
  line(`      measured rows with NO Δ: ${noD.length}${noD.length?` e.g. ${noD.slice(0,3).map(x=>x.keyword).join(', ')}`:''}`)
  const blankShareWithD=r.rows.filter(x=>x.state!=='measured'&&x.deltaPP!=null)
  line(`      blank-share rows carrying a Δ (must be 0): ${blankShareWithD.length}`)
  return r
}
async function main(){
  h('the four markets')
  for(const m of ['IT','DE','ES','FR'] as const) await show(`${m} · default`,{market:m})
  h('sparse-column sort, both directions (spend)')
  for(const dir of ['asc','desc'] as const){
    const r=await getKeywordTracker({market:'IT',sort:'spend',dir})
    const first=r.rows.slice(0,3).map(x=>`${x.keyword.slice(0,18)}=${x.spendCents==null?'—':eur(x.spendCents)}`)
    const last=r.rows.slice(-3).map(x=>`${x.keyword.slice(0,18)}=${x.spendCents==null?'—':eur(x.spendCents)}`)
    line(`   spend ${dir}: first ${first.join(' | ')}`)
    line(`               last  ${last.join(' | ')}`)
  }
  for(const dir of ['asc','desc'] as const){
    const r=await getKeywordTracker({market:'IT',sort:'delta',dir})
    line(`   delta ${dir}: first ${r.rows.slice(0,2).map(x=>`${x.keyword.slice(0,18)}=${x.deltaPP==null?'—':x.deltaPP.toFixed(2)}`).join(' | ')} · last ${r.rows.slice(-2).map(x=>`${x.keyword.slice(0,14)}=${x.deltaPP==null?'—':x.deltaPP.toFixed(2)}`).join(' | ')}`)
  }
}
main().then(()=>prisma.$disconnect()).catch(async e=>{console.error(e);await prisma.$disconnect();process.exit(1)})
