/**
 * Reviews › Etsy and Shopify (2026-10-27, build spec §3.5 / B21, PR I). Under `/api/reviews`, so the permission
 * manifest's Reviews rule applies (GET = reviews.view, writes = reviews.manage). No Prisma here: the services do the work.
 *
 *   GET    /api/reviews/area/shop-channel?channel=ETSY|SHOPIFY
 *       → { channel, label, generatedAt, sections } — Etsy: { source, tiles, reviews }; Shopify: { app, tiles, reviews };
 *         each section `{ ok: true, data } | { ok: false, error }`
 *   GET    /api/reviews/apps                → { apps: ReviewAppView[], readOn } — never a token
 *   POST   /api/reviews/apps/:app           the app's fields (Judge.me { shopDomain, apiToken }, Okendo { userId, apiKey },
 *                                           Yotpo { storeId, apiSecret }, Loox { storeId, apiKey }) → { app } (the secret is
 *                                           stored encrypted; 400 in words, 404 for an unknown app)
 *   DELETE /api/reviews/apps/:app           → { app } (the secret is deleted; the reviews already read stay)
 *
 * The request body of the connect call holds a secret: it is never logged here (request.log does not redact).
 */
import type { FastifyPluginAsync } from 'fastify'
import { requestUserId } from '../lib/auth/request-permission.js'
import { connectReviewApp, disconnectReviewApp, listReviewApps } from '../services/reviews/review-app-connection.service.js'
import { reviewsShopChannel, ShopChannelInputError } from '../services/reviews/review-shop-channel.service.js'
import { logger } from '../utils/logger.js'

const reviewShopChannelsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/reviews/area/shop-channel', async (request, reply) => {
    const q = (request.query ?? {}) as { channel?: string }
    try {
      const page = await reviewsShopChannel({ channel: q.channel })
      reply.header('Cache-Control', 'private, no-store')
      return page
    } catch (err) {
      if (err instanceof ShopChannelInputError) return reply.code(400).send({ error: err.message })
      logger.warn('[reviews-shop-channel] failed', { error: err instanceof Error ? err.message : String(err) })
      return reply.code(500).send({ error: 'This channel page could not be read. Try again in a moment.' })
    }
  })

  fastify.get('/reviews/apps', async (_request, reply) => {
    try {
      reply.header('Cache-Control', 'private, no-store')
      return await listReviewApps()
    } catch (err) {
      logger.warn('[review-apps] list failed', { error: err instanceof Error ? err.message : String(err) })
      return reply.code(500).send({ error: 'The review apps could not be read. Try again in a moment.' })
    }
  })

  fastify.post<{ Params: { app: string } }>('/reviews/apps/:app', async (request, reply) => {
    const actor = requestUserId(request)
    try {
      const result = await connectReviewApp(request.params.app, request.body, actor)
      if (result.ok === false) return reply.code(result.status).send({ error: result.error, message: result.words })
      reply.header('Cache-Control', 'private, no-store')
      return { app: result.app }
    } catch (err) {
      // Never the body (it holds the secret): the error's name only.
      logger.warn('[review-apps] connect failed', { error: err instanceof Error ? err.name : 'error' })
      return reply.code(500).send({ error: 'connect_failed', message: 'The review app could not be connected. Nothing was saved. Try again in a moment.' })
    }
  })

  fastify.delete<{ Params: { app: string } }>('/reviews/apps/:app', async (request, reply) => {
    const actor = requestUserId(request)
    try {
      const result = await disconnectReviewApp(request.params.app, actor)
      if (result.ok === false) return reply.code(result.status).send({ error: result.error, message: result.words })
      return { app: result.app }
    } catch (err) {
      logger.warn('[review-apps] disconnect failed', { error: err instanceof Error ? err.message : String(err) })
      return reply.code(500).send({ error: 'disconnect_failed', message: 'The review app could not be disconnected. Try again in a moment.' })
    }
  })
}

export default reviewShopChannelsRoutes
