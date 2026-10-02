/**
 * MCP full control P6 — the AI usage summary read moved from ai-usage.routes.ts into ai-usage-summary.service.ts.
 * GET /api/ai/usage/summary answers byte for byte what it answered before (goldens recorded on the route as it was),
 * with business profiles off and on.
 */
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})

import { expectGolden, freezeGoldenClock, goldenApp, GOLDEN_NOW, inGoldenBusiness } from '../../test-support/route-golden.js'
import aiUsageRoutes from '../../routes/ai-usage.routes.js'

const GOLDEN = './__golden__'
const daysAgo = (days: number) => new Date(GOLDEN_NOW.getTime() - days * 86_400_000)

let app: FastifyInstance
beforeAll(async () => {
  freezeGoldenClock()
  const db = state.db.client
  await inGoldenBusiness(async () => {
    const rows = [
      { id: 'golden-ai-1', provider: 'anthropic', model: 'model-a', feature: 'listing-content', inputTokens: 1000, outputTokens: 200, costUSD: '0.123456', createdAt: daysAgo(1) },
      { id: 'golden-ai-2', provider: 'anthropic', model: 'model-a', feature: 'listing-content', inputTokens: 500, outputTokens: 0, costUSD: '0.010000', ok: false, createdAt: daysAgo(2) },
      { id: 'golden-ai-3', provider: 'gemini', model: 'model-b', feature: 'alt-text', inputTokens: 10, outputTokens: 5, costUSD: '0.000500', createdAt: daysAgo(6) },
      { id: 'golden-ai-4', provider: 'gemini', model: 'model-b', feature: null, inputTokens: 7, outputTokens: 7, costUSD: '0.000100', createdAt: daysAgo(20) },
      { id: 'golden-ai-5', provider: 'anthropic', model: 'model-c', feature: 'translate', inputTokens: 3, outputTokens: 3, costUSD: '0.300000', createdAt: daysAgo(80) },
      { id: 'golden-ai-6', provider: 'anthropic', model: 'model-c', feature: 'translate', inputTokens: 3, outputTokens: 3, costUSD: '9.000000', createdAt: daysAgo(120) },
    ]
    for (const row of rows) await db.aiUsageLog.create({ data: row })
  })
  app = await goldenApp([{ plugin: aiUsageRoutes, prefix: '/api' }])
}, 60_000)

afterAll(async () => {
  await app?.close()
  vi.useRealTimers()
})

describe('P6 — AI usage summary: the route answers exactly as before', () => {
  it('GET /api/ai/usage/summary, default and other windows', async () => {
    await expectGolden(app, 'ai-usage-summary', '/api/ai/usage/summary', GOLDEN)
    await expectGolden(app, 'ai-usage-summary-30', '/api/ai/usage/summary?days=30', GOLDEN)
    await expectGolden(app, 'ai-usage-summary-capped', '/api/ai/usage/summary?days=999', GOLDEN)
    await expectGolden(app, 'ai-usage-summary-bad', '/api/ai/usage/summary?days=abc', GOLDEN)
    await expectGolden(app, 'ai-usage-summary-zero', '/api/ai/usage/summary?days=0', GOLDEN)
  })
})
