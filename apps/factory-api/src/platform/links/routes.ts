import { idempotencyKeyFrom } from '../../core/command'
import { actorOf, requireContext } from '../../core/context'
import { defineRoutes } from '../../core/manifest'
import { AUTH_RATE_LIMITS, officeAuthOf } from '../auth/sessions/office-auth'
import { createLinkContract, listLinksContract, openLinkContract, revokeLinkContract } from './contract'
import { createLink, listLinks, revokeLink } from './links'
import { manifest } from './manifest'
import { linkCommand, openedView, useLink } from './use'

/**
 * One-off links (plan A1 §3.10 "Links"; features SAL-099, PLT-007):
 *
 * GET  /links?recordType=&recordId=   office: a record's links, their state and evidence
 * POST /links                         office: make a link for a record; the answer shows its URL this once
 * POST /links/:linkId/revoke          office: the link opens nothing from now on
 * POST /link/open                     link session (token in x-factory-link, Idempotency-Key required): opens the link,
 *                                     records the open (counted for the view purposes) and says what it allows
 *
 * The link-session route is rate limited per client address (AuthRateLimits.linkUse) on top of the app's limit; every
 * link that opens nothing answers the same 404 (platform/links/authenticator.ts).
 */
export default defineRoutes('links', manifest, async (app) => {
  const linkUse = app.officeAuth?.rateLimits.linkUse ?? AUTH_RATE_LIMITS.linkUse
  const limited = { rateLimit: { max: linkUse.max, timeWindow: linkUse.timeWindowMs } }

  app.get('/links', { schema: listLinksContract }, async (request) => {
    const actor = actorOf(requireContext(request))
    const now = officeAuthOf(app).clock.now()
    const links = await request.withClient((client) => listLinks(client, actor, request.query, now))
    return { links }
  })

  app.post('/links', { schema: createLinkContract }, async (request, reply) => {
    const created = await createLink(request, request.body, idempotencyKeyFrom(request))
    return reply.code(201).send(created)
  })

  app.post('/links/:linkId/revoke', { schema: revokeLinkContract }, async (request) => {
    const link = await revokeLink(request, request.params.linkId, request.body, idempotencyKeyFrom(request))
    return { link }
  })

  app.post('/link/open', { schema: openLinkContract, config: limited }, async (request) => {
    const { result } = await linkCommand(request, { name: 'links.open', idempotencyKey: idempotencyKeyFrom(request), input: {} }, async (tools) => {
      const use = await useLink(tools, request, { action: 'open' })
      return { link: openedView(request, use) }
    })
    return result
  })
})
