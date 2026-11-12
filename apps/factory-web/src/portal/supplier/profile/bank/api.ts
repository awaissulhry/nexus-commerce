import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The supplier's bank details in its portal (B-W2b-334 on B-W2b-315's API, SCM-007): its accounts masked with their state
 * (USABLE — payments go to it —, WAITING for our call-back and second check, REFUSED with why, RETIRED), "Last changed",
 * whether this person may propose a change, and the proposal itself (after a fresh code by e-mail). No IBAN in any answer.
 * The API's English waiting sentence is not drawn: the page says its own words.
 */

const accountSchema = z.object({
  id: z.string(),
  masked: z.string(),
  bankName: z.string().nullable(),
  holder: z.string(),
  currency: z.string(),
  state: z.enum(['USABLE', 'WAITING', 'REFUSED', 'RETIRED']),
  proposedAt: z.string(),
  activatedAt: z.string().nullable(),
  refusedAt: z.string().nullable(),
  reason: z.string().nullable(),
  retiredAt: z.string().nullable(),
})
export type PortalBankAccount = z.infer<typeof accountSchema>

const bankSchema = z.object({
  accounts: z.array(accountSchema),
  mayPropose: z.boolean(),
  live: z.object({ events: z.array(z.string()) }),
})
export type PortalBank = z.infer<typeof bankSchema>

export const readSupplierBank = (api: ApiClient, signal?: AbortSignal) => api.get('/portal/supplier-bank', { schema: bankSchema, ...(signal ? { signal } : {}) })

export interface PortalProposal {
  iban: string
  holder: string
  bankName: string | null
  bic: string | null
  currency: string
}

export const proposeSupplierBank = (api: ApiClient, body: PortalProposal, idempotencyKey: string) =>
  api.post('/portal/supplier-bank', { body, idempotencyKey, schema: bankSchema.extend({ accountId: z.string() }) })
