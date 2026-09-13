/** VT.F — read GALE's eBay·IT listing shape so an UNLOCKED eBay coordinate can be made on the FIXTURE. */
import { open } from './_vtf-db.mjs'
const c = await open()
const q = async (s, p) => (await c.query(s, p)).rows
console.log('GALE eBay·IT listing:', JSON.stringify(await q(
  `SELECT id, channel, marketplace, "aliasKey", version, "listingStatus", "channelConnectionId",
          "variationTheme", "platformAttributes"->'__lastPublishedAxes' AS pub
     FROM "ChannelListing" WHERE "productId"=$1 AND channel='EBAY' AND marketplace='IT'`, ['cmokmy3a40078pm0p1fvnu523'])))
console.log('\ncolumns of ChannelListing:', (await q(
  `SELECT column_name, is_nullable, column_default FROM information_schema.columns
    WHERE table_name='ChannelListing' AND is_nullable='NO' AND column_default IS NULL ORDER BY ordinal_position`))
  .map(r => r.column_name).join(', '))
await c.end()
