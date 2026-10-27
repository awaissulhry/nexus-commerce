/**
 * Reviews area (2026-10-26, build spec §3.1 / B2) — the Overview page's reads. Read only; under `/api/reviews`, so the
 * permission manifest's Reviews rule applies (GET = reviews.view). No Prisma here: the services do the work.
 *
 *   GET /api/reviews/area/overview?period=7d|30d|90d|12m|all&channel=&market=
 *       → { period, generatedAt, sections: { tiles, trend, spread, channels, themes, watch, setup } },
 *         each section `{ ok: true, data } | { ok: false, error }` (one failed read shows only in its card)
 *   GET /api/reviews/area/needs-you?only=reply|requests|alerts&limit=8
 *       → { items, total, counts }
 *   GET /api/reviews/area/channel?channel=AMAZON|EBAY&market=IT&period=7d|30d|90d|12m   (PR F, build spec §3.5)
 *       → { channel, market, label, period, generatedAt, markets, sections } — Amazon: { tiles, trend, spread, topics,
 *         requests, watch }; eBay: { readState, tiles, summary, feedback }; each section `{ ok, data } | { ok: false, error }`
 *   GET /api/reviews/area/channel-markets → { AMAZON: { code, label }[], EBAY: { code, label }[] } (the sub-sidebar's rows)
 *   GET  /api/reviews/amazon/seller-feedback        (PR H, build spec B20) → each Amazon market's fetch state in words,
 *        whether "Fetch now" may run and why not
 *   POST /api/reviews/amazon/seller-feedback/fetch  → 202 { ok: true, words, state } (Nexus asks Amazon for the 1–3 star
 *        seller feedback report now, in the background) | 409 { ok: false, held, state }. A write, so `reviews.manage`;
 *        a double-click must not ask twice (COMMAND_SCOPES, Idempotency-Key). Never asks Amazon to remove feedback.
 */
import type { FastifyPluginAsync } from 'fastify'
import { reviewsOverview } from '../services/reviews/review-overview.service.js'
import { reviewNeedsYou } from '../services/reviews/review-needs-you.service.js'
import { ChannelInputError, reviewChannelMarkets, reviewsChannel } from '../services/reviews/review-channel.service.js'
import { readSellerFeedbackState, requestSellerFeedbackFetch } from '../services/reviews/amazon-seller-feedback.service.js'
import { logger } from '../utils/logger.js'

const reviewsAreaRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/reviews/area/overview', async (request, reply) => {
    const q = (request.query ?? {}) as { period?: string; channel?: string; market?: string }
    try {
      const overview = await reviewsOverview({ period: q.period, channel: q.channel, market: q.market })
      reply.header('Cache-Control', 'private, no-store')
      return overview
    } catch (err) {
      logger.warn('[reviews-area] overview failed', { error: err instanceof Error ? err.message : String(err) })
      return reply.code(500).send({ error: 'The Overview could not be read. Try again in a moment.' })
    }
  })

  fastify.get('/reviews/area/needs-you', async (request, reply) => {
    const q = (request.query ?? {}) as { only?: string; limit?: string }
    try {
      const needs = await reviewNeedsYou({ only: q.only, limit: q.limit })
      reply.header('Cache-Control', 'private, no-store')
      return needs
    } catch (err) {
      logger.warn('[reviews-area] needs-you failed', { error: err instanceof Error ? err.message : String(err) })
      return reply.code(500).send({ error: 'What needs you could not be read. Try again in a moment.' })
    }
  })

  fastify.get('/reviews/area/channel', async (request, reply) => {
    const q = (request.query ?? {}) as { channel?: string; market?: string; period?: string }
    try {
      const page = await reviewsChannel({ channel: q.channel, market: q.market, period: q.period })
      reply.header('Cache-Control', 'private, no-store')
      return page
    } catch (err) {
      if (err instanceof ChannelInputError) return reply.code(400).send({ error: err.message })
      logger.warn('[reviews-area] channel failed', { error: err instanceof Error ? err.message : String(err) })
      return reply.code(500).send({ error: 'This channel page could not be read. Try again in a moment.' })
    }
  })

  fastify.get('/reviews/area/channel-markets', async (_request, reply) => {
    try {
      const markets = await reviewChannelMarkets()
      reply.header('Cache-Control', 'private, no-store')
      return markets
    } catch (err) {
      logger.warn('[reviews-area] channel markets failed', { error: err instanceof Error ? err.message : String(err) })
      return reply.code(500).send({ error: 'The channel markets could not be read. Try again in a moment.' })
    }
  })

  fastify.get('/reviews/amazon/seller-feedback', async (_request, reply) => {
    try {
      const state = await readSellerFeedbackState()
      reply.header('Cache-Control', 'private, no-store')
      return state
    } catch (err) {
      logger.warn('[reviews-area] seller feedback state failed', { error: err instanceof Error ? err.message : String(err) })
      return reply.code(500).send({ error: 'Nexus could not read the seller feedback fetches. Try again in a moment.' })
    }
  })

  fastify.post('/reviews/amazon/seller-feedback/fetch', async (_request, reply) => {
    try {
      const answer = await requestSellerFeedbackFetch()
      // A held press answers 409 with its reason as the error sentence (the web shows it; nothing was asked of Amazon).
      return answer.ok ? reply.code(202).send(answer) : reply.code(409).send({ ...answer, error: answer.held })
    } catch (err) {
      logger.warn('[reviews-area] seller feedback fetch failed', { error: err instanceof Error ? err.message : String(err) })
      return reply.code(500).send({ error: 'Nexus could not ask Amazon for the report. Nothing was fetched. Try again in a moment.' })
    }
  })
}

export default reviewsAreaRoutes
