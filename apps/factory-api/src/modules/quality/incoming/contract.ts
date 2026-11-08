import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CHECK_OUTCOMES, INCOMING_LIMITS, MARK_KINDS, NEXT_STEPS, UNIT_DECISIONS } from '@nexus/factory-domain/quality/incoming/rules'
import { CERTIFICATE_CHECKS, COMPONENT_KINDS, COMPONENT_LIMITS, ROLL_UNIT_LIMITS } from '@nexus/factory-domain/quality/incoming/units'
import { planView, resultView } from '../aql/contract'

/**
 * The incoming inspection of B-W2b-98 (QHS-025, QHS-028, QHS-034, MES-054): the contracts of ./views.ts, ./open.ts,
 * ./record.ts and ./decide.ts. Words are checked in factory-domain quality/incoming (answers in words at `body/<field>`);
 * the lengths here only stop oversized bodies. No money anywhere; quantities and areas travel as decimal text.
 *
 * B-W2b-111 (QHS-032, QHS-033, QHS-036): rolls by the 4-point system, component checks, the defect counter, goods back
 * from a workshop (./units.ts, ./receipt.ts; the record's `receipt`, `rolls`, `rollSummary`, `components`).
 */

const version = z.number().int().min(1)
const decimalText = () => z.string().max(24)
const itEn = () => output({ it: z.string(), en: z.string() })
const klass = z.enum(['CRITICAL', 'MAJOR', 'MINOR'])
const status = z.enum(['OPEN', 'DECIDED', 'CANCELLED'])
const decision = z.enum(UNIT_DECISIONS)
const areaUom = z.enum(['M2', 'DM2', 'FT2'])
const quantities = output({ accepted: z.string(), rejected: z.string(), toSort: z.string() })
const ref = output({ id: z.string(), code: z.string(), name: z.string() })

const point = z.strictObject({ x: z.number(), y: z.number() })
const mark = input({
  kind: z.enum(MARK_KINDS),
  x: z.number(),
  y: z.number(),
  code: z.string().max(INCOMING_LIMITS.code * 2).nullish(),
  zone: z.string().max(INCOMING_LIMITS.code * 2).nullish(),
  outline: z.array(point).max(INCOMING_LIMITS.outline * 2).nullish(),
  note: z.string().max(INCOMING_LIMITS.markNote * 2).nullish(),
})

// ---- the record --------------------------------------------------------------------------------------------------------

const markView = output({
  kind: z.enum(MARK_KINDS),
  x: z.number(),
  y: z.number(),
  code: z.string().nullable(),
  zone: z.string().nullable(),
  outline: z.array(output({ x: z.number(), y: z.number() })),
  note: z.string().nullable(),
  defectClass: klass.nullable(),
  labelIt: z.string().nullable(),
  labelEn: z.string().nullable(),
})

const hideView = output({
  id: id(),
  hideId: id(),
  code: z.string(),
  seq: z.number().int(),
  state: z.string(),
  receivedArea: output({ area: z.string(), uom: areaUom }),
  /** Measured in this inspection (a HideMeasure names it); false: the area received stands. */
  measured: z.boolean(),
  declaredArea: z.string().nullable(),
  measuredArea: z.string(),
  areaUom,
  areaCheck: output({ declared: z.string(), difference: z.string(), differencePercent: z.string(), outcome: z.enum(['WITHIN', 'SHORT', 'OVER']) }).nullable(),
  shadeGroup: output({ id: z.string(), label: z.string(), outOfShade: z.boolean() }).nullable(),
  grade: output({ id: z.string(), code: z.string() }).nullable(),
  marks: z.array(markView),
  worstClass: klass.nullable(),
  decision: decision.nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
})

// ---- B-W2b-111: rolls, components, a workshop's receipt ---------------------------------------------------------------------

const verdictWords = output({ suggested: z.enum(['ACCEPTED', 'REJECTED']), over: z.boolean(), words: itEn() })
const certificateRef = output({ id: id(), number: z.string(), standard: z.string(), validTo: z.string() })

const rollView = output({
  id: id(),
  rollRef: z.string(),
  /** The roll's tag (B-W2b-107), when it is named. */
  roll: output({ id: id(), code: z.string(), state: z.string(), supplierRollRef: z.string().nullable() }).nullable(),
  onePoint: z.number().int(),
  twoPoint: z.number().int(),
  threePoint: z.number().int(),
  fourPoint: z.number().int(),
  points: z.number().int(),
  widthCm: z.string(),
  lengthM: z.string(),
  /** Written by the database from the counters, width and length. */
  pointsPer100SqYd: z.string(),
  verdict: verdictWords,
  decision: decision.nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
})

const rollSummaryView = output({
  rolls: z.number().int(),
  lengthM: z.string(),
  squareYards: z.string(),
  points: z.number().int(),
  pointsPer100SqYd: z.string().nullable(),
  limit: z.string(),
  over: z.number().int(),
  accepted: z.number().int(),
  rejected: z.number().int(),
  toSort: z.number().int(),
  undecided: z.number().int(),
  words: itEn(),
})

const componentView = output({
  id: id(),
  seq: z.number().int(),
  kind: z.enum(COMPONENT_KINDS),
  kindWords: itEn(),
  marking: z.string().nullable(),
  protectorType: z.string().nullable(),
  size: z.string().nullable(),
  certificate: certificateRef.nullable(),
  certificateCheck: output({ state: z.enum(CERTIFICATE_CHECKS), words: itEn() }),
  checkedQuantity: z.number().int(),
  defectiveQuantity: z.number().int(),
  suggested: z.enum(['ACCEPTED', 'REJECTED']),
  reasons: z.array(itEn()),
  decision: decision.nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
})

const receiptHead = output({
  id: id(),
  seq: z.number().int(),
  receivedAt: instant(),
  order: output({ id: id(), number: z.string(), status: z.string() }),
  workOrder: output({ id: id(), number: z.string() }),
  /** Office only (a tablet reads no party). */
  workshop: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  /** The pieces to inspect: good and defective. */
  pieces: z.number().int(),
})

const receiptView = output({
  id: id(),
  seq: z.number().int(),
  receivedAt: instant(),
  workshopDdtNumber: z.string().nullable(),
  order: output({ id: id(), number: z.string(), status: z.string() }),
  workOrder: output({ id: id(), number: z.string() }),
  workshop: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  /** The pieces inspected: good and defective. */
  lots: z.number().int(),
  lines: z.array(
    output({
      id: id(),
      seq: z.number().int(),
      operation: output({ seq: z.number().int(), code: z.string(), name: z.string() }),
      bundle: output({ id: id(), code: z.string() }).nullable(),
      good: z.number().int(),
      defective: z.number().int(),
      scrapped: z.number().int(),
      reason: z.string().nullable(),
      /** REPORTED at its operation; HELD for the open inspection; REJECTED by the decision; NOT_REPORTED (the office's to report). */
      state: z.enum(['REPORTED', 'HELD', 'REJECTED', 'NOT_REPORTED']),
      scanId: id().nullable(),
    }),
  ),
  /** While the inspection is open: what waits, in words. */
  held: itEn().nullable(),
})

export const incomingView = output({
  inspection: output({
    id: id(),
    number: z.string(),
    status,
    companyId: id(),
    siteId: id(),
    /** B-W2b-111: a lot, or goods back from a workshop. */
    subject: z.enum(['LOT', 'WORKSHOP']),
    lotSize: z.string(),
    uom: z.string(),
    byHide: z.boolean(),
    /** B-W2b-111: a lot counted in a length, inspected roll by roll (the sample is a number of rolls). */
    byRoll: z.boolean(),
    sampleSize: z.number().int(),
    codeLetter: z.string().nullable(),
    inspectionLevel: z.string().nullable(),
    aqlMajor: z.string().nullable(),
    aqlMinor: z.string().nullable(),
    acceptMajor: z.number().int().nullable(),
    acceptMinor: z.number().int().nullable(),
    found: output({ critical: z.number().int(), major: z.number().int(), minor: z.number().int() }),
    computedResult: z.enum(['PASS', 'FAIL']).nullable(),
    overrideReason: z.string().nullable(),
    decision: quantities.nullable(),
    decidedAt: instant().nullable(),
    signatureSha256: z.string().nullable(),
    cancelledAt: instant().nullable(),
    cancelReason: z.string().nullable(),
    dueAt: instant().nullable(),
    note: z.string().nullable(),
    version: z.number().int(),
    createdAt: instant(),
  }),
  lot: output({
    id: id(),
    code: z.string(),
    qualityStatus: z.string(),
    dyeBatch: z.string().nullable(),
    supplierLotRef: z.string().nullable(),
    receivedAt: instant().nullable(),
    item: ref,
    colour: ref.nullable(),
    /** Office only (a tablet reads no party). */
    supplier: output({ id: z.string(), name: z.string() }).nullable(),
  }).nullable(),
  receipt: receiptView.nullable(),
  plan: output({ planId: id(), code: z.string(), name: z.string(), versionId: id(), number: z.number().int() }).nullable(),
  sampling: output({
    method: z.enum(['AQL', 'FIXED', 'WHOLE']),
    profile: output({ id: id(), code: z.string(), name: z.string(), inspectionLevel: z.string() }).nullable(),
    /** "Inspect 13 of 120 hides · 5 done". */
    words: itEn(),
    /** ISO 2859-1's derivation for the lot and the profile (B-W2b-93's plan). */
    plan: planView.nullable(),
  }),
  progress: output({ done: z.number().int(), sampleSize: z.number().int(), remaining: z.number().int(), decided: z.number().int(), accepted: z.number().int(), rejected: z.number().int(), toSort: z.number().int(), undecided: z.number().int() }),
  result: resultView,
  hides: z.array(hideView),
  rolls: z.array(rollView),
  rollSummary: rollSummaryView,
  components: z.array(componentView),
  areaCheck: output({
    uom: areaUom,
    tolerancePercent: z.string(),
    toleranceFrom: z.enum(['ORDER_LINE', 'DEFAULT']),
    hides: z.number().int(),
    declared: z.string().nullable(),
    measuredArea: z.string().nullable(),
    difference: z.string().nullable(),
    differencePercent: z.string().nullable(),
    outcome: z.enum(['WITHIN', 'SHORT', 'OVER']).nullable(),
    opensClaim: z.boolean(),
    words: itEn(),
    route: z.string(),
  }).nullable(),
  checks: z.array(
    output({
      id: id(),
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
      answers: z.array(output({ id: id(), sampleIndex: z.number().int(), outcome: z.enum(CHECK_OUTCOMES), value: z.string().nullable(), note: z.string().nullable() })),
    }),
  ),
  checksNow: output({ failed: z.array(z.string()), failedCritical: z.array(z.string()), mandatoryMissing: z.array(z.string()) }),
  choices: output({
    shadeGroups: z.array(output({ id: id(), label: z.string(), outOfShade: z.boolean(), swatchRef: z.string().nullable(), swatchFileId: z.string().nullable(), lotId: z.string().nullable() })),
    grades: z.array(output({ id: id(), code: z.string(), labelIt: z.string(), labelEn: z.string(), usableShare: z.string() })),
    hideDefects: z.array(output({ id: id(), code: z.string(), labelIt: z.string(), labelEn: z.string(), defectClass: klass })),
    pointClasses: z.array(output({ points: z.number().int(), it: z.string(), en: z.string() })),
    fourPointLimit: z.string(),
    componentKinds: z.array(output({ kind: z.enum(COMPONENT_KINDS), it: z.string(), en: z.string() })),
    certificates: z.array(certificateRef),
    coveringCertificate: certificateRef.nullable(),
  }),
  candidates: z.array(output({ hideId: id(), code: z.string(), state: z.string(), whole: z.boolean(), area: z.string(), areaUom })),
  /** B-W2b-111: the lot's tagged rolls not on the inspection yet. */
  rollCandidates: z.array(output({ rollId: id(), code: z.string(), supplierRollRef: z.string().nullable(), state: z.string(), length: z.string(), uom: z.string(), widthCm: z.string().nullable() })),
  next: output({
    step: z.enum(NEXT_STEPS),
    words: itEn(),
    /** A lot's quality status and its release route; null for goods back from a workshop. */
    lotStatus: z.string().nullable(),
    lotRoute: z.string().nullable(),
    rejectedHides: z.array(output({ hideId: id(), code: z.string() })),
    toSortHides: z.array(output({ hideId: id(), code: z.string() })),
    rejectedRolls: z.array(output({ id: id(), rollRef: z.string() })),
    rejectedLines: z.array(output({ id: id(), seq: z.number().int(), bundleCode: z.string().nullable(), operationCode: z.string(), pieces: z.number().int() })),
    holdPrefill: output({ subjectType: z.literal('Hide'), subjectIds: z.array(id()), reasonNote: z.string() }).nullable(),
    returnPrefill: output({ kind: z.literal('RETURN'), foundAt: z.literal('INSPECTION'), reasonNote: z.string(), from: output({ lotId: id(), hideIds: z.array(id()) }) }).nullable(),
  }).nullable(),
  inspector: output({ kind: z.enum(['FLOOR', 'OFFICE']).nullable(), name: z.string().nullable(), hidden: z.boolean() }),
  yours: z.boolean(),
  may: output({ record: z.boolean(), decide: z.boolean(), cancel: z.boolean() }),
})

const inspectionParams = input({ inspectionId: id() })
const hideParams = input({ inspectionId: id(), hideId: id() })
const rollParams = input({ inspectionId: id(), rollResultId: id() })
const componentParams = input({ inspectionId: id(), seq: z.coerce.number().int().min(1).max(COMPONENT_LIMITS.rows) })

// ---- routes -------------------------------------------------------------------------------------------------------------

export const listContract = defineContract({
  querystring: input({ status: status.optional(), lotId: id().optional(), subcontractReceiptId: id().optional(), cursor: id().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: {
    200: output({
      items: z.array(
        output({
          id: id(),
          number: z.string(),
          status,
          companyId: id(),
          siteId: id(),
          lot: output({ id: id(), code: z.string(), qualityStatus: z.string() }).nullable(),
          item: ref.nullable(),
          /** B-W2b-111: goods back from a workshop. */
          receipt: output({ id: id(), workOrderId: id() }).nullable(),
          lotSize: z.string(),
          uom: z.string(),
          sampleSize: z.number().int(),
          done: z.number().int(),
          computedResult: z.enum(['PASS', 'FAIL']).nullable(),
          decision: quantities.nullable(),
          inspectorKind: z.enum(['FLOOR', 'OFFICE']).nullable(),
          dueAt: instant().nullable(),
          createdAt: instant(),
          /** B-W2b-127 (design qi-grid): the lot's supplier (office only), the plan version, a countersigned correction. */
          supplier: output({ id: id(), name: z.string() }).nullable(),
          plan: output({ code: z.string(), number: z.number().int() }),
          amended: z.boolean(),
        }),
      ),
      nextCursor: id().nullable(),
    }),
  },
})

export const scanLotContract = defineContract({
  params: input({ lotId: id() }),
  response: {
    200: output({
      lot: output({ id: id(), code: z.string(), qualityStatus: z.string(), dyeBatch: z.string().nullable(), supplierLotRef: z.string().nullable(), item: ref, colour: ref.nullable() }),
      decided: z.number().int(),
      open: incomingView.nullable(),
      opening: output({
        plan: output({ planId: id(), code: z.string(), name: z.string(), versionId: id(), number: z.number().int() }).nullable(),
        lotSize: z.string().nullable(),
        uom: z.string().nullable(),
        sampleSize: z.number().int().nullable(),
        words: itEn().nullable(),
        refusal: z.string().nullable(),
      }).nullable(),
    }),
  },
})

const openingView = output({
  plan: output({ planId: id(), code: z.string(), name: z.string(), versionId: id(), number: z.number().int() }).nullable(),
  lotSize: z.string().nullable(),
  uom: z.string().nullable(),
  sampleSize: z.number().int().nullable(),
  words: itEn().nullable(),
  refusal: z.string().nullable(),
})

export const scanReceiptContract = defineContract({
  params: input({ receiptId: id() }),
  response: { 200: output({ receipt: receiptHead, decided: z.number().int(), open: incomingView.nullable(), opening: openingView.nullable() }) },
})

export const openContract = defineContract({
  body: input({
    /** A lot, or (B-W2b-111) a workshop's receipt: exactly one. */
    lotId: id().nullish(),
    subcontractReceiptId: id().nullish(),
    planId: id().nullish(),
    profileId: id().nullish(),
    reason: z.string().max(INCOMING_LIMITS.reason * 2).nullish(),
    note: z.string().max(INCOMING_LIMITS.note * 2).nullish(),
  }),
  response: { 201: incomingView },
})

export const getContract = defineContract({ params: inspectionParams, response: { 200: incomingView } })

export const putHideContract = defineContract({
  params: hideParams,
  body: input({
    version,
    measuredArea: decimalText().nullish(),
    declaredArea: decimalText().nullish(),
    areaUom: z.string().max(8).nullish(),
    shadeGroupId: id().nullish(),
    gradeId: id().nullish(),
    marks: z.array(mark).max(INCOMING_LIMITS.marks * 2).optional(),
    decision: decision.nullish(),
    note: z.string().max(INCOMING_LIMITS.note * 2).nullish(),
  }),
  response: { 200: incomingView },
})

export const removeHideContract = defineContract({ params: hideParams, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: incomingView } })

export const putResultsContract = defineContract({
  params: inspectionParams,
  body: input({
    version,
    results: z
      .array(
        input({
          planCheckId: id(),
          sampleIndex: z.number().int().min(1).optional(),
          outcome: z.enum(CHECK_OUTCOMES),
          value: z.string().max(INCOMING_LIMITS.value * 2).nullish(),
          note: z.string().max(INCOMING_LIMITS.note * 2).nullish(),
        }),
      )
      .max(INCOMING_LIMITS.results * 2),
  }),
  response: { 200: incomingView },
})

export const decideContract = defineContract({
  params: inspectionParams,
  body: input({
    version,
    accepted: decimalText(),
    rejected: decimalText(),
    toSort: decimalText(),
    overrideReason: z.string().max(INCOMING_LIMITS.reason * 2).nullish(),
    note: z.string().max(INCOMING_LIMITS.note * 2).nullish(),
    /** B-W2b-111: goods back from a workshop: the receipt lines (bundles) rejected; the quantities follow from them. */
    rejectedLines: z.array(id()).max(400).optional(),
  }),
  response: { 200: incomingView },
})

const counter = () => z.number().int().min(0).max(ROLL_UNIT_LIMITS.counter * 10)

export const putRollContract = defineContract({
  params: inspectionParams,
  body: input({
    version,
    rollId: id().nullish(),
    rollRef: z.string().max(ROLL_UNIT_LIMITS.rollRef * 2).nullish(),
    onePoint: counter().optional(),
    twoPoint: counter().optional(),
    threePoint: counter().optional(),
    fourPoint: counter().optional(),
    widthCm: decimalText().nullish(),
    lengthM: decimalText().nullish(),
    decision: decision.nullish(),
    note: z.string().max(ROLL_UNIT_LIMITS.note * 2).nullish(),
  }),
  response: { 200: incomingView },
})

export const removeRollContract = defineContract({ params: rollParams, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: incomingView } })

export const putComponentContract = defineContract({
  params: componentParams,
  body: input({
    version,
    kind: z.enum(COMPONENT_KINDS),
    marking: z.string().max(COMPONENT_LIMITS.marking * 2).nullish(),
    protectorType: z.string().max(8).nullish(),
    size: z.string().max(COMPONENT_LIMITS.size * 2).nullish(),
    certificateId: id().nullish(),
    checkedQuantity: z.number().int().min(0).max(COMPONENT_LIMITS.checked * 10),
    defectiveQuantity: z.number().int().min(0).max(COMPONENT_LIMITS.checked * 10).optional(),
    decision: decision.nullish(),
    note: z.string().max(COMPONENT_LIMITS.note * 2).nullish(),
  }),
  response: { 200: incomingView },
})

export const removeComponentContract = defineContract({ params: componentParams, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: incomingView } })

export const putCountersContract = defineContract({
  params: inspectionParams,
  body: input({ version, found: input({ critical: z.number().int().min(0).max(100000), major: z.number().int().min(0).max(100000), minor: z.number().int().min(0).max(100000) }) }),
  response: { 200: incomingView },
})

export const cancelContract = defineContract({
  params: inspectionParams,
  body: input({ version, reason: z.string().max(INCOMING_LIMITS.reason * 2) }),
  response: { 200: incomingView },
})
