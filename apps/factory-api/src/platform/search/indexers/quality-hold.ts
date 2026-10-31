import type { CommandTx } from '../../../core/command'
import { defineIndexer, idWhere, type RecordsOf } from '../indexer'

/**
 * Quality holds (modules/quality/holds; quality.holds.view; opens in Quality › Holds): by number (B-W2b-17's HOLD series;
 * a hold placed before has none: found by what it holds), the codes of the records it holds — lots, hides, work orders,
 * bundles, garment serials, shipments, parcels — and its NCR's number. Scope as the holds list: company and site. NEVER
 * who placed or released it (a worker, Statuto art. 4) and never the reason's words. Placed, changed, released, and closed
 * by its NCR re-read it.
 */
const holdOfNcr: RecordsOf = (event) => {
  const id = (event.payload as { holdId?: unknown } | null)?.holdId
  return typeof id === 'string' ? [id] : []
}

/** The codes shown first as the hold's name; the rest are among its words. */
const SHOWN = 3

type Held = { readonly subjectType: string; readonly subjectIds: readonly string[] }

/** The label of every record the holds name (`<type>:<id>` → its code), one query per kind of record. */
async function labelsOf(tx: CommandTx, holds: readonly Held[]): Promise<Map<string, string>> {
  const ids = (type: string) => [...new Set(holds.filter((hold) => hold.subjectType === type).flatMap((hold) => hold.subjectIds))]
  const labels = new Map<string, string>()
  const add = (type: string, rows: readonly { id: string; label: string }[]) => rows.forEach((row) => labels.set(`${type}:${row.id}`, row.label))
  // One query after another: `tx` is one transaction's connection.
  for (const type of new Set(holds.map((hold) => hold.subjectType))) {
    const wanted = ids(type)
    if (wanted.length === 0) continue
    const where = { id: { in: wanted } }
    switch (type) {
      case 'Lot':
        add(type, (await tx.lot.findMany({ where, select: { id: true, code: true } })).map((row) => ({ id: row.id, label: row.code })))
        break
      case 'Hide':
        add(type, (await tx.hide.findMany({ where, select: { id: true, code: true } })).map((row) => ({ id: row.id, label: row.code })))
        break
      case 'WorkOrder':
        add(type, (await tx.workOrder.findMany({ where, select: { id: true, number: true } })).map((row) => ({ id: row.id, label: row.number })))
        break
      case 'Bundle':
        add(type, (await tx.bundle.findMany({ where, select: { id: true, code: true } })).map((row) => ({ id: row.id, label: row.code })))
        break
      case 'GarmentSerial':
        add(type, (await tx.garmentSerial.findMany({ where, select: { id: true, serial: true } })).map((row) => ({ id: row.id, label: row.serial })))
        break
      case 'Shipment':
        add(type, (await tx.shipment.findMany({ where, select: { id: true, number: true } })).map((row) => ({ id: row.id, label: row.number })))
        break
      case 'Parcel':
        add(type, (await tx.parcel.findMany({ where, select: { id: true, seq: true, shipment: { select: { number: true } } } })).map((row) => ({ id: row.id, label: `${row.shipment.number}/${row.seq}` })))
        break
    }
  }
  return labels
}

export default defineIndexer({
  recordType: 'QualityHold',
  area: 'quality',
  viewPermission: 'quality.holds.view',
  on: {
    'quality.hold_placed': 'subject',
    'quality.hold_changed': 'subject',
    'quality.hold_released': 'subject',
    'ncr.hold_closed': holdOfNcr,
  },
  async read(tx, filter, take) {
    const rows = await tx.qualityHold.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, siteId: true, number: true, subjectType: true, subjectIds: true, status: true, ncr: { select: { number: true } } },
    })
    const labels = await labelsOf(tx, rows)
    return rows.map((row) => {
      // In the order the hold names them; a record gone since is left out.
      const held = row.subjectIds.map((id) => labels.get(`${row.subjectType}:${id}`)).filter((label): label is string => Boolean(label))
      return {
        recordId: row.id,
        companyId: row.companyId,
        siteId: row.siteId,
        partyId: null,
        number: row.number,
        title: [...held.slice(0, SHOWN), ...(held.length > SHOWN ? [`+${held.length - SHOWN}`] : [])].join(', '),
        subtitle: row.ncr?.number ?? null,
        // A hold in force is said as the Holds page says it ("On hold" / "Bloccato"), not as an active master record would be.
        status: row.status === 'ACTIVE' ? 'HELD' : row.status,
        words: held.slice(SHOWN),
      }
    })
  },
})
