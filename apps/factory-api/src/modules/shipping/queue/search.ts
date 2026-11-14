import type { Prisma } from '@nexus/factory-db'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDayRange, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { reasonsInForce } from '@nexus/factory-domain/shipping/holds/holds'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { cartonCodeOf, looksLikeSscc, matchRank, searchTerm, type SearchMatch } from '@nexus/factory-domain/shipping/queue/search'
import type { ShipmentStatus } from '@nexus/factory-domain/shipping/shipments'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf } from '../access'
import { factsOf, holdsInForceBy } from '../holds/store'

/**
 * Shipment search and its history (B-W2b-386; LOG-120; rules factory-domain shipping/queue/search). Office, shipping.view:
 * every shipment the reader's grants reach (any status), newest first, found by its number, its order's number, the
 * customer's PO, the customer, a tracking number (a label's or one typed by hand), a carton's marks code or a garment's
 * serial — each hit says what it matched by — and narrowed by site, status and the days it left (the history window). The
 * export of the history is platform/exports/sources/shipments-history.ts. No money.
 */

export interface SearchQuery {
  readonly q?: string | undefined
  readonly siteId?: string | undefined
  readonly status?: ShipmentStatus | undefined
  /** The days it left (Europe/Rome), both included. */
  readonly shippedFrom?: BusinessDate | undefined
  readonly shippedTo?: BusinessDate | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

const contains = (term: string) => ({ contains: term, mode: 'insensitive' as const })

/** The shipments matching the term (any of the ways it can be found). */
function matchWhere(term: string): Prisma.ShipmentWhereInput {
  const carton = cartonCodeOf(term)
  return {
    OR: [
      { number: contains(term) },
      { salesOrder: { number: contains(term) } },
      { salesOrder: { customerRef: contains(term) } },
      { salesOrder: { party: { legalName: contains(term) } } },
      { salesOrder: { party: { code: contains(term) } } },
      { parcels: { some: { trackingNumber: contains(term) } } },
      { manualTrackingNumber: contains(term) },
      { lines: { some: { serials: { some: { serial: { equals: term, mode: 'insensitive' } } } } } },
      ...(carton ? [{ number: { equals: carton.shipmentNumber, mode: 'insensitive' as const }, parcels: { some: { cartonNumber: carton.cartonNumber } } }] : []),
    ],
  }
}

export async function searchShipments(caller: CommandCaller, query: SearchQuery) {
  const context = officeContextOf(caller)
  const term = query.q === undefined || query.q.trim() === '' ? null : searchTerm(query.q)
  if (query.q !== undefined && query.q.trim() !== '' && term === null) throw new ValidationError('Type at least 2 characters to search.', [{ path: 'query/q', message: 'At least 2 characters.' }])
  const shipped: Prisma.DateTimeNullableFilter | null =
    query.shippedFrom || query.shippedTo
      ? { ...(query.shippedFrom ? { gte: businessDayRange(query.shippedFrom).start } : {}), ...(query.shippedTo ? { lt: businessDayRange(query.shippedTo).end } : {}) }
      : null
  const where: Prisma.ShipmentWhereInput = {
    AND: [
      scopeWhere(actorOf(context), SHIPPING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.ShipmentWhereInput,
      term ? matchWhere(term) : {},
      query.siteId ? { siteId: query.siteId } : {},
      query.status ? { status: query.status } : {},
      shipped ? { shippedAt: shipped } : {},
      query.cursor && isUuid(query.cursor) ? { id: { lt: query.cursor } } : {},
    ],
  }
  return caller.withClient(async (client) => {
    const rows = await client.shipment.findMany({
      where,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      select: {
        id: true,
        number: true,
        status: true,
        companyId: true,
        siteId: true,
        partyId: true,
        salesOrderId: true,
        transportBy: true,
        carrierCode: true,
        carrierName: true,
        serviceCode: true,
        manualTrackingNumber: true,
        splitFromId: true,
        splitReason: true,
        createdAt: true,
        packedAt: true,
        shippedAt: true,
        deliveredAt: true,
        returnedAt: true,
        cancelledAt: true,
        site: { select: { code: true } },
        splitFrom: { select: { number: true } },
        salesOrder: { select: { number: true, customerRef: true, party: { select: { code: true, legalName: true } } } },
        // The serials that matched (none read without a term).
        lines: { select: { quantity: true, serials: { where: term ? { serial: { equals: term, mode: 'insensitive' as const } } : { id: { in: [] } }, select: { serial: true } } } },
        parcels: { select: { seq: true, trackingNumber: true, cartonNumber: true }, orderBy: { seq: 'asc' } },
        ddts: { where: { cancellations: { none: {} } }, select: { number: true }, take: 1 },
      },
    })
    const page = rows.slice(0, query.limit)
    const holds = await holdsInForceBy(client, page.map((row) => row.id))
    const lower = term?.toLowerCase() ?? ''
    const carton = term ? cartonCodeOf(term) : null
    const has = (value: string | null | undefined) => !!value && value.toLowerCase().includes(lower)
    return {
      term,
      /** Kinds of numbers the term looks like that are not kept yet: an SSCC (pallet and carton SSCCs come later). */
      notKept: (term && looksLikeSscc(term) ? ['SSCC'] : []) as 'SSCC'[],
      shipments: page.map((row) => {
        const serials = row.lines.flatMap((line) => line.serials.map((serial) => serial.serial))
        const trackingNumbers = [...row.parcels.flatMap((parcel) => (parcel.trackingNumber ? [parcel.trackingNumber] : [])), ...(row.manualTrackingNumber ? [row.manualTrackingNumber] : [])]
        const matchedBy: SearchMatch[] = term
          ? (
              [
                has(row.number) ? 'NUMBER' : null,
                carton && row.number.toLowerCase() === carton.shipmentNumber.toLowerCase() && row.parcels.some((parcel) => parcel.cartonNumber === carton.cartonNumber) ? 'CARTON' : null,
                serials.length > 0 ? 'SERIAL' : null,
                trackingNumbers.some(has) ? 'TRACKING' : null,
                has(row.salesOrder.number) ? 'ORDER' : null,
                has(row.salesOrder.customerRef) ? 'CUSTOMER_PO' : null,
                has(row.salesOrder.party.legalName) || has(row.salesOrder.party.code) ? 'CUSTOMER' : null,
              ] as const
            )
              .filter((match): match is SearchMatch => match !== null)
              .sort((a, b) => matchRank(a) - matchRank(b))
          : []
        return {
          id: row.id,
          number: row.number,
          status: row.status,
          siteId: row.siteId,
          siteCode: row.site.code,
          salesOrderId: row.salesOrderId,
          salesOrderNumber: row.salesOrder.number,
          customerRef: row.salesOrder.customerRef,
          partyCode: row.salesOrder.party.code,
          partyName: row.salesOrder.party.legalName,
          transportBy: row.transportBy,
          carrierCode: row.carrierCode,
          carrierName: row.carrierName,
          serviceCode: row.serviceCode,
          trackingNumbers: trackingNumbers.slice(0, 5),
          parcels: row.parcels.length,
          garments: row.lines.reduce((sum, line) => sum + line.quantity, 0),
          ddtNumber: row.ddts[0]?.number ?? null,
          splitFrom: row.splitFromId ? { id: row.splitFromId, number: row.splitFrom?.number ?? '', reason: row.splitReason } : null,
          holdReasons: reasonsInForce((holds.get(row.id) ?? []).map(factsOf)),
          createdAt: toUtcIso(row.createdAt),
          packedAt: row.packedAt ? toUtcIso(row.packedAt) : null,
          shippedAt: row.shippedAt ? toUtcIso(row.shippedAt) : null,
          deliveredAt: row.deliveredAt ? toUtcIso(row.deliveredAt) : null,
          returnedAt: row.returnedAt ? toUtcIso(row.returnedAt) : null,
          cancelledAt: row.cancelledAt ? toUtcIso(row.cancelledAt) : null,
          matchedBy,
          matchedSerials: serials.slice(0, 10),
        }
      }),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    }
  })
}
export type SearchRow = Awaited<ReturnType<typeof searchShipments>>['shipments'][number]
