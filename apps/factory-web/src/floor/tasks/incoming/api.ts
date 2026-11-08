import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { onlineFirst, type KeepsActions } from '../../queue/online-first'
import { floorRead, floorWrite, seg, type TaskOutcome } from '../shared/task-api'
import { COMPONENT_KINDS, MARK_KINDS, NEXT_STEPS, UNIT_DECISIONS } from './model'

/**
 * SCR-175's calls (B-W2b-115 on the merged API of B-W2b-98 and B-W2b-111, apps/factory-api modules/quality/incoming, and
 * B-W2b-106's queue, modules/quality/queue; floor at its own site, quality.incoming.view to read, .record to write). No
 * person in a list, no money anywhere; a tablet reads no supplier and no workshop. The API's English (or it/en) `words`
 * are never read here: the screen says its own words from the codes and the numbers.
 *
 *   open here   GET /quality/incoming?status=OPEN                 the site's open incoming inspections (the scan step's list)
 *   scan        POST /quality/queue/scan {code, stage INCOMING}    a lot (our code, the supplier's lot, the dye batch), a hide tag
 *                                                                  or an inspection number: the OPEN inspection (200) or the one it
 *                                                                  opens on its plan (201) — QHS-065; GET for the choices
 *   record      GET /quality/incoming/:id                          the whole record
 *   queued      POST /quality/queue/record {kind quality.incoming.record}   a hide (HIDE / HIDE_REMOVED) and the plan checks
 *                                                                  (RESULTS) ONLINE FIRST: a network failure keeps the SAME payload
 *                                                                  on the tablet under the try's id (B-W2b-77, B-W2b-106)
 *   online      PUT …/rolls, …/components/:seq, …/counters (B-W2b-111: no queue kind) with the record's version
 *   decide      POST …/decide {version, accepted, rejected, toSort, rejectedLines?}   signed: 403 `stepUp` → the PIN → the SAME call
 */

const klass = z.enum(['CRITICAL', 'MAJOR', 'MINOR'])
const decision = z.enum(UNIT_DECISIONS)
const areaUom = z.enum(['M2', 'DM2', 'FT2'])
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
const point = z.object({ x: z.number(), y: z.number() })

export const markSchema = z.object({
  kind: z.enum(MARK_KINDS),
  x: z.number(),
  y: z.number(),
  code: z.string().nullable(),
  zone: z.string().nullable(),
  outline: z.array(point),
  note: z.string().nullable(),
  defectClass: klass.nullable(),
  labelIt: z.string().nullable(),
  labelEn: z.string().nullable(),
})
export type HideMark = z.infer<typeof markSchema>

export const hideSchema = z.object({
  id: z.string(),
  hideId: z.string(),
  code: z.string(),
  seq: z.number(),
  state: z.string(),
  receivedArea: z.object({ area: z.string(), uom: areaUom }),
  measured: z.boolean(),
  declaredArea: z.string().nullable(),
  measuredArea: z.string(),
  areaUom,
  areaCheck: z.object({ declared: z.string(), difference: z.string(), differencePercent: z.string(), outcome: z.enum(['WITHIN', 'SHORT', 'OVER']) }).nullable(),
  shadeGroup: z.object({ id: z.string(), label: z.string(), outOfShade: z.boolean() }).nullable(),
  grade: z.object({ id: z.string(), code: z.string() }).nullable(),
  marks: z.array(markSchema),
  worstClass: klass.nullable(),
  decision: decision.nullable(),
  note: z.string().nullable(),
  version: z.number(),
})
export type HideResult = z.infer<typeof hideSchema>

const certificate = z.object({ id: z.string(), number: z.string(), standard: z.string(), validTo: z.string() })
export type CertificateRef = z.infer<typeof certificate>

export const rollSchema = z.object({
  id: z.string(),
  rollRef: z.string(),
  roll: z.object({ id: z.string(), code: z.string(), state: z.string(), supplierRollRef: z.string().nullable() }).nullable(),
  onePoint: z.number(),
  twoPoint: z.number(),
  threePoint: z.number(),
  fourPoint: z.number(),
  points: z.number(),
  widthCm: z.string(),
  lengthM: z.string(),
  pointsPer100SqYd: z.string(),
  verdict: z.object({ suggested: z.enum(['ACCEPTED', 'REJECTED']), over: z.boolean() }),
  decision: decision.nullable(),
  version: z.number(),
})
export type RollResult = z.infer<typeof rollSchema>

export const componentSchema = z.object({
  id: z.string(),
  seq: z.number(),
  kind: z.enum(COMPONENT_KINDS),
  marking: z.string().nullable(),
  protectorType: z.string().nullable(),
  size: z.string().nullable(),
  certificate: certificate.nullable(),
  certificateCheck: z.object({ state: z.enum(['VALID', 'NOT_IN_FORCE', 'NOT_EN_1621', 'MISSING', 'NOT_NEEDED']) }),
  checkedQuantity: z.number(),
  defectiveQuantity: z.number(),
  suggested: z.enum(['ACCEPTED', 'REJECTED']),
  decision: decision.nullable(),
  version: z.number(),
})
export type ComponentResult = z.infer<typeof componentSchema>

const receiptLine = z.object({
  id: z.string(),
  seq: z.number(),
  operation: z.object({ seq: z.number(), code: z.string(), name: z.string() }),
  bundle: z.object({ id: z.string(), code: z.string() }).nullable(),
  good: z.number(),
  defective: z.number(),
  scrapped: z.number(),
  state: z.enum(['REPORTED', 'HELD', 'REJECTED', 'NOT_REPORTED']),
})
export type ReceiptLine = z.infer<typeof receiptLine>

export const planCheckSchema = z.object({
  id: z.string(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  type: z.string(),
  checkClass: klass.nullable(),
  mandatory: z.boolean(),
  photoRequired: z.boolean(),
  nominal: z.string().nullable(),
  tolerance: z.string().nullable(),
  uom: z.string().nullable(),
  choices: z.array(z.string()),
  answers: z.array(z.object({ id: z.string(), sampleIndex: z.number(), outcome: z.enum(['PASS', 'FAIL', 'NOT_APPLICABLE']), value: z.string().nullable(), note: z.string().nullable() })),
})
export type PlanCheck = z.infer<typeof planCheckSchema>

/** One incoming inspection as the floor reads it (B-W2b-98's record with B-W2b-111's rolls, components and receipt). */
export const recordSchema = z.object({
  inspection: z.object({
    id: z.string(),
    number: z.string(),
    status: z.enum(['OPEN', 'DECIDED', 'CANCELLED']),
    subject: z.enum(['LOT', 'WORKSHOP']),
    lotSize: z.string(),
    uom: z.string(),
    byHide: z.boolean(),
    byRoll: z.boolean(),
    sampleSize: z.number(),
    codeLetter: z.string().nullable(),
    inspectionLevel: z.string().nullable(),
    acceptMajor: z.number().nullable(),
    acceptMinor: z.number().nullable(),
    found: z.object({ critical: z.number(), major: z.number(), minor: z.number() }),
    computedResult: z.enum(['PASS', 'FAIL']).nullable(),
    decision: z.object({ accepted: z.string(), rejected: z.string(), toSort: z.string() }).nullable(),
    decidedAt: z.string().nullable(),
    signatureSha256: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    version: z.number(),
    createdAt: z.string(),
  }),
  lot: z
    .object({
      id: z.string(),
      code: z.string(),
      qualityStatus: z.string(),
      dyeBatch: z.string().nullable(),
      supplierLotRef: z.string().nullable(),
      item: ref,
      colour: ref.nullable(),
    })
    .nullable(),
  receipt: z
    .object({
      id: z.string(),
      seq: z.number(),
      receivedAt: z.string(),
      order: z.object({ id: z.string(), number: z.string(), status: z.string() }),
      workOrder: z.object({ id: z.string(), number: z.string() }),
      lots: z.number(),
      lines: z.array(receiptLine),
    })
    .nullable(),
  plan: z.object({ planId: z.string(), code: z.string(), name: z.string(), versionId: z.string(), number: z.number() }).nullable(),
  sampling: z.object({
    method: z.enum(['AQL', 'FIXED', 'WHOLE']),
    profile: z.object({ id: z.string(), code: z.string(), name: z.string(), inspectionLevel: z.string() }).nullable(),
    plan: z.object({ lotSize: z.number(), levelText: z.string(), codeLetter: z.string().nullable(), sampleSize: z.number(), hundredPercent: z.boolean() }).nullable(),
  }),
  progress: z.object({ done: z.number(), sampleSize: z.number(), remaining: z.number(), decided: z.number(), accepted: z.number(), rejected: z.number(), toSort: z.number(), undecided: z.number() }),
  result: z.object({
    verdict: z.enum(['open', 'accept', 'reject']),
    classes: z.array(z.object({ defectClass: klass, accept: z.number(), reject: z.number(), found: z.number(), state: z.enum(['ok', 'limit', 'reject']) })),
    resultNow: z.enum(['PASS', 'FAIL']),
  }),
  hides: z.array(hideSchema),
  rolls: z.array(rollSchema),
  rollSummary: z.object({ rolls: z.number(), lengthM: z.string(), points: z.number(), pointsPer100SqYd: z.string().nullable(), limit: z.string(), over: z.number(), accepted: z.number(), rejected: z.number(), toSort: z.number(), undecided: z.number() }),
  components: z.array(componentSchema),
  areaCheck: z
    .object({
      uom: areaUom,
      tolerancePercent: z.string(),
      hides: z.number(),
      declared: z.string().nullable(),
      measuredArea: z.string().nullable(),
      differencePercent: z.string().nullable(),
      outcome: z.enum(['WITHIN', 'SHORT', 'OVER']).nullable(),
      opensClaim: z.boolean(),
    })
    .nullable(),
  checks: z.array(planCheckSchema),
  choices: z.object({
    shadeGroups: z.array(z.object({ id: z.string(), label: z.string(), outOfShade: z.boolean(), swatchRef: z.string().nullable() })),
    grades: z.array(z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), usableShare: z.string() })),
    hideDefects: z.array(z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), defectClass: klass })),
    fourPointLimit: z.string(),
    certificates: z.array(certificate),
    coveringCertificate: certificate.nullable(),
  }),
  candidates: z.array(z.object({ hideId: z.string(), code: z.string(), state: z.string(), whole: z.boolean(), area: z.string(), areaUom })),
  rollCandidates: z.array(z.object({ rollId: z.string(), code: z.string(), supplierRollRef: z.string().nullable(), state: z.string(), length: z.string(), uom: z.string(), widthCm: z.string().nullable() })),
  next: z
    .object({
      step: z.enum(NEXT_STEPS),
      lotStatus: z.string().nullable(),
      rejectedHides: z.array(z.object({ hideId: z.string(), code: z.string() })),
      toSortHides: z.array(z.object({ hideId: z.string(), code: z.string() })),
      rejectedRolls: z.array(z.object({ id: z.string(), rollRef: z.string() })),
      rejectedLines: z.array(z.object({ id: z.string(), seq: z.number(), bundleCode: z.string().nullable(), operationCode: z.string(), pieces: z.number() })),
    })
    .nullable(),
  yours: z.boolean(),
  may: z.object({ record: z.boolean(), decide: z.boolean(), cancel: z.boolean() }),
})
export type IncomingRecord = z.infer<typeof recordSchema>

// ---- the site's open inspections (the scan step's list: never a person) -----------------------------------------------------

const rowSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(['OPEN', 'DECIDED', 'CANCELLED']),
  lot: z.object({ id: z.string(), code: z.string(), qualityStatus: z.string() }).nullable(),
  item: ref.nullable(),
  receipt: z.object({ id: z.string(), workOrderId: z.string() }).nullable(),
  lotSize: z.string(),
  uom: z.string(),
  sampleSize: z.number(),
  done: z.number(),
  createdAt: z.string(),
})
export type OpenRow = z.infer<typeof rowSchema>

export const fetchOpen = (api: ApiClient): Promise<TaskOutcome<{ readonly items: readonly OpenRow[] }>> =>
  floorRead(api, '/quality/incoming', { query: { status: 'OPEN', limit: 50 }, schema: z.object({ items: z.array(rowSchema) }) })

export const fetchRecord = (api: ApiClient, inspectionId: string): Promise<TaskOutcome<IncomingRecord>> => floorRead(api, `/quality/incoming/${seg(inspectionId)}`, { schema: recordSchema })

// ---- scan to open (QHS-065) --------------------------------------------------------------------------------------------------

const model = z.object({ incoming: recordSchema.nullable() })
const startedSchema = z.object({ outcome: z.enum(['OPEN', 'STARTED']), started: z.boolean(), model })

/** A code at the incoming bench: the open inspection it leads to (200), or the one it opens on its plan (201). */
export async function scanToOpen(api: ApiClient, code: string, key: string): Promise<TaskOutcome<{ readonly record: IncomingRecord; readonly started: boolean }>> {
  const answer = await floorWrite(api, 'POST', '/quality/queue/scan', { body: { code, stage: 'INCOMING' }, schema: startedSchema, idempotencyKey: key })
  if (!answer.ok) return answer
  return answer.value.model.incoming ? { ok: true, value: { record: answer.value.model.incoming, started: answer.value.started } } : { ok: false, problem: { kind: 'unavailable' } }
}

const choiceSchema = z.object({ target: z.string(), recordType: z.string().nullable(), id: z.string().nullable(), number: z.string().nullable() })
export type ScanChoice = z.infer<typeof choiceSchema>

/** What a code could lead to (read only): the choices when it is several open inspections. */
export const scanChoices = (api: ApiClient, code: string) => floorRead(api, '/quality/queue/scan', { query: { code, stage: 'INCOMING' }, schema: z.object({ outcome: z.string(), choices: z.array(choiceSchema) }) })

// ---- the writes the tablet may keep: a hide, the plan checks --------------------------------------------------------------------

export interface MarkBody {
  readonly kind: 'DEFECT' | 'ZONE'
  readonly x: number
  readonly y: number
  readonly code?: string | null
  readonly zone?: string | null
  readonly outline?: readonly { readonly x: number; readonly y: number }[] | null
}

/** One write of the incoming bench (B-W2b-106 `quality.incoming.record`), without the version: the office applies it as it stands. */
export type BenchPayload =
  | {
      readonly what: 'HIDE'
      readonly inspectionId: string
      readonly hideId: string
      readonly measuredArea?: string | null
      readonly areaUom?: string | null
      readonly shadeGroupId?: string | null
      readonly gradeId?: string | null
      readonly marks?: readonly MarkBody[]
      readonly decision?: (typeof UNIT_DECISIONS)[number] | null
    }
  | { readonly what: 'HIDE_REMOVED'; readonly inspectionId: string; readonly hideId: string }
  | { readonly what: 'RESULTS'; readonly inspectionId: string; readonly results: readonly { readonly planCheckId: string; readonly sampleIndex: number; readonly outcome: 'PASS' | 'FAIL' | 'NOT_APPLICABLE'; readonly value?: string | null }[] }

const recordAnswer = z.object({ status: z.enum(['accepted', 'duplicate']), model })
export type RecordAnswer = z.infer<typeof recordAnswer>

/** The office's key for the queued retry (`<device>.<client event id>`, platform/floor-sync): the try sends the same (B-W2b-77). */
export const recordKey = (deviceId: string | null, clientEventId: string): string => (deviceId ? `${deviceId}.${clientEventId}` : clientEventId)

/** A bench write online first: the office's answer (the record), or the item kept on the tablet under the try's id. */
export const recordOrKeep = (api: ApiClient, queue: KeepsActions, online: boolean, deviceId: string | null, payload: BenchPayload) =>
  onlineFirst(queue, {
    online,
    kind: 'quality.incoming.record',
    payload: payload as unknown as Readonly<Record<string, unknown>>,
    attempt: (clientEventId): Promise<TaskOutcome<RecordAnswer>> =>
      floorWrite(api, 'POST', '/quality/queue/record', { body: { clientEventId, kind: 'quality.incoming.record', payload }, schema: recordAnswer, idempotencyKey: recordKey(deviceId, clientEventId) }),
  })

// ---- online only: rolls, components, the counter (B-W2b-111 has no queue kind for them) -----------------------------------------

export interface RollBody {
  readonly version: number
  readonly rollId?: string | null
  readonly rollRef?: string | null
  readonly onePoint: number
  readonly twoPoint: number
  readonly threePoint: number
  readonly fourPoint: number
  readonly widthCm?: string | null
  readonly lengthM?: string | null
  readonly decision?: (typeof UNIT_DECISIONS)[number] | null
}

export const putRoll = (api: ApiClient, inspectionId: string, body: RollBody, key: string) => floorWrite(api, 'PUT', `/quality/incoming/${seg(inspectionId)}/rolls`, { body, schema: recordSchema, idempotencyKey: key })

export interface ComponentBody {
  readonly version: number
  readonly kind: (typeof COMPONENT_KINDS)[number]
  readonly marking?: string | null
  readonly protectorType?: string | null
  readonly certificateId?: string | null
  readonly checkedQuantity: number
  readonly defectiveQuantity: number
  readonly decision?: (typeof UNIT_DECISIONS)[number] | null
}

export const putComponent = (api: ApiClient, inspectionId: string, seq: number, body: ComponentBody, key: string) =>
  floorWrite(api, 'PUT', `/quality/incoming/${seg(inspectionId)}/components/${seg(String(seq))}`, { body, schema: recordSchema, idempotencyKey: key })

export const putCounters = (api: ApiClient, inspectionId: string, body: { readonly version: number; readonly found: { readonly critical: number; readonly major: number; readonly minor: number } }, key: string) =>
  floorWrite(api, 'PUT', `/quality/incoming/${seg(inspectionId)}/counters`, { body, schema: recordSchema, idempotencyKey: key })

// ---- the decision, signed with the PIN (online only) -----------------------------------------------------------------------------

export interface DecideBody {
  readonly version: number
  readonly accepted: string
  readonly rejected: string
  readonly toSort: string
  /** Goods back from a workshop: the receipt lines (bundles) rejected; the quantities follow from them. */
  readonly rejectedLines?: readonly string[]
}

export const decideIncoming = (api: ApiClient, inspectionId: string, body: DecideBody, key: string) => floorWrite(api, 'POST', `/quality/incoming/${seg(inspectionId)}/decide`, { body, schema: recordSchema, idempotencyKey: key })
