import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import {
  CHANGE_DECISIONS,
  CHANGE_EFFECTS,
  CHANGE_LIMITS,
  CHANGE_ORDER_STATUSES,
  CHANGE_PRIORITIES,
  CHANGE_REFUSALS,
  CHANGE_REQUEST_SOURCES,
  CHANGE_REQUEST_STATUSES,
  FLOOR_PROBLEMS,
  OFFICE_SOURCES,
  ORDER_TILES,
  REQUEST_TILES,
  WIP_DISPOSITIONS,
} from './rules'

/**
 * Change requests and change orders' contracts (B-W2b-226): what apps/factory-api's modules/product/changes accepts and
 * answers. A refusal is a 409 whose issue is `refusal/<CODE>` (CHANGE_REFUSALS) with the words. No money; people as user ids
 * (an approver's name is shown inside the change order only); a floor request names no worker.
 */

const version = () => z.number().int().min(1)
const words = (max: number) => z.string().trim().min(1).max(max)
const ref = output({ id: id(), code: z.string(), name: z.string() })
const revisionRef = output({ id: id(), revision: z.number().int(), status: z.string() })
export const changeRefusal = output({ code: z.enum(CHANGE_REFUSALS), message: z.string() })
const action = output({ allowed: z.boolean(), refusal: changeRefusal.nullable() })
/** A CHANGE line's value before or after: JSON as the API shows the record (a number, words, an object …). */
const lineValue = z.union([z.string().max(4000), z.number(), z.boolean(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).nullable()

export const requestParams = input({ changeRequestId: id() })
export const orderParams = input({ changeOrderId: id() })
export const lineParams = input({ changeOrderId: id(), lineId: id() })
export const workOrderParams = input({ workOrderId: id() })
export const photoParams = input({ changeRequestId: id(), fileId: id() })

// ---- change requests ----------------------------------------------------------------------------------------------------

/** A request raised in the office: for the style (of a company, or tenant-wide with the company it is numbered in). */
export const createRequestBody = input({
  styleId: id(),
  /** A tenant-wide style's request is numbered in this company (a company style: its own; another is refused). */
  companyId: id().optional(),
  source: z.enum(OFFICE_SOURCES),
  /** The customer (CUSTOMER) or supplier (SUPPLIER) who asked. */
  partyId: id().optional(),
  /** The sample round whose fit or decision raised it (SAMPLE). */
  sampleRoundId: id().optional(),
  /** The revision it is about; left out: the style as it is. */
  revisionId: id().optional(),
  /** MES-006: the released work order where it was seen (what is already cut or sewn). */
  workOrderId: id().optional(),
  title: words(CHANGE_LIMITS.title),
  reason: words(CHANGE_LIMITS.reason),
  priority: z.enum(CHANGE_PRIORITIES).optional(),
})
export type CreateRequestBody = z.output<typeof createRequestBody>

export const updateRequestBody = input({
  version: version(),
  title: words(CHANGE_LIMITS.title).optional(),
  reason: words(CHANGE_LIMITS.reason).optional(),
  revisionId: id().nullable().optional(),
  priority: z.enum(CHANGE_PRIORITIES).optional(),
})
export type UpdateRequestBody = z.output<typeof updateRequestBody>

/** The office's triage: into review, accepted, or rejected with why (the note is shown to whoever raised it). */
export const moveRequestBody = input({
  version: version(),
  to: z.enum(['IN_REVIEW', 'ACCEPTED', 'REJECTED']),
  note: words(CHANGE_LIMITS.decisionNote).optional(),
})
export type MoveRequestBody = z.output<typeof moveRequestBody>

export const requestListQuery = input({
  tile: z.enum(REQUEST_TILES).optional(),
  status: z.enum(CHANGE_REQUEST_STATUSES).optional(),
  source: z.enum(CHANGE_REQUEST_SOURCES).optional(),
  styleId: id().optional(),
  workOrderId: id().optional(),
  changeOrderId: id().optional(),
  companyId: id().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
export type RequestListQuery = z.output<typeof requestListQuery>

/** The floor's "Report a spec problem" (PRD-259): a tile, the worker's words, where it was seen; online or from the queue. */
export const floorRequestBody = input({
  /** The tablet's own id for it: a resend answers the request it made the first time. */
  clientEventId: id(),
  workOrderId: id(),
  /** The work order's operation where it was seen. */
  workOrderOperationId: id().optional(),
  bundleId: id().optional(),
  problem: z.enum(FLOOR_PROBLEMS),
  note: words(CHANGE_LIMITS.floorNote).optional(),
  /** The tablet's time of the tap (kept beside the server's). */
  occurredAt: instant().optional(),
})
export type FloorRequestBody = z.output<typeof floorRequestBody>

/** A photo announced (then PUT to the presigned address, then confirmed). */
export const photoBody = input({
  originalName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(100),
  sizeBytes: z.number().int().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})
export type PhotoBody = z.output<typeof photoBody>

const party = output({ id: id(), code: z.string(), name: z.string() })

export const requestRow = output({
  id: id(),
  /** Null only on a floor request nobody took up yet. */
  number: z.string().nullable(),
  companyId: id(),
  siteId: id().nullable(),
  source: z.enum(CHANGE_REQUEST_SOURCES),
  party: party.nullable(),
  sampleRound: output({ id: id(), number: z.string() }).nullable(),
  style: ref,
  revision: revisionRef.nullable(),
  workOrder: output({ id: id(), number: z.string(), status: z.string() }).nullable(),
  title: z.string(),
  reason: z.string(),
  priority: z.enum(CHANGE_PRIORITIES),
  status: z.enum(CHANGE_REQUEST_STATUSES),
  changeOrder: output({ id: id(), number: z.string(), status: z.enum(CHANGE_ORDER_STATUSES) }).nullable(),
  /** Who raised it (null: the floor, which names no worker). */
  createdById: id().nullable(),
  createdAt: instant(),
  decidedAt: instant().nullable(),
  decidedById: id().nullable(),
  decisionNote: z.string().nullable(),
  photos: z.number().int(),
  version: z.number().int(),
})
export type RequestRow = z.output<typeof requestRow>

const photo = output({ id: id(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number().int(), availableAt: instant().nullable() })

/** MES-006: what of a work order is already made, so a change would touch it (bundles cut; bundles reported at an operation). */
export const workOrderMade = output({
  cut: output({ bundles: z.number().int(), pieces: z.number().int() }),
  worked: output({ bundles: z.number().int(), pieces: z.number().int() }),
})

export const requestView = requestRow.extend({
  photosList: z.array(photo),
  /** Each triage move and whether it may be made now (else the refusal in words). */
  moves: z.array(output({ to: z.enum(['IN_REVIEW', 'ACCEPTED', 'REJECTED']), allowed: z.boolean(), refusal: changeRefusal.nullable() })),
  /** The work order's bundles already cut or worked (MES-006); null without a work order or workorders.view. */
  made: workOrderMade.nullable(),
})
export type RequestView = z.output<typeof requestView>

export const requestList = output({
  rows: z.array(requestRow),
  /** Each tile's count under the other filters (the list's total under that saved filter). */
  counts: z.record(z.enum(REQUEST_TILES), z.number().int()),
  complete: z.boolean(),
})

/** The work order's "Change request" pop-up (MES-006): the work order, what is made, the requests about it. */
export const workOrderChangesView = output({
  workOrder: output({ id: id(), number: z.string(), status: z.string(), companyId: id(), siteId: id(), style: ref, revision: revisionRef.nullable() }),
  made: workOrderMade,
  requests: z.array(requestRow),
})

// ---- change orders ------------------------------------------------------------------------------------------------------

export const createOrderBody = input({
  styleId: id(),
  companyId: id().optional(),
  title: words(CHANGE_LIMITS.title),
  reason: words(CHANGE_LIMITS.reason),
  description: words(CHANGE_LIMITS.description).optional(),
  priority: z.enum(CHANGE_PRIORITIES).optional(),
  effect: z.enum(CHANGE_EFFECTS).optional(),
  effectiveDate: businessDate().optional(),
  /** The requests it carries (of the style; an open one goes into review). */
  requestIds: z.array(id()).max(CHANGE_LIMITS.requests).optional(),
})
export type CreateOrderBody = z.output<typeof createOrderBody>

export const updateOrderBody = input({
  version: version(),
  title: words(CHANGE_LIMITS.title).optional(),
  reason: words(CHANGE_LIMITS.reason).optional(),
  description: words(CHANGE_LIMITS.description).nullable().optional(),
  /** The priority changes until the change order is decided for good; the rest only while DRAFT. */
  priority: z.enum(CHANGE_PRIORITIES).optional(),
  effect: z.enum(CHANGE_EFFECTS).optional(),
  effectiveDate: businessDate().nullable().optional(),
  /** The style's DRAFT revision holding the change (one made before); null takes it off. */
  toRevisionId: id().nullable().optional(),
})
export type UpdateOrderBody = z.output<typeof updateOrderBody>

export const orderRequestsBody = input({ version: version(), requestIds: z.array(id()).max(CHANGE_LIMITS.requests) })
export type OrderRequestsBody = z.output<typeof orderRequestsBody>

export const addLineBody = input({
  version: version(),
  recordType: z.string().trim().min(1).max(60),
  recordId: id(),
  field: z.string().trim().min(1).max(100).optional(),
  before: lineValue.optional(),
  after: lineValue.optional(),
  note: words(CHANGE_LIMITS.itemNote).optional(),
})
export type AddLineBody = z.output<typeof addLineBody>

export const updateLineBody = input({
  version: version(),
  field: z.string().trim().min(1).max(100).nullable().optional(),
  before: lineValue.optional(),
  after: lineValue.optional(),
  note: words(CHANGE_LIMITS.itemNote).nullable().optional(),
})
export type UpdateLineBody = z.output<typeof updateLineBody>

export const removeLineQuery = input({ version: z.coerce.number().int().min(1) })

/** Every open work order's work in progress and what happens to it (MES-006): the whole list, replaced at once. */
export const workInProgressBody = input({
  version: version(),
  lines: z.array(input({ workOrderId: id(), disposition: z.enum(WIP_DISPOSITIONS), note: words(CHANGE_LIMITS.itemNote).optional() })).max(CHANGE_LIMITS.items),
})
export type WorkInProgressBody = z.output<typeof workInProgressBody>

/** Who decides it (one stage in V1): never its author; the whole list, replaced (decided approvals stay as they are). */
export const approversBody = input({
  version: version(),
  approvers: z.array(input({ userId: id(), required: z.boolean().optional() })).max(CHANGE_LIMITS.approvers),
})
export type ApproversBody = z.output<typeof approversBody>

export const draftRevisionBody = input({ version: version(), changeNote: words(500).optional() })
export type DraftRevisionBody = z.output<typeof draftRevisionBody>

export const versionBody = input({ version: version() })
export type VersionBody = z.output<typeof versionBody>

export const decideBody = input({ version: version(), decision: z.enum(CHANGE_DECISIONS), reason: words(CHANGE_LIMITS.approvalReason).optional() })
export type DecideBody = z.output<typeof decideBody>

export const cancelBody = input({ version: version(), reason: words(CHANGE_LIMITS.cancelReason) })
export type CancelBody = z.output<typeof cancelBody>

export const releaseOrderBody = input({ version: version(), changeNote: words(500).optional() })
export type ReleaseOrderBody = z.output<typeof releaseOrderBody>

export const orderListQuery = input({
  tile: z.enum(ORDER_TILES).optional(),
  status: z.enum(CHANGE_ORDER_STATUSES).optional(),
  styleId: id().optional(),
  companyId: id().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
export type OrderListQuery = z.output<typeof orderListQuery>

export const orderRow = output({
  id: id(),
  number: z.string(),
  companyId: id(),
  style: ref,
  fromRevision: revisionRef,
  toRevision: revisionRef.nullable(),
  title: z.string(),
  /** B-W2b-244: why, for the list's Reason column (Changes & versions). */
  reason: z.string(),
  priority: z.enum(CHANGE_PRIORITIES),
  effect: z.enum(CHANGE_EFFECTS),
  effectiveDate: businessDate().nullable(),
  status: z.enum(CHANGE_ORDER_STATUSES),
  authorId: id(),
  /** "2 of 3": required approvals given, of those required. */
  approvals: output({ approved: z.number().int(), required: z.number().int() }),
  requests: z.number().int(),
  createdAt: instant(),
  submittedAt: instant().nullable(),
  decidedAt: instant().nullable(),
  releasedAt: instant().nullable(),
  version: z.number().int(),
})
export type OrderRow = z.output<typeof orderRow>

export const orderList = output({
  rows: z.array(orderRow),
  counts: z.record(z.enum(ORDER_TILES), z.number().int()),
  complete: z.boolean(),
})

const lineView = output({
  id: id(),
  seq: z.number().int(),
  recordType: z.string(),
  recordId: id(),
  field: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  note: z.string().nullable(),
})

const wipView = output({
  id: id(),
  seq: z.number().int(),
  workOrder: output({ id: id(), number: z.string(), status: z.string(), siteId: id(), revision: z.number().int().nullable() }),
  disposition: z.enum(WIP_DISPOSITIONS),
  note: z.string().nullable(),
  made: workOrderMade,
})

const approvalView = output({
  id: id(),
  stage: z.number().int(),
  approverId: id(),
  approverName: z.string().nullable(),
  required: z.boolean(),
  decision: z.enum(CHANGE_DECISIONS).nullable(),
  decidedAt: instant().nullable(),
  reason: z.string().nullable(),
})

export const orderView = orderRow.extend({
  reason: z.string(),
  description: z.string().nullable(),
  releasedById: id().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  requestsList: z.array(requestRow),
  lines: z.array(lineView),
  workInProgress: z.array(wipView),
  approvalsList: z.array(approvalView),
  /** The open work orders of the style without a work-in-progress line yet (MES-006); null without workorders.view. */
  openWorkOrders: z.array(output({ id: id(), number: z.string(), status: z.string(), siteId: id(), revision: z.number().int().nullable() })).nullable(),
  /** The redline: GET /product/styles/:styleId/versions/compare?from&to (B-W2b-220), once a revision is proposed. */
  compare: output({ styleId: id(), from: id(), to: id() }).nullable(),
  /** What the reader may do now, each with the refusal in words. */
  actions: output({ edit: action, startDraft: action, submit: action, decide: action, cancel: action, release: action }),
})
export type OrderView = z.output<typeof orderView>
