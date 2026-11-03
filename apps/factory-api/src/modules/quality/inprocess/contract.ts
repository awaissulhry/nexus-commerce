import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CHARGE_SOURCES, IN_PROCESS_KINDS, IN_PROCESS_OUTCOMES, IN_PROCESS_STATUSES, LIMITS, RESULT_OUTCOMES } from '@nexus/factory-domain/quality/inprocess/rules'

/**
 * In-process checks' routes (B-W2b-99; QHS-039 … QHS-042, MES-127; design floor.inline SCR-176, floor.reasons "Which operation
 * caused it?", floor.myday "defects charged to your operation"). Per line and operation: a list row names no person; one
 * record names its inspector and operator only behind the site's PERFORMANCE gate (`workerHidden`, `operatorHidden`). No money
 * anywhere. A rule's refusal is a 409 whose issues are `refusal/<CODE>` and `fix`.
 */

const kind = z.enum(IN_PROCESS_KINDS)
const status = z.enum(IN_PROCESS_STATUSES)
const outcome = z.enum(IN_PROCESS_OUTCOMES)
const words = output({ it: z.string(), en: z.string() })
const version = () => z.number().int().min(1)
const count = (max: number) => z.number().int().min(0).max(max)
const note = () => z.string().max(LIMITS.note).nullable().optional()

const decision = input({
  outcome,
  pieces: z.number().int().min(1).max(LIMITS.pieces),
  defectivePieces: count(LIMITS.pieces).optional(),
  defects: count(LIMITS.defects).optional(),
  defectCodeId: id().nullable().optional(),
})

const row = {
  id: id(),
  kind,
  kindWords: words,
  status,
  statusWords: words,
  outcome: outcome.nullable(),
  outcomeWords: words.nullable(),
  siteId: id(),
  companyId: id(),
  line: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  workOrder: output({ id: id(), number: z.string() }).nullable(),
  bundle: output({ id: id(), code: z.string(), quantity: z.number().int() }).nullable(),
  operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() }).nullable(),
  pieces: z.number().int(),
  defectivePieces: z.number().int(),
  defects: z.number().int(),
  /** Defects per 100 pieces looked at, one decimal (a decided check). */
  dhu: z.string().nullable(),
  defect: output({ id: id(), code: z.string(), labelIt: z.string(), labelEn: z.string(), critical: z.boolean() }).nullable(),
  hasPlan: z.boolean(),
  decidedAt: instant().nullable(),
  createdAt: instant(),
  version: z.number().int(),
}
const checkRow = output(row)

const check = output({
  ...row,
  plan: output({ versionId: id(), planId: id(), code: z.string(), name: z.string(), number: z.number().int() }).nullable(),
  checks: z.array(
    output({
      id: id(),
      code: z.string(),
      labelIt: z.string(),
      labelEn: z.string(),
      labelI18n: z.record(z.string(), z.string()),
      type: z.string(),
      checkClass: z.string().nullable(),
      mandatory: z.boolean(),
      photoRequired: z.boolean(),
      nominal: z.string().nullable(),
      tolerance: z.string().nullable(),
      uom: z.string().nullable(),
      choices: z.array(z.string()),
    }),
  ),
  results: z.array(output({ id: id(), code: z.string(), sampleIndex: z.number().int(), outcome: z.enum(RESULT_OUTCOMES), value: z.string().nullable(), note: z.string().nullable(), recordedAt: instant() })),
  blockers: z.array(z.string()),
  sample: output({ aqlProfileId: id(), profileCode: z.string(), codeLetter: z.string().nullable(), sampleSize: z.number().int().nullable(), words: z.string().nullable() }).nullable(),
  suggested: z.enum(['GREEN', 'AMBER', 'RED']).nullable(),
  holdsRun: z.boolean().nullable(),
  sendBack: output({ workOrderOperationId: id(), bundleId: id(), pieces: z.number().int() }).nullable(),
  inspector: output({ kind: z.enum(['FLOOR', 'OFFICE']), workerId: id().nullable(), name: z.string().nullable(), workerHidden: z.boolean(), userId: id().nullable(), own: z.boolean() }),
  operator: output({ id: id(), name: z.string() }).nullable(),
  operatorHidden: z.boolean(),
  signatureSha256: z.string().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
})

const checkAnswer = { 200: output({ check }) }
const params = input({ checkId: id() })

export const listContract = defineContract({
  querystring: input({ siteId: id().optional(), lineId: id().optional(), workOrderId: id().optional(), workOrderOperationId: id().optional(), kind: kind.optional(), status: status.optional(), date: businessDate().optional() }),
  response: { 200: output({ checks: z.array(checkRow), counts: output({ open: z.number().int(), decided: z.number().int(), firstPiecesOpen: z.number().int() }), capped: z.boolean() }) },
})

export const getContract = defineContract({ params, response: checkAnswer })

export const openContract = defineContract({
  body: input({
    kind,
    workOrderId: id().optional(),
    bundleId: id().optional(),
    bundleCode: z.string().trim().min(1).max(60).optional(),
    workOrderOperationId: id().optional(),
    lineId: id().optional(),
    planVersionId: id().nullable().optional(),
    decision: decision.optional(),
    note: note(),
  }),
  response: { 201: output({ check }) },
})

export const resultsContract = defineContract({
  params,
  body: input({
    version: version(),
    results: z
      .array(input({ code: z.string().min(1).max(40), sampleIndex: z.number().int().min(1).max(LIMITS.pieces).optional(), outcome: z.enum(RESULT_OUTCOMES), value: z.string().max(LIMITS.note).nullable().optional(), note: note() }))
      .max(LIMITS.results),
  }),
  response: checkAnswer,
})

export const decideContract = defineContract({
  params,
  body: decision.extend({ version: version(), note: note() }),
  response: checkAnswer,
})

export const cancelContract = defineContract({ params, body: input({ version: version(), reason: z.string().min(1).max(LIMITS.reason) }), response: checkAnswer })

export const dhuContract = defineContract({
  querystring: input({ lineId: id().optional(), date: businessDate().optional() }),
  response: {
    200: output({
      line: output({ id: id(), code: z.string(), name: z.string() }),
      day: z.string(),
      dhu: z.string().nullable(),
      defects: z.number().int(),
      pieces: z.number().int(),
      checks: z.number().int(),
      byOperation: z.array(output({ code: z.string(), name: z.string(), defects: z.number().int() })),
      asOf: instant(),
    }),
  },
})

export const rovingContract = defineContract({
  querystring: input({ lineId: id().optional(), date: businessDate().optional() }),
  response: {
    200: output({
      line: output({ id: id(), code: z.string(), name: z.string() }),
      day: z.string(),
      tiles: z.array(
        output({
          workOrder: output({ id: id(), number: z.string() }),
          operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() }),
          latest: output({ checkId: id(), outcome: z.enum(['GREEN', 'AMBER', 'RED']), outcomeWords: words, pieces: z.number().int(), defectivePieces: z.number().int(), at: instant() }).nullable(),
          checksToday: z.number().int(),
        }),
      ),
      lineChecksToday: z.number().int(),
      asOf: instant(),
    }),
  },
})

const firstPieceCard = output({
  heldOperationIds: z.array(id()),
  firstBundle: z.boolean(),
  check: output({ id: id(), status, outcome: z.string().nullable(), outcomeWords: words.nullable(), workOrderOperationId: id().nullable() }).nullable(),
  message: z.string().nullable(),
  fix: z.string().nullable(),
})

export const firstPieceContract = defineContract({
  querystring: input({ bundleId: id() }),
  response: { 200: output({ bundle: output({ id: id(), code: z.string() }), workOrder: output({ id: id(), number: z.string() }), firstPiece: firstPieceCard.nullable() }) },
})

const bySource = output({ END_OF_LINE: z.number().int(), ROVING: z.number().int(), SCAN: z.number().int() })

export const chargesContract = defineContract({
  querystring: input({ siteId: id().optional(), lineId: id().optional(), workOrderId: id().optional(), from: businessDate().optional(), to: businessDate().optional() }),
  response: {
    200: output({
      from: z.string(),
      to: z.string(),
      operations: z.array(output({ operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() }), workOrder: output({ id: z.string(), number: z.string() }), defects: z.number().int(), bySource })),
      sources: output({ END_OF_LINE: words, ROVING: words, SCAN: words }),
      defects: z.number().int(),
    }),
  },
})

export const mineContract = defineContract({
  querystring: input({ date: businessDate().optional() }),
  response: {
    200: output({
      /** The site's PERFORMANCE gate is in force: charges per worker exist. */
      open: z.boolean(),
      words: z.string().nullable(),
      day: z.string().nullable(),
      charges: z.array(
        output({
          source: z.enum(CHARGE_SOURCES),
          sourceWords: words,
          checkId: id().nullable(),
          scanDefectId: id().nullable(),
          at: instant(),
          operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() }),
          bundle: output({ id: id(), code: z.string() }).nullable(),
          defect: z.string(),
          defects: z.number().int(),
          dispute: output({
            recordType: z.literal('OperationScan'),
            recordId: id().nullable(),
            reasons: z.array(z.string()),
            words: z.string(),
            open: output({ id: id(), status: z.enum(['OPEN', 'UPHELD', 'REJECTED', 'WITHDRAWN']), answer: z.string().nullable() }).nullable(),
          }),
        }),
      ),
    }),
  },
})

export type DecisionInput = z.infer<typeof decision>
