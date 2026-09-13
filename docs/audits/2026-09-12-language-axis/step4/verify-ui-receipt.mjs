import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const [phase]=process.argv.slice(2)
assert.ok(['acknowledged-shared','drift-cell'].includes(phase))
const read=async name=>JSON.parse(await fs.readFile(new URL(name,import.meta.url)))
const before=await read(phase==='drift-cell'?'fixture-drift-prepared.json':'fixture-inherited-setup.json'),after=await read(`fixture-${phase}.json`),http=await read('rehearsal-http.json'),write=http.writes.at(-1),baseline=await read('fixture-baseline.json')
assert.ok(new Date(after.at)-new Date(write.at)>=8000)
assert.equal(write.result.updated,1);assert.equal(write.body.changes[0].contentAcknowledged,true);assert.deepEqual(write.body.changes[0].contentAddress,{tier:'language',language:'de'})
assert.equal(after.data.Product[0].version,before.data.Product[0].version+1)
const pt=after.data.ProductTranslation.find(row=>row.language==='de');assert.equal(pt.name,write.body.changes[0].value);assert.equal(pt.version,1);assert.ok(pt.reviewedAt)
const listing=after.data.ChannelListing.find(row=>row.marketplace==='DE'&&row.channel==='AMAZON'),old=before.data.ChannelListing.find(row=>row.id===listing.id);assert.equal(listing.version,old.version+1)
const pin=after.data.ChannelListingTranslation.find(row=>row.channelListingId===listing.id&&row.language==='de');assert.ok(pin.follows.includes('title'));assert.equal(pin.name,null)
assert.equal(JSON.stringify(after.data.Product[0].localizedContent),JSON.stringify(baseline.data.Product[0].localizedContent))
for(const row of after.data.ChannelListing){const original=baseline.data.ChannelListing.find(l=>l.id===row.id);assert.equal(row.title,original.title);assert.equal(row.description,original.description)}
const queue=after.data.OutboundSyncQueue.filter(row=>!baseline.data.OutboundSyncQueue.some(old=>old.id===row.id));assert.equal(queue.length,1);assert.equal(queue[0].payload.language,'de');assert.equal(queue[0].payload.title,pt.name);assert.ok(queue.every(row=>row.holdUntil.startsWith('2099-')))
const receipt={phase,writtenAt:write.at,readAt:after.at,delayMs:new Date(after.at)-new Date(write.at),productVersion:[before.data.Product[0].version,after.data.Product[0].version],translationVersion:[0,pt.version],listingVersion:[old.version,listing.version],pinFollowMarkerVersion:pin.version,reviewedAt:pt.reviewedAt,legacyValuesUnchanged:true,queue:{count:queue.length,language:'de',heldUntil:queue[0].holdUntil},providerAttempts:http.providerAttempts}
assert.deepEqual(http.providerAttempts,[])
await fs.writeFile(new URL(`receipt-${phase}.json`,import.meta.url),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt))
