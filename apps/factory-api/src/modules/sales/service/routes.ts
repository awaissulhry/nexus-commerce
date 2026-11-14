import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { openRepair, openReturn } from './actions'
import {
  changeContract,
  countsContract,
  coverContract,
  getContract,
  linkContract,
  listContract,
  openContract,
  peopleContract,
  previewContract,
  repairContract,
  returnContract,
  statusContract,
  unlinkContract,
} from './contract'
import { linkToCase, unlinkFromCase } from './links'
import { caseCounts, casePeople, listCases } from './list'
import { manifest } from './manifest'
import { openCase, previewCase } from './open'
import { changeCase, decideCover, getCase, moveCase } from './steps'
import { caseRecordOf } from './view'
// B-W2b-394 (ML1:03): a case from a mail in one step.
import { caseFromMailContract, openCaseFromMail } from './from-mail'

/**
 * Warranty and service cases of B-W2b-345 (SAL-368 legal versus factory guarantee, SAL-436 the customer told at each status
 * change): the list and its tiles (./list.ts), opening a case from a call, a mail or a visit (./open.ts), the record and its
 * steps — change, decide the cover, move with the status mail (./steps.ts, ./notify.ts) —, its linked records (./links.ts)
 * and what it opens: a repair, a return, a remake or a credit, each linked (./actions.ts). The Activity tab is the record's
 * thread and timeline (platform/threads, record type ServiceCase). Screens: B-W2b-353.
 */
export default defineRoutes('sales.service', manifest, async (app) => {
  app.get('/sales/service/cases', { schema: listContract }, async (request) => listCases(request, request.query))
  app.get('/sales/service/cases/counts', { schema: countsContract }, async (request) => caseCounts(request))
  app.get('/sales/service/cases/people', { schema: peopleContract }, async (request) => casePeople(request, request.query.companyId))
  app.post('/sales/service/cases/preview', { schema: previewContract }, async (request) => previewCase(request, request.body))
  app.post('/sales/service/cases', { schema: openContract }, async (request, reply) => reply.code(201).send(await openCase(request, request.body, idempotencyKeyFrom(request))))
  // B-W2b-394 (ML1:03)
  app.post('/sales/service/cases/from-mail/:inboundEmailId', { schema: caseFromMailContract }, async (request, reply) => reply.code(201).send(await openCaseFromMail(request, request.params.inboundEmailId, request.body, idempotencyKeyFrom(request))))

  app.get('/sales/service/cases/:caseId', { schema: getContract }, async (request) => getCase(request, request.params.caseId))
  app.patch('/sales/service/cases/:caseId', { schema: changeContract }, async (request) => changeCase(request, request.params.caseId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/service/cases/:caseId/cover', { schema: coverContract }, async (request) => decideCover(request, request.params.caseId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/service/cases/:caseId/status', { schema: statusContract }, async (request) => moveCase(request, request.params.caseId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/service/cases/:caseId/links', { schema: linkContract }, async (request) => {
    const { caseId } = await linkToCase(request, request.params.caseId, request.body, idempotencyKeyFrom(request))
    return { case: await caseRecordOf(request, caseId) }
  })
  app.delete('/sales/service/cases/:caseId/links/:linkId', { schema: unlinkContract }, async (request) => {
    const { caseId } = await unlinkFromCase(request, request.params.caseId, request.params.linkId, request.query, idempotencyKeyFrom(request))
    return { case: await caseRecordOf(request, caseId) }
  })
  app.post('/sales/service/cases/:caseId/repair', { schema: repairContract }, async (request, reply) => reply.code(201).send(await openRepair(request, request.params.caseId, request.body, idempotencyKeyFrom(request))))
  app.post('/sales/service/cases/:caseId/return', { schema: returnContract }, async (request, reply) => reply.code(201).send(await openReturn(request, request.params.caseId, request.body, idempotencyKeyFrom(request))))
})
