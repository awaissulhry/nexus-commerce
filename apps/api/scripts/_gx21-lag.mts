import '../src/env.js'
const { hourlyPulse } = await import('../src/services/advertising/ads-hourly-pulse.service.js')
const p = await hourlyPulse({ marketplace: 'IT' })
for (const m of p.markets) console.log(`  ${m.marketplace}  last ${m.lastDay}  lag ${m.lagDays}d  idle ${m.idle}`)
const { default: prisma } = await import('../src/db.js'); await prisma.$disconnect()
