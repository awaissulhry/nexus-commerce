import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LINK_STATES } from '@nexus/factory-domain/links/purposes'
import { ANSWER_MODES, ANSWER_OUTCOMES, DECLINE_REASONS, LINE_ANSWERS, LINE_CHANGES } from '@nexus/factory-domain/purchasing/confirm/answer'
import { MAX_LINES, MAX_TEXT, PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { getOrderContract, supplierViewContract } from '../contract'

/**
 * The confirm link's contracts (B-W1-31; design links.po, SCR-100) and the office's view of the supplier's answer. The
 * link's page holds NO price: the order and lines are purchasing's price-free supplier view (the same shape as the
 * office's "What the supplier sees"); nothing here is money. The shapes of an answer are loose on purpose where the
 * domain explains a refusal in words (quantities and dates are strings it checks, naming each path).
 */

const version = z.number().int().min(1)
const text = (max: number) => z.string().max(max)
const loose = z.string().max(40).nullable().optional()

const supplierOrder = supplierViewContract.response[200]

const linkPage = {
  order: supplierOrder.shape.order,
  lines: supplierOrder.shape.lines,
  from: output({ legalName: z.string(), tradeName: z.string().nullable(), buyerName: z.string().nullable() }),
  deliverTo: output({ name: z.string(), line1: z.string(), line2: z.string().nullable(), postalCode: z.string(), city: z.string(), province: z.string().nullable(), country: z.string() }).nullable(),
  canAnswer: z.boolean(),
  message: z.string().nullable(),
  answers: z.array(output({ action: z.enum(['confirm', 'decline']), typedName: z.enum(['required', 'optional', 'none']), email: z.boolean() })),
  lineAnswers: z.array(z.enum(LINE_ANSWERS)),
  declineReasons: z.array(z.enum(DECLINE_REASONS)),
  document: z.string(),
  expiresAt: instant(),
  /** B-W2a-52: a later revision (2 on): what changed since the one before, in the supplier's words, and the buyer's note. */
  revision: output({ revision: z.number().int(), sentAt: instant(), changeNote: z.string().nullable(), changes: z.array(z.string()) }).nullable(),
}

export const openLinkOrderContract = defineContract({ response: { 200: output(linkPage) } })

/** The supplier's own confirmation PDF, uploaded through the link before answering (SCM-090; design links.po "answer"). */
const supplierFile = output({ id: id(), originalName: z.string(), sizeBytes: z.number().int(), status: z.enum(['PENDING_UPLOAD', 'AVAILABLE', 'QUARANTINED', 'DELETED']) })

const endState = output({
  ...linkPage,
  outcome: z.enum(ANSWER_OUTCOMES),
  summary: z.string().nullable(),
  done: z.string(),
  /** The supplier's confirmation PDF that went with the answer (null: none). */
  confirmationFile: supplierFile.nullable(),
})

export const confirmLinkOrderContract = defineContract({
  body: input({
    version,
    mode: z.enum(ANSWER_MODES),
    lines: z
      .array(
        input({
          lineId: z.string().max(40),
          answer: z.enum(LINE_ANSWERS),
          quantity: loose,
          date: loose,
          deliveries: z.array(input({ quantity: z.string().max(40), date: z.string().max(40) })).max(10).nullable().optional(),
          reason: text(2 * MAX_TEXT.reason).nullable().optional(),
        }),
      )
      .max(MAX_LINES)
      .nullable()
      .optional(),
    supplierRef: text(2 * MAX_TEXT.code).nullable().optional(),
    note: text(2 * MAX_TEXT.note).nullable().optional(),
    typedName: text(400).nullable().optional(),
    /** The supplier's confirmation PDF, uploaded through this link first (POST …/confirmation, then …/complete). */
    confirmationFileId: id().nullable().optional(),
  }),
  response: { 200: endState },
})

export const declineLinkOrderContract = defineContract({
  body: input({ version, reason: z.enum(DECLINE_REASONS), note: text(2 * MAX_TEXT.note).nullable().optional(), typedName: text(400).nullable().optional() }),
  response: { 200: endState },
})

/** POST /link/purchase-order/confirmation: announce the supplier's confirmation PDF; the answer holds the presigned PUT. */
export const announceConfirmationContract = defineContract({
  body: input({
    originalName: z.string().trim().min(1).max(200),
    contentType: z.string().trim().min(1).max(100),
    sizeBytes: z.number().int().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  response: {
    201: output({
      file: supplierFile,
      upload: output({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }),
    }),
  },
})

/** POST /link/purchase-order/confirmation/:fileId/complete: the store holds it (AVAILABLE, or QUARANTINED when it differs). */
export const completeConfirmationContract = defineContract({
  params: input({ fileId: id() }),
  response: { 200: output({ file: supplierFile }) },
})

export const renewLinkOrderContract = defineContract({ body: input({}).optional(), response: { 202: output({ status: z.literal('requested'), message: z.string() }) } })

// ---- the office: the supplier's answer on the order ------------------------------------------------------------------

const delivery = output({ quantity: z.string(), date: z.string().nullable() })

export const orderAnswerContract = defineContract({
  params: input({ purchaseOrderId: id() }),
  response: {
    200: output({
      purchaseOrderId: id(),
      number: z.string(),
      status: z.enum(PURCHASE_ORDER_STATUSES),
      /** WAITING (sent, no answer yet), CONFIRMED, DECLINED, CHANGES_PROPOSED, NOT_SENT, or the order's later state. */
      answer: z.enum(['NOT_SENT', 'WAITING', 'CONFIRMED', 'DECLINED', 'CHANGES_PROPOSED', 'CLOSED']),
      words: z.string(),
      confirmation: output({ at: instant(), via: z.enum(['LINK', 'OFFICE']), linkId: id().nullable(), byName: z.string().nullable(), supplierRef: z.string().nullable(), note: z.string().nullable() }).nullable(),
      decline: output({ at: instant(), reason: z.string().nullable() }).nullable(),
      proposal: output({
        at: instant(),
        linkId: id().nullable(),
        byName: z.string().nullable(),
        supplierRef: z.string().nullable(),
        note: z.string().nullable(),
        summary: z.string(),
        decision: z.enum(['ACCEPTED', 'REFUSED']).nullable(),
        decidedAt: instant().nullable(),
        decidedById: id().nullable(),
        decisionNote: z.string().nullable(),
      }).nullable(),
      lines: z.array(
        output({
          id: id(),
          seq: z.number().int(),
          item: output({ code: z.string(), name: z.string() }),
          colour: z.string().nullable(),
          asked: output({ quantity: z.string(), uom: z.enum(UOMS), needDate: z.string() }),
          proposed: output({ kind: z.enum(LINE_ANSWERS), quantity: z.string(), date: z.string().nullable(), deliveries: z.array(delivery), reason: z.string().nullable(), changes: z.array(z.enum(LINE_CHANGES)) }).nullable(),
          confirmed: delivery.nullable(),
          changes: z.array(z.enum(LINE_CHANGES)),
        }),
      ),
      evidence: z.array(output({ linkId: id(), action: z.string(), at: instant(), useNumber: z.number().int().nullable(), typedName: z.string().nullable(), ipHash: z.string().nullable(), userAgent: z.string().nullable() })),
      links: z.array(output({ id: id(), email: z.string().nullable(), state: z.enum(LINK_STATES), expiresAt: instant(), uses: z.number().int(), maxUses: z.number().int(), lastUsedAt: instant().nullable(), revokedAt: instant().nullable(), createdAt: instant() })),
    }),
  },
})

const decided = getOrderContract.response[200].shape.order

export const acceptProposalContract = defineContract({
  params: input({ purchaseOrderId: id() }),
  body: input({ version, message: text(2 * MAX_TEXT.message).nullable().optional() }),
  response: { 200: output({ order: decided, supplierTold: z.boolean() }) },
})

export const refuseProposalContract = defineContract({
  params: input({ purchaseOrderId: id() }),
  body: input({ version, note: text(2 * MAX_TEXT.reason).nullable().optional() }),
  response: { 200: output({ order: decided, next: z.string() }) },
})

/** B-W2a-52: the buyer's counter-proposal: the proposal refused and the next revision a draft to send. */
export const counterProposalContract = defineContract({
  params: input({ purchaseOrderId: id() }),
  body: input({ version, note: text(2 * MAX_TEXT.reason).nullable().optional() }),
  response: { 200: output({ order: decided, revision: z.number().int() }) },
})
