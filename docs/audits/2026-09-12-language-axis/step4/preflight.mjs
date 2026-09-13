import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { Client } from 'pg'
import { databaseTarget } from '../step1/target.mjs'
const target = await databaseTarget('local')
const db = new Client({ connectionString: target.connectionString })
await db.connect()
try {
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
 const rootId='cmokmy3a40078pm0p1fvnu523', childId='cmokmy0lr0009pm0p9yxk7ho0'
 const products=(await db.query('SELECT id,sku,name,"parentId",version,"workspaceId" FROM "Product" WHERE id=$1 OR "parentId"=$1 ORDER BY id',[rootId])).rows
 assert.equal(products.find(p=>p.id===rootId)?.sku,'GALE-JACKET');assert.equal(products.find(p=>p.id===childId)?.parentId,rootId);assert.match(products.find(p=>p.id===childId).name,/XAVIA/i)
 const listings=(await db.query('SELECT id,"productId",channel,marketplace,"channelConnectionId","aliasKey",title,"titleOverride","followMasterTitle",description,"followMasterDescription",version FROM "ChannelListing" WHERE "productId"=ANY($1::text[]) ORDER BY "productId",channel,marketplace',[products.map(p=>p.id)])).rows
 const translations=(await db.query('SELECT id,"productId",language,version,"reviewedAt" FROM "ProductTranslation" WHERE "productId"=ANY($1::text[])',[products.map(p=>p.id)])).rows
 const schemas=(await db.query('SELECT marketplace,"productType","schemaVersion","fetchedAt" FROM "CategorySchema" WHERE channel=\'AMAZON\' AND "isActive"=true AND marketplace IN (\'IT\',\'DE\')')).rows
 const receipt=(await db.query("SELECT transaction_timestamp() AS at,current_database() AS database,current_setting('transaction_read_only') AS read_only")).rows[0]
 await db.query('ROLLBACK')
 const result={...target.identity,receipt,rolledBack:true,rootId,childId,products,listings,translations,schemas}
 await fs.writeFile(new URL('rehearsal-preflight.json',import.meta.url),JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify({...target.identity,receipt,rootId,childId,products:products.length,listings:listings.length,childListings:listings.filter(l=>l.productId===childId).map(l=>({id:l.id,channel:l.channel,marketplace:l.marketplace,accountId:l.channelConnectionId,alias:l.aliasKey,follows:l.followMasterTitle,title:!!l.title,override:!!l.titleOverride,version:l.version})),translations:translations.filter(t=>t.productId===childId)}))
} finally {await db.end()}
