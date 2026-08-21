/** SG.8 — remove the verification fixtures (twin of `_sg8-seed-ai-verify.mts`). */
import prisma from '../src/db.js'

const d = await prisma.autopilotDecision.deleteMany({ where: { planId: { in: ['sg8-verify-plan-off', 'sg8-verify-plan-on'] } } })
const p = await prisma.autopilotPlan.deleteMany({ where: { id: { in: ['sg8-verify-plan-off', 'sg8-verify-plan-on'] } } })
console.log('deleted', d.count, 'decisions,', p.count, 'plans')
await prisma.$disconnect()
