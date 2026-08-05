const { default: prisma } = await import('../src/db.js')
const pids = [
  'cmokmy2v90066pm0p7ifrbajf','cmokmy2sn005zpm0pj8hz272g','cmokmy2sa005ypm0pqmy4w542',
  'cmokmy0j10002pm0pnoc35oao','cmokmy10w001cpm0pwcp6d8gv','cmokmy10i001bpm0pdh950vno',
  'cmokmy105001apm0pl1oz4pua','cmokmy2220044pm0pmgrexuct',
]
const cls = await prisma.channelListing.findMany({
  where: { productId: { in: pids }, channel: 'AMAZON', marketplace: 'ES' },
  select: { id: true, productId: true, quantity: true, followMasterQuantity: true, syncPaused: true, isPublished: true, listingStatus: true, fulfillmentMethod: true, product: { select: { sku: true, fulfillmentMethod: true } } },
})
console.log('AMAZON/ES rows for those products:', cls.length)
for (const c of cls) console.log(c.product?.sku, '| clFm=', c.fulfillmentMethod, '| prodFm=', c.product?.fulfillmentMethod, '| qty=', c.quantity, '| pub=', c.isPublished, '| status=', c.listingStatus, '| follow=', c.followMasterQuantity, '| paused=', c.syncPaused)
await prisma.$disconnect()
