import type { FactoryClient } from '@nexus/factory-db'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { PartyUsageAnswer } from '@nexus/factory-domain/parties/usage'
import { OPEN_STATUSES as OPEN_COMPLAINT_STATUSES } from '@nexus/factory-domain/quality/complaints/rules'
import { OPEN_QUOTES } from '@nexus/factory-domain/sales/before-order/groups'
import { WAITING_REQUEST_STATUSES } from '@nexus/factory-domain/sales/change-requests/rules'
import { OPEN_BEFORE_SEND } from '@nexus/factory-domain/sales/quotes/quotes'
import { OPEN_RETURN_STATUSES } from '@nexus/factory-domain/sales/returns/rules'
import { CLOSED_STAGES } from '@nexus/factory-domain/sales/samples/rules'
import { OPEN_CASE_STATUSES } from '@nexus/factory-domain/sales/service/rules'
import { HOLDABLE_STATUSES } from '@nexus/factory-domain/shipping/holds/holds'
import type { CommandCaller, CommandTx } from '../../core/command'
import { serverClock } from '../../core/time'
import { contextOf, readParty } from './store'

/**
 * F-CA-S5 (ca-s S.5; Owner decision D3, 2026-11-24: the "Used on …" counts now; the People & addresses tab of the customer
 * record): `GET /parties/:partyId/usage` (parties.view, office only) — for each contact and each address of THIS customer, how
 * many of its open records name it, and when it was last named, in ONE request of grouped counts (shape: factory-domain
 * parties/usage). Walled as every /parties/:id read: the record's own check (store.ts readParty: can() over the company AND
 * the party, else 404, as an unknown id), and every `where` below names this party — each table that names a contact or an
 * address carries the party in its key (the composite relations to PartyContact / PartyAddress), so no count crosses
 * customers. Counts and dates only: no name, subject, amount or another record's id leaves.
 *
 * "Open" is each module's OWN state list, never a new one:
 *   quotes            OPEN_QUOTES             factory-domain sales/before-order/groups.ts (the Work line's "open quotes")
 *   returns           OPEN_RETURN_STATUSES    factory-domain sales/returns/rules.ts
 *   complaints        OPEN_STATUSES           factory-domain quality/complaints/rules.ts
 *   service cases     OPEN_CASE_STATUSES      factory-domain sales/service/rules.ts
 *   quote versions    OPEN_BEFORE_SEND        factory-domain sales/quotes/quotes.ts (before the send the version names the
 *                                             address; from SENT it holds its own copy, sales.prisma QuoteVersion)
 *   shipments         HOLDABLE_STATUSES       factory-domain shipping/holds/holds.ts (DRAFT, PACKED: not left yet — the
 *                                             shipments list's own `open`, modules/shipping/shipments/shipments.ts)
 *   sample shipments  CLOSED_STAGES           factory-domain sales/samples/rules.ts (isOpenStage: the round not decided or
 *                                             cancelled)
 *   portal requests   'SENT'                  the office's own OPEN, modules/sales/portal-ordering/office.ts listOfficeRequests
 *   change requests   WAITING_REQUEST_STATUSES  factory-domain sales/change-requests/rules.ts
 */

type Reader = FactoryClient | CommandTx
type ContactUsage = PartyUsageAnswer['contacts'][number]
type AddressUsage = PartyUsageAnswer['addresses'][number]

const noContactUse = (contactId: string): ContactUsage => ({ contactId, openQuotes: 0, lastQuoteAt: null, openReturns: 0, openComplaints: 0, openServiceCases: 0, lastMailInAt: null })
const noAddressUse = (addressId: string): AddressUsage => ({ addressId, draftQuoteVersions: 0, preparedShipments: 0, openSampleShipments: 0, openPortalRequests: 0, openChangeRequests: 0 })
/** A row is listed when some record names it: a count above 0, or a date. */
const contactUsed = (row: ContactUsage): boolean => row.openQuotes + row.openReturns + row.openComplaints + row.openServiceCases > 0 || row.lastQuoteAt !== null || row.lastMailInAt !== null
const addressUsed = (row: AddressUsage): boolean => row.draftQuoteVersions + row.preparedShipments + row.openSampleShipments + row.openPortalRequests + row.openChangeRequests > 0
const isoOrNull = (at: Date | null | undefined): string | null => (at ? toUtcIso(at) : null)

/** The usage of THIS customer's contacts and addresses: grouped counts, each `where` naming the party. */
export async function usageOf(db: Reader, partyId: string, now: Date): Promise<PartyUsageAnswer> {
  // ---- per contact ------------------------------------------------------------------------------------------------------
  const openQuotes = await db.quote.groupBy({ by: ['contactId'], where: { partyId, contactId: { not: null }, status: { in: [...OPEN_QUOTES] } }, _count: { _all: true } })
  const lastQuotes = await db.quote.groupBy({ by: ['contactId'], where: { partyId, contactId: { not: null } }, _max: { createdAt: true } })
  const openReturns = await db.returnAuthorisation.groupBy({ by: ['contactId'], where: { partyId, contactId: { not: null }, status: { in: [...OPEN_RETURN_STATUSES] } }, _count: { _all: true } })
  const openComplaints = await db.complaint.groupBy({ by: ['contactId'], where: { partyId, contactId: { not: null }, status: { in: [...OPEN_COMPLAINT_STATUSES] } }, _count: { _all: true } })
  const openCases = await db.serviceCase.groupBy({ by: ['contactId'], where: { partyId, contactId: { not: null }, status: { in: [...OPEN_CASE_STATUSES] } }, _count: { _all: true } })
  // The mail matched to the contact: email-in writes the sender's party with its contact (platform/email-in/match.ts).
  const lastMails = await db.inboundEmail.groupBy({ by: ['senderContactId'], where: { senderPartyId: partyId, senderContactId: { not: null } }, _max: { receivedAt: true } })
  // ---- per address ------------------------------------------------------------------------------------------------------
  // A version that names the address as bill-to AND ship-to counts once: the versions are read, then counted per address.
  const versions = await db.quoteVersion.findMany({ where: { partyId, status: { in: [...OPEN_BEFORE_SEND] }, OR: [{ billToAddressId: { not: null } }, { shipToAddressId: { not: null } }] }, select: { billToAddressId: true, shipToAddressId: true } })
  const shipments = await db.shipment.groupBy({ by: ['shipToAddressId'], where: { partyId, shipToAddressId: { not: null }, status: { in: [...HOLDABLE_STATUSES] } }, _count: { _all: true } })
  const samples = await db.sampleShipment.groupBy({ by: ['shipToAddressId'], where: { partyId, shipToAddressId: { not: null }, round: { stage: { notIn: [...CLOSED_STAGES] } } }, _count: { _all: true } })
  const portalRequests = await db.portalOrderRequest.groupBy({ by: ['shipToAddressId'], where: { partyId, shipToAddressId: { not: null }, status: 'SENT' }, _count: { _all: true } })
  const changeRequests = await db.orderChangeRequest.groupBy({ by: ['shipToAddressId'], where: { partyId, shipToAddressId: { not: null }, status: { in: [...WAITING_REQUEST_STATUSES] } }, _count: { _all: true } })

  const contacts = new Map<string, ContactUsage>()
  const contact = (id: string | null, change: Partial<Omit<ContactUsage, 'contactId'>>): void => {
    if (id === null) return
    contacts.set(id, { ...(contacts.get(id) ?? noContactUse(id)), ...change })
  }
  for (const row of openQuotes) contact(row.contactId, { openQuotes: row._count._all })
  for (const row of lastQuotes) contact(row.contactId, { lastQuoteAt: isoOrNull(row._max.createdAt) })
  for (const row of openReturns) contact(row.contactId, { openReturns: row._count._all })
  for (const row of openComplaints) contact(row.contactId, { openComplaints: row._count._all })
  for (const row of openCases) contact(row.contactId, { openServiceCases: row._count._all })
  for (const row of lastMails) contact(row.senderContactId, { lastMailInAt: isoOrNull(row._max.receivedAt) })

  const addresses = new Map<string, AddressUsage>()
  const address = (id: string | null, change: (row: AddressUsage) => Partial<Omit<AddressUsage, 'addressId'>>): void => {
    if (id === null) return
    const row = addresses.get(id) ?? noAddressUse(id)
    addresses.set(id, { ...row, ...change(row) })
  }
  for (const version of versions) {
    for (const id of new Set([version.billToAddressId, version.shipToAddressId])) address(id, (row) => ({ draftQuoteVersions: row.draftQuoteVersions + 1 }))
  }
  for (const row of shipments) address(row.shipToAddressId, () => ({ preparedShipments: row._count._all }))
  for (const row of samples) address(row.shipToAddressId, () => ({ openSampleShipments: row._count._all }))
  for (const row of portalRequests) address(row.shipToAddressId, () => ({ openPortalRequests: row._count._all }))
  for (const row of changeRequests) address(row.shipToAddressId, () => ({ openChangeRequests: row._count._all }))

  return {
    partyId,
    asOf: toUtcIso(now),
    contacts: [...contacts.values()].filter(contactUsed).sort((a, b) => a.contactId.localeCompare(b.contactId)),
    addresses: [...addresses.values()].filter(addressUsed).sort((a, b) => a.addressId.localeCompare(b.addressId)),
  }
}

/** GET /parties/:partyId/usage (parties.view): office only; another customer's id (outside the reader's grants) is not found. */
export async function getPartyUsage(caller: CommandCaller, partyId: string): Promise<PartyUsageAnswer> {
  if (contextOf(caller).audience !== 'office') throw new ForbiddenError()
  await readParty(caller, partyId)
  const now = serverClock.now()
  return caller.withClient((client) => usageOf(client, partyId, now))
}
