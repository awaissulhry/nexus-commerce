import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
const [phase]=process.argv.slice(2)
assert.ok(['master-primary','master-german-final','channel-pin','inherited-setup'].includes(phase))
const id='cmokmy0lr0009pm0p9yxk7ho0',root='cmokmy3a40078pm0p1fvnu523',account='cmothu9bo0000nz01asw6wx8j'
const locale=phase==='master-primary'?'it':'de',channel=phase.startsWith('channel')||phase==='inherited-setup'
const base='http://127.0.0.1:4119'
const read=await fetch(`${base}/api/products/${root}/studio/sheet?scope=${channel?'channel':'master'}&market=${locale==='it'?'IT':'DE'}&locale=${locale}${channel?`&channel=AMAZON&accountId=${account}`:''}`)
assert.equal(read.status,200)
const sheet=await read.json(),row=sheet.rows.find(r=>r.id===id),cell=row.values.name,label=sheet.columns.find(c=>c.key==='name').label
const value=`XAVIA LX4 ${phase} control`,reset=phase==='inherited-setup'
const body={changes:[{id,field:cell.writeField,value:reset?null:value,contentAddress:cell.contentAddress,contentVersion:cell.contentVersion,...(reset?{intent:'reset',contentAcknowledged:true}:{}),target:channel?'channel':'master'}],expectedVersion:channel?row.listing.version:row.version,marketplaceContexts:[{marketplace:locale==='it'?'IT':'DE',locale,...(channel?{channel:'AMAZON',accountId:account,aliasKey:''}:{})}]}
const response=await fetch(`${base}/api/products/bulk`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
const result=await response.json(),writtenAt=new Date().toISOString()
await fs.writeFile(new URL(`request-${phase}.json`,import.meta.url),JSON.stringify({writtenAt,label,body,status:response.status,result},null,2)+'\n')
assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.updated,1,JSON.stringify(result));assert.deepEqual(result.errors,[])
await new Promise(resolve=>setTimeout(resolve,8100))
function fixture(command,name){const r=spawnSync('node',['docs/audits/2026-09-12-language-axis/step4/fixture.mjs',command,name],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)}
const receipt=fixture('read',phase),snapshot=JSON.parse(await fs.readFile(new URL(`fixture-${phase}.json`,import.meta.url)))
assert.ok(new Date(snapshot.at)-new Date(writtenAt)>=8000)
const stored=channel?snapshot.data.ChannelListingTranslation.find(t=>t.language==='de'):locale==='it'?snapshot.data.Product[0]:snapshot.data.ProductTranslation.find(t=>t.language==='de')
assert.equal(reset?stored.follows.includes('title'):stored.name,reset?true:value)
if(!channel&&locale!=='it')assert.ok(stored.reviewedAt)
const baseline=JSON.parse(await fs.readFile(new URL('fixture-baseline.json',import.meta.url)))
assert.equal(snapshot.data.Product[0].localizedContent&&JSON.stringify(snapshot.data.Product[0].localizedContent),baseline.data.Product[0].localizedContent&&JSON.stringify(baseline.data.Product[0].localizedContent))
for(const listing of snapshot.data.ChannelListing){const old=baseline.data.ChannelListing.find(l=>l.id===listing.id);assert.equal(listing.title,old.title);assert.equal(listing.description,old.description)}
const version=channel?snapshot.data.ChannelListing.find(l=>l.id===row.listing.id).version:snapshot.data.Product[0].version
assert.equal(version,body.expectedVersion+1)
if(!reset){fixture('restore',phase);await new Promise(resolve=>setTimeout(resolve,8100));fixture('read',`${phase}-restored`);const restored=JSON.parse(await fs.readFile(new URL(`fixture-${phase}-restored.json`,import.meta.url)));assert.deepEqual(restored.data,baseline.data)}
console.log(JSON.stringify({phase,writtenAt,readAt:snapshot.at,delayMs:new Date(snapshot.at)-new Date(writtenAt),label,versionBefore:body.expectedVersion,versionAfter:version,contentVersion:stored.version,restored:!reset}))
