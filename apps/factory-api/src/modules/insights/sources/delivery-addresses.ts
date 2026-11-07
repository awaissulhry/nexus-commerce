import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { deliveryAddressWords } from '@nexus/factory-domain/insights/words'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { PARTY_SCOPE } from '../../parties/store'
import { capped, SOURCE_LIMIT, type Source } from './common'

/**
 * Delivery addresses customers added in the portal that wait for our check (B-W2b-F13b on the wave-23 schema; design
 * portal.customer.neworder "Add a new address (waits for our approval)", home.approvals "every request that needs my yes"):
 * a WAITING, active address of a customer the viewer sees the orders of (orders.view over its company and party); whoever
 * takes its orders decides it (orders.manage: insights/attention's act). The row opens the customer's record (the check:
 * modules/sales/portal-ordering/address-check.ts). Oldest first; no order or shipment goes there until approved.
 */

export const deliveryAddress: Source = async ({ caller, viewer }) => {
  const scope = scopeWhere(viewer.actor, ORDERS_VIEW, PARTY_SCOPE) as Prisma.PartyWhereInput
  return caller.withClient(async (db) => {
    const found = await db.partyAddress.findMany({
      where: { approvalStatus: 'WAITING', status: 'ACTIVE', party: scope },
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      take: SOURCE_LIMIT + 1,
      select: { id: true, partyId: true, line1: true, postalCode: true, city: true, country: true, requestedAt: true, createdAt: true, party: { select: { code: true, legalName: true, companyId: true } } },
    })
    const { rows, complete } = capped(found, SOURCE_LIMIT)
    const candidates: AttentionCandidate[] = rows.map((row) => ({
      kind: 'DELIVERY_ADDRESS',
      state: 'WAITING',
      severity: 'MEDIUM',
      record: { type: 'Party', id: row.partyId, label: row.party.code },
      scope: { companyId: row.party.companyId, siteId: null, partyId: row.partyId },
      ...deliveryAddressWords({ customer: row.party.legalName, address: `${row.line1}, ${row.postalCode} ${row.city} (${row.country})` }),
      due: null,
      since: row.requestedAt ?? row.createdAt,
      // One row per address (a customer may add two).
      subKey: row.id,
    }))
    return { kind: 'DELIVERY_ADDRESS', candidates, complete }
  })
}
