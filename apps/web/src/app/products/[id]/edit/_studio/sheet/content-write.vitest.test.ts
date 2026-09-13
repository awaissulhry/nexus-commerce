import { afterEach, describe, expect, it, vi } from 'vitest'
import { commitMasterRow } from './master/masterWrite'
import { commitChannelRow } from './channel/useChannelSheet'
import { channelWriteGate } from './channel/rows'
import type { ContentWriteFacts } from '@nexus/shared/content-language'
const shared = { tier:'language',language:'de' } as const
const pin = { tier:'pin',language:'de',coordinate:{channel:'AMAZON',market:'DE',accountId:'account'} } as const
const acknowledgement = { shared:{label:'Edit the shared German',address:shared},pin:{label:'Pin on Amazon · DE · de',address:pin},reach:['Amazon · DE (de)'] }
const cell=(facts:ContentWriteFacts={})=>({value:'Before',writeField:'name',writeTarget:'channelListing',writeVerb:'channel',writable:true,affectsAllChannels:false,contentAcknowledgement:acknowledgement,...facts})
const row=(facts:ContentWriteFacts={})=>({id:'p',rowId:'p',aliasId:null,version:4,listing:{id:'l',version:19},values:{name:cell(facts)}}) as any
const coord={channel:'AMAZON' as const,marketplace:'DE',locale:'de',accountId:'account'}
function transport(status=200,result:any={updated:1,errors:[],currentVersion:5,versionOf:'product'}){
 const requests:any[]=[];vi.stubGlobal('fetch',vi.fn(async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:status<400,status,json:async()=>result}}));return requests
}
afterEach(()=>vi.unstubAllGlobals())
describe('LX.8 both sheet hosts echo the addressed write contract',()=>{
 it('master German and primary use the same bulk path and preserve CAS and list clears',async()=>{
  const requests=transport()
  for(const address of [shared,{tier:'source'} as const]){
   const r=row({contentAddress:address,contentVersion:3});r.values.bullets={...r.values.name,writeField:'bulletPoints'}
   await commitMasterRow({rowId:'p',row:r,expectedVersion:4,cells:[{colId:'name',value:'After',intent:'set'},{colId:'bullets',value:[],intent:'set'}]} as any,{sheet:{columns:[{key:'name',writeField:'name'},{key:'bullets',writeField:'bulletPoints'}]} as any,locale:address.tier==='source'?'it':'de',market:address.tier==='source'?'IT':'DE',opts:{}})
   expect(requests.at(-1).url).toContain('/products/bulk');expect(requests.at(-1).body.changes.map((c:any)=>c.contentAddress)).toEqual([address,address]);expect(requests.at(-1).body.changes[1].value).toEqual([]);expect(requests.at(-1).body.expectedVersion).toBe(4)
  }
 })
 it.each(['edit','paste','rangeService'])('%s uses the acknowledgement for inherited and drift cells',source=>{
  for(const follows of [true,false]){
   const c={...cell({contentAddress:null}),follows,pinned:false}
   expect(channelWriteGate({colId:'name',source,selfInflicted:false,cell:c as any,acknowledged:true})).toBe('acknowledge')
  }
  expect(channelWriteGate({colId:'name',source,selfInflicted:true,cell:cell() as any,acknowledged:false})).toBe('ignore')
 })
 it('a confirmed shared edit uses Product CAS; an operator pin uses listing CAS',async()=>{
  const requests=transport()
  for(const address of [shared,pin])await commitChannelRow({rowId:'p',row:row({contentAddress:address,contentAcknowledged:true}),expectedVersion:4,cells:[{colId:'name',value:'After',intent:'set'}]} as any,coord)
  expect(requests.map(r=>r.body.expectedVersion)).toEqual([4,19]);expect(requests.map(r=>r.body.changes[0].target)).toEqual(['master','channel']);expect(requests.map(r=>r.body.changes[0].contentAddress)).toEqual([shared,pin])
 })
 it('renders the server sentence verbatim on both hosts',async()=>{
  const sentence='Product title needs a ContentAddress before it can be saved.'
  transport(400,{error:sentence,errors:[{id:'p',field:'name',error:sentence}]})
  const req={rowId:'p',row:row(),expectedVersion:4,cells:[{colId:'name',value:'After',intent:'set'}]} as any
  const channel=await commitChannelRow(req,coord)
  const master=await commitMasterRow(req,{sheet:{columns:[{key:'name',writeField:'name'}]} as any,opts:{},market:'DE',locale:'de'})
  expect(channel.cells?.name?.reason??channel.reason).toBe(sentence);expect(master.cells?.name?.reason??master.reason).toBe(sentence)
 })
})
