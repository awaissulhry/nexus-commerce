// SG.2 — remove the preview rows seeded by _sg2-seed-preview.mts
import prisma from '../src/db.js'
const res = await prisma.adsRuleSuggestion.deleteMany({ where: { ruleId: 'sg2-preview' } })
console.log('deleted', res.count)
process.exit(0)
