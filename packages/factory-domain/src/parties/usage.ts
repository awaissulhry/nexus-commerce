import { z } from 'zod'

/**
 * The usage read of one customer (ca-s S.5; Owner decision D3, 2026-11-24: the "Used on …" counts now; the People & addresses
 * tab, research R-B9, R-B12): `GET /parties/:partyId/usage` (parties.view, office only, apps/factory-api modules/parties/usage.ts)
 * answers, for each contact and each address of THIS customer, how many of its open records name it, and when it was last
 * named. Counts and dates only: never a name, a subject, an amount or another record's id. A contact or an address that no
 * record names is not listed. Every count is read with a `where` that names this customer (each table that names a contact or
 * an address carries the customer in its key). The web parses the same shape with its own schema
 * (apps/factory-web customers/record/people/api.ts): a change of this shape is told to the web first.
 */
export const partyUsageAnswer = z.object({
  partyId: z.string(),
  asOf: z.string(), // ISO time of the read
  contacts: z.array(
    z.object({
      contactId: z.string(),
      openQuotes: z.number().int().nonnegative(), // quotes whose contactId is this contact, in an open state
      lastQuoteAt: z.string().nullable(), // newest quote of this contact (any state)
      openReturns: z.number().int().nonnegative(),
      openComplaints: z.number().int().nonnegative(),
      openServiceCases: z.number().int().nonnegative(),
      lastMailInAt: z.string().nullable(), // newest inbound mail matched to this contact (senderContactId)
    }),
  ),
  addresses: z.array(
    z.object({
      addressId: z.string(),
      draftQuoteVersions: z.number().int().nonnegative(), // DRAFT quote versions naming it as bill-to or ship-to
      preparedShipments: z.number().int().nonnegative(), // DRAFT / PACKED shipments naming it
      openSampleShipments: z.number().int().nonnegative(),
      openPortalRequests: z.number().int().nonnegative(), // portal order requests naming it, still open
      openChangeRequests: z.number().int().nonnegative(), // order change requests naming it, still open
    }),
  ),
})
export type PartyUsageAnswer = z.infer<typeof partyUsageAnswer>
