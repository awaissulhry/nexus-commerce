/** NAF.AQ.6 — seed ONE inert create-negative-keyword approval so the
 *  homogeneity refusal (a bulk approve spanning two action kinds) can be
 *  exercised on prod. Preview hand-written; touches no real entity; the tool
 *  is preview-only so it can never execute. Cleaned by _apx-seed-card clean. */
import '../src/env.js'
import prisma from '../src/db.js'
const run = await prisma.agentRun.create({
  data: { agentKey: 'amazon-negative-miner', trigger: 'AQ-VERIFY-SEED', mode: 'preview',
          status: 'done', ok: true, endedAt: new Date() },
})
const ap = await prisma.agentApproval.create({
  data: {
    agentRunId: run.id, toolName: 'create-negative-keyword', riskTier: 'high',
    args: { externalCampaignId: 'seed', keywordText: 'seed term' },
    preview: { action: 'create-negative-keyword', term: 'seed term', matchType: 'NEGATIVE_EXACT',
      scope: 'AD_GROUP', campaign: { id: 'seed', name: 'SEED campaign' },
      metrics: { costCents: 0, orders: 0, clicks: 0, windowDays: 60 },
      effect: 'Stops "seed term" from matching in SEED campaign.' },
    status: 'pending', expiresAt: new Date(Date.now() + 24*3600*1000),
  },
})
console.log(`seeded ${ap.id}`)
await prisma.$disconnect()
