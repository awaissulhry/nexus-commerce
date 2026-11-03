import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { CHECKLIST_CODES, DEFECT_CLASSES, INSPECTION_RESULTS, INSPECTION_STATUSES, MAX_DEFECT_LINES, NOTE_MAX, REASON_MAX } from '@nexus/factory-domain/quality/final/rules'
import { CHECK_STATES, FOUR_EYES_RULES, RELEASE_CHECKS, REVERSAL_REASONS, SECOND_PERSON_REASONS, SERIALS_TO } from '@nexus/factory-domain/quality/release/rules'
// B-W2b-97: the final inspection by plan.
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { IDENTITY_MODES, PLAN_LIMITS, RESULT_OUTCOMES } from '@nexus/factory-domain/quality/final/plan'
import { CHECK_TYPES } from '@nexus/factory-domain/quality/plans/rules'
import { fileView, presignedView } from '../../../platform/files/contract'
import { chainView as chainOut, planView as aqlPlanOut } from '../aql/contract'

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

const defectOut = output({
  id: id(),
  defectClass: z.enum(DEFECT_CLASSES),
  code: z.string(),
  /** W2a (B-W2a-67): the library's defect it was picked from (null: typed, W1) and where on the garment (a GARMENT_ZONES id). */
  defectCodeId: id().nullable(),
  zone: z.string().nullable(),
  description: z.string().nullable(),
  quantity: z.number().int(),
  workOrderSizeId: id().nullable(),
  note: z.string().nullable(),
})
/**
 * W2a (B-W2a-67; design qi-assign): who an inspection is assigned to before it is decided — an office user (by name) or a
 * worker of the site (named only inside one inspection, never in the list: Owner answer W1).
 */
const assignedOut = output({ kind: z.enum(['USER', 'WORKER']), userId: id().nullable(), workerId: id().nullable(), name: z.string().nullable() })
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
  assigned: assignedOut.nullable(),
  /** B-W2b-17: by when it is due (the office sets it while OPEN), and whether it is past it. */
  dueAt: instant().nullable(),
  overdue: z.boolean(),
  notMakerStatement: z.boolean(),
  decidedAt: instant().nullable(),
  signatureSha256: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  /** B-W2b-97: the plan version it runs on (null: W1's fixed checklist), the AQL profile and ISO 2859-1 code letter of its sample, the units inspected (on a plan). */
  planVersion: output({ id: id(), planId: id(), code: z.string(), name: z.string(), number: z.number().int() }).nullable(),
  aqlProfileId: id().nullable(),
  codeLetter: z.string().nullable(),
  inspected: z.number().int().nullable(),
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

/** A quality hold of a work order as the bench shows it (B-W2a-75): no person's name, the placer's kind only. */
const benchHoldOut = output({
  id: id(),
  reasonCode: z.string(),
  reasonIt: z.string(),
  reasonEn: z.string(),
  reasonNote: z.string().nullable(),
  placedAt: instant(),
  placedBy: z.enum(['USER', 'WORKER', 'SYSTEM']),
  /** The NCR that decides it, once one does. */
  ncrNumber: z.string().nullable(),
})

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
      /** B-W2a-75: the ACTIVE quality holds of the work order (releasing and packing wait for quality), oldest first. */
      holds: z.array(benchHoldOut),
    }),
  },
})

/**
 * B-W2a-75 — Hold lot at the inspection bench (floor): a reason of the HOLD list (its note when it asks one), the open
 * inspection when there is one, the garments held. ONE command places the hold on the work order and raises the NCR that
 * decides it (./bench-hold.ts). 201 with the hold as the bench shows it and the NCR's number.
 */
export const benchHoldContract = defineContract({
  params: workOrderParams,
  body: input({
    reasonCode: z.string().trim().min(1).max(40),
    reasonNote: z.string().trim().max(500).nullish(),
    inspectionId: id().nullish(),
    quantity: garments,
  }),
  response: {
    201: output({ hold: benchHoldOut, workOrderHeld: z.boolean(), ncr: output({ id: id(), number: z.string() }), replayed: z.boolean() }),
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
          /**
           * B-W2b-17 (B-W2a-67's gap: the bench list says who is assigned): the open inspection's number, due time and assignee —
           * the caller's own (`mine`), an office person (named for the office only) or another bench inspector (never named).
           */
          openInspection: output({
            id: id(),
            number: z.string().nullable(),
            dueAt: instant().nullable(),
            overdue: z.boolean(),
            assigned: output({ kind: z.enum(['USER', 'WORKER']), mine: z.boolean(), name: z.string().nullable() }).nullable(),
          }).nullable(),
          /** Released, in progress or completed with finished garments not yet released. */
          ready: z.boolean(),
        }),
      ),
    }),
  },
})

// ---- inspections ------------------------------------------------------------------------------------------------------------

export const openInspectionContract = defineContract({
  /** W2a (B-W2a-67; design qi-new "Inspector (optional)"): the office may assign it at once (never a maker). */
  body: input({
    workOrderId: id(),
    lotSize: plan.lotSize,
    // W1's typed sampling plan: every field, or none (B-W2b-97: the plan's fixed sample or the AQL profile then gives it).
    sampleSize: plan.sampleSize.optional(),
    inspectionLevel: plan.inspectionLevel.optional(),
    aqlMajor: plan.aqlMajor.optional(),
    aqlMinor: plan.aqlMinor.optional(),
    acceptMajor: plan.acceptMajor.optional(),
    acceptMinor: plan.acceptMinor.optional(),
    note: note().nullable().optional(),
    assigneeId: id().nullable().optional(),
    assigneeWorkerId: id().nullable().optional(),
    /** B-W2b-17: by when it is due (office only). */
    dueAt: instant().nullable().optional(),
    /** B-W2b-97: the FINAL plan it runs on (its approved version is frozen on it), and why when another plan applies. */
    planId: id().nullable().optional(),
    planReason: reason().nullable().optional(),
    /** B-W2b-93's chain: a profile other than the one it gives, and why. */
    profileId: id().nullable().optional(),
    profileReason: reason().nullable().optional(),
  }),
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
          /** W2a: picked from the library (an active defect, not a category; `code` is its code) and its garment zone. */
          defectCodeId: id().nullable().optional(),
          zone: z.string().trim().max(40).nullable().optional(),
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
    /** W1's checklist; B-W2b-97: an inspection on a plan sends none (its results are the answers). */
    checklist: z.array(checklistAnswer).max(CHECKLIST_CODES.length * 2).optional(),
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
    /** W2a (B-W2a-67; design qi-metrics "Failed - not decided"): the newest decided inspection FAILED, no hold and no NCR from it yet. */
    failedUndecided: flag.optional(),
    /** W2a: assigned to the caller (`me`), or not decided and assigned to nobody (`none`). */
    assigned: z.enum(['me', 'none']).optional(),
    /** B-W2b-17: open and past its due time. */
    overdue: flag.optional(),
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
          /** W2a: who it is assigned to (a worker without a name: names only inside one inspection). */
          assigned: assignedOut.nullable(),
          /** B-W2b-17: by when it is due, and whether it is past it. */
          dueAt: instant().nullable(),
          overdue: z.boolean(),
          /** W2a: the quality holds placed from it (any state) and the NCRs raised from or linked to it (not cancelled). */
          holds: z.number().int(),
          ncrs: z.number().int(),
          /** FAILED, the newest decided of its work order, with no hold and no NCR from it: someone must decide (qi-metrics). */
          undecided: z.boolean(),
          version: z.number().int(),
          decidedAt: instant().nullable(),
          createdAt: instant(),
        }),
      ),
    }),
  },
})

// ---- W2a: assign an inspector (B-W2a-67; design qi-assign, qi-grid inline "Inspector") ----------------------------------------

/**
 * The people an inspection of these work orders may be assigned to at a site: ACTIVE office users who record inspections
 * there and, for whoever sees the site's workers, its floor inspectors; each with the work orders of these whose garments
 * they made (held in the dialog: "Made garments of WO-0142"). Me first, then by name.
 */
export const inspectorsContract = defineContract({
  querystring: input({ siteId: id(), workOrderIds: z.string().max(2000).optional() }),
  response: {
    200: output({
      inspectors: z.array(output({ kind: z.enum(['USER', 'WORKER']), id: id(), name: z.string(), me: z.boolean(), made: z.array(z.string()) })),
      floorListed: z.boolean(),
    }),
  },
})

/** Assign (or clear) the inspector of OPEN inspections, all in one command: every one or none (409 `inspections/<i>`). */
export const assignContract = defineContract({
  body: input({
    inspections: z.array(input({ id: id(), version })).min(1).max(50),
    assigneeId: id().nullable().optional(),
    assigneeWorkerId: id().nullable().optional(),
  }),
  response: { 200: output({ inspections: z.array(output({ id: id(), version: z.number().int(), assigned: assignedOut.nullable() })) }) },
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
  /** B-W2b-10: the cell's garments that left finished goods with the reversal (a report taken back whole: the rest put back), and what is left to take out by hand. */
  finishedGoods: output({ takenOut: z.number().int(), putBack: z.number().int(), left: z.number().int(), moveIds: z.array(id()), words: z.string() }),
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
      cutting: z.array(output({ id: id(), hideCode: z.string().nullable(), lotId: id(), areaUsed: z.string(), uom: z.string(), reversal: z.boolean(), worker: z.string().nullable(), workerHidden: z.boolean(), station: z.string().nullable(), at: instant() })),
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
          workerHidden: z.boolean(),
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

// ---- B-W2b-17: by when an inspection is due (design qi-grid inline "Due") --------------------------------------------------

/** Set (or clear) the due time of OPEN inspections, all in one command: every one or none (409 `inspections/<i>`). */
export const dueContract = defineContract({
  body: input({ inspections: z.array(input({ id: id(), version })).min(1).max(50), dueAt: instant().nullable() }),
  response: { 200: output({ inspections: z.array(output({ id: id(), version: z.number().int(), dueAt: instant().nullable(), overdue: z.boolean() })) }) },
})

// ---- B-W2b-97: the final inspection by plan ------------------------------------------------------------------------------------

const outcome = z.enum(RESULT_OUTCOMES)
const verdict = z.enum(['open', 'accept', 'reject'])
const words = z.string()
const decimalText = z.string().trim().max(14)
const versionBody = { version }

/** The bench sheet: the checks with their results and photos, the measurement chart, the identity check, the photo set, the counter, the result, what holds the signature. */
export const sheetOut = output({
  inspection: output({
    id: id(),
    number: z.string().nullable(),
    workOrderId: id(),
    status,
    version: z.number().int(),
    lotSize: z.number().int(),
    sampleSize: z.number().int(),
    inspectionLevel: z.string(),
    codeLetter: z.string().nullable(),
    aqlProfileId: id().nullable(),
    aqlMajor: z.string(),
    aqlMinor: z.string(),
    acceptMajor: z.number().int(),
    acceptMinor: z.number().int(),
    decidedAt: instant().nullable(),
  }),
  plan: output({ planId: id(), code: z.string(), name: z.string(), versionId: id(), number: z.number().int(), samplingMethod: z.enum(['AQL_PROFILE', 'FIXED']) }),
  language: z.string(),
  checks: z.array(
    output({
      id: id(),
      code: z.string(),
      label: z.string(),
      /** The person's language has no words for it: English stands in. */
      missingWords: z.boolean(),
      labelIt: z.string(),
      labelEn: z.string(),
      type: z.enum(CHECK_TYPES),
      typeWords: z.string(),
      checkClass: z.enum(DEFECT_CLASSES).nullable(),
      classWords: z.string().nullable(),
      mandatory: z.boolean(),
      photoRequired: z.boolean(),
      takesResult: z.boolean(),
      /** A measurement: answered on the chart. */
      onChart: z.boolean(),
      choices: z.array(z.string()),
      results: z.array(
        output({
          id: id(),
          sampleIndex: z.number().int(),
          outcome,
          value: z.string().nullable(),
          note: z.string().nullable(),
          photos: z.array(output({ id: id(), status: z.string() })),
          recordedBy: z.enum(['FLOOR', 'OFFICE']),
          recordedAt: instant(),
        }),
      ),
    }),
  ),
  /** "11 of 12 checked · 1 failed · critical failed: none". */
  checksNow: output({ answered: z.number().int(), outOf: z.number().int(), failed: z.array(z.string()), failedCritical: z.array(z.string()), mandatoryMissing: z.array(z.string()), words }),
  chart: output({
    points: z.array(
      output({
        pointCode: z.string(),
        checkCode: z.string().nullable(),
        label: z.string(),
        size: z.string().nullable(),
        /** PLAN: the plan's nominal; SIZE_CHART: typed from the size chart; PROFILE: the rider's measurement profile (QHS-053); TYPED: a point measured outside the plan. */
        source: z.enum(['PLAN', 'SIZE_CHART', 'PROFILE', 'TYPED']),
        nominal: z.string().nullable(),
        tolerance: z.string().nullable(),
        uom: z.string().nullable(),
        spec: z.string(),
        values: z.array(output({ id: id(), size: z.string(), sampleIndex: z.number().int(), measured: z.string(), nominal: z.string(), tolerance: z.string(), pass: z.boolean(), words })),
      }),
    ),
    values: z.number().int(),
    outOfTolerance: z.number().int(),
    words,
    madeToMeasure: output({
      garmentType: z.string(),
      revision: z.number().int(),
      size: z.string(),
      points: z.array(output({ code: z.string(), name: z.string(), nominal: z.string(), uom: z.string() })),
      pointsWithout: z.array(z.string()),
    }).nullable(),
  }),
  identity: output({
    mode: z.enum(IDENTITY_MODES),
    target: z.number().int(),
    matched: z.number().int(),
    missing: z.array(z.string()),
    missingCount: z.number().int(),
    unknown: z.array(z.string()),
    noNumber: z.number().int(),
    done: z.boolean(),
    ok: z.boolean().nullable(),
    words,
    scans: z.number().int(),
    batchNumber: z.string().nullable(),
  }),
  photos: output({
    slots: z.array(output({ code: z.string(), labelIt: z.string(), labelEn: z.string(), mandatory: z.boolean(), photos: z.number().int(), state: z.enum(['TAKEN', 'MISSING', 'NOT_APPLICABLE', 'OPEN']) })),
    waiting: z.array(z.string()),
    mandatoryMissing: z.array(z.string()),
    words,
  }),
  counter: output({
    sampleSize: z.number().int(),
    inspected: z.number().int(),
    remaining: z.number().int(),
    classes: z.array(output({ defectClass: z.enum(DEFECT_CLASSES), aql: z.string(), accept: z.number().int(), reject: z.number().int(), found: z.number().int(), state: z.enum(['ok', 'limit', 'reject']), spare: z.number().int().nullable(), words })),
    verdict,
    stop: output({ stop: z.boolean(), source: z.enum(['PLAN', 'COMPANY', 'TENANT', 'DEFAULT']), words }),
    words,
  }),
  result: output({ resultNow: z.enum(INSPECTION_RESULTS), reasons: z.array(z.string()), byCountsOnly: z.boolean(), overrideWords: words, words }),
  /** What holds the signature of a PASS and of a FAIL, in words (never silent). */
  sign: output({ pass: output({ held: z.boolean(), reasons: z.array(z.string()) }), fail: output({ held: z.boolean(), reasons: z.array(z.string()) }) }),
  may: output({ record: z.boolean() }),
})

export const sheetContract = defineContract({ params: inspectionParams, querystring: input({ language: z.string().trim().regex(/^[a-z]{2}$/).optional() }), response: { 200: sheetOut } })

export const resultsContract = defineContract({
  params: inspectionParams,
  body: input({
    ...versionBody,
    results: z
      .array(
        input({
          checkCode: z.string().trim().min(1).max(40),
          sampleIndex: z.number().int().min(1).max(100_000).optional(),
          /** null: take the answer back (Not checked). */
          outcome: outcome.nullable(),
          value: z.string().trim().max(PLAN_LIMITS.value + 1).nullable().optional(),
          note: note().nullable().optional(),
        }),
      )
      .min(1)
      .max(PLAN_LIMITS.rows + 1),
  }),
  response: { 200: sheetOut },
})

export const measurementsContract = defineContract({
  params: inspectionParams,
  body: input({
    ...versionBody,
    measurements: z
      .array(
        input({
          checkCode: z.string().trim().min(1).max(40).nullable().optional(),
          pointCode: z.string().trim().min(1).max(PLAN_LIMITS.pointCode + 1).nullable().optional(),
          size: z.string().trim().min(1).max(PLAN_LIMITS.size).nullable().optional(),
          sampleIndex: z.number().int().min(1).max(100_000).optional(),
          /** null: take the value back. */
          measured: decimalText.nullable(),
          nominal: decimalText.nullable().optional(),
          tolerance: decimalText.nullable().optional(),
          uom: z.enum(UOMS).nullable().optional(),
        }),
      )
      .min(1)
      .max(PLAN_LIMITS.rows + 1),
  }),
  response: { 200: sheetOut },
})

export const countContract = defineContract({
  params: inspectionParams,
  body: input({ ...versionBody, inspected: z.number().int().min(0).max(100_000).optional(), add: z.number().int().min(-100_000).max(100_000).optional() }),
  response: { 200: sheetOut },
})

export const identityContract = defineContract({
  params: inspectionParams,
  body: input({
    ...versionBody,
    /** Numbers read off the garments (serials, or the batch label); null: a garment without a readable number. */
    add: z.array(z.string().trim().max(61).nullable()).max(PLAN_LIMITS.scans).optional(),
    /** Numbers to take back; NO_NUMBER takes back one garment ticked without a number. */
    remove: z.array(z.string().trim().min(1).max(61)).max(PLAN_LIMITS.scans).optional(),
  }),
  response: { 200: sheetOut },
})

const resultParams = input({ inspectionId: id(), resultId: id() })
export const resultPhotoContract = defineContract({
  params: resultParams,
  body: input({ originalName: z.string().min(1).max(500), contentType: z.string().min(1).max(200), sizeBytes: z.number().int().min(1), sha256: z.string() }),
  response: { 201: output({ file: fileView, upload: presignedView }) },
})
export const resultPhotoCompleteContract = defineContract({ params: input({ inspectionId: id(), resultId: id(), fileId: id() }), response: { 200: output({ file: fileView }) } })

const planFit = output({
  id: id(),
  code: z.string(),
  name: z.string(),
  approved: output({ id: id(), number: z.number().int() }).nullable(),
  matches: z.boolean(),
  usable: z.boolean(),
  suggested: z.boolean(),
  /** "category Jacket, customer Example Moto"; null when it does not apply. */
  because: z.string().nullable(),
})
export const workOrderPlansContract = defineContract({
  params: workOrderParams,
  querystring: input({ lotSize: z.coerce.number().int().min(1).max(100_000).optional(), planId: id().optional(), profileId: id().optional() }),
  response: {
    200: output({
      workOrderId: id(),
      number: z.string(),
      plans: z.array(planFit),
      suggestedId: id().nullable(),
      words,
      /** With ?lotSize: the sample of the plan (suggested, or ?planId): its fixed size, or B-W2b-93's AQL plan from the chain (or ?profileId). */
      sampling: output({
        method: z.enum(['FIXED', 'AQL_PROFILE']),
        sampleSize: z.number().int().nullable(),
        words,
        chain: chainOut.nullable(),
        plan: aqlPlanOut.nullable(),
        named: z.boolean(),
      }).nullable(),
    }),
  },
})
