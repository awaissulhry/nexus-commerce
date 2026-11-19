import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'
import { DRAFT_LATER_PARTS, DRAFT_PART_STATES, DRAFT_PARTS } from '@nexus/factory-domain/sales/portal-ordering/office'

/**
 * F-CP-107 (customer page plan D10; 10-customer-page §6, 12-portal-drafts-team §3): the customer's portal drafts as the office reads
 * them — read only — through B-CP-071's route: GET /sales/order-requests?status=DRAFT&partyId= (orders.view over the customer; a
 * customer out of reach answers "Customer not found.", as unknown as a wrong id: the brand wall). Never in Incoming, Approvals or any
 * count. Money is marked on the API (`netShown`, price grain): absent for a person without prices — never 0.
 */

const fileSchema = z.object({ id: z.string(), lineId: z.string().nullable(), originalName: z.string().nullable(), kind: z.string(), sizeBytes: z.number(), status: z.string(), locked: z.boolean() })

export const officeDraftSchema = z.object({
  startedBy: z.string().nullable(),
  startedAt: z.string(),
  lastEditedBy: z.string().nullable(),
  lastEditedAt: z.string(),
  /** The first line's style; null: "Untitled draft". */
  title: z.string().nullable(),
  people: z.number(),
  readiness: z.object({ parts: z.array(z.object({ part: z.enum(DRAFT_PARTS), state: z.enum(DRAFT_PART_STATES) })), done: z.number(), of: z.number(), problems: z.number() }),
  later: z.array(z.enum(DRAFT_LATER_PARTS)),
  /** Its conversation, for a reader of its thread (null: not one). */
  thread: z.object({ messages: z.number(), lastAt: z.string().nullable(), designerAsked: z.boolean() }).nullable(),
  files: z.object({ logos: z.array(fileSchema), references: z.array(fileSchema), sheets: z.array(fileSchema) }),
})

export const draftRowSchema = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: z.string(),
  party: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  customerRef: z.string().nullable(),
  requestedDate: z.string().nullable(),
  lines: z.number(),
  pieces: z.number(),
  /** The net at the prices shown to the customer (price grain only: absent without it). */
  netShown: z.string().nullable().optional(),
  currency: z.string(),
  version: z.number(),
  draft: officeDraftSchema.nullable(),
})
export type DraftRow = z.infer<typeof draftRowSchema>

const listSchema = z.object({ requests: z.array(draftRowSchema) })

/** One customer's portal drafts, newest change first (the API's order). */
export async function listCustomerDrafts(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<DraftRow[]> {
  return (await api.get('/sales/order-requests', { query: { status: 'DRAFT', partyId }, schema: listSchema, signal })).requests
}
