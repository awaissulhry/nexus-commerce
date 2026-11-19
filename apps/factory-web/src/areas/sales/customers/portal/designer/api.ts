import { z } from 'zod'
import { DESIGNER_STATES } from '@nexus/factory-domain/auth/partners/designer'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * F-CP-155 (customer page plan C7, D12; design 10 §7; the API's B-CP-078) — the calls of the factory designer slot on "Who looks after
 * {customer}": the slot as the office reads it (partners.view), who may be named (partners.manage over every company of the customer)
 * and the change (the stored version; no step-up: a name, no money, no access). A customer out of the reader's reach answers 404
 * "Customer not found." like an unknown id (the brand wall). The API's English words of a state are never drawn: the card says its own.
 */

const person = z.object({ id: z.string(), name: z.string(), state: z.enum(DESIGNER_STATES) })
const slotSchema = z.object({
  factoryDesigner: z.object({
    partyId: z.string(),
    designer: person.nullable(),
    backup: person.nullable(),
    since: z.string().nullable(),
    /** The customer's portal is on (off: the name shows once it is on). */
    portalOn: z.boolean(),
    /** The stored version (0: no settings row yet). */
    version: z.number(),
    /** partners.manage over every company the customer works with. */
    mayManage: z.boolean(),
  }),
})
export type DesignerSlot = z.infer<typeof slotSchema>['factoryDesigner']
export type DesignerPerson = NonNullable<DesignerSlot['designer']>

const choicesSchema = z.object({ people: z.array(z.object({ id: z.string(), name: z.string(), me: z.boolean() })), complete: z.boolean() })
export type DesignerChoices = z.infer<typeof choicesSchema>

export interface DesignerBody {
  readonly designerId: string | null
  readonly backupId: string | null
  /** The stored version read (0: no settings row yet). */
  readonly version: number
}

const path = (partyId: string) => `/partners/${encodeURIComponent(partyId)}/factory-designer`

/** GET /partners/:partyId/factory-designer */
export const readFactoryDesigner = (api: ApiClient, partyId: string, signal?: AbortSignal): Promise<DesignerSlot> => api.get(path(partyId), { schema: slotSchema, signal }).then((answer) => answer.factoryDesigner)

/** GET /partners/:partyId/factory-designer/choices — ACTIVE office people who read and answer the customer's threads (names only). */
export const readDesignerChoices = (api: ApiClient, partyId: string, signal?: AbortSignal): Promise<DesignerChoices> => api.get(`${path(partyId)}/choices`, { schema: choicesSchema, signal })

/** PUT /partners/:partyId/factory-designer — the designer and the backup at the stored version. */
export const setFactoryDesigner = (api: ApiClient, partyId: string, body: DesignerBody, idempotencyKey: string): Promise<DesignerSlot> =>
  api.request('PUT', path(partyId), { body, schema: slotSchema, idempotencyKey }).then((answer) => answer.factoryDesigner)
