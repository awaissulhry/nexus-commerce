/**
 * Scan into the carton (B-W2b-384; LOG-007, LOG-003, LOG-010; design floor.pack "Scan into the carton", warehouse.shipments
 * "Cartons", "Carton 2 of 3"), pure. Packers scan every garment every shift (Rule 1): each scan puts one garment of the
 * shipment into the open carton, counted per size against the shipment's lines; a wrong style, colour or size or an extra
 * piece is refused in words, by a code the screens word themselves.
 *
 * The model the API keeps (W1's lines stay true, factory-db …_packing_w2b_guards checks the rest):
 *   - a shipment line lies in one parcel (W1): a cell's garments in carton 2 are one line of the cell in carton 2; the
 *     garments not in a carton yet are the cell's loose line (no parcel);
 *   - a line's carton contents (ParcelLine) are in the line's own carton and count the garments scanned into it; a line
 *     whose garments are all scanned has contents equal to its quantity (what the move to PACKED needs);
 *   - a scanned serial lies in its line and its line's carton (GarmentSerial.shipmentLineId + parcelId), with when and who.
 * A scan COUNTs a garment of the cell's line already in the carton, or MOVEs one garment of another line of the cell (the
 * loose line first) into the carton (W1's split or join of a line); a serial of a garment counted there without it
 * (ATTACH) only takes the carton. Taking a garment out is the reverse: it goes back to the cell's loose line, its
 * serial out of the shipment.
 *
 * A carton is OPEN until Close carton numbers it ("n of N", its marks); a closed carton takes no more scans; taking a
 * garment out of it opens it again.
 */

/** Why a scan, a garment taken out or a carton closed is refused (the issue path `refusal/<CODE>`). */
export const CARTON_REFUSALS = [
  'UNKNOWN_CODE',
  'WRONG_BATCH',
  'WRONG_STYLE',
  'WRONG_COLOUR',
  'WRONG_SIZE',
  'EXTRA_PIECE',
  'SERIAL_NEEDED',
  'SIZE_NEEDED',
  'NOT_RELEASED',
  'NOT_FOR_ORDER',
  'OTHER_SHIPMENT',
  'ALREADY_PACKED',
  'NOT_IN_CARTON',
  'ON_HOLD',
  /** Goods of the scan on a quality hold (modules/quality/holds: a hold on the shipment, carton, work order or serial). */
  'QUALITY_HOLD',
  'NOT_DRAFT',
  'CARTON_CLOSED',
  'CARTON_LABELLED',
  'TOO_MANY_CARTONS',
  'EMPTY_CARTON',
  'NOT_SCANNED',
  'PACKAGING_NEEDED',
  'PACKAGING_NOT_PARCEL',
  'PACKAGING_OFF',
] as const
export type CartonRefusalCode = (typeof CARTON_REFUSALS)[number]

export interface CartonRefusal {
  readonly code: CartonRefusalCode
  readonly message: string
}

/** The issue path of a refusal (floor-sync reads `refusal/<CODE>` as the module's own refusal: B-W2b-F31). */
export const refusalPath = (code: CartonRefusalCode): string => `refusal/${code}`

/** A line of the shipment as the bench sees it. */
export interface CartonLine {
  readonly id: string
  /** The work order cell (WorkOrderSize). */
  readonly cellId: string
  readonly workOrderId: string
  readonly styleId: string
  readonly styleCode: string
  readonly colourwayId: string
  readonly colourwayCode: string
  readonly size: string
  readonly quantity: number
  readonly parcelId: string | null
  /** Garments of the line scanned into its carton (its carton contents; 0: none). */
  readonly scanned: number
  readonly serialIds: readonly string[]
  /** Of its serials, those lying in its carton. */
  readonly serialsInCarton: number
  readonly serialTracked: boolean
}

/** A parcel of the shipment as the bench sees it. */
export interface CartonParcel {
  readonly id: string
  readonly seq: number
  /** Closed: numbered "n of N" by Close carton. */
  readonly closed: boolean
  /** A carrier label was bought for it. */
  readonly labelled: boolean
}

/** What was scanned, as its record says. */
export type ScannedPiece =
  | {
      readonly kind: 'SERIAL'
      readonly serialId: string
      readonly serial: string
      readonly cellId: string
      readonly styleId: string
      readonly styleCode: string
      readonly colourwayId: string
      readonly colourwayCode: string
      readonly size: string
      readonly status: string
      /** Made for an order line (a sample made for none never ships on an order's shipment). */
      readonly forOrder: boolean
      /** The shipment line it is packed into, if any, and whether that line is of this shipment. */
      readonly shipmentLineId: string | null
      readonly onThisShipment: boolean
      readonly parcelId: string | null
    }
  | { readonly kind: 'SKU'; readonly code: string; readonly styleId: string; readonly styleCode: string; readonly colourwayId: string; readonly colourwayCode: string; readonly size: string }
  | { readonly kind: 'BATCH'; readonly code: string; readonly workOrderId: string; readonly cellId: string | null }

/** Garments of a line not scanned into a carton. */
const unscanned = (line: CartonLine): number => line.quantity - line.scanned

const describe = (line: Pick<CartonLine, 'styleCode' | 'colourwayCode' | 'size'>): string => `${line.styleCode} ${line.colourwayCode} size ${line.size}`

const refuse = (code: CartonRefusalCode, message: string): { readonly ok: false; readonly refusal: CartonRefusal } => ({ ok: false, refusal: { code, message } })

/** The words of a refusal that names nothing but the carton or the shipment. */
export function cartonRefusal(code: 'ON_HOLD' | 'NOT_DRAFT' | 'CARTON_CLOSED' | 'CARTON_LABELLED' | 'TOO_MANY_CARTONS' | 'EMPTY_CARTON' | 'PACKAGING_NEEDED' | 'PACKAGING_NOT_PARCEL' | 'PACKAGING_OFF', facts: { readonly seq?: number; readonly status?: string; readonly reason?: string; readonly max?: number } = {}): CartonRefusal {
  switch (code) {
    case 'ON_HOLD':
      return { code, message: `This shipment is on hold (${facts.reason ?? 'a hold'}): nothing goes into its cartons, and it is not packed, until the hold is released.` }
    case 'NOT_DRAFT':
      return { code, message: `The shipment is ${facts.status ?? 'not a draft'}: its cartons change only while it is a DRAFT (unpack it first).` }
    case 'CARTON_CLOSED':
      return { code, message: `Carton ${facts.seq ?? ''} is closed: scan into an open carton, or take a garment out of it to open it again.` }
    case 'CARTON_LABELLED':
      return { code, message: `Carton ${facts.seq ?? ''} has a carrier label: its contents stay until the label is voided.` }
    case 'TOO_MANY_CARTONS':
      return { code, message: `A shipment has at most ${facts.max ?? 99} cartons.` }
    case 'EMPTY_CARTON':
      return { code, message: `Carton ${facts.seq ?? ''} is empty: scan its garments first.` }
    case 'PACKAGING_NEEDED':
      return { code, message: 'Choose what the carton is packed in: no default packaging fits these garments.' }
    case 'PACKAGING_NOT_PARCEL':
      return { code, message: 'A carton is packed in a carton, a box or a pallet of the shipment’s company, not in a polybag or a hanger.' }
    case 'PACKAGING_OFF':
      return { code, message: 'That packaging is switched off: choose one in use.' }
  }
}

/** Why the shipment refuses a garment of this cell before any line is chosen (a serial's state, a sample). */
function serialRefusal(piece: Extract<ScannedPiece, { kind: 'SERIAL' }>, cartonSeqOf: (parcelId: string) => number | null): CartonRefusal | null {
  if (piece.shipmentLineId !== null && !piece.onThisShipment) return { code: 'OTHER_SHIPMENT', message: `Serial ${piece.serial} is packed in another shipment.` }
  if (piece.shipmentLineId !== null && piece.parcelId !== null) return { code: 'ALREADY_PACKED', message: `Serial ${piece.serial} is in carton ${cartonSeqOf(piece.parcelId) ?? ''} already.` }
  if (!piece.forOrder) return { code: 'NOT_FOR_ORDER', message: `Serial ${piece.serial} is a sample made for no order line: samples do not ship on an order's shipment.` }
  if (piece.status !== 'RELEASED') return { code: 'NOT_RELEASED', message: `Serial ${piece.serial} is ${piece.status}: only garments quality released are packed (QHS-073).` }
  return null
}

/** The refusal of a garment of a style, colour and size this shipment does not carry (the most precise words). */
function notOnShipment(lines: readonly CartonLine[], garment: { readonly styleId: string; readonly styleCode: string; readonly colourwayId: string; readonly colourwayCode: string; readonly size: string }): CartonRefusal {
  if (!lines.some((line) => line.styleId === garment.styleId)) return { code: 'WRONG_STYLE', message: `Style ${garment.styleCode} is not on this shipment.` }
  if (!lines.some((line) => line.styleId === garment.styleId && line.colourwayId === garment.colourwayId)) {
    return { code: 'WRONG_COLOUR', message: `${garment.styleCode} in ${garment.colourwayCode} is not on this shipment.` }
  }
  return { code: 'WRONG_SIZE', message: `${describe(garment)} is not on this shipment.` }
}

/** The cells of the shipment a scanned piece can be, or the refusal. */
export function cellsOfPiece(piece: ScannedPiece, lines: readonly CartonLine[], cartonSeqOf: (parcelId: string) => number | null): { readonly ok: true; readonly cellIds: readonly string[] } | { readonly ok: false; readonly refusal: CartonRefusal } {
  switch (piece.kind) {
    case 'SERIAL': {
      const refusal = serialRefusal(piece, cartonSeqOf)
      if (refusal) return { ok: false, refusal }
      if (!lines.some((line) => line.cellId === piece.cellId)) return { ok: false, refusal: notOnShipment(lines, piece) }
      return { ok: true, cellIds: [piece.cellId] }
    }
    case 'SKU': {
      const matching = lines.filter((line) => line.styleId === piece.styleId && line.colourwayId === piece.colourwayId && line.size === piece.size)
      if (matching.length === 0) return { ok: false, refusal: notOnShipment(lines, piece) }
      if (matching.some((line) => line.serialTracked)) return refuse('SERIAL_NEEDED', `${piece.styleCode} is traced by serial: scan the garment's serial label.`)
      return { ok: true, cellIds: [...new Set(matching.map((line) => line.cellId))] }
    }
    case 'BATCH': {
      const ofBatch = lines.filter((line) => line.workOrderId === piece.workOrderId)
      if (ofBatch.length === 0) return refuse('WRONG_BATCH', `Batch ${piece.code} is not on this shipment.`)
      if (ofBatch.some((line) => line.serialTracked)) return refuse('SERIAL_NEEDED', `${ofBatch[0]!.styleCode} is traced by serial: scan the garment's serial label.`)
      if (piece.cellId !== null) {
        if (!ofBatch.some((line) => line.cellId === piece.cellId)) return refuse('WRONG_SIZE', `That colour and size is not of batch ${piece.code} on this shipment.`)
        return { ok: true, cellIds: [piece.cellId] }
      }
      const cells = [...new Set(ofBatch.map((line) => line.cellId))]
      const open = cells.filter((cellId) => ofBatch.filter((line) => line.cellId === cellId).reduce((left, line) => left + unscanned(line), 0) > 0)
      if (open.length > 1) {
        const choices = open.map((cellId) => ofBatch.find((line) => line.cellId === cellId)!).map((line) => `${line.colourwayCode} ${line.size}`)
        return refuse('SIZE_NEEDED', `Batch ${piece.code} has ${choices.join(', ')} left on this shipment: choose the colour and size.`)
      }
      return { ok: true, cellIds: open.length === 1 ? open : cells }
    }
  }
}

/** Where a scanned garment goes: counted on the cell's line in the carton, or moved there from another line of the cell. */
export type Take =
  | { readonly kind: 'COUNT'; readonly lineId: string }
  /** A serial into its line's carton for a garment counted there without one (its contents stay). */
  | { readonly kind: 'ATTACH'; readonly lineId: string }
  /**
   * One garment of `fromLineId` into the carton: onto the cell's line there (`intoLineId`), or as a new line (null).
   * `whole`: the source is that one garment and nothing of it is counted: the line itself moves into the carton.
   */
  | { readonly kind: 'MOVE'; readonly fromLineId: string; readonly intoLineId: string | null; readonly whole: boolean }

/**
 * Where one garment of one of these cells goes in the carton (`serialLineId`: the line of this shipment the scanned serial
 * is already on, if any): a count on a cell's line in the carton first, else a move from another line of the same cell
 * (the loose line first). A line in a closed or labelled carton gives nothing. Refused EXTRA_PIECE when every garment of
 * the cells is scanned into a carton already (or, for a serial, every garment left has its serial already).
 */
export function takeInto(
  lines: readonly CartonLine[],
  cellIds: readonly string[],
  parcels: readonly CartonParcel[],
  cartonId: string,
  scan: { readonly serial: boolean; readonly serialLineId: string | null },
): { readonly ok: true; readonly take: Take } | { readonly ok: false; readonly refusal: CartonRefusal } {
  const parcelOf = (id: string | null) => (id === null ? null : (parcels.find((parcel) => parcel.id === id) ?? null))
  const movable = (line: CartonLine) => {
    const parcel = parcelOf(line.parcelId)
    return parcel === null || (!parcel.closed && !parcel.labelled)
  }
  const move = (from: CartonLine, target: CartonLine | undefined): Take => ({ kind: 'MOVE', fromLineId: from.id, intoLineId: target?.id ?? null, whole: target === undefined && from.quantity === 1 && from.scanned === 0 })
  const ofCell = (cellId: string) => lines.filter((line) => line.cellId === cellId)
  // A cell has one line in a carton (W1 joins a cell's garments in a parcel into one line).
  const targetOf = (cellId: string) => ofCell(cellId).find((line) => line.parcelId === cartonId)
  /** Garments counted in the line's carton without their serial there yet. */
  const counted = (line: CartonLine) => line.scanned - line.serialsInCarton
  const takes: Take[] = []
  if (scan.serialLineId !== null) {
    const own = lines.find((line) => line.id === scan.serialLineId)
    if (own && own.parcelId === cartonId && counted(own) > 0) takes.push({ kind: 'ATTACH', lineId: own.id })
    else if (own && unscanned(own) > 0) {
      if (own.parcelId === cartonId) takes.push({ kind: 'COUNT', lineId: own.id })
      else if (movable(own)) takes.push(move(own, targetOf(own.cellId)))
    }
  } else {
    for (const cellId of cellIds) {
      const target = targetOf(cellId)
      if (scan.serial && target && counted(target) > 0 && target.quantity - target.serialIds.length > 0) takes.push({ kind: 'ATTACH', lineId: target.id })
    }
    for (const cellId of cellIds) {
      const target = targetOf(cellId)
      if (target && unscanned(target) > 0 && (!scan.serial || target.quantity - target.serialIds.length > 0)) takes.push({ kind: 'COUNT', lineId: target.id })
    }
    for (const cellId of cellIds) {
      const target = targetOf(cellId)
      const from = ofCell(cellId)
        .filter((line) => line.id !== target?.id && unscanned(line) > 0 && movable(line) && (!scan.serial || line.quantity - 1 >= line.serialIds.length))
        .sort((a, b) => Number(a.parcelId !== null) - Number(b.parcelId !== null))[0]
      if (from) takes.push(move(from, target))
    }
  }
  const take = takes[0]
  if (take) return { ok: true, take }
  const cell = lines.filter((line) => cellIds.includes(line.cellId))
  const total = cell.reduce((sum, line) => sum + line.quantity, 0)
  return refuse('EXTRA_PIECE', `All ${total} of ${describe(cell[0]!)} on this shipment are in cartons already: this one is an extra piece.`)
}

/** Taking one garment out of a carton: its line there, and the cell's loose line it joins (null: it becomes one). */
export interface TakeOut {
  readonly lineId: string
  readonly intoLineId: string | null
  /** The line is that one garment: it moves out whole (no loose line to join). */
  readonly whole: boolean
}

/** Where a garment of one of these cells taken out of the carton goes (`serialLineId`: the scanned serial's line, if any). */
export function takeOutOf(
  lines: readonly CartonLine[],
  cellIds: readonly string[],
  cartonId: string,
  scan: { readonly serialLineId: string | null; readonly serialParcelId: string | null },
  label: string,
): { readonly ok: true; readonly out: TakeOut } | { readonly ok: false; readonly refusal: CartonRefusal } {
  const inCarton = lines.find((line) => cellIds.includes(line.cellId) && line.parcelId === cartonId && line.scanned > 0 && (scan.serialLineId === null || line.id === scan.serialLineId))
  if (!inCarton || (scan.serialLineId !== null && scan.serialParcelId !== cartonId)) return refuse('NOT_IN_CARTON', `${label} is not in this carton.`)
  const loose = lines.find((line) => line.cellId === inCarton.cellId && line.parcelId === null)
  return { ok: true, out: { lineId: inCarton.id, intoLineId: loose?.id ?? null, whole: loose === undefined && inCarton.quantity === 1 } }
}

// ---- the size grid, the cartons' numbers and what packing still needs ----------------------------------------------

export interface GridSize {
  readonly size: string
  readonly cellIds: readonly string[]
  /** Garments of this colour and size on the shipment. */
  readonly ordered: number
  /** Of them, scanned into a carton. */
  readonly packed: number
}

export interface GridRow {
  readonly styleId: string
  readonly colourwayId: string
  readonly serialTracked: boolean
  readonly sizes: readonly GridSize[]
}

/** The size grid, ordered against packed, per style and colour (rows and sizes in the lines' order). */
export function sizeGrid(lines: readonly CartonLine[]): GridRow[] {
  const rows: { styleId: string; colourwayId: string; serialTracked: boolean; sizes: { size: string; cellIds: string[]; ordered: number; packed: number }[] }[] = []
  for (const line of lines) {
    let row = rows.find((entry) => entry.styleId === line.styleId && entry.colourwayId === line.colourwayId)
    if (!row) rows.push((row = { styleId: line.styleId, colourwayId: line.colourwayId, serialTracked: line.serialTracked, sizes: [] }))
    let size = row.sizes.find((entry) => entry.size === line.size)
    if (!size) row.sizes.push((size = { size: line.size, cellIds: [], ordered: 0, packed: 0 }))
    if (!size.cellIds.includes(line.cellId)) size.cellIds.push(line.cellId)
    size.ordered += line.quantity
    size.packed += line.scanned
  }
  return rows
}

/** A parcel's printed number and marks. */
export interface NumberedParcel {
  readonly id: string
  readonly seq: number
  readonly cartonNumber: number | null
  readonly cartonCount: number | null
  readonly marksPrinted: boolean
}

/**
 * The closed cartons whose "n of N" no longer matches their place and the shipment's carton count (a carton added or
 * removed since): their new numbers, their marks to print again.
 */
export function renumbered(parcels: readonly NumberedParcel[]): { readonly id: string; readonly cartonNumber: number; readonly cartonCount: number }[] {
  const count = parcels.length
  return parcels.filter((parcel) => parcel.cartonNumber !== null && (parcel.cartonNumber !== parcel.seq || parcel.cartonCount !== count)).map((parcel) => ({ id: parcel.id, cartonNumber: parcel.seq, cartonCount: count }))
}

/** The carton's marks say what it is now: closed, its "n of N" its place and the shipment's count, printed since. */
export const marksCurrent = (parcel: NumberedParcel, count: number): boolean => parcel.cartonNumber !== null && parcel.marksPrinted && parcel.cartonNumber === parcel.seq && parcel.cartonCount === count

/** What the bench still has to do before the shipment is packed, as codes the screens word (empty: nothing). */
export const BENCH_PROBLEMS = ['NOT_SCANNED', 'SERIALS_NOT_IN_CARTONS', 'CARTON_OPEN', 'MARKS_NOT_PRINTED'] as const
export type BenchProblem = (typeof BENCH_PROBLEMS)[number]

export function benchProblems(lines: readonly CartonLine[], parcels: readonly (NumberedParcel & { readonly hasContents: boolean })[]): BenchProblem[] {
  const problems: BenchProblem[] = []
  if (lines.some((line) => unscanned(line) > 0)) problems.push('NOT_SCANNED')
  // The move to PACKED wants each serial of a line with carton contents in its carton.
  if (lines.some((line) => line.scanned > 0 && line.serialIds.length > line.serialsInCarton)) problems.push('SERIALS_NOT_IN_CARTONS')
  if (parcels.some((parcel) => parcel.hasContents && parcel.cartonNumber === null)) problems.push('CARTON_OPEN')
  if (parcels.some((parcel) => parcel.cartonNumber !== null && !marksCurrent(parcel, parcels.length))) problems.push('MARKS_NOT_PRINTED')
  return problems
}

/** The carton a scan goes into when none is named: the last open one without a label, or none (a new one is made). */
export function openCarton(parcels: readonly CartonParcel[]): CartonParcel | null {
  return [...parcels].sort((a, b) => b.seq - a.seq).find((parcel) => !parcel.closed && !parcel.labelled) ?? null
}
