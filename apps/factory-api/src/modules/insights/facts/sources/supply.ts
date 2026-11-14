import type { Prisma } from '@nexus/factory-db'
import { daysFrom, eachDay } from '@nexus/factory-domain/calendars/dates'
import type { WhereClause } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange, type BusinessDate } from '@nexus/factory-domain/core/time'
import { measureOf } from '@nexus/factory-domain/insights/kpis/measures'
import { receivedOnTime, supplierDueOf } from '@nexus/factory-domain/insights/kpis/supplier-on-time'
import { numberOf, type DayFact, type Reader, type Source } from '../rows'

/**
 * The supply source (B-W2b-429; ANA-023; measures purchasing.lines_received and purchasing.lines_on_time; rules factory-domain
 * insights/kpis/supplier-on-time.ts): the goods receipt lines against a purchase order line of the receipts POSTED at each site
 * (a reversed receipt no longer counts: what stands now), by the day they were posted on the site's clock, and those posted
 * by the line's confirmed date (else the date it was needed by). One row per measure, site and day, zeros included.
 * `readSupplyLines` is also the drill's read (kpis/drills/supply.ts).
 */

const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)

export interface SupplyLine {
  readonly receiptLineId: string
  readonly siteId: string
  readonly receipt: { readonly id: string; readonly number: string }
  readonly postedDay: BusinessDate
  readonly purchaseOrder: { readonly id: string; readonly number: string }
  readonly purchaseOrderLineId: string
  readonly seq: number
  readonly supplierId: string
  readonly itemId: string
  readonly category: string
  readonly due: BusinessDate
  readonly onTime: boolean
  /** Days after its due day it was posted (0 on time). */
  readonly lateDays: number
}

/**
 * The receipt lines posted at some sites between two days on each site's clock. `where` is a reader's own scope on the
 * purchase order (company and supplier); `extra` the drill's filters on the purchase order line.
 */
export async function readSupplyLines(db: Reader, input: { readonly sites: readonly { readonly id: string; readonly timezone: string }[]; readonly from: BusinessDate; readonly to: BusinessDate; readonly where?: WhereClause | undefined; readonly extra?: Prisma.PurchaseOrderLineWhereInput }): Promise<SupplyLine[]> {
  const out: SupplyLine[] = []
  for (const site of input.sites) {
    const rows = await db.goodsReceiptLine.findMany({
      where: {
        siteId: site.id,
        receipt: { status: 'POSTED', postedAt: { gte: businessDayRange(input.from, site.timezone).start, lt: businessDayRange(input.to, site.timezone).end } },
        purchaseOrderLine: { AND: [{ purchaseOrder: (input.where ?? {}) as Prisma.PurchaseOrderWhereInput }, input.extra ?? {}] },
      },
      select: {
        id: true,
        receipt: { select: { id: true, number: true, postedAt: true } },
        purchaseOrderLine: { select: { id: true, seq: true, needDate: true, confirmedDate: true, partyId: true, itemId: true, item: { select: { kind: true } }, purchaseOrder: { select: { id: true, number: true } } } },
      },
      orderBy: [{ receiptId: 'asc' }, { seq: 'asc' }, { id: 'asc' }],
    })
    for (const row of rows) {
      const line = row.purchaseOrderLine
      if (!line || !row.receipt.postedAt) continue
      const postedDay = businessDate(row.receipt.postedAt, site.timezone)
      const due = supplierDueOf({ confirmedDate: line.confirmedDate ? dayOf(line.confirmedDate) : null, needDate: dayOf(line.needDate) })
      const onTime = receivedOnTime(postedDay, due)
      out.push({
        receiptLineId: row.id,
        siteId: site.id,
        receipt: { id: row.receipt.id, number: row.receipt.number },
        postedDay,
        purchaseOrder: { id: line.purchaseOrder.id, number: line.purchaseOrder.number },
        purchaseOrderLineId: line.id,
        seq: line.seq,
        supplierId: line.partyId,
        itemId: line.itemId,
        category: line.item.kind,
        due,
        onTime,
        lateDays: onTime ? 0 : daysFrom(due, postedDay),
      })
    }
  }
  return out
}

export const supplySource: Source = async (db, { company, from, to, now, where }) => {
  const daily: DayFact[] = []
  const received = measureOf('purchasing.lines_received')!
  const onTime = measureOf('purchasing.lines_on_time')!
  for (const site of company.sites) {
    const today = businessDate(now, site.timezone)
    const last = to < today ? to : today
    if (last < from) continue
    const lines = await readSupplyLines(db, { sites: [site], from, to: last, where })
    for (const day of eachDay(from, last)) {
      const mine = lines.filter((line) => line.postedDay === day)
      daily.push({ companyId: company.id, siteId: site.id, lineId: null, day, measureKey: received.key, number: numberOf(received, mine.length) })
      daily.push({ companyId: company.id, siteId: site.id, lineId: null, day, measureKey: onTime.key, number: numberOf(onTime, mine.filter((line) => line.onTime).length) })
    }
  }
  return { daily, hourly: [] }
}
