import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { changeContract, inviteContract, linkAnnounceContract, linkCompleteContract, linkMessagesContract, linkNotifyContract, linkPageContract, linkPostContract, recordSharesContract, revokeContract } from './contract'
import { manifest } from './manifest'
import { setShareNotify } from './notify'
import { changeSharePermissions, inviteToRecord, recordShares, revokeShare } from './office'
import { linkShareMessages, linkSharePage } from './page'
import { postOnShare } from './post'
import { announceShareUpload, completeShareUpload } from './upload'

/**
 * Inviting a partner to one record (B-W2b-200): the office invites, changes and revokes (./office.ts); the invited partner
 * reads the record's shared fields, files and thread (./page.ts), writes on it (./post.ts), adds a file (./upload.ts) and
 * switches "E-mail me" (./notify.ts, with the worker's mails). Importing ./page.ts registers the RECORD_INVITE live check
 * (platform/links records.ts): the link opens only while its share lives. The screens are this step's (SCR-270, the record
 * panels' Partners tab).
 */
export default defineRoutes('shares', manifest, async (app) => {
  app.get('/shares', { schema: recordSharesContract }, async (request) => recordShares(request, request.query.recordType, request.query.recordId))

  app.post('/shares', { schema: inviteContract }, async (request, reply) => {
    const answer = await inviteToRecord(request, request.body, idempotencyKeyFrom(request))
    return reply.code(201).send(answer)
  })

  app.put('/shares/:shareId/permissions', { schema: changeContract }, async (request) => changeSharePermissions(request, request.params.shareId, request.body, idempotencyKeyFrom(request)))

  app.post('/shares/:shareId/revoke', { schema: revokeContract }, async (request) => revokeShare(request, request.params.shareId, request.body, idempotencyKeyFrom(request)))

  app.get('/link/share', { schema: linkPageContract }, async (request) => linkSharePage(request, request.query))

  app.get('/link/share/messages', { schema: linkMessagesContract }, async (request) => linkShareMessages(request, request.query.cursor))

  app.post('/link/share/messages', { schema: linkPostContract }, async (request, reply) => {
    const answer = await postOnShare(request, request.body, idempotencyKeyFrom(request))
    return reply.code(201).send(answer)
  })

  app.put('/link/share/notify', { schema: linkNotifyContract }, async (request) => {
    const { notifyByEmail, version } = await setShareNotify(request, request.body, idempotencyKeyFrom(request))
    return { notifyByEmail, version }
  })

  app.post('/link/share/files', { schema: linkAnnounceContract }, async (request, reply) => {
    const answer = await announceShareUpload(request, request.body, idempotencyKeyFrom(request))
    return reply.code(201).send(answer)
  })

  app.post('/link/share/files/:fileId/complete', { schema: linkCompleteContract }, async (request) => completeShareUpload(request, request.params.fileId, idempotencyKeyFrom(request)))
})
