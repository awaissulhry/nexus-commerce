import { definePartnerView, equalsTyped, holdsTyped, idsOf } from '../view'

/**
 * A customer's quality complaints (modules/quality/complaints, reported from the portal or a claim link by
 * modules/sales/portal-returns; the index's ../../indexers/complaint.ts): their own reference first, our complaint number
 * second, the day we received it and its status; the serial they reported may be typed. Read as the partner role reads it
 * (W2b schema wave 23): never the triage, the findings, the root cause, the letter while it is written, the internal note
 * or who in the office did what. B-W2b-197: the complaint's Messages tab in the portal (its thread) and the portal search's
 * Returns group.
 */
export default definePartnerView({
  recordType: 'Complaint',
  group: 'returns',
  kinds: ['CUSTOMER'],
  async read(client, ids) {
    const rows = await client.complaint.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, companyId: true, number: true, customerRef: true, status: true, receivedAt: true, serial: true },
    })
    return rows.map((row) => ({ id: row.id, companyId: row.companyId, theirRef: row.customerRef, ourRef: row.number, subtitle: null, status: row.status, date: row.receivedAt, words: [row.serial] }))
  },
  async lookup(client, typed, take) {
    return idsOf(await client.complaint.findMany({ where: { OR: [{ number: equalsTyped(typed) }, { customerRef: holdsTyped(typed) }, { serial: equalsTyped(typed) }] }, select: { id: true }, orderBy: { receivedAt: 'desc' }, take }))
  },
})
