import type { RegisterConcern } from './rules'

/**
 * The trace of a register entry (B-W1-43; A2 compliance.register "Affected units"; Reg. (EU) 2016/425 art. 8(4), 8(8)):
 * from what the entry names — batch numbers, serials, material lots, work orders — to the work orders and their cells
 * (colourway × size), what was released, packed and shipped, the shipments with their live DDTs, and the customers that
 * got the garments. A recall must find them; the distributors to keep informed are those customers.
 *
 * Pure: apps/factory-api's modules/compliance/register/trace.ts reads the rows (only the entry's company) and calls
 * buildTrace. No cost, price, margin or wage is read or shown.
 *
 * Reach: a work order found by its batch number, by a lot issued to it or named directly concerns ALL its garments
 * (WHOLE); one found only through serials or named shipments concerns just PART of them: the named serials, and the
 * garments of its lines on the named shipments.
 */

/** Shipments that left: the garments are with the customer (B-W1-51's "shipped": SHIPPED or DELIVERED). */
export const LEFT_STATUSES = ['SHIPPED', 'DELIVERED'] as const
/** Shipments that hold garments but have not left yet. */
export const PACKING_STATUSES = ['DRAFT', 'PACKED'] as const

export type TraceVia = 'BATCH' | 'SERIAL' | 'LOT' | 'WORK_ORDER' | 'SHIPMENT'
const VIA_ORDER: readonly TraceVia[] = ['BATCH', 'SERIAL', 'LOT', 'WORK_ORDER', 'SHIPMENT']
/** The ways that reach every garment of a work order. */
const WHOLE_VIA: readonly TraceVia[] = ['BATCH', 'LOT', 'WORK_ORDER']

export interface TraceWorkOrderRow {
  readonly id: string
  readonly number: string
  readonly batchNumber: string | null
  readonly styleId: string
  readonly styleCode: string
  /** The frozen style revision's number, when released. */
  readonly revision: number | null
  readonly status: string
}

export interface TraceSerialRow {
  readonly serial: string
  readonly status: string
  readonly workOrderId: string
  readonly workOrderSizeId: string
  readonly shipmentLineId: string | null
}

export interface TraceLotIssueRow {
  readonly lotId: string
  readonly workOrderId: string
}

export interface TraceCellRow {
  readonly id: string
  readonly workOrderId: string
  readonly colourwayCode: string
  readonly size: string
  /** Garments the cell makes. */
  readonly quantity: number
}

export interface TraceQuantityRow {
  readonly workOrderSizeId: string
  readonly quantity: number
}

export interface TraceLineRow {
  readonly id: string
  readonly shipmentId: string
  readonly workOrderId: string
  readonly workOrderSizeId: string
  readonly quantity: number
}

export interface TraceShipmentRow {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly shippedAt: string | null
  readonly deliveredAt: string | null
  readonly partyId: string
  /** Its live (not cancelled) DDTs' numbers. */
  readonly ddtNumbers: readonly string[]
}

export interface TracePartyRow {
  readonly id: string
  readonly code: string
  readonly name: string
}

export interface TraceLotRow {
  readonly id: string
  readonly code: string
}

/** Everything buildTrace needs, as read by the API (only the entry's company's rows). */
export interface TraceInput {
  readonly concern: Pick<RegisterConcern, 'styleId' | 'batchNumbers' | 'serials' | 'lotIds' | 'workOrderIds' | 'shipmentIds'>
  /** Every work order found by any route (batch, serial, lot, id), whatever its style. */
  readonly workOrders: readonly TraceWorkOrderRow[]
  /** The serials found (by their serial text). */
  readonly serials: readonly TraceSerialRow[]
  /** The lots found (by id). */
  readonly lots: readonly TraceLotRow[]
  /** The lots' ISSUE moves to work orders that were not reversed. */
  readonly lotIssues: readonly TraceLotIssueRow[]
  readonly cells: readonly TraceCellRow[]
  /** Released garments per cell (releases), and reversed ones (reversals). */
  readonly released: readonly TraceQuantityRow[]
  readonly reversed: readonly TraceQuantityRow[]
  /** The shipment lines of the cells (any shipment but cancelled ones), the named shipments' lines among them. */
  readonly lines: readonly TraceLineRow[]
  /** The lines' shipments and the named ones. */
  readonly shipments: readonly TraceShipmentRow[]
  readonly parties: readonly TracePartyRow[]
}

export interface TraceSerialView {
  readonly serial: string
  readonly status: string
  readonly shipmentId: string | null
  readonly shipmentNumber: string | null
}

export interface TraceCellView {
  readonly workOrderSizeId: string
  readonly colourwayCode: string
  readonly size: string
  /** Garments the cell makes. */
  readonly pieces: number
  /** The garments of it the entry concerns: the cell's pieces, or the named serials. */
  readonly concerned: number
  /** Released less reversed (the whole cell). */
  readonly released: number
  /** Concerned garments on shipments not left yet (DRAFT, PACKED), that left (SHIPPED, DELIVERED), that came back (RETURNED). */
  readonly packed: number
  readonly shipped: number
  readonly returned: number
  /** The named serials of this cell (part reach). */
  readonly serials: TraceSerialView[]
}

export interface TraceWorkOrderView {
  readonly id: string
  readonly number: string
  readonly batchNumber: string | null
  readonly styleId: string
  readonly styleCode: string
  readonly revision: number | null
  readonly status: string
  readonly reach: 'WHOLE' | 'PART'
  readonly via: TraceVia[]
  readonly cells: TraceCellView[]
}

export interface TraceShipmentView {
  readonly id: string
  readonly number: string
  readonly status: string
  /** It left: the garments are with the customer. */
  readonly left: boolean
  readonly shippedAt: string | null
  readonly deliveredAt: string | null
  readonly partyId: string
  readonly partyCode: string
  readonly partyName: string
  readonly ddtNumbers: string[]
  /** Concerned garments on it. */
  readonly garments: number
  readonly workOrderNumbers: string[]
}

export interface TraceCustomerView {
  readonly partyId: string
  readonly code: string
  readonly name: string
  /** Concerned garments that reached them, and on which shipments (numbers). */
  readonly garments: number
  readonly shipmentNumbers: string[]
  readonly ddtNumbers: string[]
}

export interface TraceLotView {
  readonly id: string
  readonly code: string
  readonly workOrderNumbers: string[]
}

export interface TraceProblem {
  readonly path: string
  readonly code:
    | 'UNKNOWN_BATCH'
    | 'OTHER_STYLE_BATCH'
    | 'UNKNOWN_SERIAL'
    | 'OTHER_STYLE_SERIAL'
    | 'UNKNOWN_LOT'
    | 'LOT_NOT_ISSUED'
    | 'LOT_OTHER_STYLE'
    | 'UNKNOWN_WORK_ORDER'
    | 'OTHER_STYLE_WORK_ORDER'
    | 'UNKNOWN_SHIPMENT'
    | 'SHIPMENT_OTHER_STYLE'
  readonly message: string
}

export interface TraceView {
  readonly workOrders: TraceWorkOrderView[]
  readonly lots: TraceLotView[]
  readonly shipments: TraceShipmentView[]
  readonly customers: TraceCustomerView[]
  readonly counts: {
    readonly workOrders: number
    readonly concerned: number
    readonly released: number
    readonly packed: number
    readonly shipped: number
    readonly returned: number
    readonly customers: number
  }
  /** Concerned garments have left for customers: the distributors must be kept informed. */
  readonly shippedGoods: boolean
  /** What the entry names but the trace could not follow, in plain words (the entry keeps what was reported). */
  readonly problems: TraceProblem[]
}

const byNumber = <Row extends { number: string; id: string }>(a: Row, b: Row): number => a.number.localeCompare(b.number) || a.id.localeCompare(b.id)
const sum = (rows: readonly TraceQuantityRow[]): Map<string, number> => {
  const out = new Map<string, number>()
  for (const row of rows) out.set(row.workOrderSizeId, (out.get(row.workOrderSizeId) ?? 0) + row.quantity)
  return out
}
const isLeft = (status: string): boolean => (LEFT_STATUSES as readonly string[]).includes(status)
const isPacking = (status: string): boolean => (PACKING_STATUSES as readonly string[]).includes(status)

/** The trace, from the rows the API read. */
export function buildTrace(input: TraceInput): TraceView {
  const { concern } = input
  const problems: TraceProblem[] = []
  const workOrderById = new Map(input.workOrders.map((row) => [row.id, row]))
  const sameStyle = (row: TraceWorkOrderRow): boolean => row.styleId === concern.styleId

  // Which work orders the entry reaches, how, and how far.
  const via = new Map<string, Set<TraceVia>>()
  const reach = (workOrderId: string, how: TraceVia): void => {
    const set = via.get(workOrderId) ?? new Set<TraceVia>()
    set.add(how)
    via.set(workOrderId, set)
  }
  concern.batchNumbers.forEach((batch, index) => {
    const row = input.workOrders.find((candidate) => candidate.batchNumber === batch)
    const path = `concern/batchNumbers/${index}`
    if (!row) problems.push({ path, code: 'UNKNOWN_BATCH', message: `No work order of this company has batch ${batch}.` })
    else if (!sameStyle(row)) problems.push({ path, code: 'OTHER_STYLE_BATCH', message: `Batch ${batch} (work order ${row.number}) is of style ${row.styleCode}, not of this entry's style.` })
    else reach(row.id, 'BATCH')
  })
  const serialByText = new Map(input.serials.map((row) => [row.serial, row]))
  const namedSerials: TraceSerialRow[] = []
  concern.serials.forEach((serial, index) => {
    const row = serialByText.get(serial)
    const workOrder = row ? workOrderById.get(row.workOrderId) : undefined
    const path = `concern/serials/${index}`
    if (!row || !workOrder) problems.push({ path, code: 'UNKNOWN_SERIAL', message: `No garment of this company has serial ${serial}.` })
    else if (!sameStyle(workOrder)) problems.push({ path, code: 'OTHER_STYLE_SERIAL', message: `Serial ${serial} is a garment of style ${workOrder.styleCode}, not of this entry's style.` })
    else {
      reach(workOrder.id, 'SERIAL')
      namedSerials.push(row)
    }
  })
  const lotById = new Map(input.lots.map((row) => [row.id, row]))
  const lotWorkOrders = new Map<string, Set<string>>()
  concern.lotIds.forEach((lotId, index) => {
    const lot = lotById.get(lotId)
    const path = `concern/lotIds/${index}`
    if (!lot) {
      problems.push({ path, code: 'UNKNOWN_LOT', message: 'No material lot of this company has this id.' })
      return
    }
    const issued = input.lotIssues.filter((row) => row.lotId === lotId).map((row) => workOrderById.get(row.workOrderId)).filter((row): row is TraceWorkOrderRow => row !== undefined)
    const ofStyle = issued.filter(sameStyle)
    if (issued.length === 0) problems.push({ path, code: 'LOT_NOT_ISSUED', message: `Lot ${lot.code} was not issued to any work order.` })
    else if (ofStyle.length === 0) problems.push({ path, code: 'LOT_OTHER_STYLE', message: `Lot ${lot.code} went only into work orders of other styles (${[...new Set(issued.map((row) => row.number))].sort().join(', ')}).` })
    const set = new Set<string>()
    for (const row of ofStyle) {
      reach(row.id, 'LOT')
      set.add(row.id)
    }
    lotWorkOrders.set(lotId, set)
  })
  concern.workOrderIds.forEach((workOrderId, index) => {
    const row = workOrderById.get(workOrderId)
    const path = `concern/workOrderIds/${index}`
    if (!row) problems.push({ path, code: 'UNKNOWN_WORK_ORDER', message: 'No work order of this company has this id.' })
    else if (!sameStyle(row)) problems.push({ path, code: 'OTHER_STYLE_WORK_ORDER', message: `Work order ${row.number} is of style ${row.styleCode}, not of this entry's style.` })
    else reach(row.id, 'WORK_ORDER')
  })
  const shipmentById = new Map(input.shipments.map((row) => [row.id, row]))
  const namedShipments = new Set(concern.shipmentIds)
  concern.shipmentIds.forEach((shipmentId, index) => {
    const shipment = shipmentById.get(shipmentId)
    const path = `concern/shipmentIds/${index}`
    if (!shipment) {
      problems.push({ path, code: 'UNKNOWN_SHIPMENT', message: 'No shipment of this company has this id.' })
      return
    }
    const held = input.lines.filter((line) => line.shipmentId === shipmentId).map((line) => workOrderById.get(line.workOrderId)).filter((row): row is TraceWorkOrderRow => row !== undefined && sameStyle(row))
    if (held.length === 0) problems.push({ path, code: 'SHIPMENT_OTHER_STYLE', message: `Shipment ${shipment.number} holds no garment of this entry's style.` })
    for (const row of held) reach(row.id, 'SHIPMENT')
  })

  const whole = (workOrderId: string): boolean => [...(via.get(workOrderId) ?? [])].some((how) => WHOLE_VIA.includes(how))
  const releasedByCell = sum(input.released)
  const reversedByCell = sum(input.reversed)
  const lineById = new Map(input.lines.map((row) => [row.id, row]))
  const serialsByLine = new Map<string, number>()
  for (const serial of namedSerials) {
    if (serial.shipmentLineId) serialsByLine.set(serial.shipmentLineId, (serialsByLine.get(serial.shipmentLineId) ?? 0) + 1)
  }

  // The concerned garments on each line: the whole line for a whole work order or a named shipment, else the named
  // serials it holds.
  const concernedOnLine = (line: TraceLineRow): number =>
    whole(line.workOrderId) || namedShipments.has(line.shipmentId) ? line.quantity : (serialsByLine.get(line.id) ?? 0)
  const onNamedShipment = (shipmentLineId: string | null): boolean => {
    const line = shipmentLineId ? lineById.get(shipmentLineId) : undefined
    return line !== undefined && namedShipments.has(line.shipmentId)
  }
  const relevantLines = input.lines.filter((line) => via.has(line.workOrderId) && shipmentById.has(line.shipmentId) && concernedOnLine(line) > 0)

  const workOrders: TraceWorkOrderView[] = [...via.keys()]
    .map((id) => workOrderById.get(id)!)
    .sort(byNumber)
    .map((workOrder) => {
      const isWhole = whole(workOrder.id)
      const partCells = new Set([
        ...namedSerials.filter((serial) => serial.workOrderId === workOrder.id).map((serial) => serial.workOrderSizeId),
        ...input.lines.filter((line) => line.workOrderId === workOrder.id && namedShipments.has(line.shipmentId)).map((line) => line.workOrderSizeId),
      ])
      const cells = input.cells
        .filter((cell) => cell.workOrderId === workOrder.id && (isWhole || partCells.has(cell.id)))
        .sort((a, b) => a.colourwayCode.localeCompare(b.colourwayCode) || a.size.localeCompare(b.size, undefined, { numeric: true }) || a.id.localeCompare(b.id))
        .map((cell): TraceCellView => {
          const cellSerials = namedSerials.filter((serial) => serial.workOrderSizeId === cell.id).sort((a, b) => a.serial.localeCompare(b.serial))
          let packed = 0
          let shipped = 0
          let returned = 0
          for (const line of relevantLines) {
            if (line.workOrderSizeId !== cell.id) continue
            const status = shipmentById.get(line.shipmentId)!.status
            const garments = concernedOnLine(line)
            if (isLeft(status)) shipped += garments
            else if (isPacking(status)) packed += garments
            else if (status === 'RETURNED') returned += garments
          }
          return {
            workOrderSizeId: cell.id,
            colourwayCode: cell.colourwayCode,
            size: cell.size,
            pieces: cell.quantity,
            concerned: isWhole
              ? cell.quantity
              : input.lines.filter((line) => line.workOrderSizeId === cell.id && namedShipments.has(line.shipmentId)).reduce((acc, line) => acc + line.quantity, 0) +
                cellSerials.filter((serial) => !onNamedShipment(serial.shipmentLineId)).length,
            released: (releasedByCell.get(cell.id) ?? 0) - (reversedByCell.get(cell.id) ?? 0),
            packed,
            shipped,
            returned,
            serials: isWhole
              ? []
              : cellSerials.map((serial) => {
                  const line = serial.shipmentLineId ? lineById.get(serial.shipmentLineId) : undefined
                  const shipment = line ? shipmentById.get(line.shipmentId) : undefined
                  return { serial: serial.serial, status: serial.status, shipmentId: shipment?.id ?? null, shipmentNumber: shipment?.number ?? null }
                }),
          }
        })
      return {
        id: workOrder.id,
        number: workOrder.number,
        batchNumber: workOrder.batchNumber,
        styleId: workOrder.styleId,
        styleCode: workOrder.styleCode,
        revision: workOrder.revision,
        status: workOrder.status,
        reach: isWhole ? 'WHOLE' : 'PART',
        via: VIA_ORDER.filter((how) => via.get(workOrder.id)!.has(how)),
        cells,
      }
    })

  const partyById = new Map(input.parties.map((row) => [row.id, row]))
  const shipmentGarments = new Map<string, { garments: number; workOrders: Set<string> }>()
  for (const line of relevantLines) {
    const entry = shipmentGarments.get(line.shipmentId) ?? { garments: 0, workOrders: new Set<string>() }
    entry.garments += concernedOnLine(line)
    entry.workOrders.add(workOrderById.get(line.workOrderId)!.number)
    shipmentGarments.set(line.shipmentId, entry)
  }
  const shipments: TraceShipmentView[] = [...shipmentGarments.entries()]
    .map(([shipmentId, { garments, workOrders: numbers }]) => {
      const shipment = shipmentById.get(shipmentId)!
      const party = partyById.get(shipment.partyId)
      return {
        id: shipment.id,
        number: shipment.number,
        status: shipment.status,
        left: isLeft(shipment.status),
        shippedAt: shipment.shippedAt,
        deliveredAt: shipment.deliveredAt,
        partyId: shipment.partyId,
        partyCode: party?.code ?? '',
        partyName: party?.name ?? '',
        ddtNumbers: [...shipment.ddtNumbers].sort(),
        garments,
        workOrderNumbers: [...numbers].sort(),
      }
    })
    .sort(byNumber)

  const customersById = new Map<string, { garments: number; shipments: string[]; ddts: string[] }>()
  for (const shipment of shipments) {
    if (!shipment.left) continue
    const entry = customersById.get(shipment.partyId) ?? { garments: 0, shipments: [], ddts: [] }
    entry.garments += shipment.garments
    entry.shipments.push(shipment.number)
    entry.ddts.push(...shipment.ddtNumbers)
    customersById.set(shipment.partyId, entry)
  }
  const customers: TraceCustomerView[] = [...customersById.entries()]
    .map(([partyId, entry]) => {
      const party = partyById.get(partyId)
      return { partyId, code: party?.code ?? '', name: party?.name ?? '', garments: entry.garments, shipmentNumbers: entry.shipments.sort(), ddtNumbers: [...new Set(entry.ddts)].sort() }
    })
    .sort((a, b) => a.code.localeCompare(b.code) || a.partyId.localeCompare(b.partyId))

  const lots: TraceLotView[] = concern.lotIds
    .filter((lotId) => lotById.has(lotId))
    .map((lotId) => ({
      id: lotId,
      code: lotById.get(lotId)!.code,
      workOrderNumbers: [...(lotWorkOrders.get(lotId) ?? [])].map((id) => workOrderById.get(id)!.number).sort(),
    }))

  const cells = workOrders.flatMap((workOrder) => workOrder.cells)
  const total = (field: 'concerned' | 'released' | 'packed' | 'shipped' | 'returned'): number => cells.reduce((acc, cell) => acc + cell[field], 0)
  return {
    workOrders,
    lots,
    shipments,
    customers,
    counts: {
      workOrders: workOrders.length,
      concerned: total('concerned'),
      released: total('released'),
      packed: total('packed'),
      shipped: total('shipped'),
      returned: total('returned'),
      customers: customers.length,
    },
    shippedGoods: customers.length > 0,
    problems,
  }
}

/** The numbers of the shipments that left (for closeProblems' message). */
export const leftShipmentNumbers = (trace: Pick<TraceView, 'shipments'>): string[] => trace.shipments.filter((shipment) => shipment.left).map((shipment) => shipment.number)
