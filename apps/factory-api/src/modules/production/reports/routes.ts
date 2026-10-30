import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { changeSubscriptionContract, dailyContract, linesContract, recipientsContract, subscribeContract, subscriptionsContract } from './contract'
import { dailyAnswer } from './daily'
import { linesAnswer } from './lines'
import { manifest } from './manifest'
import { changeSubscription, listRecipients, listSubscriptions, subscribe } from './subscriptions'

/**
 * Production reports (B-W2a-38; MES-301 daily production report, MES-160 the floor overview by line; design
 * production.reports, production.floor "Lines"): per line, work centre, style and size, never per person. The e-mail
 * settings are ReportSubscription rows (one per recipient); the clustered cron `production.dailyReport` (./mail.ts)
 * sends them. Every write is one command; a repeated Idempotency-Key answers from its receipt.
 */
export default defineRoutes('production.reports', manifest, async (app) => {
  app.get('/production/reports/daily', { schema: dailyContract }, async (request) => dailyAnswer(request, request.query))
  app.get('/production/reports/lines', { schema: linesContract }, async (request) => linesAnswer(request, request.query))
  app.get('/production/reports/subscriptions', { schema: subscriptionsContract }, async (request) => listSubscriptions(request, request.query))
  app.get('/production/reports/recipients', { schema: recipientsContract }, async (request) => listRecipients(request, request.query.siteId))

  app.post('/production/reports/subscriptions', { schema: subscribeContract }, async (request, reply) => {
    const result = await subscribe(request, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send({ subscriptions: result.subscriptions })
  })

  app.patch('/production/reports/subscriptions/:subscriptionId', { schema: changeSubscriptionContract }, async (request) =>
    changeSubscription(request, request.params.subscriptionId, request.body, idempotencyKeyFrom(request)),
  )
})
