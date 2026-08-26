// SG.2 — read-only: what suggestion rows exist and in what status
import prisma from '../src/db.js'
const rows = await prisma.adsRuleSuggestion.findMany({ select: { id: true, status: true, decidedAt: true, decidedBy: true, lastSeenAt: true, ruleName: true } })
console.log(JSON.stringify(rows, null, 1))
process.exit(0)
