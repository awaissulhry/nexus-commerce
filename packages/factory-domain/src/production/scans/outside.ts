import type { WorkOrderStatus } from '../work-orders/machine'
import { isOpen, type Counts, type ScanFact, type ScanOperation } from './rules'

/**
 * An outside operation reported at receive back (B-W2b-10; the follow-up of B-W2a-25 and B-W2a-76; design
 * purchasing.subcontracting "Received back", floor.kits "Receive back"), pure. When a workshop sends a bundle back, the
 * operation it did is reported for the bundle, so the next operation takes it (the scans cap a later operation at what
 * the previous scanned one passed). apps/factory-api modules/production/scans/outside.ts reads the facts under the scan
 * locks inside the receive command and writes the OperationScan; the scan trigger stays the last word.
 *
 *   who      the scan names the subcontract receipt line that brought the bundle back (OperationScan.subcontract-
 *            ReceiptLineId), never a worker, a station or a device: the workshop did the work, the receipt says where
 *            (the order's workshop and its location); the person who received it is the scan's createdById (the office
 *            user; null when the floor's kit task received it as the tenant's system caller, whose audit row names the
 *            tablet and its worker inside the one record).
 *   counts   the line's: good as good, scrapped at the workshop as scrap, defective (rejected at our check) as rework.
 *   when     a line that names a bundle, ACTIVE, of a work order RELEASED or IN_PROGRESS, not on hold, at most the
 *            garments still in the bundle; else nothing is written and the answer says why in words (the office reports
 *            it later from the receipt line: POST /production/scans/receipt-lines/:lineId/report).
 *   again    a bundle has one standing report per operation (MES-069). A later receipt of the same bundle and operation
 *            adds its counts to the report an earlier receipt line made: a CORRECTION approved by the office person who
 *            receives (the floor's system caller cannot approve: then the answer says so and the office adds it). A
 *            report someone made on the floor stands as it is (it is never overwritten from a receipt).
 */

/** The device-free client scan id of a receipt line's scan (OperationScan's unique key is per device: null here). */
export const receiptLineClientId = (lineId: string): string => `receipt-line:${lineId}`

export interface OutsideLine {
  readonly good: number
  readonly defective: number
  readonly scrapped: number
}

/** The line's counts as a scan's: good; scrapped as scrap; defective as rework (the trigger's rule). */
export const outsideCounts = (line: OutsideLine): Counts => ({ good: line.good, scrap: line.scrapped, rework: line.defective })

export interface OutsideFacts {
  readonly line: OutsideLine
  /** The bundle the line brought back (null: pieces counted without one), with its live garments (a split parent's). */
  readonly bundle: { readonly code: string; readonly status: 'ACTIVE' | 'VOID'; readonly live: number } | null
  readonly workOrder: { readonly number: string; readonly status: WorkOrderStatus }
  readonly operation: Pick<ScanOperation, 'seq' | 'name'>
  /** The bundle's standing report at the operation, and whether a receipt line made it (itself or the report it corrects). */
  readonly standing: (Pick<ScanFact, 'id' | 'goodQuantity' | 'scrapQuantity' | 'reworkQuantity'> & { readonly fromReceipt: boolean }) | null
  /** Why a hold stops its scans (quality/holds holdOnScan's words), or null. */
  readonly held: string | null
  /** An office person receives (and may approve the correction that adds a later receipt). */
  readonly byPerson: boolean
}

export type OutsidePlan =
  | { readonly action: 'REPORT'; readonly counts: Counts }
  | { readonly action: 'CORRECTION'; readonly correctsId: string; readonly counts: Counts; readonly added: number }
  | { readonly action: 'NONE'; readonly words: string }

const garments = (count: number) => `${count} garment${count === 1 ? '' : 's'}`
const total = (counts: Counts) => counts.good + counts.scrap + counts.rework
const at = (operation: Pick<ScanOperation, 'seq' | 'name'>) => `Op ${operation.seq} ${operation.name}`
const later = 'the office reports it from the receipt line when it can (Report at the operation).'

/** What a receipt line writes at its outside operation: a REPORT, a CORRECTION adding it to an earlier receipt's, or nothing (why). */
export function outsidePlan(facts: OutsideFacts): OutsidePlan {
  const { bundle, operation } = facts
  const counts = outsideCounts(facts.line)
  if (!bundle) return { action: 'NONE', words: `Pieces came back without a bundle: no bundle is reported at ${at(operation)} (the next operation takes bundles).` }
  if (bundle.status !== 'ACTIVE') return { action: 'NONE', words: `Bundle ${bundle.code} is voided: it is not reported at ${at(operation)}.` }
  if (!isOpen(facts.workOrder.status)) {
    return { action: 'NONE', words: `Work order ${facts.workOrder.number} is ${facts.workOrder.status}: bundle ${bundle.code} is not reported at ${at(operation)} now; ${later}` }
  }
  if (facts.held) return { action: 'NONE', words: `${facts.held} Bundle ${bundle.code} is not reported at ${at(operation)} now; ${later}` }
  if (facts.standing) {
    if (!facts.standing.fromReceipt) {
      return { action: 'NONE', words: `Bundle ${bundle.code} is reported at ${at(operation)} already, on the floor: one report per bundle per operation. If the workshop's counts differ, correct that report.` }
    }
    const summed = { good: facts.standing.goodQuantity + counts.good, scrap: facts.standing.scrapQuantity + counts.scrap, rework: facts.standing.reworkQuantity + counts.rework }
    if (total(summed) > bundle.live) {
      return { action: 'NONE', words: `Bundle ${bundle.code} carries ${garments(bundle.live)}; ${total(summed)} would be reported at ${at(operation)} with the earlier receipts: correct the report by hand.` }
    }
    if (!facts.byPerson) return { action: 'NONE', words: `Bundle ${bundle.code} is reported at ${at(operation)} from an earlier receipt: the office adds these ${garments(total(counts))} to it (Report at the operation).` }
    return { action: 'CORRECTION', correctsId: facts.standing.id, counts: summed, added: total(counts) }
  }
  if (total(counts) > bundle.live) {
    return { action: 'NONE', words: `Bundle ${bundle.code} carries ${garments(bundle.live)} now; the receipt brought back ${total(counts)}: it is not reported at ${at(operation)} (correct the receipt's bundle by hand).` }
  }
  return { action: 'REPORT', counts }
}

/** The receipt-line scan's REPORT a CORRECTION chain starts from (the root of `correctsId`), or null. */
export function rootReport<Scan extends Pick<ScanFact, 'id' | 'correctsId' | 'kind'>>(scans: readonly Scan[], scanId: string): Scan | null {
  const byId = new Map(scans.map((scan) => [scan.id, scan]))
  let scan = byId.get(scanId)
  for (let depth = 0; scan && scan.kind !== 'REPORT' && scan.correctsId && depth < 64; depth++) scan = byId.get(scan.correctsId)
  return scan && scan.kind === 'REPORT' ? scan : null
}
