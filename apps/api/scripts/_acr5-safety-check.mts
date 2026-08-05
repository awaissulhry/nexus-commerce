/**
 * ACR Stage 5 — did anything get created while testing? READ-ONLY.
 * Run after any UI exercise that touches a create endpoint.
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()

const total = await p.campaign.count()
const recent = await p.campaign.findMany({
  where: { createdAt: { gte: new Date(Date.now() - 3600_000) } },
  select: { name: true, adProduct: true, status: true, createdAt: true, externalCampaignId: true },
  orderBy: { createdAt: 'desc' },
})
console.log(`total campaigns: ${total}`)
console.log(`created in the last hour: ${recent.length}`)
for (const r of recent) {
  console.log(`  ${r.createdAt.toISOString()}  ${r.adProduct}  ${r.status}  ${JSON.stringify(r.name)}  ext=${r.externalCampaignId}`)
}
console.log(recent.length === 0 ? '\nPASS — nothing was created.' : '\n⚠ REVIEW the rows above.')
await p.$disconnect(); process.exit(0)
