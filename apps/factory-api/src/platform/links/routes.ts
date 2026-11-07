import { LINK_RENEW_ANSWER } from '@nexus/factory-domain/links/renew'
import { parseLinkToken } from '@nexus/factory-domain/links/token'
import { idempotencyKeyFrom } from '../../core/command'
import { actorOf, requireContext } from '../../core/context'
import { defineRoutes } from '../../core/manifest'
import { abuseGuardOf } from '../abuse/guard'
import { AUTH_RATE_LIMITS, officeAuthOf } from '../auth/sessions/office-auth'
import { processEmail } from '../email-out/service'
import {
  createFileLinkContract,
  createLinkContract,
  linkDraftContract,
  linkFileDownloadContract,
  linkFilePreviewContract,
  linkFilesContract,
  linkPasswordContract,
  linkReceiptContract,
  listLinksContract,
  openLinkContract,
  renewLinkContract,
  revokeLinkContract,
  saveLinkDraftContract,
} from './contract'
import { readLinkDraft, saveLinkDraft } from './drafts'
import { checkLinkPassword, confirmReceipt, createFileLink, downloadSetFile, linkFilesView, previewSetFile } from './files'
import { createLink, listLinks, revokeLink } from './links'
import { manifest } from './manifest'
import { renewLink, renewTokenOf } from './renew'
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
 * W2b-3 (B-W2b-163; COL-051, MES-274; design links.document, links.file, links.frame):
 *
 * POST /links/files                   office: a set of files by a DOCUMENT_VIEW or SECURE_FILE link (files.ts)
 * GET  /link/files                    link: what was sent (the files once the password was given)
 * POST /link/password                 link: the password sent apart (5 wrong ones hold the link 15 minutes)
 * POST /link/files/:fileId/download   link: a download, logged (DOWNLOADED; a use on SECURE_FILE)
 * GET  /link/files/:fileId/preview    link: a PDF or a picture in the page (DOCUMENT_VIEW)
 * POST /link/files/received           link: "I received these files" (SECURE_FILE), once
 * GET|PUT /link/draft                 link: a long form's draft kept with us, sealed (drafts.ts)
 * POST /link/renew                    PUBLIC (the dead link's token in x-factory-link): "Ask for a new link"; ONE
 *                                     answer at once, the work after it (renew.ts); held by the abuse guard
 *
 * The link-session routes are rate limited per client address (AuthRateLimits.linkUse) on top of the app's limit; every
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

  // ---- B-W2b-163 ----------------------------------------------------------------------------------------------------

  app.post('/links/files', { schema: createFileLinkContract }, async (request, reply) => reply.code(201).send(await createFileLink(request, request.body, idempotencyKeyFrom(request))))

  app.get('/link/files', { schema: linkFilesContract, config: limited }, async (request) => linkFilesView(request))

  app.post('/link/password', { schema: linkPasswordContract, config: limited }, async (request, reply) => checkLinkPassword(request, reply, request.body.password, idempotencyKeyFrom(request)))

  app.post('/link/files/:fileId/download', { schema: linkFileDownloadContract, config: limited }, async (request) => downloadSetFile(request, request.params.fileId, idempotencyKeyFrom(request)))

  app.get('/link/files/:fileId/preview', { schema: linkFilePreviewContract, config: limited }, async (request) => previewSetFile(request, request.params.fileId))

  app.post('/link/files/received', { schema: linkReceiptContract, config: limited }, async (request) => confirmReceipt(request, request.body, idempotencyKeyFrom(request)))

  app.get('/link/draft', { schema: linkDraftContract, config: limited }, async (request) => readLinkDraft(request))

  app.put('/link/draft', { schema: saveLinkDraftContract, config: limited }, async (request) => saveLinkDraft(request, request.body, idempotencyKeyFrom(request)))

  app.post('/link/renew', { schema: renewLinkContract, config: limited }, async (request, reply) => {
    const auth = officeAuthOf(app)
    const header = renewTokenOf(request)
    const token = parseLinkToken(typeof header === 'string' ? header.trim() : undefined)
    const guard = abuseGuardOf(app)
    // Per token and per network (PLT-066); a challenge after suspicious traffic. A token that names nothing counts.
    await guard.check(request, reply, 'links.renew', { ...(token ? { subject: token.linkId } : {}), proof: request.body?.proof })
    auth.afterAnswer(async () => {
      const outcome = await renewLink(processEmail(), request, header)
      if (outcome === 'NOT_A_TOKEN' || outcome === 'UNKNOWN') await guard.failed(request, 'links.renew')
      request.log.info({ outcome }, 'a new link was asked for')
    }, request.log)
    return reply.code(202).send({ status: 'requested' as const, message: LINK_RENEW_ANSWER })
  })
})
