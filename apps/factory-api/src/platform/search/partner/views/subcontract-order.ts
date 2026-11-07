import { definePartnerView, equalsTyped, idsOf } from '../view'

/**
 * A workshop's jobs (subcontract orders; modules/purchasing/subcontracting; the index's ../../indexers/subcontract-order.ts),
 * once issued to it: our job number, the order date and status. NEVER the fee or an amount (Owner answer C2), the internal
 * note or who in the office issued or decided. The workshop has no reference of its own on a job yet.
 */
const ISSUED = { issuedAt: { not: null } } as const

export default definePartnerView({
  recordType: 'SubcontractOrder',
  group: 'jobs',
  kinds: ['SUBCONTRACTOR'],
  async read(client, ids) {
    const rows = await client.subcontractOrder.findMany({
      where: { id: { in: [...ids] }, ...ISSUED },
      select: { id: true, companyId: true, number: true, status: true, orderDate: true },
    })
    return rows.map((row) => ({ id: row.id, companyId: row.companyId, theirRef: null, ourRef: row.number, subtitle: null, status: row.status, date: row.orderDate, words: [] }))
  },
  async lookup(client, typed, take) {
    return idsOf(await client.subcontractOrder.findMany({ where: { ...ISSUED, number: equalsTyped(typed) }, select: { id: true }, orderBy: { orderDate: 'desc' }, take }))
  },
})
