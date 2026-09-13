import { open } from './_vtf-db.mjs'
const c = await open()
const q = async (s,p) => (await c.query(s,p)).rows
for (const [label, id] of [['GALE','cmokmy3a40078pm0p1fvnu523'],['VX','cmtzci5kf0000njr9f8yhrsxm']]) {
  console.log(`\n== ${label}`)
  console.log(JSON.stringify(await q(`SELECT l.id, l.channel, l.marketplace, l."aliasKey", l.version, l."variationTheme", l."listingStatus", l."channelConnectionId", cc."displayName"
    FROM "ChannelListing" l LEFT JOIN "ChannelConnection" cc ON cc.id = l."channelConnectionId"
    WHERE l."productId"=$1 ORDER BY l.channel, l.marketplace`, [id]), null, 0))
}
await c.end()
