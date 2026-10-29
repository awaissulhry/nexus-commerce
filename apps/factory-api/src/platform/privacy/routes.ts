import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { serverClock } from '../../core/time'
import { requireStepUp } from '../auth/office/account'
import { AUTH_RATE_LIMITS, officeAuthOf } from '../auth/sessions/office-auth'
import {
  announceDpiaPdfContract,
  announceTextPdfContract,
  archiveActivityContract,
  completeDpiaPdfContract,
  completeTextPdfContract,
  createActivityContract,
  createDpiaContract,
  createNoticeContract,
  deleteNoticeContract,
  deleteTextContract,
  floorAckContract,
  floorNoticeContract,
  getNoticeContract,
  listActivitiesContract,
  listDpiaContract,
  listNoticesContract,
  noticeAcksContract,
  overviewContract,
  paperAckContract,
  patchActivityContract,
  publicNoticeContract,
  publishNoticeContract,
  putTextContract,
  staffAckContract,
  staffNoticeContract,
  storeDpiaContract,
} from './contract'
import { createDpia, listDpia, storeDpia } from './dpia'
import { announceDpiaPdf, announceNoticePdf, completeDpiaPdf, completeNoticePdf } from './files'
import { manifest } from './manifest'
import { createNotice, deleteNotice, deleteText, getNotice, listNotices, noticeAcks, paperAck, publishNotice, putText } from './notices'
import { privacyOverview } from './overview'
import { acknowledgeFloorNotice, acknowledgeStaffNotice, floorNotice, publicNotice, staffNotice } from './people'
import { archiveActivity, createActivity, listActivities, patchActivity } from './register'

/**
 * Admin › Privacy & notices (B-W1-36; A2 SCR-086; GDPR arts. 13, 28, 30, 35; Statuto dei Lavoratori art. 4 c.3):
 *   GET    /privacy/overview                                       the duties per company, the floor's gate per site (words)
 *   GET    /privacy/notices?companyId=&kind=                       the versions of a company's notices
 *   GET    /privacy/notices/:noticeId                              one version: texts, PDFs, fingerprints, counts
 *   POST   /privacy/notices                                        a new DRAFT (from the texts in force)
 *   PUT    /privacy/notices/:noticeId/texts/:locale                a language's text (DRAFT; version)
 *   DELETE /privacy/notices/:noticeId/texts/:locale?version=       a language off the DRAFT
 *   POST   /privacy/notices/:noticeId/texts/:locale/pdf            announce a language's PDF (+ …/:fileId/complete)
 *   POST   /privacy/notices/:noticeId/publish                      in force; the earlier version superseded (step-up)
 *   DELETE /privacy/notices/:noticeId?version=                     a DRAFT deleted
 *   GET    /privacy/notices/:noticeId/acknowledgements             counts; names with privacy.manage
 *   POST   /privacy/notices/:noticeId/paper-acknowledgements       a worker's signed paper copy (the version in force)
 *   GET    /privacy/dpia?companyId=  POST /privacy/dpia            the DPIA versions; a new DRAFT
 *   POST   /privacy/dpia/:dpiaId/pdf (+ …/:fileId/complete)        the signed PDF
 *   POST   /privacy/dpia/:dpiaId/store                             stored as signed; the earlier one superseded (step-up)
 *   GET    /privacy/register?companyId=  POST /privacy/register    the record of processing activities
 *   PATCH  /privacy/register/:activityId  POST …/archive           change (version), archive
 * People's own notices:
 *   GET|POST /privacy/staff-notice[/acknowledge]                   office: the staff notice once per version
 *   GET|POST /privacy/floor/notice[/acknowledge]                   floor: the worker notice and the scan gate
 *   GET      /privacy/public/:companyId                            anyone: the public notice (/privacy/<company id>)
 */
export default defineRoutes('privacy', manifest, async (app) => {
  const stepUpFor = (request: Parameters<typeof requireStepUp>[1]) => () => requireStepUp(officeAuthOf(app), request)
  const linkUse = app.officeAuth?.rateLimits.linkUse ?? AUTH_RATE_LIMITS.linkUse
  const limited = { rateLimit: { max: linkUse.max, timeWindow: linkUse.timeWindowMs } }

  app.get('/privacy/overview', { schema: overviewContract }, async (request) => privacyOverview(request, request.query, serverClock.now()))

  app.get('/privacy/notices', { schema: listNoticesContract }, async (request) => listNotices(request, request.query))
  app.get('/privacy/notices/:noticeId', { schema: getNoticeContract }, async (request) => getNotice(request, request.params.noticeId))
  app.post('/privacy/notices', { schema: createNoticeContract }, async (request, reply) => reply.code(201).send(await createNotice(request, request.body, idempotencyKeyFrom(request))))
  app.put('/privacy/notices/:noticeId/texts/:locale', { schema: putTextContract }, async (request) =>
    putText(request, request.params.noticeId, request.params.locale, request.body, idempotencyKeyFrom(request)),
  )
  app.delete('/privacy/notices/:noticeId/texts/:locale', { schema: deleteTextContract }, async (request) =>
    deleteText(request, request.params.noticeId, request.params.locale, request.query.version, idempotencyKeyFrom(request)),
  )
  app.post('/privacy/notices/:noticeId/texts/:locale/pdf', { schema: announceTextPdfContract }, async (request, reply) =>
    reply.code(201).send(await announceNoticePdf(request, request.params.noticeId, request.params.locale, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/privacy/notices/:noticeId/texts/:locale/pdf/:fileId/complete', { schema: completeTextPdfContract }, async (request) =>
    completeNoticePdf(request, request.params.noticeId, request.params.locale, request.params.fileId, idempotencyKeyFrom(request)),
  )
  app.post('/privacy/notices/:noticeId/publish', { schema: publishNoticeContract }, async (request) =>
    publishNotice(request, request.params.noticeId, request.body, { stepUp: stepUpFor(request), idempotencyKey: idempotencyKeyFrom(request) }),
  )
  app.delete('/privacy/notices/:noticeId', { schema: deleteNoticeContract }, async (request) => deleteNotice(request, request.params.noticeId, request.query.version, idempotencyKeyFrom(request)))
  app.get('/privacy/notices/:noticeId/acknowledgements', { schema: noticeAcksContract }, async (request) => noticeAcks(request, request.params.noticeId))
  app.post('/privacy/notices/:noticeId/paper-acknowledgements', { schema: paperAckContract }, async (request) => paperAck(request, request.params.noticeId, request.body, idempotencyKeyFrom(request)))

  app.get('/privacy/dpia', { schema: listDpiaContract }, async (request) => listDpia(request, request.query))
  app.post('/privacy/dpia', { schema: createDpiaContract }, async (request, reply) => reply.code(201).send(await createDpia(request, request.body, idempotencyKeyFrom(request))))
  app.post('/privacy/dpia/:dpiaId/pdf', { schema: announceDpiaPdfContract }, async (request, reply) =>
    reply.code(201).send(await announceDpiaPdf(request, request.params.dpiaId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/privacy/dpia/:dpiaId/pdf/:fileId/complete', { schema: completeDpiaPdfContract }, async (request) => completeDpiaPdf(request, request.params.dpiaId, request.params.fileId, idempotencyKeyFrom(request)))
  app.post('/privacy/dpia/:dpiaId/store', { schema: storeDpiaContract }, async (request) =>
    storeDpia(request, request.params.dpiaId, request.body, { stepUp: stepUpFor(request), idempotencyKey: idempotencyKeyFrom(request), now: serverClock.now() }),
  )

  app.get('/privacy/register', { schema: listActivitiesContract }, async (request) => listActivities(request, request.query))
  app.post('/privacy/register', { schema: createActivityContract }, async (request, reply) => reply.code(201).send(await createActivity(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/privacy/register/:activityId', { schema: patchActivityContract }, async (request) => patchActivity(request, request.params.activityId, request.body, idempotencyKeyFrom(request)))
  app.post('/privacy/register/:activityId/archive', { schema: archiveActivityContract }, async (request) => archiveActivity(request, request.params.activityId, request.body, idempotencyKeyFrom(request)))

  app.get('/privacy/staff-notice', { schema: staffNoticeContract }, async (request) => staffNotice(request, request.query))
  app.post('/privacy/staff-notice/acknowledge', { schema: staffAckContract }, async (request) => acknowledgeStaffNotice(request, request.body, idempotencyKeyFrom(request)))
  app.get('/privacy/floor/notice', { schema: floorNoticeContract }, async (request) => floorNotice(request, request.query))
  app.post('/privacy/floor/notice/acknowledge', { schema: floorAckContract }, async (request) => acknowledgeFloorNotice(request, request.body, idempotencyKeyFrom(request)))
  app.get('/privacy/public/:companyId', { schema: publicNoticeContract, config: limited }, async (request) => publicNotice(request, request.params.companyId, request.query))
})
