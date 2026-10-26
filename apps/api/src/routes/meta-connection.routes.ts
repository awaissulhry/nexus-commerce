/**
 * Meta ads, step 1 (2026-10-20) — the business's Meta connection and its asset choice. The logic lives in
 * services/cx/connectors/meta/connect.ts and services/meta/meta-accounts.service.ts; this file parses, calls them and
 * maps their errors. Nothing here changes anything at Meta: Meta is only read (GET, through the gateway).
 *
 *   GET  /api/meta-ads/connections                         C1  { items: MetaConnection[] }
 *   POST /api/meta-ads/connect                             connect Meta: { appId, appSecret, systemUserToken } (write-only;
 *                                                          the secret and the token are never answered or logged)
 *   PUT  /api/meta-ads/connections/:id/credentials         replace the app id, app secret and token of this connection
 *   POST /api/meta-ads/connections/:id/token-check         ask Meta about the token now (debug_token)
 *   GET  /api/meta-ads/connections/:id/choices[?refresh=1] C2  what the system user can see (Meta asked at most once per
 *                                                          5 minutes; refresh=1 asks again now)
 *   PUT  /api/meta-ads/connections/:id/selection           C3  { adAccountId, pageId?, instagramId? }
 *   GET  /api/meta-ads/conversions-api                     step 33: the business's "Send sales to Meta" switch { on, since, by },
 *                                                          and canChange (this person has settings.security.manage)
 *   PUT  /api/meta-ads/conversions-api                     { on: boolean } — a person with settings.security.manage turns it on
 *                                                          or off (Claude cannot); off by default (D2). Answers { switch, changed }.
 *   GET  /api/meta-ads/customer-lists                      consent PR 2: the business's "Upload customer lists to Meta" switch
 *                                                          { on, since, by }, and canChange (this person has settings.security.manage)
 *   PUT  /api/meta-ads/customer-lists                      { on: boolean } — a person with settings.security.manage turns it on
 *                                                          or off (Claude cannot); off by default (D8). Answers { switch, changed }.
 *
 * Disconnect is the shared POST /api/cx/connections/:id/revoke (it also lets go of this business's Meta picks).
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { logger } from '../utils/logger.js'
import { connectMeta, MetaConnectError, recheckMetaToken } from '../services/cx/connectors/meta/connect.js'
import {
  getMetaChoices, listMetaConnections, metaChoicesAnswer, MetaConnectionNotFound, MetaSelectionError, saveMetaSelection,
} from '../services/meta/meta-accounts.service.js'
import { FEATURES as F } from '@nexus/shared/permissions'
import { assertRequestPermission } from '../lib/auth/request-permission.js'
import { metaEventsSwitch, setMetaEventsSwitch } from '../services/marketing/meta-ads/events-switch.js'
import { metaCustomerListsSwitch, setMetaCustomerListsSwitch } from '../services/marketing/meta-ads/customer-lists-switch.js'

const actorOf = (request: unknown) => ({ kind: 'operator' as const, userId: (request as { authUser?: { id?: string } }).authUser?.id ?? null })

function fail(reply: FastifyReply, err: unknown, what: string) {
  if (err instanceof MetaConnectError) return reply.code(err.statusCode).send({ code: err.code, error: err.message })
  if (err instanceof MetaSelectionError) return reply.code(err.statusCode).send({ code: err.code, error: err.message, product: err.product })
  if (err instanceof MetaConnectionNotFound) return reply.code(404).send({ code: 'not_found', error: err.message })
  const status = (err as { statusCode?: unknown })?.statusCode
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return reply.code(status).send({ error: err instanceof Error ? err.message : `Nexus could not ${what}.` })
  }
  // Never the body: it holds the app secret and the token.
  logger.error(`[meta-connection] ${what} failed`, { error: err instanceof Error ? err.message : String(err) })
  return reply.code(500).send({ error: `Nexus could not ${what}. Try again in a minute.` })
}

export default async function metaConnectionRoutes(app: FastifyInstance) {
  app.get('/meta-ads/connections', async (_request, reply) => {
    try {
      return reply.send({ items: await listMetaConnections() })
    } catch (err) {
      return fail(reply, err, 'load the Meta connection')
    }
  })

  app.post('/meta-ads/connect', async (request, reply) => {
    try {
      return reply.send(await connectMeta({ body: request.body, actor: actorOf(request) }))
    } catch (err) {
      return fail(reply, err, 'connect Meta')
    }
  })

  app.put<{ Params: { id: string } }>('/meta-ads/connections/:id/credentials', async (request, reply) => {
    try {
      return reply.send(await connectMeta({ body: request.body, targetConnectionId: request.params.id, actor: actorOf(request) }))
    } catch (err) {
      return fail(reply, err, 'replace the Meta credentials')
    }
  })

  app.post<{ Params: { id: string } }>('/meta-ads/connections/:id/token-check', async (request, reply) => {
    try {
      return reply.send({ token: await recheckMetaToken(request.params.id) })
    } catch (err) {
      return fail(reply, err, 'check the Meta token')
    }
  })

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>('/meta-ads/connections/:id/choices', async (request, reply) => {
    try {
      const force = request.query?.refresh === '1' || request.query?.refresh === 'true'
      return reply.send(await metaChoicesAnswer(await getMetaChoices(request.params.id, { force })))
    } catch (err) {
      return fail(reply, err, 'list what this Meta system user can see')
    }
  })

  app.put<{ Params: { id: string } }>('/meta-ads/connections/:id/selection', async (request, reply) => {
    try {
      const saved = await saveMetaSelection(request.params.id, request.body, { userId: actorOf(request).userId })
      return reply.send({ connection: saved.connection })
    } catch (err) {
      return fail(reply, err, 'save the Meta assets')
    }
  })

  // Meta step 33 (D2) — "Send sales to Meta (Conversions API)": a person's own switch, per business (events-switch.ts).
  app.get('/meta-ads/conversions-api', async (request, reply) => {
    try {
      const canChange = await assertRequestPermission(request, F.settingsSecurityManage).then(() => true, () => false)
      return reply.send({ switch: await metaEventsSwitch(), canChange })
    } catch (err) {
      return fail(reply, err, 'read the "Send sales to Meta" switch')
    }
  })

  app.put('/meta-ads/conversions-api', async (request, reply) => {
    const on = (request.body as { on?: unknown } | null)?.on
    if (typeof on !== 'boolean') return reply.code(400).send({ error: 'on must be true or false.' })
    // A person's own switch: a signed-in person with settings.security.manage, checked here as well as by the RBAC hook
    // (review F6) — never an API key or Claude (Claude has no route here).
    const user = (request as { authUser?: { id?: string; email?: string; displayName?: string | null } }).authUser
    if (!user?.id) return reply.code(403).send({ error: 'A person signed in to Nexus turns this switch on or off.' })
    try {
      await assertRequestPermission(request, F.settingsSecurityManage)
    } catch {
      return reply.code(403).send({ error: 'Turning "Send sales to Meta" on or off needs the permission to manage the business\'s security (settings.security.manage).' })
    }
    try {
      return reply.send(await setMetaEventsSwitch(on, { label: user.displayName?.trim() || user.email || user.id }))
    } catch (err) {
      return fail(reply, err, 'change the "Send sales to Meta" switch')
    }
  })

  // Meta consent PR 2 (D8) — "Upload customer lists to Meta": a person's own switch, per business (customer-lists-switch.ts),
  // checked exactly as step 33's.
  app.get('/meta-ads/customer-lists', async (request, reply) => {
    try {
      const canChange = await assertRequestPermission(request, F.settingsSecurityManage).then(() => true, () => false)
      return reply.send({ switch: await metaCustomerListsSwitch(), canChange })
    } catch (err) {
      return fail(reply, err, 'read the "Upload customer lists to Meta" switch')
    }
  })

  app.put('/meta-ads/customer-lists', async (request, reply) => {
    const on = (request.body as { on?: unknown } | null)?.on
    if (typeof on !== 'boolean') return reply.code(400).send({ error: 'on must be true or false.' })
    // A person's own switch: a signed-in person with settings.security.manage, checked here as well as by the RBAC hook —
    // never an API key or Claude (Claude has no route here).
    const user = (request as { authUser?: { id?: string; email?: string; displayName?: string | null } }).authUser
    if (!user?.id) return reply.code(403).send({ error: 'A person signed in to Nexus turns this switch on or off.' })
    try {
      await assertRequestPermission(request, F.settingsSecurityManage)
    } catch {
      return reply.code(403).send({ error: 'Turning "Upload customer lists to Meta" on or off needs the permission to manage the business\'s security (settings.security.manage).' })
    }
    try {
      return reply.send(await setMetaCustomerListsSwitch(on, { label: user.displayName?.trim() || user.email || user.id }))
    } catch (err) {
      return fail(reply, err, 'change the "Upload customer lists to Meta" switch')
    }
  })
}
