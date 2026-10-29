import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { CHECKLIST_CODES, DEFECT_CLASSES, INSPECTION_RESULTS, INSPECTION_STATUSES, MAX_DEFECT_LINES, NOTE_MAX, REASON_MAX } from '@nexus/factory-domain/quality/final/rules'
import { CHECK_STATES, FOUR_EYES_RULES, RELEASE_CHECKS, REVERSAL_REASONS, SECOND_PERSON_REASONS, SERIALS_TO } from '@nexus/factory-domain/quality/release/rules'

/**
 * The final inspection and release (B-W1-45; QHS-013, QHS-050, QHS-051, QHS-058, QHS-073, PLT-097; Owner answers Q1, Q2,
 * Q3; A2 SCR-075, SCR-076, SCR-097). Counts are garments (whole numbers); AQLs decimal strings with three decimals. A
 * refused release is a 409 whose issues are `checks/<CODE>` with the words, then `checks/<CODE>/fix`; a maker is refused
 * with the issue `maker`. The only money is the evidence trail's value issued per lot (cost grain: dropped without it).
 */

const version = z.number().int().min(1)
const note = () => z.string().trim().max(NOTE_MAX)
const reason = () => z.string().trim().min(3).max(REASON_MAX)
const flag = z.enum(['true', 'false'])
const limit = z.coerce.number().int().min(1).max(200).default(50)
const garments = z.number().int().min(1).max(100_000)
const status = z.enum(INSPECTION_STATUSES)
const who = output({ kind: z.enum(['FLOOR', 'OFFICE']), workerId: id().nullable(), userId: id().nullable() })

const checklistAnswer = input({ code: z.enum(CHECKLIST_CODES as [string, ...string[]]), ok: z.boolean().nullable(), note: note().nullable().optional() })
const plan = {
  lotSize: garments,
  sampleSize: garments,
  inspectionLevel: z.string().trim().min(1).max(20),
  aqlMajor: z.string().trim().max(8),
  aqlMinor: z.string().trim().max(8),
  acceptMajor: z.number().int().min(0).max(100_000),
  acceptMinor: z.number().int().min(0).max(100_000),
}

const defectOut = output({ id: id(), defectClass: z.enum(DEFECT_CLASSES), code: z.string(), description: z.string().nullable(), quantity: z.number().int(), workOrderSizeId: id().nullable(), note: z.string().nullable() })
export const inspectionOut = output({
  id: id(),
  /** Its own number (INS-2026-0412, the company's INSPECTION series); null for one opened before the series existed. */
  inspectionNumber: z.string().nullable(),
  /** Its number, or "WO-0003 · inspection 2" for one without (W1 history). */
  label: z.string(),
  workOrderId: id(),
  companyId: id(),
  siteId: id(),
  status,
  plan: output({ ...plan, aqlMajor: z.string(), aqlMinor: z.string(), inspectionLevel: z.string(), hundredPercent: z.boolean() }),
  checklist: z.array(output({ code: z.string(), ok: z.boolean().nullable(), note: z.string().nullable() })),
  defects: z.array(defectOut),
  counts: output({ critical: z.number().int(), major: z.number().int(), minor: z.number().int() }),
  /** The rules' result: as it stands while OPEN; what the database wrote once decided. */
  computed: output({ result: z.enum(INSPECTION_RESULTS), words: z.string() }),
  overridden: z.boolean(),
  overrideReason: z.string().nullable(),
  inspector: who,
  notMakerStatement: z.boolean(),
  decidedAt: instant().nullable(),
  signatureSha256: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
})

const makerOut = output({ made: z.boolean(), words: z.string() })
const checkOut = output({ code: z.enum(RELEASE_CHECKS), state: z.enum(CHECK_STATES), message: z.string(), fix: z.string().nullable() })

const reversalOut = output({
  id: id(),
  quantity: z.number().int(),
  reasonCode: z.enum(REVERSAL_REASONS).nullable(),
  reason: z.string(),
  serialIds: z.array(id()),
  serialsTo: z.enum(['MADE', 'RELEASED', 'SHIPPED', 'VOID']).nullable(),
  reversedById: id(),
  reversedAt: instant(),
  /** On hold until an inspection of the work order passes after it (Q3 (a)). */
  onHold: z.boolean(),
})
export const releaseOut = output({
  id: id(),
  /** Its own number (REL-2026-0088, the company's RELEASE series); null for one made before the series existed. */
  releaseNumber: z.string().nullable(),
  workOrderId: id(),
  /** The work order's number. */
  number: z.string(),
  workOrderSizeId: id(),
  inspectionId: id(),
  companyId: id(),
  siteId: id(),
  quantity: z.number().int(),
  reversed: z.number().int(),
  onHold: z.number().int(),
  releasedBy: who,
  releasedAt: instant(),
  signatureSha256: z.string(),
  secondPerson: output({ reasons: z.array(z.enum(SECOND_PERSON_REASONS)), words: z.string() }),
  certificates: z.array(output({ id: id(), number: z.string(), standard: z.string(), ppeClass: z.string().nullable(), statusNow: z.string(), validTo: businessDate() })),
  serials: z.array(output({ id: id(), serial: z.string(), status: z.string(), packed: z.boolean() })),
  reversals: z.array(reversalOut),
  note: z.string().nullable(),
})
const impactOut = output({ reversible: z.number().int(), onDraft: z.number().int(), packed: z.number().int(), shipped: z.number().int(), words: z.string() })

const workOrderParams = input({ workOrderId: id() })
const inspectionParams = input({ inspectionId: id() })
const releaseParams = input({ releaseId: id() })
const inspectionAnswer = output({ inspection: inspectionOut })

// ---- the work order's final state ----------------------------------------------------------------------------------------

export const workOrderFinalContract = defineContract({
  params: workOrderParams,
  response: {
    200: output({
      workOrder: output({ id: id(), number: z.string(), status: z.string(), batchNumber: z.string().nullable(), companyId: id(), siteId: id() }),
      inspectionId: id().nullable(),
      inspections: z.array(output({ id: id(), inspectionNumber: z.string().nullable(), label: z.string(), status, lotSize: z.number().int(), released: z.number().int(), overridden: z.boolean(), decidedAt: instant().nullable() })),
      cells: z.array(
        output({
          workOrderSizeId: id(),
          colourwayCode: z.string(),
          size: z.string(),
          pieces: z.number().int(),
          released: z.number().int(),
          labelsPrinted: z.number().int(),
          /** Garments of the newest PASSED inspection this cell can still release. */
          releasable: z.number().int(),
          readySerials: z.array(output({ id: id(), serial: z.string() })),
          /** "Ready to release" / "Release · 2 checks open", for the viewer as the releaser. */
          summary: z.string(),
          checks: z.array(checkOut),
          secondPersonReasons: z.array(z.enum(SECOND_PERSON_REASONS)),
        }),
      ),
      maker: makerOut,
      documents: z.array(output({ code: z.string(), message: z.string() })),
      rule: output({ rule: z.enum(FOUR_EYES_RULES), source: z.enum(['COMPANY', 'TENANT', 'DEFAULT']), words: z.string(), customerListed: z.boolean() }),
    }),
  },
})

/**
 * The inspection bench's work orders (A2 SCR-097 floor.final "scan"): the caller's sites' work orders with finished garments
 * still to inspect or release, or the one with a scanned number (any status: the bench then says why it is not ready).
 * The floor inspector's role has no other way to turn a traveller's number into a work order. No money, no person.
 */
export const benchWorkOrdersContract = defineContract({
  querystring: input({
    /** A scanned or typed work order number (exact, any status). */
    number: z.string().trim().min(1).max(60).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  }),
  response: {
    200: output({
      workOrders: z.array(
        output({
          id: id(),
          number: z.string(),
          batchNumber: z.string().nullable(),
          status: z.string(),
          siteId: id(),
          dueDate: businessDate().nullable(),
          priority: z.number().int(),
          style: output({ code: z.string(), name: z.string() }),
          pieces: z.number().int(),
          /** Good garments at the final operation; null: the routing has no scanned operation. */
          finished: z.number().int().nullable(),
          /** Garments released (less reversals). */
          released: z.number().int(),
          /** The OPEN inspection of the work order (the bench continues it), or null. */
          openInspectionId: id().nullable(),
          /** Released, in progress or completed with finished garments not yet released. */
          ready: z.boolean(),
        }),
      ),
    }),
  },
})

// ---- inspections ------------------------------------------------------------------------------------------------------------

export const openInspectionContract = defineContract({
  body: input({ workOrderId: id(), ...plan, note: note().nullable().optional() }),
  response: { 200: inspectionAnswer, 201: inspectionAnswer },
})

export const getInspectionContract = defineContract({
  params: inspectionParams,
  response: { 200: output({ inspection: inspectionOut, workOrder: output({ id: id(), number: z.string(), status: z.string(), batchNumber: z.string().nullable() }), maker: makerOut, statementNeeded: z.boolean(), yours: z.boolean() }) },
})

export const updateInspectionContract = defineContract({
  params: inspectionParams,
  body: input({
    version,
    lotSize: plan.lotSize.optional(),
    sampleSize: plan.sampleSize.optional(),
    inspectionLevel: plan.inspectionLevel.optional(),
    aqlMajor: plan.aqlMajor.optional(),
    aqlMinor: plan.aqlMinor.optional(),
    acceptMajor: plan.acceptMajor.optional(),
    acceptMinor: plan.acceptMinor.optional(),
    checklist: z.array(checklistAnswer).max(CHECKLIST_CODES.length * 2).optional(),
    note: note().nullable().optional(),
    notMakerStatement: z.boolean().optional(),
  }),
  response: { 200: inspectionAnswer },
})

export const putDefectsContract = defineContract({
  params: inspectionParams,
  body: input({
    version,
    defects: z
      .array(
        input({
          defectClass: z.enum(DEFECT_CLASSES),
          code: z.string().trim().min(1).max(40),
          quantity: z.number().int().min(0).max(100_000),
          workOrderSizeId: id().nullable().optional(),
          description: note().nullable().optional(),
          note: note().nullable().optional(),
        }),
      )
      .max(MAX_DEFECT_LINES + 1),
  }),
  response: { 200: inspectionAnswer },
})

export const decideInspectionContract = defineContract({
  params: inspectionParams,
  body: input({
    version,
    result: z.enum(INSPECTION_RESULTS),
    checklist: z.array(checklistAnswer).max(CHECKLIST_CODES.length * 2),
    /** "I did not make these garments" — where the site records the station, not the worker. */
    notMakerStatement: z.boolean().optional(),
    /** QHS-013: the decision against the computed result, and why. */
    overrideReason: z.string().trim().max(REASON_MAX).nullable().optional(),
    note: note().nullable().optional(),
  }),
  response: { 200: inspectionAnswer },
})

export const cancelInspectionContract = defineContract({ params: inspectionParams, body: input({ version, reason: reason() }), response: { 200: inspectionAnswer } })

export const listInspectionsContract = defineContract({
  querystring: input({
    companyId: id().optional(),
    siteId: id().optional(),
    workOrderId: id().optional(),
    status: status.optional(),
    /** Goods on hold through it (Q3 (a)): the newest decided inspection FAILED, or its released garments were taken back. */
    onHold: flag.optional(),
    /** The four-eyes queue: PASSED with garments still to release. */
    waitingRelease: flag.optional(),
    limit,
  }),
  response: {
    200: output({
      inspections: z.array(
        output({
          id: id(),
          inspectionNumber: z.string().nullable(),
          label: z.string(),
          workOrderId: id(),
          number: z.string(),
          companyId: id(),
          siteId: id(),
          status,
          lotSize: z.number().int(),
          sampleSize: z.number().int(),
          computedResult: z.enum(INSPECTION_RESULTS).nullable(),
          overridden: z.boolean(),
          inspector: who,
          released: z.number().int(),
          reversed: z.number().int(),
          /** Garments of its lot still to release (PASSED only). */
          toRelease: z.number().int(),
          onHold: z.boolean(),
          holdWords: z.string().nullable(),
          decidedAt: instant().nullable(),
          createdAt: instant(),
        }),
      ),
    }),
  },
})

// ---- releases and reversals ----------------------------------------------------------------------------------------------------

const releaseAnswer = output({ release: releaseOut, words: z.string() })

export const releaseContract = defineContract({
  body: input({ inspectionId: id(), workOrderSizeId: id(), quantity: garments, serialIds: z.array(id()).max(500).optional(), note: note().nullable().optional() }),
  response: { 200: releaseAnswer, 201: releaseAnswer },
})

export const getReleaseContract = defineContract({
  params: releaseParams,
  response: { 200: output({ release: releaseOut, reverseImpact: impactOut, registerEntries: z.array(output({ id: id(), reference: z.string(), status: z.string(), reversalId: id().nullable() })) }) },
})

export const listReleasesContract = defineContract({
  querystring: input({
    companyId: id().optional(),
    siteId: id().optional(),
    workOrderId: id().optional(),
    /** The reversed-release view: releases with garments taken back. */
    reversed: flag.optional(),
    /** Taken-back garments still on hold (Q3 (a)). */
    onHold: flag.optional(),
    limit,
  }),
  response: { 200: output({ releases: z.array(releaseOut) }) },
})

const reverseAnswer = output({
  reversalId: id(),
  impact: impactOut,
  register: output({ opened: z.boolean(), entryId: id().nullable(), reference: z.string().nullable(), shippedGoods: z.boolean().nullable(), words: z.string() }),
  release: releaseOut,
  words: z.string(),
})

export const reverseContract = defineContract({
  params: releaseParams,
  body: input({ quantity: garments, serialIds: z.array(id()).max(500).optional(), serialsTo: z.enum(SERIALS_TO).nullable().optional(), reasonCode: z.enum(REVERSAL_REASONS), reason: reason() }),
  response: { 200: reverseAnswer, 201: reverseAnswer },
})

// ---- the four-eyes rule (Owner answer Q1) -------------------------------------------------------------------------------------------

const ruleAnswer = output({
  companyId: id().nullable(),
  inForce: output({ rule: z.enum(FOUR_EYES_RULES), source: z.enum(['COMPANY', 'TENANT', 'DEFAULT']), words: z.string() }),
  /** This row (the company's, or the tenant-wide one): null when never saved; its version for the next save (0: none). */
  own: output({ releaseFourEyes: z.enum(FOUR_EYES_RULES).nullable(), secondPersonPartyIds: z.array(id()), updatedAt: instant() }).nullable(),
  version: z.number().int(),
  customers: z.array(output({ id: id(), code: z.string(), name: z.string(), listedOn: z.enum(['COMPANY', 'TENANT']) })),
})

export const getRuleContract = defineContract({ querystring: input({ companyId: id().optional() }), response: { 200: ruleAnswer } })

export const saveRuleContract = defineContract({
  body: input({
    companyId: id().nullable().optional(),
    /** null: follow the tenant-wide rule (a company row) or the default (the tenant-wide row). */
    releaseFourEyes: z.enum(FOUR_EYES_RULES).nullable(),
    secondPersonPartyIds: z.array(id()).max(500),
    version: z.number().int().min(0),
    reason: z.string().trim().max(REASON_MAX).nullable().optional(),
  }),
  response: { 200: output({ rule: ruleAnswer, loosened: z.boolean() }) },
})

// ---- the evidence trail (Owner answer Q2 (a)) -----------------------------------------------------------------------------------------

export const evidenceContract = defineContract({
  querystring: input({ serial: z.string().trim().min(3).max(60).optional(), batch: z.string().trim().min(1).max(60).optional() }),
  response: {
    200: output({
      subject: output({
        kind: z.enum(['SERIAL', 'BATCH']),
        serial: output({ id: id(), serial: z.string(), status: z.string(), bundleId: id().nullable(), releaseId: id().nullable() }).nullable(),
        batchNumber: z.string().nullable(),
        workOrder: output({ id: id(), number: z.string(), status: z.string(), companyId: id(), siteId: id(), releasedAt: instant().nullable() }),
        cells: z.array(output({ workOrderSizeId: id(), colourwayCode: z.string(), size: z.string(), pieces: z.number().int() })),
      }),
      style: output({ id: id(), code: z.string(), name: z.string(), ppeCategory: z.string(), ppeStandard: z.string().nullable(), ppeClass: z.string().nullable(), tracking: z.string() }).nullable(),
      revision: output({ id: id(), revision: z.number().int(), status: z.string(), releasedAt: instant().nullable() }).nullable(),
      labelTemplate: output({ id: id(), code: z.string(), revision: z.number().int(), status: z.string(), languages: z.array(z.string()) }).nullable(),
      documents: z.array(output({ id: id(), kind: z.string(), language: z.string(), revision: z.number().int(), status: z.string(), number: z.string().nullable(), issuedAt: z.string().nullable(), file: output({ id: id(), sha256: z.string() }).nullable() })),
      certificates: output({ today: z.array(output({ workOrderSizeId: id(), cell: z.string(), words: z.string() })), date: businessDate() }),
      lots: z.array(
        output({
          id: id(),
          code: z.string(),
          item: output({ code: z.string(), name: z.string(), isPpeComponent: z.boolean() }).nullable(),
          qualityStatus: z.string(),
          crVi: output({ required: z.boolean(), status: z.string(), valueMgKg: z.string().nullable(), limitMgKg: z.string().nullable(), evidence: z.string().nullable(), testedOn: businessDate().nullable() }),
          results: z.array(
            output({
              id: id(),
              test: z.string(),
              method: z.string(),
              valueMgKg: z.string().nullable(),
              belowDetectionLimit: z.boolean(),
              limitMgKg: z.string(),
              verdict: z.string(),
              lab: z.string(),
              reportNumber: z.string().nullable(),
              testedOn: businessDate(),
              evidence: z.string(),
              fileId: id(),
              supersedesId: id().nullable(),
            }),
          ),
          documents: z.array(output({ id: id(), kind: z.string(), fileId: id(), validTo: businessDate().nullable(), status: z.string() })),
          /** The value of the lot issued to the work order, in minor units (cost: dropped without the grain); null when not valued. */
          issuedCostMinor: money.cost(z.number().int().nullable()),
          currency: z.string().nullable(),
        }),
      ),
      cutting: z.array(output({ id: id(), hideCode: z.string().nullable(), lotId: id(), areaUsed: z.string(), uom: z.string(), reversal: z.boolean(), worker: z.string().nullable(), station: z.string().nullable(), at: instant() })),
      bundles: z.array(output({ id: id(), code: z.string(), workOrderSizeId: id(), quantity: z.number().int(), part: z.string().nullable(), status: z.string(), cutLogIds: z.array(id()), madeOn: z.enum(['FLOOR', 'OFFICE']), at: instant() })),
      scans: z.array(
        output({
          id: id(),
          bundleCode: z.string().nullable(),
          operation: output({ seq: z.number().int(), code: z.string(), name: z.string() }).nullable(),
          kind: z.string(),
          good: z.number().int(),
          scrap: z.number().int(),
          rework: z.number().int(),
          corrects: id().nullable(),
          worker: z.string().nullable(),
          station: z.string().nullable(),
          at: instant(),
        }),
      ),
      inspections: z.array(inspectionOut.extend({ checklistAnswered: z.number().int() })),
      releases: z.array(releaseOut),
      labelPrints: z.array(output({ id: id(), kind: z.string(), tracking: z.string(), workOrderSizeId: id(), quantity: z.number().int(), batchNumber: z.string(), reason: z.string().nullable(), postedBy: z.enum(['FLOOR', 'OFFICE']), at: instant() })),
      shipments: z.array(output({ id: id(), number: z.string(), status: z.string(), shippedAt: instant().nullable(), garments: z.number().int(), ddtNumbers: z.array(z.string()) })),
      registerEntries: z.array(output({ id: id(), reference: z.string(), kind: z.string(), status: z.string(), risk: z.string(), reportedAt: instant() })),
    }),
  },
})
