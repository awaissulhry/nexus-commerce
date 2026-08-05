/** ACR.0.7 — does the deployed gate actually deny while halted? READ-ONLY (no write attempted). */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const prisma = (await import('../src/db.js')).default
const { checkAdsWriteGate } = await import('../src/services/advertising/ads-write-gate.js')
const { getAutomationState } = await import('../src/services/advertising/ads-automation-state.service.js')
const { adsMode } = await import('../src/services/advertising/ads-api-client.js')

const st = await getAutomationState()
console.log(`adsMode=${adsMode()}  autonomy=${st.autonomy} halted=${st.halted} effectivelyStopped=${st.effectivelyStopped} degraded=${st.degraded}`)

const c = await prisma.campaign.findFirst({ where: { liveBidWritesEnabled: true }, select: { id: true, marketplace: true, name: true } })
console.log(`probe campaign: ${c?.name} (${c?.marketplace})`)
if (c) {
  const ordinary = await checkAdsWriteGate({ marketplace: c.marketplace, campaignId: c.id, payloadValueCents: 0 })
  console.log('\nORDINARY write  →', JSON.stringify(ordinary))
  const suppress = await checkAdsWriteGate({ marketplace: c.marketplace, campaignId: c.id, payloadValueCents: 0, field: 'bid', intendedValueCents: 2, isSuppression: true })
  console.log('SUPPRESSION     →', JSON.stringify(suppress))
}
await prisma.$disconnect(); process.exit(0)
