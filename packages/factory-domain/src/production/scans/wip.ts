import { bundleFlow, type Flow as BundleFlow, type FlowRework } from '../bundles/split'
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
 * W2b (B-W2b-10, B-W2a-13's follow-up) — splits and rework orders:
 *   flow      each bundle is read through its flow (../bundles/split bundleFlow): a split parent counts at most its live
 *             garments (its quantity as cut less its children that are not VOID), a child takes its parent's place
 *             at the operations its parent passed before the split, and a DONE rework's good garments count as passed
 *             at the operation the fault was found at. So a split no longer shows the child's garments as `missing`
 *             (nor as `waiting` where its parent passed them).
 *   rework    a rework order (not CANCELLED) found at an operation moves garments there: OPEN or IN_PROGRESS counts
 *             them as `rework` (in rework) and the bundle that carries all of them waits for it (not `waiting` for a
 *             scan); DONE counts its good ones as `good` and its scrapped ones as `scrap`. What it took is not
 *             counted twice: a rework opened from a scan takes its garments out of that scan's rework count; one opened
 *             by hand on a whole bundle that was reported there takes them out of the report's good. A rework that names
 *             no bundle, or was found outside the routing, counts in its cell only (inRework, scrapped).
 *   cells     inRework = garments counted for rework and not sent back yet + those in an open rework order;
 *             scrapped = garments scrapped at an operation + those a DONE rework scrapped.
 * Callers pass every bundle of the work order (ACTIVE and VOID, as cut: the flow subtracts the children) and its
 * rework orders; without `reworks` and splits the figures are W1's.
 *
 * Privacy (Statuto dei Lavoratori art. 4; Owner answers W1, F2): nothing here is per person or per station; lines only.
 */

export interface WipBundle {
  readonly id: string
  readonly workOrderSizeId: string
  readonly part: string | null
  /** Garments as cut (the flow takes its children off). */
  readonly quantity: number
  /** W2b: ACTIVE (left out: ACTIVE) or VOID (counted nowhere; a VOID child gives its garments back to its parent). */
  readonly status?: string | undefined
  /** W2b: the bundle it was split from (B-W2a-13), and when it was made (the split). */
  readonly parentBundleId?: string | null | undefined
  readonly createdAt?: Date | undefined
}

/** W2b: a rework order of the work order as WIP reads it (CANCELLED ones are left out). */
export interface WipRework extends FlowRework {
  readonly workOrderSizeId: string
  readonly bundleId: string | null
  readonly scrapQuantity: number
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
 * WIP of one work order. `scans`: every scan of its bundles; `bundles`: its bundles (ACTIVE and VOID, as cut); `reworks`:
 * its rework orders; `lineOf`: the line of a station (null for a station that stands alone).
 */
export function wipOf(input: {
  readonly operations: readonly ScanOperation[]
  readonly cells: readonly WipCell[]
  readonly bundles: readonly WipBundle[]
  readonly scans: readonly ScanFact[]
  readonly reworks?: readonly WipRework[] | undefined
  readonly lineOf: (stationId: string) => string | null
}): Wip {
  const operations = [...input.operations].sort((a, b) => a.seq - b.seq)
  const standing = standingScans(input.scans)
  const final = finalOperationOf(operations)
  const sewn = sewnOperationOf(operations)
  const reworks = (input.reworks ?? []).filter((rework) => rework.status !== 'CANCELLED')
  const isActive = (bundle: WipBundle) => (bundle.status ?? 'ACTIVE') === 'ACTIVE'
  const active = input.bundles.filter(isActive)
  const flows = bundleFlows(input.bundles, operations, standing, reworks)
  const opIds = new Set(operations.map((operation) => operation.id))
  const scanById = new Map(input.scans.map((scan) => [scan.id, scan]))

  // What the rework orders took out of the reports at the operation they were found at (never below 0).
  const takenRework = new Map<string, number>() // standing scan id → garments its reworks took from its rework count
  const takenGood = new Map<string, number>() // standing scan id → garments a whole-bundle rework by hand took from its good
  for (const rework of reworks) {
    if (rework.sourceScanId) {
      const source = scanById.get(rework.sourceScanId)
      if (!source) continue
      const left = source.reworkQuantity - (takenRework.get(source.id) ?? 0)
      takenRework.set(source.id, (takenRework.get(source.id) ?? 0) + Math.max(0, Math.min(rework.quantity, left)))
    } else if (rework.bundleId && rework.foundAtOperationId) {
      const own = standing.get(standingKey(rework.bundleId, rework.foundAtOperationId))
      if (!own || own.serverTime.getTime() > rework.createdAt.getTime()) continue
      const left = own.goodQuantity - (takenGood.get(own.id) ?? 0)
      takenGood.set(own.id, (takenGood.get(own.id) ?? 0) + Math.max(0, Math.min(rework.quantity, left)))
    }
  }
  // The reworks counted on an operation row (a bundle and a found-at operation of the routing); the rest in their cell.
  const onRow = (rework: WipRework) => rework.bundleId !== null && rework.foundAtOperationId !== null && opIds.has(rework.foundAtOperationId)

  const arrivedAt = (bundle: WipBundle, operation: ScanOperation): number => {
    const flow = flows.get(bundle.id)!
    const previous = previousScanned(operations, operation.id)
    if (!previous) return flow.quantity
    return flow.standing.get(standingKey(bundle.id, previous.id))?.goodQuantity ?? 0
  }

  const rows: WipOperation[] = operations.map((operation) => {
    const total = emptyFlow()
    const perCell = new Map(input.cells.map((cell) => [cell.id, emptyFlow()]))
    const bundles = { done: 0, waiting: 0, notReached: 0 }
    const partBundles = { done: 0, waiting: 0, notReached: 0 }
    const lines = new Map<string, number>()
    const flowsOf = (cellId: string) => [total, perCell.get(cellId)].filter((flow): flow is ReturnType<typeof emptyFlow> => flow !== undefined)
    for (const bundle of active) {
      const flow = flows.get(bundle.id)!
      const key = standingKey(bundle.id, operation.id)
      const own = standing.get(key)
      const passed = flow.standing.get(key)
      const held = heldBy(bundle.id, flow, reworks)
      const heldHere = held !== null && flow.refusal !== null && held.foundAtOperationId === operation.id
      const doneHere = reworks.filter((rework) => rework.status === 'DONE' && rework.bundleId === bundle.id && rework.foundAtOperationId === operation.id)
      const arrived = arrivedAt(bundle, operation)
      const tally = bundle.part === null ? bundles : partBundles
      if (own || (passed && !heldHere)) tally.done++
      else if (heldHere || arrived > 0) tally.waiting++
      else tally.notReached++
      if (bundle.part !== null) continue
      let good = 0
      for (const counts of flowsOf(bundle.workOrderSizeId)) {
        counts.arrived += arrived
        if (own) {
          // Its own report: the good at most its live garments, less what a whole-bundle rework by hand took from it.
          good = Math.max(0, Math.min(own.goodQuantity, flow.quantity) - (takenGood.get(own.id) ?? 0))
          counts.good += good
          counts.scrap += own.scrapQuantity
          counts.rework += Math.max(0, own.reworkQuantity - (takenRework.get(own.id) ?? 0))
          counts.missing += Math.max(0, arrived - (own.goodQuantity + own.scrapQuantity + own.reworkQuantity))
        } else if (heldHere) {
          // In an open rework found here: the rework order counts its garments (below).
        } else if (passed && doneHere.length > 0) {
          // A rework child back from its DONE rework: the rework order counts its good and scrapped garments (below).
          const back = doneHere.reduce((sum, rework) => sum + rework.goodQuantity + rework.scrapQuantity, 0)
          counts.missing += Math.max(0, arrived - back)
        } else if (passed) {
          // A child where its parent passed its garments before the split.
          good = passed.goodQuantity
          counts.good += good
          counts.missing += Math.max(0, arrived - passed.goodQuantity)
        } else {
          const scrapped = doneHere.reduce((sum, rework) => sum + rework.scrapQuantity, 0)
          counts.waiting += Math.max(0, arrived - scrapped)
        }
      }
      const stationId = own?.stationId ?? (passed && !heldHere && doneHere.length === 0 ? passed.stationId : null)
      const lineId = stationId ? input.lineOf(stationId) : null
      if (good > 0 && lineId) lines.set(lineId, (lines.get(lineId) ?? 0) + good)
    }
    // The rework orders found here.
    for (const rework of reworks) {
      if (!onRow(rework) || rework.foundAtOperationId !== operation.id) continue
      const carrier = input.bundles.find((bundle) => bundle.id === rework.bundleId)
      if (carrier && carrier.part !== null) continue
      for (const counts of flowsOf(rework.workOrderSizeId)) {
        if (rework.status === 'DONE') {
          counts.good += rework.goodQuantity
          counts.scrap += rework.scrapQuantity
        } else {
          counts.rework += rework.quantity
        }
      }
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
  const offRow = reworks.filter((rework) => !onRow(rework))
  const cells = input.cells.map((cell) => {
    const whole = active.filter((bundle) => bundle.part === null && bundle.workOrderSizeId === cell.id)
    const perCell = rows.map((row) => row.cells.find((entry) => entry.workOrderSizeId === cell.id)!)
    const mine = offRow.filter((rework) => rework.workOrderSizeId === cell.id)
    return {
      workOrderSizeId: cell.id,
      quantity: cell.quantity,
      bundled: whole.reduce((sum, bundle) => sum + flows.get(bundle.id)!.quantity, 0),
      sewn: goodAt(sewn?.id, cell.id),
      finished: goodAt(final?.id, cell.id),
      scrapped: perCell.reduce((sum, flow) => sum + flow.scrap, 0) + mine.filter((rework) => rework.status === 'DONE').reduce((sum, rework) => sum + rework.scrapQuantity, 0),
      inRework: perCell.reduce((sum, flow) => sum + flow.rework, 0) + mine.filter((rework) => rework.status !== 'DONE').reduce((sum, rework) => sum + rework.quantity, 0),
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

/** The rework a bundle's flow is held by (the first not CANCELLED that carries all its live garments), as bundleFlow reads it. */
function heldBy(bundleId: string, flow: BundleFlow<ScanFact>, reworks: readonly WipRework[]): WipRework | null {
  return reworks.find((rework) => rework.bundleId === bundleId && rework.quantity >= flow.quantity) ?? null
}

/** Every bundle's flow (../bundles/split bundleFlow): a child after its parent, up a chain of at most eight splits. */
function bundleFlows(bundles: readonly WipBundle[], operations: readonly ScanOperation[], standing: ReadonlyMap<string, ScanFact>, reworks: readonly WipRework[]): Map<string, BundleFlow<ScanFact>> {
  const byId = new Map(bundles.map((bundle) => [bundle.id, bundle]))
  const children = new Map<string, WipBundle[]>()
  for (const bundle of bundles) if (bundle.parentBundleId) children.set(bundle.parentBundleId, [...(children.get(bundle.parentBundleId) ?? []), bundle])
  const own = new Map<string, Map<string, ScanFact>>()
  for (const [key, scan] of standing) {
    const bundleId = scan.bundleId
    if (!own.has(bundleId)) own.set(bundleId, new Map())
    own.get(bundleId)!.set(key, scan)
  }
  const flows = new Map<string, BundleFlow<ScanFact>>()
  const flowOf = (bundle: WipBundle, depth: number): BundleFlow<ScanFact> => {
    const known = flows.get(bundle.id)
    if (known) return known
    const mine = own.get(bundle.id) ?? new Map<string, ScanFact>()
    const kids = (children.get(bundle.id) ?? []).map((child) => ({ quantity: child.quantity, status: child.status === 'VOID' ? ('VOID' as const) : ('ACTIVE' as const) }))
    const theirs = reworks.filter((rework) => rework.bundleId === bundle.id)
    const above = bundle.parentBundleId ? byId.get(bundle.parentBundleId) : undefined
    const parent = above && depth < 8 ? { id: above.id, standing: flowOf(above, depth + 1).standing } : null
    const flow =
      !parent && kids.length === 0 && theirs.length === 0
        ? { quantity: bundle.quantity, standing: new Map(mine), refusal: null }
        : bundleFlow({ bundle: { id: bundle.id, code: '', quantity: bundle.quantity, createdAt: bundle.createdAt ?? new Date(0) }, operations, standing: mine, children: kids, reworks: theirs, parent })
    flows.set(bundle.id, flow)
    return flow
  }
  for (const bundle of bundles) flowOf(bundle, 0)
  return flows
}
