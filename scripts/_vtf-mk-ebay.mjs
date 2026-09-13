/**
 * VT.F — FORCE A3's unexercised arm: give `VX-TEST-3AX` an UNLOCKED eBay·IT coordinate.
 *
 * Why this is necessary rather than convenient (`reference_recover_the_arm_you_cannot_observe`): the mouse
 * re-point can only be witnessed on a coordinate whose target control is an ENABLED `Listbox`, i.e. eBay-kind
 * candidates on an UNLOCKED coordinate. Measured on this catalogue: eBay·IT is the ONLY coordinate with cached
 * aspects, and it is LIVE with BOTH axes published, so both its Listboxes are correctly disabled (that is A5
 * working). eBay·DE and Etsy·GLOBAL are unlocked but answer `targetOptionsState: unavailable`. So no existing
 * coordinate can exercise the arm, and the fixture has to.
 *
 * DRAFT, no external id, no `__lastPublishedAxes` — so it is unlocked by construction — and it is removed with
 * the family at item A11. LOCAL DB only.
 */
import { open } from './_vtf-db.mjs'
const c = await open()
const q = async (s, p) => (await c.query(s, p)).rows
const db = (await q('SELECT current_database() AS n'))[0].n
if (db !== 'nexus_development') { console.error(`REFUSING: connected to ${db}`); process.exit(1) }
console.log('current_database:', db)

const gale = (await q(`SELECT "platformAttributes", "channelMarket", region FROM "ChannelListing" WHERE "productId"=$1 AND channel='EBAY' AND marketplace='IT'`, ['cmokmy3a40078pm0p1fvnu523']))[0]
console.log('GALE eBay·IT platformAttributes keys:', Object.keys(gale.platformAttributes ?? {}).join(', '))
console.log('GALE channelMarket / region:', gale.channelMarket, '/', gale.region)

if (process.argv[2] !== '--create') { await c.end(); process.exit(0) }

/* Copy ONLY the category-shaped keys, never `__lastPublishedAxes` (that is the lock) and never the theme. */
const keep = {}
for (const [k, v] of Object.entries(gale.platformAttributes ?? {})) {
  if (/categor/i.test(k) || k === 'itemSpecifics' || k === 'primaryCategory') keep[k] = v
}
console.log('copied keys:', Object.keys(keep).join(', ') || '(none)')
const id = 'vtf_ebay_it_fixture'
await q(`DELETE FROM "ChannelListing" WHERE id=$1`, [id])
await q(
  `INSERT INTO "ChannelListing" (id,"productId","channelMarket",channel,region,marketplace,"aliasKey",version,"listingStatus","channelConnectionId","platformAttributes","updatedAt","createdAt")
   VALUES ($1,$2,$3,'EBAY',$4,'IT','',1,'DRAFT',$5,$6,now(),now())`,
  [id, 'cmtzci5kf0000njr9f8yhrsxm', gale.channelMarket, gale.region, 'cmr4aaqb00025nz016k18rup9', keep],
)
console.log('created:', JSON.stringify(await q(`SELECT id,channel,marketplace,version,"listingStatus","aliasKey" FROM "ChannelListing" WHERE id=$1`, [id])))
await c.end()
