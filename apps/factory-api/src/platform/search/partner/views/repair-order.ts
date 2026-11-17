import { definePartnerView, equalsTyped, holdsTyped, idsOf } from '../view'

/**
 * B-TH-081 (threads plan TH-6, N12; O-SAL-REP.thread, P-CUS-REP.thread; walls W09, W14): a customer's repairs and alterations
 * (modules/sales/repairs, asked from the portal or a claim link by modules/sales/repairs-depth; the index's
 * ../../indexers/repair-order.ts) — so the portal's repair page has its thread (GET /portal/threads/RepairOrder/<id>, the same
 * conversation the office answers on the repair's page) and the portal search finds a repair in its Returns group.
 *
 * Read as the partner role reads a repair (W2b schema wave 43/44: its own party's rows only): our repair number, the garment's serial
 * as read from its label (or the serial of our garment), its stage and the day it was opened; their own DDT number may be typed. Never
 * the internal note, the owner, who checked the PPE garment or who made it (hidden columns, never selected), never an estimate or
 * an amount. A repair of another customer is not there to read (404 at the thread, no search hit).
 */
export default definePartnerView({
  recordType: 'RepairOrder',
  group: 'returns',
  kinds: ['CUSTOMER'],
  async read(client, ids) {
    const rows = await client.repairOrder.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, companyId: true, number: true, serial: true, garmentSerial: true, inboundDdtNumber: true, stage: true, createdAt: true },
    })
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      theirRef: null,
      ourRef: row.number,
      subtitle: row.serial ?? row.garmentSerial,
      status: row.stage,
      date: row.createdAt,
      words: [row.serial, row.garmentSerial, row.inboundDdtNumber],
    }))
  },
  async lookup(client, typed, take) {
    return idsOf(
      await client.repairOrder.findMany({
        where: { OR: [{ number: equalsTyped(typed) }, { serial: equalsTyped(typed) }, { garmentSerial: equalsTyped(typed) }, { inboundDdtNumber: holdsTyped(typed) }] },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
        take,
      }),
    )
  },
})
