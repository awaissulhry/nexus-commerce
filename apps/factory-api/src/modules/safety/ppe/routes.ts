import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { processFiles } from '../../../platform/files/service'
import { inlineDisposition } from '../../inventory/receipts/report'
import { leaverPpe, markPpeReturned } from '../../people/leavers/ppe-step'
import {
  commonItemsContract,
  countsContract,
  createItemContract,
  editItemContract,
  floorItemsContract,
  floorPersonContract,
  floorReceiveContract,
  gapsContract,
  issuePaperContract,
  itemRecordContract,
  itemStatusContract,
  keepReceiptContract,
  kitsContract,
  leaverPpeContract,
  leaverPpeReturnedContract,
  listIssuesContract,
  listItemsContract,
  personCardContract,
  receiptPdfContract,
  receiptRecordContract,
  voidIssueContract,
} from './contract'
import { floorItems, floorPerson, floorReceive } from './floor'
import { listGaps, listKits, personCard, ppeCounts } from './gaps'
import { addCommonItems, addItem, editItem, itemRecord, listItems, setItemStatus } from './items'
import { issueOnPaper, listIssues, receiptRecord, voidIssue } from './issues'
import { manifest } from './manifest'
import { keepReceipt, previewReceipt } from './receipt'

/**
 * PPE for workers (B-W2b-134): the catalogue (./items.ts), who lacks what (./gaps.ts), issues and receipts (./issues.ts,
 * ./receipt.ts), the floor's Receive PPE (./floor.ts) and the leaver step's link (../../people/leavers/ppe-step.ts: B-W2b-26's
 * leaver routes file stays its own). Each write is one command with an Idempotency-Key (required on the floor); a repeated key
 * answers from its receipt.
 */
export default defineRoutes('safety.ppe', manifest, async (app) => {
  app.get('/safety/ppe/counts', { schema: countsContract }, async (request) => ppeCounts(request, request.query))
  app.get('/safety/ppe/gaps', { schema: gapsContract }, async (request) => listGaps(request, request.query))
  app.get('/safety/ppe/kits', { schema: kitsContract }, async (request) => listKits(request, request.query))

  app.get('/safety/ppe/items', { schema: listItemsContract }, async (request) => listItems(request, request.query))
  app.get('/safety/ppe/items/:ppeItemId', { schema: itemRecordContract }, async (request) => itemRecord(request, request.params.ppeItemId))
  app.post('/safety/ppe/items', { schema: createItemContract }, async (request, reply) => {
    const answer = await addItem(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send({ item: answer.item })
  })
  app.post('/safety/ppe/items/common', { schema: commonItemsContract }, async (request) => addCommonItems(request, request.body, idempotencyKeyFrom(request)))
  app.patch('/safety/ppe/items/:ppeItemId', { schema: editItemContract }, async (request) => editItem(request, request.params.ppeItemId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/ppe/items/:ppeItemId/archive', { schema: itemStatusContract }, async (request) => setItemStatus(request, request.params.ppeItemId, 'ARCHIVED', request.body, idempotencyKeyFrom(request)))
  app.post('/safety/ppe/items/:ppeItemId/restore', { schema: itemStatusContract }, async (request) => setItemStatus(request, request.params.ppeItemId, 'ACTIVE', request.body, idempotencyKeyFrom(request)))

  app.get('/safety/ppe/issues', { schema: listIssuesContract }, async (request) => listIssues(request, request.query))
  app.post('/safety/ppe/issues', { schema: issuePaperContract }, async (request, reply) => {
    const answer = await issueOnPaper(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send({ receipt: answer.receipt, scan: answer.scan })
  })
  app.post('/safety/ppe/issues/:issueId/void', { schema: voidIssueContract }, async (request) => voidIssue(request, request.params.issueId, request.body, idempotencyKeyFrom(request)))
  app.get('/safety/ppe/receipts/:receiptId', { schema: receiptRecordContract }, async (request) => receiptRecord(request, request.params.receiptId))
  app.get('/safety/ppe/receipts/:receiptId/pdf', { schema: receiptPdfContract }, async (request, reply) => {
    const { pdf, fileName } = await previewReceipt(request, request.params.receiptId, request.query)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })
  app.post('/safety/ppe/receipts/:receiptId/pdf', { schema: keepReceiptContract }, async (request) =>
    keepReceipt(processFiles(), request, request.params.receiptId, { language: request.body.language, idempotencyKey: idempotencyKeyFrom(request) }),
  )
  app.get('/safety/ppe/people/:employeeId', { schema: personCardContract }, async (request) => personCard(request, request.params.employeeId))

  app.get('/safety/floor/ppe/items', { schema: floorItemsContract }, async (request) => floorItems(request))
  app.post('/safety/floor/ppe/person', { schema: floorPersonContract }, async (request) => floorPerson(request, request.body))
  app.post('/safety/floor/ppe/receive', { schema: floorReceiveContract }, async (request) => floorReceive(officeAuthOf(app), request, request.body, idempotencyKeyFrom(request)))

  app.get('/people/leavers/:caseId/ppe', { schema: leaverPpeContract }, async (request) => leaverPpe(request, request.params.caseId))
  app.post('/people/leavers/:caseId/steps/:stepId/ppe-returned', { schema: leaverPpeReturnedContract }, async (request) =>
    markPpeReturned(request, request.params.caseId, request.params.stepId, request.body, idempotencyKeyFrom(request)),
  )
})
