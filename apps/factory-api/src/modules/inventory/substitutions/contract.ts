import { z } from 'zod'
import { defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { SUBSTITUTE_KINDS, SUBSTITUTION_LIMITS, SUBSTITUTION_STATUSES } from '@nexus/factory-domain/inventory/substitutions/rules'
import { ALTERNATE_USES } from '@nexus/factory-domain/product/bom-lines/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'

/**
 * Substitutes with a yes (B-W2b-298; MES-139): the dialog's read, the ask, the list and one substitute, the withdrawal and the
 * issue. Quantities are decimal text in the stated unit; no field carries money; no list names a person.
 */

const version = () => z.number().int().min(1)
const words = (max: number) => z.string().trim().min(1).max(max)
/** A reason code: without spaces (the database's rule). */
const reasonCode = () => z.string().trim().regex(/^\S{1,40}$/, 'A code without spaces (1 to 40 characters).')

const itemRef = output({ id: id(), code: z.string(), name: z.string(), kind: z.string().optional(), tracking: z.string(), baseUom: z.string(), isPpeComponent: z.boolean() })

export const substitutionView = output({
  id: id(),
  siteId: id(),
  workOrder: output({ id: id(), number: z.string(), status: z.string() }),
  line: output({ id: id(), seq: z.number().int(), placement: z.string().nullable(), material: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.string() }) }),
  kind: z.enum(SUBSTITUTE_KINDS),
  substitute: output({
    item: itemRef,
    colour: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
    lot: output({ id: id(), code: z.string(), qualityStatus: z.string() }).nullable(),
    alternate: output({ id: id(), priority: z.number().int(), allowedWhen: z.enum(ALTERNATE_USES) }).nullable(),
  }),
  quantity: z.string(),
  uom: z.string(),
  baseQuantity: z.string(),
  /** What it stands for of the line's own material (its base unit); null when a unit does not convert. */
  replaces: output({ quantity: z.string(), uom: z.string() }).nullable(),
  reasonCode: z.string().nullable(),
  reason: z.string(),
  /** The alternate rule's answer when it was asked, as it was given (B-W2b-228 alternateUse). */
  ruleAnswer: output({ may: z.boolean(), held: z.array(z.string()), message: z.string() }),
  status: z.enum(SUBSTITUTION_STATUSES),
  statusWords: z.string(),
  /** Its request for a yes (Home › Approvals), or null: none was asked. */
  approval: output({ taskId: id(), status: z.string(), dueAt: instant().nullable() }).nullable(),
  /** Who asked: the office or the floor (never who). */
  asked: z.enum(['OFFICE', 'FLOOR']),
  decidedAt: instant().nullable(),
  refuseReason: z.string().nullable(),
  issuedAt: instant().nullable(),
  moveIds: z.array(id()),
  withdrawnAt: instant().nullable(),
  withdrawReason: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
})

const refusal = output({ code: z.string(), message: z.string() })
const approvalRoute = output({
  /** A switched-on rule asks for a yes on these facts. */
  asks: z.boolean(),
  /** How many rules of the kind are switched on. */
  active: z.number().int(),
  rule: output({ id: id(), name: z.string(), signatureMeaning: z.string().nullable(), requireStepUp: z.boolean(), dueHours: z.number().int().nullable() }).nullable(),
  approver: output({ kind: z.enum(['ROLE', 'PERSON']), id: id(), name: z.string() }).nullable(),
  /** Every rule that holds names the person asking: nobody could decide it. */
  namedSelf: z.boolean(),
})

const stockLot = output({
  lot: output({ id: id(), code: z.string(), qualityStatus: z.string(), crViStatus: z.string(), requiresCrViTest: z.boolean() }).nullable(),
  colour: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  onHand: z.string(),
  hides: z.number().int(),
  places: z.array(z.string()),
  usable: z.boolean(),
  /** Why it is not used now, in words (no valid chromium VI test, on hold …), or null. */
  words: z.string().nullable(),
})

export const optionsContract = defineContract({
  querystring: input({ workOrderId: id(), bomLineId: id() }),
  response: {
    200: output({
      asOf: instant(),
      workOrder: output({ id: id(), number: z.string(), status: z.string(), siteId: id(), companyId: id() }),
      line: output({
        id: id(),
        seq: z.number().int(),
        placement: z.string().nullable(),
        material: itemRef,
        qty: z.string(),
        uom: z.string(),
        planned: z.string(),
        issued: z.string(),
        toIssue: z.string(),
        /** What neither the work order's reservations nor the free stock covers. */
        short: z.string(),
        ownShort: z.boolean(),
        /** What standing substitutes stand for (asked, approved, issued), of the own material. */
        standing: z.string(),
        open: z.string(),
      }),
      substitutions: z.array(substitutionView),
      choices: z.array(
        output({
          kind: z.enum(SUBSTITUTE_KINDS),
          alternate: output({ id: id(), priority: z.number().int(), allowedWhen: z.enum(ALTERNATE_USES), certificateCheck: z.boolean(), qty: z.string().nullable(), note: z.string().nullable(), colourId: id().nullable() }).nullable(),
          item: itemRef,
          answer: output({ may: z.boolean(), held: z.array(z.string()), message: z.string() }),
          needsPerson: z.boolean(),
          refusal: refusal.nullable(),
          certificateRequired: z.boolean(),
          certificate: output({ id: id(), number: z.string(), standard: z.string(), validTo: z.string() }).nullable(),
          max: z.string().nullable(),
          stock: output({ onHand: z.string(), lots: z.array(stockLot) }),
          approval: approvalRoute,
          mayAsk: z.boolean(),
          held: z.string().nullable(),
        }),
      ),
    }),
  },
})

export const askBody = input({
  workOrderId: id(),
  bomLineId: id(),
  /** The line's own material (another lot: toLotId) or one of the line's alternates. */
  toItemId: id(),
  toItemColourId: id().nullish(),
  toLotId: id().optional(),
  quantity: quantity(),
  uom: z.enum(UOMS).optional(),
  baseQuantity: quantity().optional(),
  reasonCode: reasonCode().optional(),
  reason: words(SUBSTITUTION_LIMITS.reason),
  note: words(SUBSTITUTION_LIMITS.note).optional(),
})

export const askContract = defineContract({
  body: askBody,
  response: {
    201: output({
      substitution: substitutionView,
      approval: output({ asked: z.boolean(), taskId: id().nullable(), approverRoleId: id().nullable(), approverUserId: id().nullable(), dueAt: instant().nullable() }),
      /** Nobody's yes was needed and no rule asked one: approved at once. */
      approvedAtOnce: z.boolean(),
    }),
  },
})

export const listContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    workOrderId: id().optional(),
    status: z.enum([...SUBSTITUTION_STATUSES, 'OPEN', 'ALL']).optional(),
    limit: z.coerce.number().int().min(1).max(SUBSTITUTION_LIMITS.list).default(50),
  }),
  response: { 200: output({ asOf: instant(), tiles: output({ waiting: z.number().int(), approved: z.number().int() }), substitutions: z.array(substitutionView), more: z.boolean() }) },
})

const params = input({ substitutionId: id() })

export const recordContract = defineContract({
  params,
  response: {
    200: output({
      substitution: substitutionView,
      requestedById: id().nullable(),
      decidedById: id().nullable(),
      mine: z.boolean(),
      request: output({
        id: id(),
        status: z.string(),
        approverRoleId: id().nullable(),
        approverUserId: id().nullable(),
        signatureMeaning: z.string().nullable(),
        dueAt: instant().nullable(),
        decidedAt: instant().nullable(),
        rejectReasonCode: z.string().nullable(),
        rejectReason: z.string().nullable(),
      }).nullable(),
    }),
  },
})

export const withdrawContract = defineContract({
  params,
  body: input({ version: version(), reason: words(SUBSTITUTION_LIMITS.withdrawReason) }),
  response: { 200: output({ substitution: substitutionView }) },
})

export const issueBody = input({
  version: version().optional(),
  /** A scanned tag: a hide's, else a lot's code. */
  code: z.string().trim().min(1).max(80).optional(),
  lotId: id().optional(),
  hideIds: z.array(id()).min(1).max(50).optional(),
  quantity: quantity().optional(),
  uom: z.enum(UOMS).optional(),
  baseQuantity: quantity().optional(),
  fromLocationId: id().optional(),
  overIssueReason: words(500).optional(),
  occurredAt: instant().optional(),
})

export const issueContract = defineContract({
  params,
  body: issueBody,
  response: {
    201: output({
      substitution: substitutionView,
      /** What was issued (the substitute's base unit). */
      issued: z.string(),
      moveIds: z.array(id()),
      /** The substitute's line at the work order after it: allowed, issued, still to issue. */
      line: output({ planned: z.string(), issued: z.string(), toIssue: z.string() }),
    }),
  },
})
