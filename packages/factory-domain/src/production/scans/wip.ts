import { finalOperationOf, previousScanned, sewnOperationOf, standingKey, standingScans, type ScanFact, type ScanOperation } from './rules'

/**
 * Work in progress from the floor's scans (B-W1-42; MES-167 WIP by operation, MES-079 the operation bulletin; design
 * production.floor "fn-wip", work order "Bundles & progress" wo-flow, the size grid's sewn and finished), pure. A ledger,
 * not counters: every figure is a sum of the standing reports (rules.ts standingScans) of the work order's ACTIVE
 * bundles, read again each time.
 *
 *   arrived   garments that reached the operation: a bundle's garments at the first scanned operation; at a later one
 *             what the previous scanned operation passed (its standing report's good).
 *   good      passed on (the standing report's good); scrap: lost there; rework: taken out to be made again (they wait
 *             at the operation until a correction counts them good or scrap).
 *   waiting   arrived and not reported yet at the operation (a reported bundle's garments it did not count are
 *             `missing`, not waiting).
 *   bundles   done (a standing report), waiting (arrived, not reported) and not reached (nothing passed to it yet).
 *   cells     per colourway × size: the same figures, and the size grid's progress: sewn = the good of the sewn
 *             operation (rules.ts sewnOperationOf; null when the routing sews nowhere), finished = the good of the final
 *             operation (the last scanned one).
 *   lines     per operation, the good its reports passed per line of the reporting station (F2: output per line only).
 * Garment figures count bundles of whole garments; a part bundle (sleeves on their own) travels through its operations
 * as pieces of one part, so it is counted on its own (`partBundles`), never as garments.
 *
 * Privacy (Statuto dei Lavoratori art. 4; Owner answers W1, F2): nothing here is per person or per station; lines only.
 */

export interface WipBundle {
  readonly id: string
  readonly workOrderSizeId: string
  readonly part: string | null
  readonly quantity: number
}

export interface WipCell {
  readonly id: string
  readonly quantity: number
}

export interface Flow {
  readonly arrived: number
  readonly waiting: number
  readonly good: number
  readonly scrap: number
  readonly rework: number
  readonly missing: number
}

export interface BundleCounts {
  readonly done: number
  readonly waiting: number
  readonly notReached: number
}

export interface WipOperation extends Flow {
  readonly operationId: string
  readonly seq: number
  readonly code: string
  readonly name: string
  readonly scanRequired: boolean
  readonly final: boolean
  readonly sewn: boolean
  readonly bundles: BundleCounts
  readonly partBundles: BundleCounts
  readonly cells: readonly ({ readonly workOrderSizeId: string } & Flow)[]
  readonly lines: readonly { readonly lineId: string; readonly good: number }[]
}

export interface WipCellProgress {
  readonly workOrderSizeId: string
  readonly quantity: number
  /** Garments in ACTIVE bundles of whole garments. */
  readonly bundled: number
  readonly sewn: number | null
  readonly finished: number | null
  /** Scrapped at any operation. */
  readonly scrapped: number
  /** Waiting for rework at any operation. */
  readonly inRework: number
}

export interface Wip {
  readonly operations: readonly WipOperation[]
  readonly cells: readonly WipCellProgress[]
  readonly finalOperationId: string | null
  readonly sewnOperationId: string | null
  /** Every cell's finished garments reach its quantity: the office may complete the work order. */
  readonly allFinished: boolean
}

const emptyFlow = (): { arrived: number; waiting: number; good: number; scrap: number; rework: number; missing: number } => ({ arrived: 0, waiting: 0, good: 0, scrap: 0, rework: 0, missing: 0 })

/**
 * WIP of one work order. `scans`: every scan of its bundles; `bundles`: its ACTIVE bundles; `lineOf`: the line of a
 * station (null for a station that stands alone).
 */
export function wipOf(input: {
  readonly operations: readonly ScanOperation[]
  readonly cells: readonly WipCell[]
  readonly bundles: readonly WipBundle[]
  readonly scans: readonly ScanFact[]
  readonly lineOf: (stationId: string) => string | null
}): Wip {
  const operations = [...input.operations].sort((a, b) => a.seq - b.seq)
  const standing = standingScans(input.scans)
  const final = finalOperationOf(operations)
  const sewn = sewnOperationOf(operations)

  const arrivedAt = (bundle: WipBundle, operation: ScanOperation): number => {
    const previous = previousScanned(operations, operation.id)
    if (!previous) return bundle.quantity
    return standing.get(standingKey(bundle.id, previous.id))?.goodQuantity ?? 0
  }

  const rows: WipOperation[] = operations.map((operation) => {
    const total = emptyFlow()
    const perCell = new Map(input.cells.map((cell) => [cell.id, emptyFlow()]))
    const bundles = { done: 0, waiting: 0, notReached: 0 }
    const partBundles = { done: 0, waiting: 0, notReached: 0 }
    const lines = new Map<string, number>()
    for (const bundle of input.bundles) {
      const arrived = arrivedAt(bundle, operation)
      const report = standing.get(standingKey(bundle.id, operation.id))
      const tally = bundle.part === null ? bundles : partBundles
      if (report) tally.done++
      else if (arrived > 0) tally.waiting++
      else tally.notReached++
      if (bundle.part !== null) continue
      const flows = [total, perCell.get(bundle.workOrderSizeId)].filter((flow): flow is ReturnType<typeof emptyFlow> => flow !== undefined)
      for (const flow of flows) {
        flow.arrived += arrived
        if (report) {
          flow.good += report.goodQuantity
          flow.scrap += report.scrapQuantity
          flow.rework += report.reworkQuantity
          flow.missing += Math.max(0, arrived - (report.goodQuantity + report.scrapQuantity + report.reworkQuantity))
        } else {
          flow.waiting += arrived
        }
      }
      const lineId = report?.stationId ? input.lineOf(report.stationId) : null
      if (report && lineId) lines.set(lineId, (lines.get(lineId) ?? 0) + report.goodQuantity)
    }
    return {
      operationId: operation.id,
      seq: operation.seq,
      code: operation.code,
      name: operation.name,
      scanRequired: operation.scanRequired,
      final: operation.id === final?.id,
      sewn: operation.id === sewn?.id,
      ...total,
      bundles,
      partBundles,
      cells: input.cells.map((cell) => ({ workOrderSizeId: cell.id, ...perCell.get(cell.id)! })),
      lines: [...lines.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([lineId, good]) => ({ lineId, good })),
    }
  })

  const goodAt = (operationId: string | undefined, cellId: string): number | null => {
    if (!operationId) return null
    return rows.find((row) => row.operationId === operationId)!.cells.find((cell) => cell.workOrderSizeId === cellId)!.good
  }
  const cells = input.cells.map((cell) => {
    const whole = input.bundles.filter((bundle) => bundle.part === null && bundle.workOrderSizeId === cell.id)
    const perCell = rows.map((row) => row.cells.find((entry) => entry.workOrderSizeId === cell.id)!)
    return {
      workOrderSizeId: cell.id,
      quantity: cell.quantity,
      bundled: whole.reduce((sum, bundle) => sum + bundle.quantity, 0),
      sewn: goodAt(sewn?.id, cell.id),
      finished: goodAt(final?.id, cell.id),
      scrapped: perCell.reduce((sum, flow) => sum + flow.scrap, 0),
      inRework: perCell.reduce((sum, flow) => sum + flow.rework, 0),
    }
  })
  return {
    operations: rows,
    cells,
    finalOperationId: final?.id ?? null,
    sewnOperationId: sewn?.id ?? null,
    allFinished: final !== null && cells.length > 0 && cells.every((cell) => (cell.finished ?? 0) >= cell.quantity),
  }
}
