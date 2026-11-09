import { ValidationError } from '@nexus/factory-domain/core/errors'
import { idempotencyKeyFrom, IDEMPOTENCY_KEY_HEADER } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { inlineDisposition } from '../../inventory/receipts/report'
import { acknowledge, floorMine, recordPaper } from './acks'
import {
  acknowledgementsContract,
  announceContract,
  bringTypedContract,
  completeContract,
  createContract,
  discardContract,
  draftContract,
  floorMediaContract,
  floorOperationContract,
  floorSpecContract,
  listContract,
  mineContract,
  paperContract,
  publishContract,
  recordContract,
  saveContract,
  seenContract,
  sheetContract,
  statusContract,
  typedContract,
  versionContract,
} from './contract'
import { floorInstruction, floorSpec } from './floor'
import { manifest } from './manifest'
import { announceMedia, completeMedia, floorMediaDownload } from './media'
import { acknowledgementsOf, instructionRecord, listInstructions, versionRecord } from './office'
import { sheetPdf } from './sheet'
import { bringTypedSteps, typedSteps } from './typed'
import { createInstruction, discardVersion, draftVersion, publishVersion, saveVersion, setInstructionStatus } from './write'

/**
 * Work instructions (B-W2b-214; PRD-117, PRD-258, MES-110, MES-119): the office's reads (./office.ts), writes (./write.ts),
 * media (./media.ts), the PDF sheet (./sheet.ts) and the typed step lines brought in once (./typed.ts); the floor's look at
 * the operation in hand and the frozen spec (./floor.ts) and Seen (./acks.ts: 201 recorded, 200 a resend or seen already;
 * offline it queues as production.instruction.ack). The steps the tablet ticks are the published version's
 * (checklists/store.ts stepsOfOperation reads ./lookup.ts).
 */
export default defineRoutes('production.instructions', manifest, async (app) => {
  app.get('/production/instructions', { schema: listContract }, async (request) => listInstructions(request, request.query))

  app.post('/production/instructions', { schema: createContract }, async (request, reply) => reply.code(201).send(await createInstruction(request, request.body, idempotencyKeyFrom(request))))

  app.get('/production/instructions/typed-steps', { schema: typedContract }, async (request) => typedSteps(request, request.query))

  app.post('/production/instructions/typed-steps', { schema: bringTypedContract }, async (request) => bringTypedSteps(request, request.body, idempotencyKeyFrom(request)))

  app.get('/production/instructions/:instructionId', { schema: recordContract }, async (request) => instructionRecord(request, request.params.instructionId))

  app.post('/production/instructions/:instructionId/archive', { schema: statusContract }, async (request) => setInstructionStatus(request, request.params.instructionId, 'ARCHIVED', request.body, idempotencyKeyFrom(request)))

  app.post('/production/instructions/:instructionId/restore', { schema: statusContract }, async (request) => setInstructionStatus(request, request.params.instructionId, 'ACTIVE', request.body, idempotencyKeyFrom(request)))

  app.post('/production/instructions/:instructionId/versions', { schema: draftContract }, async (request, reply) => reply.code(201).send(await draftVersion(request, request.params.instructionId, request.body, idempotencyKeyFrom(request))))

  app.get('/production/instructions/:instructionId/versions/:versionId', { schema: versionContract }, async (request) => versionRecord(request, request.params.instructionId, request.params.versionId, request.query))

  app.put('/production/instructions/:instructionId/versions/:versionId', { schema: saveContract }, async (request) => saveVersion(request, request.params.instructionId, request.params.versionId, request.body, idempotencyKeyFrom(request)))

  app.post('/production/instructions/:instructionId/versions/:versionId/publish', { schema: publishContract }, async (request) => publishVersion(request, request.params.instructionId, request.params.versionId, request.body, idempotencyKeyFrom(request)))

  app.post('/production/instructions/:instructionId/versions/:versionId/discard', { schema: discardContract }, async (request) => discardVersion(request, request.params.instructionId, request.params.versionId, request.body, idempotencyKeyFrom(request)))

  app.get('/production/instructions/:instructionId/versions/:versionId/sheet', { schema: sheetContract }, async (request, reply) => {
    const { pdf, fileName } = await sheetPdf(request, request.params.instructionId, request.params.versionId, request.query.language)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })

  app.post('/production/instructions/:instructionId/files', { schema: announceContract }, async (request, reply) => reply.code(201).send(await announceMedia(request, request.params.instructionId, request.body, idempotencyKeyFrom(request))))

  app.post('/production/instructions/:instructionId/files/:fileId/complete', { schema: completeContract }, async (request) => completeMedia(request, request.params.instructionId, request.params.fileId, idempotencyKeyFrom(request)))

  app.get('/production/instructions/:instructionId/acknowledgements', { schema: acknowledgementsContract }, async (request) => acknowledgementsOf(request, request.params.instructionId))

  app.post('/production/instructions/:instructionId/versions/:versionId/acknowledgements', { schema: paperContract }, async (request, reply) => reply.code(201).send(await recordPaper(request, request.params.instructionId, request.params.versionId, request.body, idempotencyKeyFrom(request))))

  app.get('/production/instructions/floor/operation', { schema: floorOperationContract }, async (request) => floorInstruction(request, request.query))

  app.get('/production/instructions/floor/spec', { schema: floorSpecContract }, async (request) => floorSpec(request, request.query))

  app.post('/production/instructions/floor/seen', { schema: seenContract }, async (request, reply) => {
    const header = idempotencyKeyFrom(request)
    if (header !== undefined && header !== request.body.clientEventId) {
      throw new ValidationError('The Idempotency-Key is the Seen’s clientEventId: send the same value, or no header.', [{ path: `headers/${IDEMPOTENCY_KEY_HEADER}`, message: 'Must equal body.clientEventId.' }])
    }
    const { replayed, ...answer } = await acknowledge(request, request.body)
    return reply.code(replayed ? 200 : 201).send(answer)
  })

  app.get('/production/instructions/floor/mine', { schema: mineContract }, async (request) => floorMine(request))

  app.get('/production/instructions/floor/media/:mediaId/download', { schema: floorMediaContract }, async (request) => floorMediaDownload(request, request.params.mediaId))
})
