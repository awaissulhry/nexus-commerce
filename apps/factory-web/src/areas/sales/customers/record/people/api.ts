import { z } from 'zod'
import { ADDRESS_APPROVALS } from '@nexus/factory-domain/parties/address-approval'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * F-CA-102 (customer page › PEOPLE & ADDRESSES tab, lane ca-; 13-backend §5.2; 18-lead-settles Z10, D3) — the tab's own calls. Every one
 * names THIS customer (or one of its addresses) and is walled on the server; no list is filtered by customer in the browser. Answers are
 * checked (zod; unknown fields dropped). Every write names the version it read and carries one Idempotency-Key per attempt.
 *   - the usage read (D3, built by the server PR `ca-s`): counts and dates only — never a name, a subject, an amount or another
 *     record's id. Its shape is FIXED in the lane's briefs; parsed here with our OWN schema so the web never waits for the server PR.
 *   - the office's check of a delivery address the customer added in the portal: Approve (one click), Refuse (the reason the customer
 *     reads) — the portal-ordering routes (orders.manage).
 */

const enc = encodeURIComponent
const count = z.number().int().nonnegative()

/** `GET /parties/:partyId/usage` (parties.view): what each contact and address is used on, open work only. */
export const partyUsageSchema = z.object({
  partyId: z.string(),
  asOf: z.string(),
  contacts: z.array(
    z.object({
      contactId: z.string(),
      openQuotes: count,
      lastQuoteAt: z.string().nullable(),
      openReturns: count,
      openComplaints: count,
      openServiceCases: count,
      lastMailInAt: z.string().nullable(),
    }),
  ),
  addresses: z.array(
    z.object({
      addressId: z.string(),
      draftQuoteVersions: count,
      preparedShipments: count,
      openSampleShipments: count,
      openPortalRequests: count,
      openChangeRequests: count,
    }),
  ),
})
export type PartyUsage = z.infer<typeof partyUsageSchema>
export type ContactUsage = PartyUsage['contacts'][number]
export type AddressUsage = PartyUsage['addresses'][number]

/** The usage read of THIS customer (read only on People; while it reads or when it fails, the usage lines are left out). */
export function readPartyUsage(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<PartyUsage> {
  return api.get(`/parties/${enc(partyId)}/usage`, { schema: partyUsageSchema, ...(signal ? { signal } : {}) })
}

/** The check as the portal-ordering routes answer it (only what the tab reads; the party read is read again after). */
const addressCheckAnswer = z.object({
  address: z.object({ id: z.string(), status: z.string(), approval: z.object({ status: z.enum(ADDRESS_APPROVALS) }), version: z.number() }),
})
export type AddressCheckAnswer = z.infer<typeof addressCheckAnswer>

/** `POST /sales/delivery-addresses/:addressId/approve` (orders.manage): the address can be chosen for deliveries from now on. */
export function approveDeliveryAddress(api: ApiClient, addressId: string, body: { readonly version: number }, key: string): Promise<AddressCheckAnswer> {
  return api.post(`/sales/delivery-addresses/${enc(addressId)}/approve`, { body, idempotencyKey: key, schema: addressCheckAnswer })
}

/** `POST /sales/delivery-addresses/:addressId/refuse` (orders.manage): refused for good, with the words the customer reads. */
export function refuseDeliveryAddress(api: ApiClient, addressId: string, body: { readonly version: number; readonly reason: string }, key: string): Promise<AddressCheckAnswer> {
  return api.post(`/sales/delivery-addresses/${enc(addressId)}/refuse`, { body, idempotencyKey: key, schema: addressCheckAnswer })
}
