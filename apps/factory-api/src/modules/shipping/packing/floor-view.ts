import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { PACKAGING_KINDS } from '@nexus/factory-domain/shipping/packaging/rules'
import { SHIPPING_PACK } from '@nexus/factory-domain/shipping/permissions'
import type { CommandCaller } from '../../../core/command'
import { mayOn, shippingContextOf } from '../access'
import { benchView } from '../cartons/store'
import { SHIPMENT_HEADER } from '../store'
import { statusSchema } from '../views'

/**
 * The floor's view of one carton (B-W2b-387; design floor.scan "What you scanned": "Carton (W2b)", LOG-019): the code its
 * shipping marks carry (`<shipment number>-<carton number>`, factory-domain shipping/cartons/marks cartonMarkCode) scanned
 * on Scan anything — or at the packing bench — answers the carton as a packer needs it: its shipment's number and state,
 * "Carton 2 of 3" (or open), its packaging, its weights, its garments by style, colour and size with their batch (the lot)
 * and how many serials. Never a customer, an order, an address, a serial number or money: the floor reads none.
 *
 * Office and floor (shipping.pack, as the bench): a floor device finds only its own site's shipments (row-level security,
 * and can() pins the site); the office within its grants, its company first. Nothing matches → 404.
 */

/** A carton's marks code: the shipment's number, a hyphen, the carton's number (1 to 99). */
const MARKS_CODE = /^(.+)-(\d{1,2})$/

/** The shipment number and the carton number a marks code names, or null. Exported for the tests. */
export function cartonCodeParts(code: string): { readonly number: string; readonly seq: number } | null {
  const match = MARKS_CODE.exec(code.trim())
  if (!match) return null
  const seq = Number.parseInt(match[2]!, 10)
  return seq >= 1 ? { number: match[1]!, seq } : null
}

export const cartonScanContract = defineContract({
  querystring: input({ code: z.string().trim().min(3).max(80) }),
  response: {
    200: output({
      carton: output({
        shipmentId: id(),
        shipmentNumber: z.string(),
        shipmentStatus: statusSchema,
        /** The hold in force on the shipment (its reason code; the floor words it), or null. */
        hold: output({ reason: z.string() }).nullable(),
        id: id(),
        seq: z.number().int(),
        closed: z.boolean(),
        cartonNumber: z.number().int().nullable(),
        cartonCount: z.number().int().nullable(),
        /** The shipment's cartons now (the "of N" of an open carton). */
        cartons: z.number().int(),
        marksCurrent: z.boolean(),
        labelled: z.boolean(),
        packagingType: output({ name: z.string(), kind: z.enum(PACKAGING_KINDS) }).nullable(),
        grossWeightKg: z.string().nullable(),
        netWeightKg: z.string().nullable(),
        garments: z.number().int(),
        contents: z.array(
          output({
            styleCode: z.string(),
            styleName: z.string(),
            colourwayCode: z.string(),
            colourwayName: z.string(),
            size: z.string(),
            quantity: z.number().int(),
            /** The lot of the garments: their work order's batch number. */
            batchNumber: z.string().nullable(),
            serials: z.number().int(),
          }),
        ),
      }),
    }),
  },
})

/** shipping.pack: the carton whose marks carry `code`, as the floor sees it. */
export async function cartonOfCode(caller: CommandCaller, code: string) {
  const context = shippingContextOf(caller)
  const parts = cartonCodeParts(code)
  if (!parts) throw new NotFoundError('No carton has this code.')
  const numbers = [...new Set([parts.number, parts.number.toUpperCase()])]
  const candidates = await caller.withClient((client) => client.shipment.findMany({ where: { number: { in: numbers } }, select: SHIPMENT_HEADER, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }))
  // A company numbers its own shipments: the same number can be another company's. The floor's own site, the office's company first.
  const own = context.audience === 'floor' ? context.siteId : (context.companyId ?? null)
  const visible = candidates.filter((shipment) => mayOn(context, SHIPPING_PACK, shipment))
  const shipment = visible.find((entry) => entry.siteId === own || entry.companyId === own) ?? visible[0]
  if (!shipment) throw new NotFoundError('No carton has this code.')
  const bench = await caller.withClient((client) => benchView(client, shipment))
  const carton = bench.cartons.find((entry) => entry.seq === parts.seq)
  if (!carton) throw new NotFoundError('No carton has this code.')
  return {
    carton: {
      shipmentId: shipment.id,
      shipmentNumber: shipment.number,
      shipmentStatus: shipment.status,
      hold: bench.hold ? { reason: bench.hold.reason } : null,
      id: carton.id,
      seq: carton.seq,
      closed: carton.closed,
      cartonNumber: carton.cartonNumber,
      cartonCount: carton.cartonCount,
      cartons: bench.cartons.length,
      marksCurrent: carton.marksCurrent,
      labelled: carton.labelled,
      packagingType: carton.packagingType ? { name: carton.packagingType.name, kind: carton.packagingType.kind } : null,
      grossWeightKg: carton.grossWeightKg,
      netWeightKg: carton.netWeightKg,
      garments: carton.garments,
      contents: carton.contents.map((content) => ({
        styleCode: content.styleCode,
        styleName: content.styleName,
        colourwayCode: content.colourwayCode,
        colourwayName: content.colourwayName,
        size: content.size,
        quantity: content.quantity,
        batchNumber: content.batchNumber,
        serials: content.serials.length,
      })),
    },
  }
}
