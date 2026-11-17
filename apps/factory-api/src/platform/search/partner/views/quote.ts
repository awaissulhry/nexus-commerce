import { customerRefOf } from '@nexus/factory-domain/sales/customer-numbers'
import { definePartnerView, equalsTyped, holdsTyped, idsOf } from '../view'

/**
 * A customer's quotes (modules/sales/quotes; the index's ../../indexers/quote.ts), once a version of it was sent to them
 * (a quote being drafted is the office's): their reference first, our number second, when the newest version was sent.
 * Never the lost reason, the internal note, a cost or a margin. th2-backend step 7 (threads plan §0.5): "ours" is the customer's
 * OWN quote number ("#3"); the office's QT-… number is only matched (it is printed on the quote the customer holds), never shown.
 */
const SENT = { versions: { some: { sentAt: { not: null } } } } as const

export default definePartnerView({
  recordType: 'Quote',
  group: 'orders',
  kinds: ['CUSTOMER'],
  async read(client, ids) {
    const rows = await client.quote.findMany({
      where: { id: { in: [...ids] }, ...SENT },
      select: { id: true, companyId: true, number: true, customerRef: true, customerSeq: true, status: true, versions: { where: { sentAt: { not: null } }, orderBy: { sentAt: 'desc' }, take: 1, select: { sentAt: true } } },
    })
    return rows.map((row) => ({ id: row.id, companyId: row.companyId, theirRef: row.customerRef, ourRef: customerRefOf('QUOTE', row.customerSeq), subtitle: null, status: row.status, date: row.versions[0]?.sentAt ?? null, words: [row.number] }))
  },
  async lookup(client, typed, take) {
    return idsOf(await client.quote.findMany({ where: { ...SENT, OR: [{ number: equalsTyped(typed) }, { customerRef: holdsTyped(typed) }] }, select: { id: true }, orderBy: { createdAt: 'desc' }, take }))
  },
})
