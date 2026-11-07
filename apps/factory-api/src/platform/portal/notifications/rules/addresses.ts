import { can } from '@nexus/factory-domain/core/permissions'
import { addressInShort } from '@nexus/factory-domain/parties/address-approval'
import { events as portalOrderingEvents } from '@nexus/factory-domain/portal-ordering/events'
import { PORTAL_HOME_VIEW } from '@nexus/factory-domain/portal/tasks/permissions'
import { PORTAL_ADDRESSES_VIEW } from '@nexus/factory-domain/sales/portal-ordering/permissions'
import type { CommandTx } from '../../../../core/command'
import type { PartnerDraft, PartnerRule } from './types'

/**
 * Our check of a delivery address a customer added in the portal (B-W2b-F15; B-W2b-F13b's office check, design
 * portal.customer.neworder "Add a new address (waits for our approval)"). `delivery_address.checked` → the ONE person who
 * asked for the address (PartyAddress.requestedByUserId), while they can use the portal and read their organisation's
 * delivery addresses (portal.home.view and portal.addresses.view over the company and the party), is told in their language:
 *
 *   APPROVED  portal.address.approved  "Your delivery address <address in short> was checked: your orders can use it"
 *   REFUSED   portal.address.refused   "Your delivery address <address in short> was not accepted: <the office's reason>"
 *
 * Topic ORDERS (transactional: mailed at once). Never a colleague, never the office's own addresses (they are never checked,
 * so no event), never the office person who decided. The reason is the one the customer already reads on its address list.
 *
 * The company: the party's own; for a party of every company (companyId null) the company whose portal the person asked in
 * (their newest portal session there), else the tenant's only active company; none of these → nobody is told (the portal's
 * address list still shows the decision).
 */

const checked = portalOrderingEvents.find((event) => event.type === 'delivery_address.checked')!

async function portalCompanyOf(tx: CommandTx, personId: string, partyId: string): Promise<string | null> {
  const session = await tx.session.findFirst({
    where: { userId: personId, partyId, audience: 'PARTNER', previewOfPartyId: null, companyId: { not: null } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { companyId: true },
  })
  if (session?.companyId) return session.companyId
  const companies = await tx.company.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, take: 2 })
  return companies.length === 1 ? companies[0]!.id : null
}

export const ADDRESS_RULES: readonly PartnerRule[] = Object.freeze([
  {
    name: 'portalNews.deliveryAddressChecked',
    events: ['delivery_address.checked'],
    async drafts(context, raw) {
      const event = checked.payload.parse(raw) as { addressId: string; partyId: string; decision: 'APPROVED' | 'REFUSED' }
      const address = await context.tx.partyAddress.findUnique({
        where: { id: event.addressId },
        select: { id: true, partyId: true, name: true, line1: true, postalCode: true, city: true, approvalStatus: true, refuseReason: true, requestedByUserId: true, party: { select: { companyId: true } } },
      })
      // The decision is made once (factory-db's guard): a row that says otherwise is not this event's.
      if (!address || address.partyId !== event.partyId || address.approvalStatus !== event.decision || address.requestedByUserId === null) return []
      const askerId = address.requestedByUserId
      const companyId = address.party.companyId ?? (await portalCompanyOf(context.tx, askerId, address.partyId))
      if (!companyId) return []
      const place = { companyId, partyId: address.partyId }
      const draft: PartnerDraft = {
        partyId: address.partyId,
        companyId,
        record: { type: 'PartyAddress', id: address.id, label: addressInShort(address) },
        messageKey: event.decision === 'APPROVED' ? 'portal.address.approved' : 'portal.address.refused',
        params: event.decision === 'REFUSED' && address.refuseReason ? { reason: address.refuseReason } : {},
        anchor: null,
        forReader: (reader) => reader.personId === askerId && can(reader.actor, PORTAL_HOME_VIEW, place) && can(reader.actor, PORTAL_ADDRESSES_VIEW, place),
      }
      return [draft]
    },
  },
])
