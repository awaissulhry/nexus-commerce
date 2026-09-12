import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'dotenv'
import pg from 'pg'
const repo = resolve(process.cwd(), '../..')
const config = parse(readFileSync(resolve(repo, 'apps/api/.env')))
const url = new URL(config.DATABASE_URL)
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '55439' || url.pathname !== '/nexus_development') throw new Error('Refused: this rehearsal is local only')
const client = new pg.Client({ connectionString: url.toString() }); await client.connect()
try {
 const database = (await client.query('SELECT current_database() AS name, inet_server_addr()::text AS address')).rows[0]
 const parent = (await client.query('SELECT id,sku,version,"variationAxes" FROM "Product" WHERE id=$1', ['cmokmy3a40078pm0p1fvnu523'])).rows[0]
 const products = (await client.query('SELECT id,sku,status,version,"parentId","deletedAt","variantAttributes","categoryAttributes" FROM "Product" WHERE sku LIKE $2 OR ("parentId"=$1 AND sku LIKE $3) ORDER BY sku', [parent.id, 'GALE-JACKET-VPF-%', '%-XXS'])).rows
 const accounts = (await client.query('SELECT "channelConnectionId", count(*)::int AS listings FROM "ChannelListing" WHERE channel=\'EBAY\' AND marketplace=\'IT\' AND "productId" IN (SELECT id FROM "Product" WHERE id=$1 OR "parentId"=$1) GROUP BY "channelConnectionId"', [parent.id])).rows
 const parentListing = (await client.query('SELECT id,version,"platformAttributes","isPublished","syncPaused" FROM "ChannelListing" WHERE "productId"=$1 AND channel=\'EBAY\' AND marketplace=\'IT\' AND "channelConnectionId"=$2 AND "aliasKey"=\'\'', [parent.id, 'cmr4aaqb00025nz016k18rup9'])).rows[0]
 const devLoginExists = (await client.query('SELECT count(*)::int AS count FROM "UserProfile" WHERE email=$1 AND status=\'active\'', ['dev+admin@nexus.local'])).rows[0].count
 const fixtureListings = (await client.query('SELECT id,"productId",channel,marketplace,"channelConnectionId","aliasKey",version,"listingStatus","variationExcluded","syncPaused","isPublished","externalListingId","overrideData","platformAttributes" FROM "ChannelListing" WHERE "productId" IN (SELECT id FROM "Product" WHERE sku LIKE $2 AND ($1::text IS NOT NULL))', [parent.id, 'GALE-JACKET-VPF-%'])).rows
 const report={at:new Date().toISOString(),database,parent,products,accounts,fixtureListings,parentListing,devLoginExists}
 writeFileSync(resolve(repo,'docs/audits/2026-09-11-variants-final/rehearsal-readback.json'),JSON.stringify(report,null,2))
 console.log(JSON.stringify({at:report.at,database,parent,products:products.map(p=>({id:p.id,sku:p.sku,status:p.status,version:p.version,parentId:p.parentId,deletedAt:p.deletedAt,variations:p.categoryAttributes?.variations,scalarColor:p.categoryAttributes?.color,scalarSize:p.categoryAttributes?.size,legacy:p.variantAttributes})),accounts,fixtureListings,parentListing,devLoginExists},null,2))
} finally {await client.end()}
