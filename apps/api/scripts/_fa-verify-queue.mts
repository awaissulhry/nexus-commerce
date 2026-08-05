const { default: prisma } = await import('../src/db.js')
// rows where cascade wrote 0 over a null stored qty
const rows = await prisma.$queryRawUnsafe<any[]>(`
  SELECT id, "productId", "targetChannel", "syncType", "syncStatus", "externalListingId",
         payload->>'quantity' AS q, payload->>'oldQuantity' AS oldq, payload->>'reason' AS reason,
         payload->>'source' AS src, "errorMessage", "createdAt"
  FROM "OutboundSyncQueue"
  WHERE payload->>'source' = 'STOCK_MOVEMENT'
    AND payload->>'quantity' = '0'
    AND payload->'oldQuantity' = 'null'::jsonb
  ORDER BY "createdAt" DESC LIMIT 25`)
console.log('zero-over-null rows:', rows.length)
for (const r of rows) console.log(JSON.stringify(r))
const counts = await prisma.$queryRawUnsafe<any[]>(`
  SELECT "targetChannel", "syncStatus", count(*)::int AS n
  FROM "OutboundSyncQueue"
  WHERE payload->>'source' = 'STOCK_MOVEMENT' AND payload->>'quantity' = '0'
    AND payload->'oldQuantity' = 'null'::jsonb
  GROUP BY 1,2 ORDER BY 3 DESC`)
console.log('counts', JSON.stringify(counts))
await prisma.$disconnect()
