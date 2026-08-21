import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const [total, enabled, allow, allowEnabled] = await Promise.all([
  prisma.campaign.count(),
  prisma.campaign.count({ where: { status: 'ENABLED' } }),
  prisma.campaign.count({ where: { liveBidWritesEnabled: true } }),
  prisma.campaign.count({ where: { status: 'ENABLED', liveBidWritesEnabled: true } }),
])
console.log(JSON.stringify({ total, enabled, allow, allowEnabled, mode: process.env.NEXUS_AMAZON_ADS_MODE ?? '(unset locally — check Railway)' }))
await prisma.$disconnect()
