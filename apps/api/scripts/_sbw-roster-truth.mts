/**
 * NAF.SB.W — read-only: what the Workers page will actually have to render.
 * Answers the questions the design depends on: how many charter rows exist,
 * how many runs each worker has, how they failed, whether scorecards exist,
 * whether any charter revision has ever been authored.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const charters = await prisma.agentCharter.findMany({
  orderBy: [{ tier: 'asc' }, { key: 'asc' }],
  select: {
    key: true, version: true, tier: true, domain: true, name: true,
    enabled: true, autonomyLevel: true, autonomyCap: true, cadence: true,
    dailyBudgetUSD: true, maxTokensPerRun: true, modelFeature: true,
    scopeMarketplaces: true, scopeCampaignIds: true, pausedUntil: true,
    createdBy: true, createdAt: true,
    modelProviderOverride: true, modelNameOverride: true,
  },
})

const runs = await prisma.agentRun.groupBy({
  by: ['agentKey', 'status'],
  _count: { _all: true },
  where: { mode: { not: null } },
})

const runModes = await prisma.agentRun.groupBy({
  by: ['mode'],
  _count: { _all: true },
  where: { mode: { not: null } },
})

const errs = await prisma.agentRun.findMany({
  where: { mode: { not: null }, ok: false },
  select: { agentKey: true, errorMessage: true, createdAt: true },
  orderBy: { createdAt: 'desc' },
  take: 10,
})

const findings = await prisma.agentFinding.groupBy({
  by: ['charterKey', 'status'],
  _count: { _all: true },
})

const cards = await prisma.agentScorecard.count()
const revisions = await prisma.agentCharterRevision.count()
const audits = await prisma.agentControlAudit.count()
const approvals = await prisma.agentApproval.groupBy({
  by: ['status'],
  _count: { _all: true },
})

console.log(JSON.stringify({
  charters, runs, runModes, errs, findings,
  counts: { scorecards: cards, revisions, controlAudits: audits },
  approvals,
}, null, 2))

await prisma.$disconnect()
