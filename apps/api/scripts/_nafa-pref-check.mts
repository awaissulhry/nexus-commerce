import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const prefs = await prisma.aiFeatureModelPref.findMany({
  select: { featureKey: true, provider: true, model: true },
})
console.log('AiFeatureModelPref rows:', JSON.stringify(prefs, null, 2))
await prisma.$disconnect()
