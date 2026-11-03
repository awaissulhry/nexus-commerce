import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CLIENT_EVENT_ID } from '@nexus/factory-domain/floor-sync/rules'
import { BLOCKS, FINAL_WHATS, FOUND_TYPES, INCOMING_WHATS, QUEUE_KINDS, SCAN_OUTCOMES, SCAN_STAGES, STARTABLE_CHECKS, TAKEN } from '@nexus/factory-domain/quality/queue/rules'
import { countContract, getInspectionContract, identityContract, measurementsContract, putDefectsContract, resultsContract as finalResultsContract, sheetOut, updateInspectionContract } from '../final/contract'
import { incomingView, putHideContract, putResultsContract as incomingResultsContract } from '../incoming/contract'
import { getContract as checkContract, resultsContract as checkResultsContract } from '../inprocess/contract'

/**
 * My inspections (B-W2b-106; QHS-068, QHS-065, QHS-062): the contracts of ./queue.ts, ./scan.ts, ./record.ts and
 * ./offline.ts. Words come in Italian and English beside every code. No money and no person anywhere: whose a row is says
 * MINE, NOBODY or OTHER only. A record's own model is the module's own answer (B-W2b-97's sheet and W1's inspection,
 * B-W2b-98's incoming record, B-W2b-99's check), so the tablet keeps exactly what the bench screens read.
 */

const words = output({ it: z.string(), en: z.string() })
const kind = z.enum(QUEUE_KINDS)
const stage = z.enum(SCAN_STAGES)
const recordType = z.enum(['Inspection', 'IncomingInspection', 'InProcessCheck'])
const target = z.enum(['INCOMING', 'IN_LINE', 'FINAL'])
const day = z.string()

export const queueRow = output({
  /** `<recordType>:<id>`, or `WorkOrder:<id>` for garments that wait for a final inspection nobody opened. */
  key: z.string(),
  kind,
  kindWords: words,
  recordType: recordType.nullable(),
  id: id().nullable(),
  /** INS-…, IIN-…; null for an in-process check (no number) or garments that wait. */
  number: z.string().nullable(),
  title: z.string(),
  companyId: id(),
  siteId: id(),
  workOrder: output({ id: id(), number: z.string() }).nullable(),
  lot: output({ id: id(), code: z.string(), qualityStatus: z.string() }).nullable(),
  item: output({ code: z.string(), name: z.string() }).nullable(),
  bundle: output({ id: id(), code: z.string() }).nullable(),
  operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() }).nullable(),
  plan: output({ code: z.string(), number: z.number().int() }).nullable(),
  /** The sample so far ("3 of 5"); null where nothing is counted yet. */
  progress: output({ done: z.number().int().nullable(), of: z.number().int().nullable(), words }).nullable(),
  openedAt: instant().nullable(),
  waitingSince: instant().nullable(),
  waiting: output({ minutes: z.number().int(), words }).nullable(),
  dueAt: instant().nullable(),
  overdue: z.boolean(),
  blocks: output({ what: z.enum(BLOCKS), rank: z.number().int(), needBy: day.nullable(), count: z.number().int().nullable(), words }),
  taken: z.enum(TAKEN),
  may: output({ record: z.boolean(), start: z.boolean() }),
  /** The record's own read (the bench's screen loads it). */
  open: output({ method: z.literal('GET'), path: z.string() }).nullable(),
  /** Garments that wait: scan to start with this code at this bench (POST /quality/queue/scan). */
  start: output({ code: z.string(), stage }).nullable(),
  version: z.number().int().nullable(),
})

export const queueContract = defineContract({
  querystring: input({
    /** mine (default): the viewer's own and those nobody took yet; all: everything the viewer may see. */
    scope: z.enum(['mine', 'all']).default('mine'),
    companyId: id().optional(),
    siteId: id().optional(),
    kind: kind.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }),
  response: { 200: output({ asOf: instant(), scope: z.enum(['mine', 'all']), rows: z.array(queueRow), capped: z.boolean() }) },
})

/** What one record is, for the screen that records it: the module's own answers. */
export const recordModel = output({
  /** A final inspection: W1's view (defects, checklist, decision) … */
  final: getInspectionContract.response[200].nullable(),
  /** … and, on a plan, the bench sheet (checks, chart, counter, serial check, photo set). */
  sheet: sheetOut.nullable(),
  incoming: incomingView.nullable(),
  check: checkContract.response[200].shape.check.nullable(),
})

const ref = output({ recordType, id: id(), kind, number: z.string().nullable(), taken: z.enum(TAKEN), version: z.number().int(), path: z.string() })
const found = output({ type: z.enum(FOUND_TYPES), id: id(), code: z.string(), label: z.string() })
const choice = output({ target, kind: kind.nullable(), recordType: recordType.nullable(), id: id().nullable(), number: z.string().nullable(), words })

export const scanQuery = input({ code: z.string().trim().min(1).max(80), stage: stage.optional() })

export const scanContract = defineContract({
  querystring: scanQuery,
  response: {
    200: output({
      code: z.string(),
      found: found.nullable(),
      outcome: z.enum(SCAN_OUTCOMES),
      target: target.nullable(),
      /** OPEN: the open record the code leads to. */
      open: ref.nullable(),
      /** START: what POST /quality/queue/scan would open, with its plan and sample. */
      start: output({
        target,
        kind,
        plan: output({ code: z.string(), number: z.number().int(), words: z.string().nullable() }).nullable(),
        lotSize: z.string().nullable(),
        uom: z.string().nullable(),
        sampleSize: z.number().int().nullable(),
        words,
      }).nullable(),
      /** CHOOSE: what the code could lead to (several open records, or several kinds of inspection). */
      choices: z.array(choice),
      words,
    }),
  },
})

export const startContract = defineContract({
  body: input({
    code: z.string().trim().min(1).max(80),
    stage: stage.optional(),
    /** In-line: which check to open on the bundle (a roving or end-of-line check is one step: POST /quality/inprocess/checks). */
    kind: z.enum(STARTABLE_CHECKS).optional(),
    workOrderOperationId: id().optional(),
    /** Final: the garments the inspection judges; left out: every garment finished, not released and not in an open inspection. */
    lotSize: z.number().int().min(1).max(100_000).optional(),
  }),
  response: {
    200: output({ outcome: z.literal('OPEN'), started: z.literal(false), open: ref, model: recordModel, words }),
    201: output({ outcome: z.literal('STARTED'), started: z.literal(true), open: ref, model: recordModel, words }),
  },
})

// ---- the writes the tablet queues (factory-domain floor-sync kinds) ----------------------------------------------------------------

const without = <Shape extends z.ZodRawShape>(body: z.ZodObject<Shape>) => body.omit({ version: true } as never) as unknown as z.ZodObject<Omit<Shape, 'version'>>

/** quality.final.record: one write of B-W2b-97 (or W1's defects and checklist) on a final inspection, without its version. */
export const finalPayload = z.discriminatedUnion('what', [
  without(finalResultsContract.body).extend({ what: z.literal('RESULTS'), inspectionId: id() }),
  without(measurementsContract.body).extend({ what: z.literal('MEASUREMENTS'), inspectionId: id() }),
  without(countContract.body).extend({ what: z.literal('COUNT'), inspectionId: id() }),
  without(identityContract.body).extend({ what: z.literal('IDENTITY'), inspectionId: id() }),
  without(putDefectsContract.body).extend({ what: z.literal('DEFECTS'), inspectionId: id() }),
  input({ what: z.literal('CHECKLIST'), inspectionId: id(), checklist: updateInspectionContract.body.shape.checklist.unwrap(), note: updateInspectionContract.body.shape.note }),
])
export type FinalPayload = z.infer<typeof finalPayload>

/** quality.incoming.record: a hide put or taken out of the sample, or the plan checks, of B-W2b-98, without the version. */
export const incomingPayload = z.discriminatedUnion('what', [
  without(putHideContract.body).extend({ what: z.literal('HIDE'), inspectionId: id(), hideId: id() }),
  input({ what: z.literal('HIDE_REMOVED'), inspectionId: id(), hideId: id() }),
  without(incomingResultsContract.body).extend({ what: z.literal('RESULTS'), inspectionId: id() }),
])
export type IncomingPayload = z.infer<typeof incomingPayload>

/** quality.inprocess.results: the plan checks of an open in-process check (B-W2b-99), the whole list, without the version. */
export const checkPayload = without(checkResultsContract.body).extend({ checkId: id() })
export type CheckPayload = z.infer<typeof checkPayload>

export const QUEUE_RECORD_KINDS = ['quality.final.record', 'quality.incoming.record', 'quality.inprocess.results'] as const
export type QueueRecordKind = (typeof QUEUE_RECORD_KINDS)[number]

export const recordContract = defineContract({
  body: input({ clientEventId: z.string().regex(CLIENT_EVENT_ID), kind: z.enum(QUEUE_RECORD_KINDS), payload: z.record(z.string(), z.unknown()) }),
  response: { 200: output({ status: z.enum(['accepted', 'duplicate']), result: output({ type: recordType, id: id() }), model: recordModel }) },
})

export const offlineContract = defineContract({
  response: {
    200: output({
      asOf: instant(),
      /** After this the tablet reads the pack again before trusting it (when the network is back). */
      keepUntil: instant(),
      rows: z.array(queueRow),
      records: z.array(output({ key: z.string(), recordType, id: id(), kind, version: z.number().int(), model: recordModel })),
      /** The queued kinds and their record whats: what the tablet may keep while offline. */
      queues: output({ kinds: z.array(z.enum(QUEUE_RECORD_KINDS)), final: z.array(z.enum(FINAL_WHATS)), incoming: z.array(z.enum(INCOMING_WHATS)) }),
      words: output({ queued: words, held: words }),
      capped: z.boolean(),
    }),
  },
})
