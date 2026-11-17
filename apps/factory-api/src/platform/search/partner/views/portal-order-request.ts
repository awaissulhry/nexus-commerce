import { REQUEST_STATUS_WORDS, type RequestStatus } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { definePartnerView, equalsTyped, holdsTyped, idsOf } from '../view'

/**
 * A customer's catalogue orders (B-TH-040; threads plan TH-3, G16, L2-G04; modules/sales/portal-ordering): its order requests
 * once SENT (a draft is still being written: it has no thread and is never found), read in the PARTNER scope (the party's
 * row-level security and column grants: never who in the office decided). Their purchase-order number first, our request number
 * second, the state in words under it. Its thread opens on it (platform/threads/partner): the office and the customer discuss the
 * order there. The portal search's Orders group finds it by either number.
 */
export default definePartnerView({
  recordType: 'PortalOrderRequest',
  group: 'orders',
  kinds: ['CUSTOMER'],
  async read(client, ids) {
    const rows = await client.portalOrderRequest.findMany({
      where: { id: { in: [...ids] }, status: { not: 'DRAFT' } },
      select: { id: true, companyId: true, number: true, customerRef: true, status: true, sentAt: true },
    })
    return rows.map((row) => ({ id: row.id, companyId: row.companyId, theirRef: row.customerRef, ourRef: row.number, subtitle: REQUEST_STATUS_WORDS[row.status as RequestStatus].en, status: row.status, date: row.sentAt, words: [] }))
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
