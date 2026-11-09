import { definePartnerView, equalsTyped, holdsTyped, idsOf } from '../view'

/**
 * A customer's returns (RMAs; modules/sales/returns, asked from the portal or a claim link by modules/sales/portal-returns;
 * the index's ../../indexers/return-authorisation.ts): their own reference first, our RMA number second, the day it was
 * asked and its status. Read as the partner role reads it (W2b schema wave 23): never the internal note, the owner or who
 * in the office authorised it; never an amount. B-W2b-197: the return's Messages tab in the portal (its thread) and the
 * portal search's Returns group.
 */
export default definePartnerView({
  recordType: 'ReturnAuthorisation',
  group: 'returns',
  kinds: ['CUSTOMER'],
  async read(client, ids) {
    const rows = await client.returnAuthorisation.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, companyId: true, number: true, customerRef: true, status: true, requestedAt: true },
    })
    return rows.map((row) => ({ id: row.id, companyId: row.companyId, theirRef: row.customerRef, ourRef: row.number, subtitle: null, status: row.status, date: row.requestedAt, words: [] }))
  },
  async lookup(client, typed, take) {
    return idsOf(await client.returnAuthorisation.findMany({ where: { OR: [{ number: equalsTyped(typed) }, { customerRef: holdsTyped(typed) }] }, select: { id: true }, orderBy: { requestedAt: 'desc' }, take }))
  },
})
