import { z } from 'zod'
import { DEFECT_CLASSES, INSPECTION_RESULTS, INSPECTION_STATUSES } from '@nexus/factory-domain/quality/final/rules'
import type { ApiClient } from '../../../../lib/api/client'
import { presignedSchema } from '../../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../../record-panels/store'
import { onlineFirst, type KeepsActions } from '../../../queue/online-first'
import { AsOfMemory, codeKey, type Remembered } from '../../shared/as-of'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../../shared/task-api'
import { inspectionReadSchema } from '../api'

/**
 * The final bench on its plan (B-W2b-109 on the merged API of B-W2b-97 and B-W2b-106; design floor.final "serial", "aql",
 * "measure", "photos"; QHS-023, QHS-049, QHS-052 … QHS-054, QHS-065, QHS-067): every call the plan bench makes, each answer
 * checked against its shape.
 *
 *   plans      GET /quality/final/work-orders/:id/plans?lotSize   the plan that applies and the sample of the lot (B-W2b-93's AQL
 *                                                                  chain or the plan's fixed sample: the screen never computes AQL)
 *   open       POST /quality/inspections {workOrderId, lotSize, planId}   no typed sampling: the plan gives it inside the command
 *   sheet      GET /quality/inspections/:id/sheet                    the bench sheet: checks, chart, counter, serial check, photos
 *   record     POST /quality/queue/record {clientEventId, kind quality.final.record, payload}   every bench write ONLINE FIRST:
 *              a network failure keeps the SAME kind and payload on the tablet under the try's id (B-W2b-77, B-W2b-106), so a
 *              queued retry is answered `duplicate`, never applied twice. The answer is the record's model (W1 view + sheet).
 *   scan       POST /quality/queue/scan {code, stage FINAL}         a lot, bundle, serial, carton, work order or inspection number
 *                                                                  opens the right inspection (QHS-065), or starts it; GET the
 *                                                                  choices when it could be several
 *   photos     POST …/results/:resultId/photos → PUT → complete      the photo set and a result's photo: online only
 *   decide     POST /quality/inspections/:id/decide {version, result}   on a plan no checklist is sent: the command writes it
 *   defects    GET /quality/vocabulary?stage=FINAL                    the defects a counted piece may have, in the worker's language
 *
 * The API's English `words` are never shown: the screen says its own words from the codes and figures.
 */

const klass = z.enum(DEFECT_CLASSES)
const outcome = z.enum(['PASS', 'FAIL', 'NOT_APPLICABLE'])

export const sheetSchema = z.object({
  inspection: z.object({
    id: z.string(),
    number: z.string().nullable(),
    workOrderId: z.string(),
    status: z.enum(INSPECTION_STATUSES),
    version: z.number(),
    lotSize: z.number(),
    sampleSize: z.number(),
    inspectionLevel: z.string(),
    codeLetter: z.string().nullable(),
    aqlMajor: z.string(),
    aqlMinor: z.string(),
    acceptMajor: z.number(),
    acceptMinor: z.number(),
    decidedAt: z.string().nullable(),
  }),
  plan: z.object({ planId: z.string(), code: z.string(), name: z.string(), versionId: z.string(), number: z.number(), samplingMethod: z.enum(['AQL_PROFILE', 'FIXED']) }),
  language: z.string(),
  checks: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      label: z.string(),
      missingWords: z.boolean(),
      labelIt: z.string(),
      labelEn: z.string(),
      type: z.string(),
      checkClass: klass.nullable(),
      mandatory: z.boolean(),
      photoRequired: z.boolean(),
      takesResult: z.boolean(),
      onChart: z.boolean(),
      choices: z.array(z.string()),
      results: z.array(
        z.object({
          id: z.string(),
          sampleIndex: z.number(),
          outcome,
          value: z.string().nullable(),
          note: z.string().nullable(),
          photos: z.array(z.object({ id: z.string(), status: z.string() })),
          recordedBy: z.enum(['FLOOR', 'OFFICE']),
          recordedAt: z.string(),
        }),
      ),
    }),
  ),
  checksNow: z.object({ answered: z.number(), outOf: z.number(), failed: z.array(z.string()), failedCritical: z.array(z.string()), mandatoryMissing: z.array(z.string()), words: z.string() }),
  chart: z.object({
    points: z.array(
      z.object({
        pointCode: z.string(),
        checkCode: z.string().nullable(),
        label: z.string(),
        size: z.string().nullable(),
        // B-W2b-283 (FU1:05): a point of the revision's approved measurement spec (B-W2b-224's SPEC), per size with its band.
        source: z.enum(['PLAN', 'SIZE_CHART', 'PROFILE', 'SPEC', 'TYPED']),
        nominal: z.string().nullable(),
        tolerance: z.string().nullable(),
        uom: z.string().nullable(),
        spec: z.string(),
        bySize: z.array(z.object({ size: z.string(), nominal: z.string(), tolerance: z.string(), toleranceMinus: z.string().nullable().optional(), tolerancePlus: z.string().nullable().optional(), words: z.string() })).optional(),
        values: z.array(z.object({ id: z.string(), size: z.string(), sampleIndex: z.number(), measured: z.string(), nominal: z.string(), tolerance: z.string(), toleranceMinus: z.string().nullable().optional(), tolerancePlus: z.string().nullable().optional(), pass: z.boolean(), words: z.string() })),
      }),
    ),
    values: z.number(),
    outOfTolerance: z.number(),
    words: z.string(),
    madeToMeasure: z
      .object({
        garmentType: z.string(),
        revision: z.number(),
        size: z.string(),
        points: z.array(z.object({ code: z.string(), name: z.string(), nominal: z.string(), uom: z.string() })),
        pointsWithout: z.array(z.string()),
      })
      .nullable(),
  }),
  identity: z.object({
    mode: z.enum(['SERIAL', 'BATCH']),
    target: z.number(),
    matched: z.number(),
    missing: z.array(z.string()),
    missingCount: z.number(),
    unknown: z.array(z.string()),
    noNumber: z.number(),
    done: z.boolean(),
    ok: z.boolean().nullable(),
    words: z.string(),
    scans: z.number(),
    batchNumber: z.string().nullable(),
  }),
  photos: z.object({
    slots: z.array(z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string(), mandatory: z.boolean(), photos: z.number(), state: z.enum(['TAKEN', 'MISSING', 'NOT_APPLICABLE', 'OPEN']) })),
    waiting: z.array(z.string()),
    mandatoryMissing: z.array(z.string()),
    words: z.string(),
  }),
  counter: z.object({
    sampleSize: z.number(),
    inspected: z.number(),
    remaining: z.number(),
    classes: z.array(z.object({ defectClass: klass, aql: z.string(), accept: z.number(), reject: z.number(), found: z.number(), state: z.enum(['ok', 'limit', 'reject']), spare: z.number().nullable(), words: z.string() })),
    verdict: z.enum(['open', 'accept', 'reject']),
    stop: z.object({ stop: z.boolean(), source: z.enum(['PLAN', 'COMPANY', 'TENANT', 'DEFAULT']), words: z.string() }),
    words: z.string(),
  }),
  result: z.object({ resultNow: z.enum(INSPECTION_RESULTS), reasons: z.array(z.string()), byCountsOnly: z.boolean(), overrideWords: z.string(), words: z.string() }),
  sign: z.object({ pass: z.object({ held: z.boolean(), reasons: z.array(z.string()) }), fail: z.object({ held: z.boolean(), reasons: z.array(z.string()) }) }),
  may: z.object({ record: z.boolean() }),
})
export type Sheet = z.infer<typeof sheetSchema>
export type SheetCheck = Sheet['checks'][number]
export type ChartPoint = Sheet['chart']['points'][number]

/** A record's model as the queue's routes answer it: W1's view and, on a plan, the sheet. */
export const recordModelSchema = z.object({ final: inspectionReadSchema.nullable(), sheet: sheetSchema.nullable() })
export type RecordModel = z.infer<typeof recordModelSchema>

// ---- the plan that applies, and the sample of the lot ------------------------------------------------------------------------

const sampleClass = z.object({ defectClass: klass, aql: z.string(), accept: z.number(), reject: z.number() })

export const plansSchema = z.object({
  workOrderId: z.string(),
  number: z.string(),
  plans: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), approved: z.object({ id: z.string(), number: z.number() }).nullable(), matches: z.boolean(), usable: z.boolean(), suggested: z.boolean(), because: z.string().nullable() })),
  suggestedId: z.string().nullable(),
  sampling: z
    .object({
      method: z.enum(['FIXED', 'AQL_PROFILE']),
      sampleSize: z.number().nullable(),
      plan: z.object({ lotSize: z.number(), levelText: z.string(), codeLetter: z.string().nullable(), sampleSize: z.number(), hundredPercent: z.boolean(), classes: z.array(sampleClass) }).nullable(),
      named: z.boolean(),
    })
    .nullable(),
})
export type PlansAnswer = z.infer<typeof plansSchema>

/** The FINAL plans of the work order: which one applies, and (with the lot) its sample from the API (never computed here). */
export const readPlans = (api: ApiClient, workOrderId: string, lotSize: number) =>
  floorRead(api, `/quality/final/work-orders/${seg(workOrderId)}/plans`, { query: { lotSize }, schema: plansSchema })

const openedSchema = z.object({ inspection: z.object({ id: z.string(), version: z.number() }) })

/** Opens the inspection on the plan: the lot only, the plan gives the sample inside the command (keep `key` for a resend). */
export const openOnPlan = (api: ApiClient, body: { workOrderId: string; lotSize: number; planId: string }, key: string) =>
  floorWrite(api, 'POST', '/quality/inspections', { body, schema: openedSchema, idempotencyKey: key })

export const readSheet = (api: ApiClient, inspectionId: string, language: string) => floorRead(api, `/quality/inspections/${seg(inspectionId)}/sheet`, { query: { language }, schema: sheetSchema })

export const readRecord = (api: ApiClient, inspectionId: string) => floorRead(api, `/quality/inspections/${seg(inspectionId)}`, { schema: inspectionReadSchema })

/** Signs the result on a plan with the PIN (the checklist is written by the command from the results: none is sent). */
export const decideOnPlan = (api: ApiClient, inspectionId: string, body: { version: number; result: 'PASS' | 'FAIL'; notMakerStatement?: boolean }, key: string) =>
  floorWrite(api, 'POST', `/quality/inspections/${seg(inspectionId)}/decide`, { body, schema: z.object({ inspection: z.object({ id: z.string(), status: z.enum(INSPECTION_STATUSES) }) }), idempotencyKey: key })

// ---- the bench writes: online first, the same action queued when the network fails ---------------------------------------------

/** One write of the bench (B-W2b-106 `quality.final.record`), without the version: the office applies it on the record as it stands. */
export type BenchPayload =
  | { readonly what: 'COUNT'; readonly inspectionId: string; readonly add: number }
  | { readonly what: 'RESULTS'; readonly inspectionId: string; readonly results: readonly { checkCode: string; sampleIndex: number; outcome: 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | null; value?: string | null; note?: string | null }[] }
  | {
      readonly what: 'MEASUREMENTS'
      readonly inspectionId: string
      readonly measurements: readonly { checkCode?: string | null; pointCode?: string | null; size?: string | null; sampleIndex: number; measured: string | null; nominal?: string | null; tolerance?: string | null; uom?: string | null }[]
    }
  | { readonly what: 'IDENTITY'; readonly inspectionId: string; readonly add?: readonly (string | null)[]; readonly remove?: readonly string[] }
  | { readonly what: 'DEFECTS'; readonly inspectionId: string; readonly defects: readonly { defectClass: (typeof DEFECT_CLASSES)[number]; code: string; quantity: number }[] }

const recordAnswer = z.object({ status: z.enum(['accepted', 'duplicate']), model: recordModelSchema })
export type RecordAnswer = z.infer<typeof recordAnswer>

/** The office's key for the queued retry (`<device>.<client event id>`, platform/floor-sync): the try sends the same (B-W2b-77). */
export const recordKey = (deviceId: string | null, clientEventId: string): string => (deviceId ? `${deviceId}.${clientEventId}` : clientEventId)

/** A bench write online first: the office's answer (the record's model), or the item kept on the tablet under the try's id. */
export const recordOrKeep = (api: ApiClient, queue: KeepsActions, online: boolean, deviceId: string | null, payload: BenchPayload) =>
  onlineFirst(queue, {
    online,
    kind: 'quality.final.record',
    payload: payload as unknown as Readonly<Record<string, unknown>>,
    attempt: (clientEventId): Promise<TaskOutcome<RecordAnswer>> =>
      floorWrite(api, 'POST', '/quality/queue/record', { body: { clientEventId, kind: 'quality.final.record', payload }, schema: recordAnswer, idempotencyKey: recordKey(deviceId, clientEventId) }),
  })

// ---- scan to start (QHS-065) -----------------------------------------------------------------------------------------------------

const refSchema = z.object({ recordType: z.string(), id: z.string(), kind: z.string(), number: z.string().nullable(), taken: z.string(), version: z.number(), path: z.string() })
const startedSchema = z.object({ outcome: z.enum(['OPEN', 'STARTED']), started: z.boolean(), open: refSchema, model: recordModelSchema })
export type Started = z.infer<typeof startedSchema>

/** A code at the final bench: the open inspection it leads to (200), or the one it starts (201), with the record's model. */
export const scanToStart = (api: ApiClient, code: string, key: string) => floorWrite(api, 'POST', '/quality/queue/scan', { body: { code, stage: 'FINAL' }, schema: startedSchema, idempotencyKey: key })

const choiceSchema = z.object({ target: z.string(), kind: z.string().nullable(), recordType: z.string().nullable(), id: z.string().nullable(), number: z.string().nullable(), words: z.object({ it: z.string(), en: z.string() }) })
export type ScanChoice = z.infer<typeof choiceSchema>

/** What a code could lead to (read only): the choices when it is several open inspections. */
export const scanChoices = (api: ApiClient, code: string) =>
  floorRead(api, '/quality/queue/scan', { query: { code, stage: 'FINAL' }, schema: z.object({ outcome: z.string(), choices: z.array(choiceSchema) }) })

// ---- the defects a piece may have (B-W2b-90's vocabulary, stage FINAL) ------------------------------------------------------------

const defectSchema = z.object({ id: z.string(), code: z.string(), label: z.string(), severity: z.string(), needsDetail: z.boolean() })
export type FinalDefect = z.infer<typeof defectSchema>

const KEPT_DEFECTS = new AsOfMemory<readonly FinalDefect[]>(2)

/** The FINAL stage's defects in the worker's language, kept for the visit (an offline tablet still counts with them). */
export async function fetchFinalDefects(api: ApiClient, language: string): Promise<TaskOutcome<readonly FinalDefect[]>> {
  const answer = await floorRead(api, '/quality/vocabulary', { query: { stage: 'FINAL', language }, schema: z.object({ defects: z.array(defectSchema) }) })
  if (answer.ok) KEPT_DEFECTS.keep(language, answer.value.defects)
  return answer.ok ? { ok: true, value: answer.value.defects } : answer
}

export const keptFinalDefects = (language: string): Remembered<readonly FinalDefect[]> | null => KEPT_DEFECTS.get(language)

// ---- photos: the photo set's slot or a result's photo (online only) ------------------------------------------------------------

const announced = z.object({ file: z.object({ id: z.string() }), upload: presignedSchema })

/** A photo of a result: announced with its size and SHA-256, its bytes PUT straight to the store, then confirmed. */
export async function uploadResultPhoto(api: ApiClient, inspectionId: string, resultId: string, photo: Blob, name: string): Promise<TaskOutcome<{ fileId: string }>> {
  const base = `/quality/inspections/${seg(inspectionId)}/results/${seg(resultId)}/photos`
  const bytes = await photo.arrayBuffer()
  const first = await floorWrite(api, 'POST', base, { body: { originalName: name, contentType: photo.type || 'image/jpeg', sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes) }, schema: announced })
  if (!first.ok) return first
  try {
    await putToStore(first.value.upload, bytes)
  } catch {
    return { ok: false, problem: { kind: 'unavailable' } }
  }
  const done = await floorWrite(api, 'POST', `${base}/${seg(first.value.file.id)}/complete`, { schema: z.object({ file: z.object({ id: z.string() }) }) })
  return done.ok ? { ok: true, value: { fileId: done.value.file.id } } : done
}

// ---- kept for the visit: the sheets this tablet read (offline, the bench goes on from them) ------------------------------------

const KEPT_SHEETS = new AsOfMemory<RecordModel>(60)
const numberKey = (code: string) => `number:${codeKey(code)}`

/** Keeps a record's model by its id and by its number (an inspection number scanned or picked offline finds it). */
export function keepModel(inspectionId: string, model: RecordModel): void {
  KEPT_SHEETS.keep(inspectionId, model)
  const number = model.final?.inspection.inspectionNumber ?? model.sheet?.inspection.number ?? null
  if (number) KEPT_SHEETS.keep(numberKey(number), model)
}
export const keptModel = (inspectionId: string): Remembered<RecordModel> | null => KEPT_SHEETS.get(inspectionId)
export const keptModelByNumber = (code: string): Remembered<RecordModel> | null => KEPT_SHEETS.get(numberKey(code))
