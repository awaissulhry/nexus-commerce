import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { DEFECT_CLASSES, DISPOSITION_FOLLOW_UPS, DISPOSITION_MOVES, DISPOSITION_OUTCOMES, QUALITY_STAGES } from '@nexus/factory-domain/quality/defects/rules'
import { HOLD_LIMITS, HOLD_SUBJECT_TYPES } from '@nexus/factory-domain/quality/holds/rules'
import {
  BOARD_LANES,
  CONTAINMENT_KINDS,
  CONTAINMENT_STATUSES,
  DECISION_STATES,
  NCR_FROM_TYPES,
  NCR_LIMITS,
  NCR_LINK_TYPES,
  NCR_SOURCES,
  NCR_STAGES,
  NCR_BULK_LIMIT,
  NCR_PICKED_DEFECTS_LIMIT,
  NCR_TITLE_KEYS,
  CONTAINMENT_HOURS_LIMITS,
  STAGE_CHECKS,
} from '@nexus/factory-domain/quality/ncr/rules'

/**
 * Nonconformances (B-W2a-47; QHS-080 … QHS-091; design quality.ncr SCR-144: ncr-metrics, ncr-grid, ncr-board; SCR-145:
 * the NCR record — Problem & evidence, Containment, Disposition, Linked records — and the pop-ups ncr-new, ncr-close).
 * Office routes; every write takes an Idempotency-Key and the NCR's version (the containment action's or decision's for
 * theirs). Refusals in words: `body/<field>` (400), `stage/<CHECK>` (409, the board's move and the close). No cost, no
 * price; no worker's name.
 */

const stage = z.enum(NCR_STAGES)
const source = z.enum(NCR_SOURCES)
const severity = z.enum(DEFECT_CLASSES)
const foundAt = z.enum(QUALITY_STAGES)
const uom = z.enum(UOMS)
const kind = z.enum(CONTAINMENT_KINDS)
const version = () => z.number().int().min(1)
const text = (max: number) => z.string().max(max)
const ref = output({ id: id(), code: z.string(), name: z.string() })
const check = output({ key: z.enum(STAGE_CHECKS), ok: z.boolean(), words: z.string() })

export const summaryView = output({
  id: id(),
  number: z.string(),
  companyId: id(),
  siteId: id(),
  title: z.string(),
  source,
  sourceType: z.string().nullable(),
  sourceId: id().nullable(),
  stage,
  severity,
  defect: output({ id: id(), code: z.string(), labelEn: z.string(), labelIt: z.string(), icon: z.string().nullable(), colour: z.string().nullable() }).nullable(),
  zone: z.string().nullable(),
  foundAt,
  foundOn: instant(),
  quantityAffected: z.string(),
  quantitySuspect: z.string().nullable(),
  uom,
  /** "28 of 40 PCS decided · 12 left". */
  decided: output({ decided: z.string(), left: z.string(), words: z.string() }),
  style: output({ id: id(), code: z.string(), name: z.string(), ppe: z.boolean() }).nullable(),
  colourway: ref.nullable(),
  size: z.string().nullable(),
  serial: z.string().nullable(),
  workOrder: output({ id: id(), number: z.string() }).nullable(),
  item: ref.nullable(),
  lot: output({ id: id(), code: z.string() }).nullable(),
  supplier: ref.nullable(),
  ownerId: id().nullable(),
  containmentDueAt: instant().nullable(),
  containmentOverdue: z.boolean(),
  actions: output({ open: z.number().int(), done: z.number().int() }),
  decisionsWaiting: z.number().int(),
  ageDays: z.number().int(),
  containedAt: instant().nullable(),
  decidedAt: instant().nullable(),
  closedAt: instant().nullable(),
  cancelledAt: instant().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})

export const ncrView = summaryView.extend({
  description: z.string().nullable(),
  foundBy: output({ kind: z.enum(['USER', 'WORKER', 'NONE']), userId: id().nullable(), workerId: id().nullable() }),
  closedById: id().nullable(),
  closeNote: z.string().nullable(),
  closeSignatureSha256: z.string().nullable(),
  cancelReason: z.string().nullable(),
  createdById: id().nullable(),
})

const actionView = output({
  id: id(),
  seq: z.number().int(),
  kind,
  description: z.string().nullable(),
  ownerId: id().nullable(),
  dueAt: instant().nullable(),
  overdue: z.boolean(),
  status: z.enum(CONTAINMENT_STATUSES),
  doneAt: instant().nullable(),
  doneById: id().nullable(),
  evidenceNote: z.string().nullable(),
  /** B-W2b-17: why it was cancelled (null unless CANCELLED). */
  cancelReason: z.string().nullable(),
  /** Files of the action (StoredFile recordType "NcrContainmentAction"): its photos and documents. */
  files: z.number().int(),
  record: output({ type: z.string(), id: id() }).nullable(),
  hold: output({ id: id(), status: z.string(), subjectType: z.string(), count: z.number().int() }).nullable(),
  version: z.number().int(),
})

const decisionView = output({
  id: id(),
  seq: z.number().int(),
  disposition: output({
    id: id(),
    code: z.string(),
    labelEn: z.string(),
    labelIt: z.string(),
    icon: z.string().nullable(),
    colour: z.string().nullable(),
    outcome: z.enum(DISPOSITION_OUTCOMES),
    stockMoveReason: z.enum(DISPOSITION_MOVES).nullable(),
    followUp: z.enum(DISPOSITION_FOLLOW_UPS).nullable(),
    reinspection: z.boolean(),
    words: z.string(),
  }).nullable(),
  quantity: z.string(),
  note: z.string().nullable(),
  decidedAt: instant(),
  decidedById: id().nullable(),
  approvalRequired: z.boolean(),
  approvedAt: instant().nullable(),
  approvedById: id().nullable(),
  state: z.enum(DECISION_STATES),
  mayApprove: z.boolean(),
  doneAt: instant().nullable(),
  stockMove: output({ id: id(), reason: z.string().nullable(), quantity: z.string().nullable(), uom: z.string().nullable(), from: z.string().nullable(), to: z.string().nullable() }).nullable(),
  followUp: output({ type: z.string(), id: id(), label: z.string().nullable(), state: z.string().nullable() }).nullable(),
  version: z.number().int(),
})

const linkView = output({ id: id(), recordType: z.string(), recordId: id(), label: z.string().nullable(), note: z.string().nullable(), createdAt: instant(), createdById: id().nullable() })
const holdRow = output({ id: id(), status: z.string(), subjectType: z.string(), subjectIds: z.array(id()), reasonCode: z.string(), reasonNote: z.string().nullable(), placedAt: instant(), decidedHere: z.boolean() })

export const recordView = output({
  ncr: ncrView,
  containment: z.array(actionView),
  decisions: z.array(decisionView),
  links: z.array(linkView),
  holds: z.array(holdRow),
  register: output({ id: id(), reference: z.string(), status: z.string() }).nullable(),
  /** The next stage on the board and what it needs (the Stepper's "what is missing"). */
  next: output({ stage: stage.nullable(), checks: z.array(check), ready: z.boolean() }),
  /** The closing checklist (ncr-close). */
  closing: output({ checks: z.array(check), ready: z.boolean() }),
  /** The band's actions: null = allowed, words = why not. */
  actions: output({ edit: z.string().nullable(), contain: z.string().nullable(), decide: z.string().nullable(), close: z.string().nullable(), cancel: z.string().nullable() }),
  may: output({ manage: z.boolean(), approve: z.boolean(), close: z.boolean(), raise: z.boolean() }),
})

const one = output({ record: recordView })
const ncrParams = input({ ncrId: id() })

// ---- reads ------------------------------------------------------------------------------------------------------------

const flag = z.enum(['true', 'false']).optional()
const filters = {
  stage: z.string().max(80).optional(),
  open: flag,
  severity: severity.optional(),
  source: source.optional(),
  siteId: id().optional(),
  ownerId: z.string().max(40).optional(),
  overdue: flag,
  waiting: flag,
  recordType: z.string().max(60).optional(),
  recordId: id().optional(),
  styleId: id().optional(),
  workOrderId: id().optional(),
  lotId: id().optional(),
  supplierId: id().optional(),
  q: z.string().max(80).optional(),
}

export const listContract = defineContract({
  querystring: input(filters),
  response: { 200: output({ items: z.array(summaryView), truncated: z.boolean() }) },
})

export const countsContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: {
    200: output({
      counts: output({ open: z.number().int(), containmentOverdue: z.number().int(), waitingDisposition: z.number().int(), criticalOpen: z.number().int(), closedThisMonth: z.number().int(), mine: z.number().int() }),
    }),
  },
})

const { stage: _stage, open: _open, ...boardFilters } = filters
const card = summaryView.extend({ next: output({ stage: stage.nullable(), ready: z.boolean(), words: z.string().nullable() }) })
export const boardContract = defineContract({
  querystring: input(boardFilters),
  response: { 200: output({ lanes: z.array(output({ stage: z.enum(BOARD_LANES), count: z.number().int(), truncated: z.boolean(), cards: z.array(card) })) }) },
})

const prefillView = output({
  fromType: z.enum(NCR_FROM_TYPES),
  fromId: id(),
  label: z.string(),
  companyId: id().nullable(),
  siteId: id().nullable(),
  source,
  foundAt,
  title: z.string().nullable(),
  /** B-W2b-17: the title in parts: the screen words `key` with `values` in the reader's language (title = its English). */
  titleParts: output({ key: z.enum(NCR_TITLE_KEYS), values: z.record(z.string(), z.string()) }).nullable(),
  /** B-W2b-17: the inspection's defect lines it takes (empty: all of them). */
  defectIds: z.array(id()),
  description: z.string().nullable(),
  foundOn: instant().nullable(),
  foundById: id().nullable(),
  foundByWorkerId: id().nullable(),
  quantityAffected: z.string().nullable(),
  uom: uom.nullable(),
  severity: severity.nullable(),
  defectCodeId: id().nullable(),
  zone: z.string().nullable(),
  styleId: id().nullable(),
  colourwayId: id().nullable(),
  size: z.string().nullable(),
  serial: z.string().nullable(),
  workOrderId: id().nullable(),
  itemId: id().nullable(),
  lotId: id().nullable(),
  supplierId: id().nullable(),
  links: z.array(output({ recordType: z.string(), recordId: id(), note: z.string().nullable() })),
  holdIds: z.array(id()),
  problem: z.string().nullable(),
  /** Photos and files of the source record (its StoredFiles) the NCR may show. */
  files: z.array(output({ id: id(), kind: z.string(), originalName: z.string() })),
  /** The NCRs already raised from or linked to this record. */
  existing: z.array(output({ id: id(), number: z.string(), stage })),
  /** B-W2b-17: the company's containment time in hours (null: the record names no company — read GET /quality/ncr/settings). */
  containmentHours: z.number().int().nullable(),
})

/** B-W2b-17: picked defect lines as one query value, comma separated. */
const defectIdList = z
  .string()
  .max(40 * NCR_PICKED_DEFECTS_LIMIT)
  .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean))
  .pipe(z.array(id()).max(NCR_PICKED_DEFECTS_LIMIT))

export const prefillContract = defineContract({
  querystring: input({ recordType: z.enum(NCR_FROM_TYPES), recordId: id(), defectIds: defectIdList.optional() }),
  response: { 200: output({ prefill: prefillView }) },
})

export const getContract = defineContract({ params: ncrParams, response: { 200: one } })

// ---- raise and change ---------------------------------------------------------------------------------------------------

const content = {
  title: text(NCR_LIMITS.title * 2),
  description: text(NCR_LIMITS.description * 2).nullable(),
  source,
  foundAt,
  foundOn: instant(),
  foundById: id().nullable(),
  foundByWorkerId: id().nullable(),
  quantityAffected: quantity(),
  quantitySuspect: quantity().nullable(),
  uom,
  defectCodeId: id().nullable(),
  severity,
  zone: z.string().max(40).nullable(),
  styleId: id().nullable(),
  colourwayId: id().nullable(),
  size: text(NCR_LIMITS.size * 2).nullable(),
  serial: text(NCR_LIMITS.serial * 2).nullable(),
  workOrderId: id().nullable(),
  itemId: id().nullable(),
  lotId: id().nullable(),
  supplierId: id().nullable(),
  ownerId: id().nullable(),
  containmentDueAt: instant().nullable(),
}
const optional = Object.fromEntries(Object.entries(content).map(([key, schema]) => [key, schema.optional()])) as { [Key in keyof typeof content]: z.ZodOptional<(typeof content)[Key]> }

export const raiseContract = defineContract({
  body: input({
    ...optional,
    /** The record it is raised from: its content prefills what the body leaves out. */
    from: input({ recordType: z.enum(NCR_FROM_TYPES), recordId: id(), /** B-W2b-17: an inspection's picked defect lines. */ defectIds: z.array(id()).max(NCR_PICKED_DEFECTS_LIMIT).optional() }).optional(),
    /** The site, when the record names none (a complaint) or it is raised by hand. */
    siteId: id().optional(),
    /** More records to link (beyond the source's). */
    links: z.array(input({ recordType: z.enum(NCR_LINK_TYPES), recordId: id(), note: text(NCR_LIMITS.note).nullable().optional() })).max(20).optional(),
    /** Open its PPE register entry now (a PPE style); default: by the rule (critical, or found by the customer). */
    register: z.boolean().optional(),
  }),
  response: { 201: one },
})

export const editContract = defineContract({ params: ncrParams, body: input({ version: version(), ...optional }), response: { 200: one } })

export const stageContract = defineContract({ params: ncrParams, body: input({ version: version(), to: z.enum(['CONTAINED', 'DECIDED']) }), response: { 200: one } })
export const closeContract = defineContract({ params: ncrParams, body: input({ version: version(), note: z.string().trim().min(3).max(NCR_LIMITS.note) }), response: { 200: output({ record: recordView, holdsClosed: z.array(id()), signature: z.string() }) } })
export const cancelContract = defineContract({ params: ncrParams, body: input({ version: version(), reason: z.string().trim().min(3).max(NCR_LIMITS.reason) }), response: { 200: one } })

export const linkContract = defineContract({ params: ncrParams, body: input({ version: version(), recordType: z.enum(NCR_LINK_TYPES), recordId: id(), note: text(NCR_LIMITS.note).nullable().optional() }), response: { 201: one } })
export const unlinkContract = defineContract({ params: input({ ncrId: id(), linkId: id() }), querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: one } })
export const registerContract = defineContract({ params: ncrParams, body: input({ version: version(), description: text(2000).nullable().optional() }), response: { 200: one } })
export const closeHoldContract = defineContract({ params: input({ ncrId: id(), holdId: id() }), body: input({ version: version(), note: z.string().trim().min(3).max(NCR_LIMITS.note) }), response: { 200: output({ record: recordView, workOrdersLifted: z.array(id()) }) } })

// ---- containment --------------------------------------------------------------------------------------------------------

/** Place a hold for the action (the Place hold dialog's fields): the NCR is its source and decides it. */
const placeHold = input({
  subjectType: z.enum(HOLD_SUBJECT_TYPES),
  subjectIds: z.array(id()).min(1).max(HOLD_LIMITS.subjects),
  reasonCode: z.string().min(1).max(40),
  reasonNote: z.string().max(HOLD_LIMITS.reasonNote * 2).nullable().optional(),
  ownerId: id().nullable().optional(),
  expectedReleaseOn: businessDate().nullable().optional(),
  askQuarantine: z.boolean().optional(),
  quarantineLocationId: id().nullable().optional(),
})
const actionParams = input({ ncrId: id(), actionId: id() })

export const addActionContract = defineContract({
  params: ncrParams,
  body: input({
    version: version(),
    kind,
    description: text(NCR_LIMITS.note * 2).nullable().optional(),
    ownerId: id().nullable().optional(),
    dueAt: instant().nullable().optional(),
    /** HOLD_STOCK: place this hold now (the action is done with it), or name a hold of the goods. */
    hold: placeHold.optional(),
    holdId: id().optional(),
    evidenceNote: text(NCR_LIMITS.evidence * 2).nullable().optional(),
  }),
  response: { 201: one },
})
export const editActionContract = defineContract({
  params: actionParams,
  body: input({ version: version(), description: text(NCR_LIMITS.note * 2).nullable().optional(), ownerId: id().nullable().optional(), dueAt: instant().nullable().optional() }),
  response: { 200: one },
})
export const doneActionContract = defineContract({
  params: actionParams,
  body: input({ version: version(), evidenceNote: text(NCR_LIMITS.evidence * 2).nullable().optional(), hold: placeHold.optional(), holdId: id().optional(), record: input({ type: z.string().min(1).max(60), id: id() }).optional() }),
  response: { 200: one },
})
export const cancelActionContract = defineContract({ params: actionParams, body: input({ version: version(), reason: z.string().trim().min(3).max(NCR_LIMITS.reason) }), response: { 200: one } })

// ---- decisions ----------------------------------------------------------------------------------------------------------

const decisionParams = input({ ncrId: id(), decisionId: id() })
export const addDecisionContract = defineContract({
  params: ncrParams,
  body: input({ version: version(), dispositionCodeId: id(), quantity: quantity(), note: text(NCR_LIMITS.note * 2).nullable().optional() }),
  response: { 201: one },
})
export const editDecisionContract = defineContract({
  params: decisionParams,
  body: input({ version: version(), dispositionCodeId: id().optional(), quantity: quantity().optional(), note: text(NCR_LIMITS.note * 2).nullable().optional() }),
  response: { 200: one },
})
export const removeDecisionContract = defineContract({ params: decisionParams, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: one } })
export const approveDecisionContract = defineContract({ params: decisionParams, body: input({ version: version(), note: text(NCR_LIMITS.note).nullable().optional() }), response: { 200: one } })

const stockLine = input({
  itemId: id().optional(),
  itemColourId: id().nullable().optional(),
  lotId: id().nullable().optional(),
  hideId: id().nullable().optional(),
  fromLocationId: id().optional(),
  quantity: quantity().optional(),
  uom: uom.optional(),
})
export const carryOutContract = defineContract({
  params: decisionParams,
  body: input({
    version: version(),
    note: text(NCR_LIMITS.note * 2).nullable().optional(),
    /** The code's stock move: what moves, from where (and to where, or to which work order). */
    stock: input({ lines: z.array(stockLine).min(1).max(50), toLocationId: id().nullable().optional(), workOrderId: id().nullable().optional() }).optional(),
    /** The code's follow-up record, made elsewhere: a rework order, a repair, a supplier claim. */
    followUp: input({ type: z.enum(['ReworkOrder', 'RepairOrder', 'SupplierClaim']), id: id() }).optional(),
    /** RETURN TO SUPPLIER: the supplier claim opened now (DRAFT; sent from Purchasing › Claims). */
    claim: input({
      kind: z.enum(['RETURN', 'CLAIM']),
      reasonCode: z.string().min(1).max(40),
      reasonNote: text(1000).nullable().optional(),
      remedy: z.enum(['CREDIT', 'REPLACEMENT']).nullable().optional(),
      hideIds: z.array(id()).max(50).optional(),
    }).optional(),
  }),
  response: { 200: output({ record: recordView, stockMoveIds: z.array(id()), followUp: output({ type: z.string(), id: id() }).nullable() }) },
})

export const reworkContract = defineContract({
  params: decisionParams,
  body: input({
    version: version(),
    reworkAtOperationId: id(),
    workOrderSizeId: id().optional(),
    bundleId: id().nullable().optional(),
    foundAtOperationId: id().nullable().optional(),
    reasonCode: z.string().min(1).max(40).optional(),
    description: text(1000).optional(),
    split: z.boolean().optional(),
    printerId: id().nullable().optional(),
  }),
  response: { 200: output({ record: recordView, reworkId: id(), ticket: z.unknown().nullable() }) },
})

// ---- B-W2b-17: bulk owner and the containment time -------------------------------------------------------------------

export const assignContract = defineContract({
  body: input({
    ncrs: z.array(input({ id: id(), version: version() })).min(1).max(NCR_BULK_LIMIT),
    /** null: nobody follows them up. */
    ownerId: id().nullable(),
  }),
  response: { 200: output({ ncrs: z.array(summaryView), changed: z.array(id()) }) },
})

const settingSource = z.enum(['COMPANY', 'TENANT', 'DEFAULT'])
const ncrSettings = output({
  companyId: id().nullable(),
  inForce: output({ hours: z.number().int(), source: settingSource }),
  own: output({ defaultContainmentHours: z.number().int().nullable(), updatedAt: instant() }).nullable(),
  version: z.number().int().min(0),
})

export const getSettingsContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: { 200: output({ settings: ncrSettings, mayChange: z.boolean() }) },
})

export const saveSettingsContract = defineContract({
  body: input({
    companyId: id().nullable().optional(),
    /** Hours after the problem was found; null: follow the tenant-wide row (a company) or the default 24. */
    defaultContainmentHours: z.number().int().min(CONTAINMENT_HOURS_LIMITS.min).max(CONTAINMENT_HOURS_LIMITS.max).nullable(),
    version: z.number().int().min(0),
  }),
  response: { 200: output({ settings: ncrSettings, mayChange: z.boolean() }) },
})
