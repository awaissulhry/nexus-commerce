/**
 * ACR.2.2b/2.3 — a two-route preview server for UI verification. READ-ONLY.
 *
 * Booting the real API locally is not an option here: `apps/api/src/index.ts` registers every
 * cron unconditionally (no NODE_ENV guard), and the local DATABASE_URL is prod Neon — so a dev
 * boot runs the whole account's automation against production. This serves ONLY the two
 * endpoints the Coverage page reads, calling the same service functions the real routes call.
 *
 * Usage: npx tsx scripts/_acr23-preview-server.mts   (listens on 8099)
 */
import '../src/env.js'
import Fastify from 'fastify'
import cors from '@fastify/cors'

await import('../src/db.js')
const { getCoverageScoreboard, coverageMarketplaces } = await import('../src/services/advertising/ads-coverage.service.js')
const { getAccountKeywordContests } = await import('../src/services/advertising/ads-keyword-contests.service.js')

const app = Fastify({ logger: false })
await app.register(cors, { origin: true })

app.get('/api/advertising/coverage/scoreboard', async (request) => {
  const q = request.query as { marketplace?: string; week?: string; limit?: string }
  const markets = await coverageMarketplaces()
  const board = await getCoverageScoreboard({
    marketplace: q.marketplace && markets.includes(q.marketplace) ? q.marketplace : markets[0] ?? 'IT',
    week: q.week,
    limit: q.limit ? Number(q.limit) : undefined,
  })
  return { ...board, marketplaces: markets }
})

app.get('/api/advertising/coverage/contests', async (request) => {
  const q = request.query as { marketplace?: string; windowDays?: string; limit?: string; crossPortfolioOnly?: string }
  return getAccountKeywordContests({
    marketplace: q.marketplace,
    windowDays: q.windowDays ? Number(q.windowDays) : undefined,
    limit: q.limit ? Number(q.limit) : undefined,
    crossPortfolioOnly: q.crossPortfolioOnly === 'true',
  })
})

await app.listen({ port: 8099, host: '127.0.0.1' })
console.log('preview API on http://127.0.0.1:8099 — scoreboard + contests only, no crons')
