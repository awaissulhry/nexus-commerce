import { REQUEST_STATUS_WORDS, type RequestStatus } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { definePartnerView, equalsTyped, holdsTyped, idsOf, type PartnerReader } from '../view'
// B-CP-071: a draft opens only to the people of the party who keep its drafts.
import { can } from '@nexus/factory-domain/core/permissions'
import { PORTAL_ORDER_DRAFTS_EDIT } from '@nexus/factory-domain/sales/portal-ordering/permissions'

/**
 * A customer's catalogue orders (B-TH-040; threads plan TH-3, G16, L2-G04; modules/sales/portal-ordering): its order requests
 * once SENT, read in the PARTNER scope (the party's row-level security and column grants: never who in the office decided). Their
 * purchase-order number first, our request number second, the state in words under it. Its thread opens on it
 * (platform/threads/partner): the office and the customer discuss the order there. The portal search's Orders group finds it by
 * either number. B-CP-071 (customer page plan D10): a DRAFT opens too — its thread from its first save — to the party's people who
 * keep drafts (portal.orderDrafts.edit over it), never to a colleague who does not; it is still never FOUND (the lookup and the
 * office index skip drafts: a draft has no number and is nobody's search result).
 */
export default definePartnerView({
  recordType: 'PortalOrderRequest',
  group: 'orders',
  kinds: ['CUSTOMER'],
  async read(client, ids, reader?: PartnerReader) {
    const rows = await client.portalOrderRequest.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, companyId: true, partyId: true, number: true, customerRef: true, status: true, sentAt: true, createdAt: true },
    })
    // B-CP-071: a draft for a reader who keeps the party's drafts only (no reader named: none).
    const opens = (row: (typeof rows)[number]) => row.status !== 'DRAFT' || (reader !== undefined && can(reader.actor, PORTAL_ORDER_DRAFTS_EDIT, { companyId: row.companyId, partyId: row.partyId }))
    return rows
      .filter(opens)
      .map((row) => ({ id: row.id, companyId: row.companyId, theirRef: row.customerRef, ourRef: row.number, subtitle: REQUEST_STATUS_WORDS[row.status as RequestStatus].en, status: row.status, date: row.sentAt ?? row.createdAt, words: [] }))
  },
  async lookup(client, typed, take) {
    return idsOf(
      await client.portalOrderRequest.findMany({
        where: { status: { not: 'DRAFT' }, OR: [{ number: equalsTyped(typed) }, { customerRef: holdsTyped(typed) }] },
        select: { id: true },
        orderBy: { sentAt: 'desc' },
        take,
      }),
    )
  },
})
