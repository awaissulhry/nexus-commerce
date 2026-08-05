const { default: prisma } = await import('../src/db.js')
// Which of the July-20 zero-over-null pushes came from a LEDGER-EMPTY product (true UNCOUNTED)?
const pids = await prisma.$queryRawUnsafe<any[]>(`
  SELECT DISTINCT q."productId" FROM "OutboundSyncQueue" q
  WHERE q.payload->>'source'='STOCK_MOVEMENT' AND q.payload->>'quantity'='0'
    AND q.payload->'oldQuantity'='null'::jsonb`)
console.log('distinct products in zero-over-null pushes:', pids.length)
let ledgerEmpty = 0, ledgerRows = 0
for (const p of pids) {
  const n = await prisma.stockLevel.count({ where: { productId: p.productId, location: { type: 'WAREHOUSE' } } })
  if (n === 0) ledgerEmpty++; else ledgerRows++
}
console.log('  of those, ledger-EMPTY (true UNCOUNTED at cascade time, modulo later changes):', ledgerEmpty, ' with rows:', ledgerRows)

// Currently ARMED: listing quantity NULL, follow, not paused, non-FBA, product has ZERO warehouse ledger rows
const armed = await prisma.$queryRawUnsafe<any[]>(`
  SELECT cl.id, p.sku, p.id AS pid, cl.channel, cl.marketplace, cl."externalListingId", cl."isPublished",
         cl."listingStatus", cl."fulfillmentMethod", p."fulfillmentMethod" AS pff, cl."lastSyncStatus",
         (SELECT count(*)::int FROM "Product" c WHERE c."parentId"=p.id) AS kids
  FROM "ChannelListing" cl JOIN "Product" p ON p.id = cl."productId"
  WHERE cl.quantity IS NULL AND cl."followMasterQuantity" = true AND cl."syncPaused" = false
    AND NOT EXISTS (SELECT 1 FROM "StockLevel" s JOIN "StockLocation" l ON l.id=s."locationId"
                    WHERE s."productId"=p.id AND l.type='WAREHOUSE')
  ORDER BY cl.channel, p.sku`)
console.log('ARMED listings (null qty + follow + unpaused + ledger-empty):', armed.length)
for (const a of armed) console.log(' ', JSON.stringify(a))
await prisma.$disconnect()
