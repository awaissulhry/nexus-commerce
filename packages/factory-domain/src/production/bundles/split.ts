import type { ScanFact, ScanOperation, ScanRefusal } from '../scans/rules'
import { operationLabel, standingKey } from '../scans/rules'
import { CUTTABLE_STATUSES } from '../cutting/rules'
import type { WorkOrderStatus } from '../work-orders/machine'
import type { BundleRefusal } from './rules'

/**
 * Split a bundle (B-W2a-13; MES-071; design floor.bundles "Split a bundle", production.bundles "Split bundle"), pure:
 * some garments of a bundle go off into a child bundle with its own ticket (rework, a recut, a hold), and the genealogy
 * stays (the child names the parent and the parent's cut log entries). The API (apps/factory-api modules/production/
 * bundles split.ts) reads the facts inside its command under the work order's issue lock, the cell's bundle lock and the
 * parent's row lock; the …_production_w2a_guards Bundle_split_check trigger stays the last word (an ACTIVE parent of the
 * same cell and part, Σ live children ≤ parent − 1).
 *
 *   live      the PARENT KEEPS ITS QUANTITY AS CUT (W1 freezes Bundle.quantity): the garments still in it are its
 *             quantity − Σ its children that are not VOID. A void child gives its garments back.
 *   split     1 … live − 1 garments (at least one stays), of an ACTIVE bundle of a RELEASED or IN_PROGRESS work order;
 *             a held work order (ON_HOLD) splits nothing until the hold is lifted (the DB gate refuses the insert).
 *
 * The flow (bundleFlow): what a scan of a split bundle may report, as B-W1-42's scan rules read it (scans `capAt`):
 *
 *   parent    its standing reports count at most its live garments (a report made before the split counted the
 *             garments that left: they are the child's now).
 *   child     takes its parent's place in the flow at the time of the split: the parent's standing reports made before
 *             the split count for the child too (up to its garments), so the child goes on from where the garments were.
 *             A child that carries rework takes them only before the operation the fault was found at.
 *   rework    while an OPEN or IN_PROGRESS rework holds every garment of a bundle (a rework child, or a whole bundle
 *             sent back), no scan takes it: the rework moves through its own record (start, done). Once DONE, its
 *             good garments count as passed at the operation the fault was found at: the next operation takes them.
 */

export const SPLIT_REASONS = ['REWORK', 'RECUT', 'HOLD'] as const
export type SplitReason = (typeof SPLIT_REASONS)[number]

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** The garments still in a bundle: its quantity as cut less every child split off that is not VOID. */
export function liveGarments(quantity: number, children: readonly { readonly quantity: number; readonly status: 'ACTIVE' | 'VOID' }[]): number {
  return quantity - children.filter((child) => child.status !== 'VOID').reduce((sum, child) => sum + child.quantity, 0)
}

export interface SplitFacts {
  readonly bundle: { readonly code: string; readonly status: 'ACTIVE' | 'VOID'; readonly quantity: number }
  readonly workOrder: { readonly number: string; readonly status: WorkOrderStatus; readonly holdReason?: string | null | undefined }
  readonly children: readonly { readonly quantity: number; readonly status: 'ACTIVE' | 'VOID' }[]
  readonly quantity: number
}

/** Why the bundle may not be split by `quantity` garments, or null. */
export function splitRefusal(facts: SplitFacts): BundleRefusal | null {
  if (facts.bundle.status === 'VOID') return { code: 'VOIDED', message: `Bundle ${facts.bundle.code} is voided: nothing is split off it.` }
  if (facts.workOrder.status === 'ON_HOLD') {
    return { code: 'WORK_ORDER_ON_HOLD', message: `Work order ${facts.workOrder.number} is on hold${facts.workOrder.holdReason ? ` (${facts.workOrder.holdReason})` : ''}: its bundles are split once the hold is lifted.` }
  }
  if (!CUTTABLE_STATUSES.includes(facts.workOrder.status)) {
    return { code: 'WORK_ORDER_NOT_OPEN', message: `Work order ${facts.workOrder.number} is ${facts.workOrder.status}; its bundles change only while it is RELEASED or IN_PROGRESS.` }
  }
  const live = liveGarments(facts.bundle.quantity, facts.children)
  if (facts.quantity < 1 || facts.quantity > live - 1) {
    return {
      code: 'SPLIT_TOO_MANY',
      message:
        live <= 1
          ? `Bundle ${facts.bundle.code} carries ${plural(live, 'garment')}: nothing can be split off it (at least one stays).`
          : `Bundle ${facts.bundle.code} carries ${plural(live, 'garment')}: split off 1 to ${live - 1} (at least one stays); ${facts.quantity} asked.`,
    }
  }
  return null
}

// ---- the flow of a split bundle (the scan's hook) -------------------------------------------------------------------------------

/** A rework that names the bundle (not CANCELLED), as the flow reads it. */
export interface FlowRework {
  readonly id: string
  readonly status: 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED'
  readonly quantity: number
  readonly goodQuantity: number
  readonly reasonCode: string
  readonly foundAtOperationId: string | null
  readonly reworkAtOperationId: string
  readonly sourceScanId: string | null
  readonly createdAt: Date
}

export interface FlowFacts<S extends ScanFact> {
  readonly bundle: { readonly id: string; readonly code: string; readonly quantity: number; readonly createdAt: Date }
  readonly operations: readonly ScanOperation[]
  /** The bundle's own standing scans (scans standingScans), keyed `<bundle>|<operation>`. */
  readonly standing: ReadonlyMap<string, S>
  /** Its children split off it (any status). */
  readonly children: readonly { readonly quantity: number; readonly status: 'ACTIVE' | 'VOID' }[]
  /** The reworks that name it as their bundle, CANCELLED ones left out. */
  readonly reworks: readonly FlowRework[]
  /** Its parent with the parent's own flow (bundleFlow of the parent), when it was split off one. */
  readonly parent: { readonly id: string; readonly standing: ReadonlyMap<string, S> } | null
}

export interface Flow<S extends ScanFact> {
  /** The garments a scan of it may report at the first operation (its live garments). */
  readonly quantity: number
  /** Its standing scans as the cap reads them (keyed to it). */
  readonly standing: Map<string, S>
  /** Why no scan takes it now (every garment in an open rework), or null. */
  readonly refusal: ScanRefusal | null
}

const seqOf = (operations: readonly ScanOperation[], operationId: string | null): number | null => (operationId ? (operations.find((operation) => operation.id === operationId)?.seq ?? null) : null)

/** What a scan of a bundle (maybe split, maybe a child, maybe in rework) may report (see the file's head). */
export function bundleFlow<S extends ScanFact>(facts: FlowFacts<S>): Flow<S> {
  const live = liveGarments(facts.bundle.quantity, facts.children)
  const standing = new Map<string, S>(facts.standing)
  const operations = facts.operations
  // A rework that holds every garment of the bundle: a child split off for it, or a whole bundle sent back.
  const holding = facts.reworks.find((rework) => rework.status !== 'CANCELLED' && rework.quantity >= live) ?? null
  const childRework = facts.parent ? holding : null
  const foundSeq = childRework ? seqOf(operations, childRework.foundAtOperationId) : null

  // A child takes its parent's place in the flow at the split (before the fault's operation when it carries rework).
  if (facts.parent) {
    for (const operation of operations) {
      const key = standingKey(facts.bundle.id, operation.id)
      if (standing.has(key)) continue
      if (foundSeq !== null && operation.seq >= foundSeq) continue
      const passed = facts.parent.standing.get(standingKey(facts.parent.id, operation.id))
      if (!passed || passed.serverTime.getTime() > facts.bundle.createdAt.getTime()) continue
      standing.set(key, { ...passed, bundleId: facts.bundle.id, goodQuantity: Math.min(passed.goodQuantity, live) })
    }
  }

  // Rework DONE: its good garments count as passed where the fault was found.
  for (const rework of facts.reworks) {
    if (rework.status !== 'DONE' || !rework.foundAtOperationId) continue
    const key = standingKey(facts.bundle.id, rework.foundAtOperationId)
    const own = standing.get(key)
    if (own && own.serverTime.getTime() <= rework.createdAt.getTime() && facts.standing.has(key)) {
      // The report that counted them as rework (the bundle itself was sent back).
      standing.set(key, { ...own, goodQuantity: own.goodQuantity + rework.goodQuantity })
    } else if (!own && facts.parent) {
      // A rework child: the parent's report at that operation is where they rejoin.
      const source = facts.parent.standing.get(standingKey(facts.parent.id, rework.foundAtOperationId))
      if (source) standing.set(key, { ...source, bundleId: facts.bundle.id, goodQuantity: rework.goodQuantity })
    }
  }

  // The parent counts at most its live garments.
  for (const [key, scan] of standing) if (scan.goodQuantity > live) standing.set(key, { ...scan, goodQuantity: live })

  let refusal: ScanRefusal | null = null
  if (holding && holding.status !== 'DONE') {
    const found = operations.find((operation) => operation.id === holding.foundAtOperationId) ?? null
    const back = operations.find((operation) => operation.id === holding.reworkAtOperationId) ?? null
    refusal = {
      code: 'PREVIOUS_NOT_REPORTED',
      message: `Bundle ${facts.bundle.code} is in rework (${holding.reasonCode}): back to ${back ? operationLabel(back) : 'its operation'}${found ? `, found at ${operationLabel(found)}` : ''}.`,
      fix: 'It moves on when its rework is done: finish the rework first (Scrap & rework).',
      final: false,
    }
  }
  return { quantity: live, standing, refusal }
}
