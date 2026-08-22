/** FB.3e — read-only: recent bid-field AdvertisingChange rows, to prove the stored unit. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT field, "oldValue", "newValue", "changedAt"::date AS day
  FROM "CampaignBidHistory"
  WHERE field IN ('bid','defaultBid','dailyBudget')
  ORDER BY "changedAt" DESC LIMIT 12`)
for (const r of rows) console.log('ROW', JSON.stringify(r))
await prisma.$disconnect()
