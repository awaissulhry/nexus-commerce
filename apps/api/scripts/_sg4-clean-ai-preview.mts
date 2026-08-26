/** SG.4 — remove the preview AutopilotPlan + its decisions (twin of _sg4-seed-ai-preview.mts). */
import prisma from '../src/db.js'

const del = await prisma.autopilotDecision.deleteMany({ where: { planId: 'sg4-preview-plan' } })
const plan = await prisma.autopilotPlan.deleteMany({ where: { id: 'sg4-preview-plan' } })
console.log('deleted decisions:', del.count, 'plans:', plan.count)
await prisma.$disconnect()
