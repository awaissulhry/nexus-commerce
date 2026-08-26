// NAF.C post-deploy — C-D5: pin the critic to a DIFFERENT model than the
// director (same-vendor-different-model, the recorded deviation from the
// brief's different-vendor ideal). Director inherits the global sonnet-4-6
// pref; the critic pins haiku-4-5 like the analysts.
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pinned = await prisma.aiFeatureModelPref.upsert({
  where: { featureKey: 'agent-fleet-critic' },
  create: {
    featureKey: 'agent-fleet-critic',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    updatedBy: null,
  },
  update: { provider: 'anthropic', model: 'claude-haiku-4-5' },
})
console.log('pinned:', pinned.featureKey, '→', pinned.provider, pinned.model)

const all = await prisma.aiFeatureModelPref.findMany({
  where: { featureKey: { startsWith: 'agent-fleet' } },
  select: { featureKey: true, provider: true, model: true },
})
console.log('fleet prefs now:', JSON.stringify(all, null, 2))
await prisma.$disconnect()
