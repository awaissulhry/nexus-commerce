import { z } from 'zod'
import { COMPLIANCE_GATES } from '@nexus/factory-domain/compliance/requirements/rules'
import { PROPOSAL_STATES } from '@nexus/factory-domain/planning/promise-keep/repromise'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * B-TH-256 — what points at a sales order, as GET /sales/orders/:orderId/links answers it (B-TH-077, orders.view): its complaints and
 * its returns (each null when the reader holds no right to them: the section is not drawn), planning's re-promises still waiting for
 * sales (accept / decline with orders.manage, never by the planner who proposed it; `tell` also needs email.send), and the compliance
 * gates' refusals that still block its work orders and shipments (the event's id only with the compliance view right: words only
 * without). Wall W27: only the order's own customer's records come back.
 */

const enc = encodeURIComponent
const person = z.object({ id: z.string(), name: z.string() })

const complaint = z.object({ id: z.string(), number: z.string(), status: z.string(), receivedAt: z.string(), category: z.string().nullable(), severity: z.string().nullable(), answerDueOn: z.string().nullable() })
const returned = z.object({ id: z.string(), number: z.string(), status: z.string(), requestedAt: z.string(), closedAt: z.string().nullable(), outcomeWanted: z.string().nullable() })
const rePromise = z.object({
  id: z.string(),
  state: z.enum(PROPOSAL_STATES),
  line: z.object({ id: z.string(), seq: z.number(), styleCode: z.string().nullable() }),
  sizes: z.array(z.object({ size: z.string().nullable(), from: z.string().nullable(), to: z.string() })),
  reasonCode: z.string(),
  /** The planner's note (office only). */
  reason: z.string().nullable(),
  words: z.string(),
  proposedAt: z.string(),
  proposedBy: person.nullable(),
  may: z.object({ accept: z.boolean(), decline: z.boolean(), tell: z.boolean() }),
})
const gate = z.object({
  eventId: z.string().nullable(),
  gate: z.enum(COMPLIANCE_GATES),
  place: z.string(),
  at: z.string(),
  subject: z.object({ type: z.enum(['WorkOrder', 'Shipment']), id: z.string(), number: z.string().nullable() }),
  styleCode: z.string().nullable(),
  reason: z.string(),
})

export const linksSchema = z.object({
  order: z.object({ id: z.string(), number: z.string() }),
  complaints: z.array(complaint).nullable(),
  returns: z.array(returned).nullable(),
  rePromises: z.array(rePromise),
  gates: z.array(gate),
  asOf: z.string(),
})
export type OrderLinks = z.infer<typeof linksSchema>
export type OrderComplaint = z.infer<typeof complaint>
export type OrderReturn = z.infer<typeof returned>
export type OrderRePromise = z.infer<typeof rePromise>
export type OrderGate = z.infer<typeof gate>

/** GET /sales/orders/:orderId/links. */
export const getOrderLinks = (api: ApiClient, orderId: string, signal?: AbortSignal): Promise<OrderLinks> => api.get(`/sales/orders/${enc(orderId)}/links`, { schema: linksSchema, signal })
