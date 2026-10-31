import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DDT_REASONS } from '@nexus/factory-domain/documents/model'
import {
  HAND_MOVES,
  POINT_RESULTS,
  REPAIR_ACTIONS,
  REPAIR_KINDS,
  REPAIR_LIST_VIEWS,
  REPAIR_STAGES,
  REPAIR_STEPS,
  SAFETY_RESULTS,
  SAFETY_STATES,
  STEP_STATES,
} from '@nexus/factory-domain/sales/repairs/rules'
import { fileView } from '../../../platform/files/contract'
import { sourceRequest } from '../../shipping/ddt/contract'

/**
 * Repairs and alterations (B-W2a-57; SAL-383, SAL-390, LOG-116; design sales.returns "Repair order"). No money anywhere
 * (the estimate with its prices is W2b). Every write takes an Idempotency-Key and the repair's `version` (COL-078).
 * Refusals in words: `body/<field>` (400), a stage that takes no such change or a missing prerequisite (409
 * invalid_state), a stale version (409 conflict). No worker's name anywhere; office people by id, their names in `people`.
 */

const version = z.number().int().min(1)
const stage = z.enum(REPAIR_STAGES)
const kind = z.enum(REPAIR_KINDS)
const issue = output({ path: z.string(), message: z.string() })
const repairParams = input({ repairId: id() })
const ref = output({ id: id(), code: z.string(), name: z.string() })
const party = output({ id: id(), code: z.string(), legalName: z.string() })
const person = output({ id: id(), name: z.string() })
const workOrderRef = output({ id: id(), number: z.string(), status: z.string() })

const text = (max: number) => z.string().trim().max(max)

const checklistInput = input({
  seams: z.enum(POINT_RESULTS),
  abrasionZones: z.enum(POINT_RESULTS),
  closures: z.enum(POINT_RESULTS),
  protectors: input({ result: z.enum(POINT_RESULTS), replaced: z.boolean(), lot: text(120).nullish(), level: text(8).nullish() }),
  certificateCovers: z.boolean(),
  note: text(2000).nullish(),
})
const checklistView = output({
  seams: z.string(),
  abrasionZones: z.string(),
  closures: z.string(),
  protectors: output({ result: z.string(), replaced: z.boolean(), lot: z.string().nullable(), level: z.string().nullable() }),
  certificateCovers: z.boolean(),
  note: z.string().nullable(),
})

// ---- the record ---------------------------------------------------------------------------------------------------

export const repairView = output({
  id: id(),
  number: z.string(),
  companyId: id(),
  site: ref,
  party,
  kind,
  stage,
  /** Where it stands, in words. */
  status: z.string(),
  problem: z.string(),
  garment: output({
    serial: z.string().nullable(),
    style: output({ id: id(), code: z.string(), name: z.string(), ppeCategory: z.string() }).nullable(),
    colourway: ref.nullable(),
    size: z.string().nullable(),
    /** Our garment with this serial: made on, its work order and batch, made for this customer. */
    found: output({ madeOn: businessDate(), workOrderNumber: z.string(), batchNumber: z.string().nullable(), forThisCustomer: z.boolean() }).nullable(),
  }),
  source: output({
    returnLine: output({ id: id(), seq: z.number().int(), returnId: id(), returnNumber: z.string() }).nullable(),
    complaint: output({ id: id(), number: z.string(), status: z.string() }).nullable(),
  }),
  receivedAt: instant().nullable(),
  /** The customer's DDT the garment came with (DPR 472/1996), printed as the reference of the way back. */
  inboundDdt: output({ number: z.string(), date: businessDate().nullable() }).nullable(),
  /** Its repair work order (B-W2a-12), any status. */
  workOrder: workOrderRef.nullable(),
  /** B-W2b-16: the work orders of earlier rounds (a rework after the repair went back into repair gets its own). */
  earlierWorkOrders: z.array(workOrderRef),
  /** B-W2b-16: back into repair after it was repaired: a new repair work order may follow a done one. */
  reworkRound: z.boolean(),
  repairedAt: instant().nullable(),
  safety: output({
    required: z.boolean(),
    state: z.enum(SAFETY_STATES),
    result: z.enum(SAFETY_RESULTS).nullable(),
    checklist: checklistView.nullable(),
    failures: z.array(z.string()),
    checkedAt: instant().nullable(),
    checkedById: id().nullable(),
  }),
  shippedAt: instant().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  ownerId: id().nullable(),
  internalNote: z.string().nullable(),
  createdAt: instant(),
  createdById: id().nullable(),
  version: z.number().int(),
  /** Every stage move, oldest first (the RepairStageEvent rows): from, to, when, why, by whom. */
  stages: z.array(output({ id: id(), from: stage.nullable(), to: stage, at: instant(), note: z.string().nullable(), byId: id().nullable() })),
  /** The design's stepper: received → estimated → approved → in repair → repaired → shipped. */
  steps: z.array(output({ stage: z.enum(REPAIR_STEPS), state: z.enum(STEP_STATES), at: instant().nullable() })),
  /** Its DDTs (B-W2a-17): the live one and the cancelled ones. */
  ddts: z.array(output({ id: id(), number: z.string(), documentDate: businessDate(), reason: z.string(), startAt: instant(), live: z.boolean() })),
  /** The garment's other repairs (same serial), newest first. */
  history: z.array(output({ id: id(), number: z.string(), kind, stage, problem: z.string(), createdAt: instant() })),
  /** The NCRs it is linked to or carries out (with quality.ncr.view only). */
  ncrs: z.array(output({ id: id(), number: z.string(), stage: z.string() })),
  actions: z.array(output({ action: z.enum(REPAIR_ACTIONS), allowed: z.boolean(), held: z.string().nullable() })),
  people: z.array(person),
})

const oneRepair = output({ repair: repairView })
const withWarnings = output({ repair: repairView, warnings: z.array(issue) })

export const getContract = defineContract({ params: repairParams, response: { 200: oneRepair } })

// ---- the list -----------------------------------------------------------------------------------------------------

export const listContract = defineContract({
  querystring: input({
    view: z.enum(REPAIR_LIST_VIEWS).optional(),
    stage: z.string().max(200).optional(),
    partyId: id().optional(),
    siteId: id().optional(),
    returnId: id().optional(),
    complaintId: id().optional(),
    owner: z.string().max(40).optional(),
    q: z.string().max(100).optional(),
  }),
  response: {
    200: output({
      repairs: z.array(
        output({
          id: id(),
          number: z.string(),
          kind,
          stage,
          status: z.string(),
          companyId: id(),
          siteId: id(),
          siteCode: z.string(),
          party,
          serial: z.string().nullable(),
          style: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
          size: z.string().nullable(),
          problem: z.string(),
          source: z.enum(['RETURN', 'COMPLAINT', 'HAND']),
          returnNumber: z.string().nullable(),
          complaintNumber: z.string().nullable(),
          receivedAt: instant().nullable(),
          repairedAt: instant().nullable(),
          shippedAt: instant().nullable(),
          safety: z.enum(SAFETY_STATES),
          workOrder: workOrderRef.nullable(),
          ownerId: id().nullable(),
          createdAt: instant(),
        }),
      ),
      truncated: z.boolean(),
      people: z.array(person),
      asOf: instant(),
    }),
  },
})

export const countsContract = defineContract({
  response: {
    200: output({
      counts: output({ awaiting: z.number().int(), received: z.number().int(), inRepair: z.number().int(), toCheck: z.number().int(), toShip: z.number().int(), open: z.number().int() }),
      asOf: instant(),
    }),
  },
})

// ---- make one ---------------------------------------------------------------------------------------------------------

export const createBody = input({
  /** From an RMA line decided Repair (the garment is here): its company, site, customer and garment. */
  returnLineId: id().optional(),
  /** From a complaint (a service case) of the customer. */
  complaintId: id().optional(),
  /** By hand (or with a complaint): the company and customer. */
  companyId: id().optional(),
  partyId: id().optional(),
  /** The repairing site; default the RMA's, else the company's only active plant. */
  siteId: id().optional(),
  kind: kind.optional(),
  /** The serial read from the garment's label (scan or type): our serial gives its style, colourway and size. */
  serial: text(120).nullish(),
  styleId: id().nullish(),
  colourwayId: id().nullish(),
  size: text(40).nullish(),
  /** The customer's description; default the RMA line's or the complaint's words. */
  problem: text(4000).optional(),
  ownerId: id().nullish(),
  internalNote: text(4000).nullish(),
  /** The garment came with the customer (by hand or with its DDT): the repair starts RECEIVED. */
  received: input({ at: instant().optional(), inboundDdtNumber: text(80).nullish(), inboundDdtDate: businessDate().nullish() }).nullish(),
})

const draftView = output({
  companyId: id(),
  siteId: id(),
  partyId: id(),
  kind,
  stage,
  serial: z.string().nullable(),
  styleId: id().nullable(),
  colourwayId: id().nullable(),
  size: z.string().nullable(),
  problem: z.string(),
  safetyCheckRequired: z.boolean(),
  receivedAt: instant().nullable(),
  inboundDdt: output({ number: z.string(), date: businessDate().nullable() }).nullable(),
  returnLineId: id().nullable(),
  complaintId: id().nullable(),
})

export const previewContract = defineContract({
  body: createBody,
  response: {
    200: output({
      ok: z.boolean(),
      problems: z.array(issue),
      warnings: z.array(issue),
      draft: draftView.nullable(),
      garment: output({ madeOn: businessDate(), workOrderNumber: z.string(), batchNumber: z.string().nullable(), forThisCustomer: z.boolean() }).nullable(),
      history: z.array(output({ id: id(), number: z.string(), stage, createdAt: instant() })),
    }),
  },
})

export const createContract = defineContract({ body: createBody, response: { 201: withWarnings } })

// ---- change it ----------------------------------------------------------------------------------------------------------

export const headerContract = defineContract({
  params: repairParams,
  body: input({
    version,
    kind: kind.optional(),
    problem: text(4000).optional(),
    serial: text(120).nullish(),
    styleId: id().nullish(),
    colourwayId: id().nullish(),
    size: text(40).nullish(),
    ownerId: id().nullish(),
    internalNote: text(4000).nullish(),
    inboundDdtNumber: text(80).nullish(),
    inboundDdtDate: businessDate().nullish(),
  }),
  response: { 200: withWarnings },
})

export const receiveContract = defineContract({
  params: repairParams,
  body: input({ version, at: instant().optional(), inboundDdtNumber: text(80).nullish(), inboundDdtDate: businessDate().nullish(), note: text(2000).nullish() }),
  response: { 200: withWarnings },
})

export const stageContract = defineContract({
  params: repairParams,
  body: input({ version, to: z.enum(HAND_MOVES), note: text(2000).nullish() }),
  response: { 200: oneRepair },
})

export const safetyContract = defineContract({
  params: repairParams,
  body: input({ version, checklist: checklistInput }),
  response: { 200: output({ repair: repairView, result: z.enum(SAFETY_RESULTS), failures: z.array(z.string()) }) },
})

/** The repair's DDT, issued in the same step: what shipping's source DDT takes, the garment being the repair's own. */
export const repairDdt = sourceRequest.omit({ version: true, lineIds: true })

export const shipContract = defineContract({
  params: repairParams,
  body: input({ version, note: text(2000).nullish(), ddt: repairDdt.optional() }),
  response: {
    200: output({
      repair: repairView,
      ddt: output({ id: id(), number: z.string(), reason: z.enum(DDT_REASONS), issuedNow: z.boolean(), file: fileView.nullable(), pdfProblem: z.string().nullable() }),
      warnings: z.array(issue),
    }),
  },
})

export const cancelContract = defineContract({
  params: repairParams,
  body: input({ version, reason: text(1000) }),
  response: { 200: withWarnings },
})
