/** SG.9 — remove the pause-check fixture (twin of _sg9-seed-pause-check.mts). */
import prisma from '../src/db.js'
const d = await prisma.adsRuleSuggestion.deleteMany({ where: { ruleId: 'sg9-preview' } })
const m = await prisma.adsSuggestionMute.deleteMany({ where: { reason: { contains: 'sg9' } } })
console.log('deleted', d.count, 'suggestions,', m.count, 'mutes')
await prisma.$disconnect()
