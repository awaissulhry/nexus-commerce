import type { LabelInput, LabelLanguage } from '../../labels/model'
import { CUTTABLE_STATUSES } from '../cutting/rules'
import type { WorkOrderStatus } from '../work-orders/machine'
import type { BundleRefusal } from './rules'
import type { BundleTicket } from './ticket'

/**
 * One bundle code or a coupon per operation (B-W2b-41; MES-067; design production.settings "Bundle codes",
 * floor.operation "Checks before it counts"), pure. A site chooses (ProductionSettings.bundleCodeMode):
 *
 *   ONE_CODE               the bundle's ticket is scanned at every operation (W1; the default).
 *   COUPON_PER_OPERATION   each scanned operation of a bundle also gets a coupon (BundleCoupon): a stub with its own
 *                          code, scanned at that operation only. A scan of a coupon reports the coupon's operation
 *                          (the station's next operation is not guessed); a coupon of another operation than the one
 *                          named is refused; a lost coupon is VOID with its reason and replaced by a new one, and
 *                          scanning the old one is refused with the new code in the words. The bundle's own ticket still
 *                          scans in both modes (decided: the floor screens find the bundle by it; a "coupon required"
 *                          rule would be a floor rule per site, B-W2b-53).
 *
 * Codes: a coupon's code is a BUNDLE scannable id from the tenant's BUNDLE counter (`BN-…`): no COUPON number kind
 * exists in the schema (a schema need, named), and one counter keeps a coupon's code and every ticket's code apart for
 * good. So every scanner route that reads a bundle ticket reads a coupon too.
 *
 * Which operations get one: the work order's scanned operations (`scanRequired`) that have no ACTIVE coupon of the
 * bundle and no standing report yet (a coupon for work already reported proves nothing). Only an ACTIVE bundle of an
 * open work order gets coupons; a voided bundle's coupons are voided with it.
 */

export const BUNDLE_CODE_MODES = ['ONE_CODE', 'COUPON_PER_OPERATION'] as const
export type BundleCodeMode = (typeof BUNDLE_CODE_MODES)[number]

/** The most coupons one request prints (a work order's bundles × operations). */
export const MAX_COUPONS_PER_ISSUE = 400

export interface CouponOperation {
  readonly id: string
  readonly seq: number
  readonly code: string
  readonly name: string
  readonly scanRequired: boolean
}

export interface CouponFacts {
  readonly id: string
  readonly code: string
  readonly workOrderOperationId: string
  readonly status: 'ACTIVE' | 'VOID'
}

export interface CouponBundle {
  readonly id: string
  readonly code: string
  readonly status: 'ACTIVE' | 'VOID'
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const operationWords = (operation: Pick<CouponOperation, 'seq' | 'name' | 'code'>) => `${operation.seq} · ${operation.name || operation.code}`

/** Why coupons are not printed at all now: the site scans one bundle code, or the work order is not open. */
export function couponsRefusal(facts: { readonly mode: BundleCodeMode; readonly workOrder: { readonly number: string; readonly status: WorkOrderStatus } }): BundleRefusal | null {
  if (facts.mode !== 'COUPON_PER_OPERATION') {
    return { code: 'COUPONS_OFF', message: 'This site scans one bundle code at every operation: it prints no coupons. Production › Settings › Bundle codes switches to a coupon per operation.' }
  }
  if (!CUTTABLE_STATUSES.includes(facts.workOrder.status)) {
    return { code: 'WORK_ORDER_NOT_OPEN', message: `Work order ${facts.workOrder.number} is ${facts.workOrder.status}; its bundles get coupons only while it is RELEASED or IN_PROGRESS.` }
  }
  return null
}

/**
 * The operations of one bundle that still need a coupon, in routing order: scanned operations with no ACTIVE coupon and
 * no standing report. An empty list for a VOID bundle.
 */
export function couponsToIssue(facts: {
  readonly bundle: CouponBundle
  readonly operations: readonly CouponOperation[]
  readonly coupons: readonly CouponFacts[]
  /** The operations the bundle has a standing report at. */
  readonly reportedAt: ReadonlySet<string>
}): CouponOperation[] {
  if (facts.bundle.status !== 'ACTIVE') return []
  const covered = new Set(facts.coupons.filter((coupon) => coupon.status === 'ACTIVE').map((coupon) => coupon.workOrderOperationId))
  return [...facts.operations]
    .filter((operation) => operation.scanRequired && !covered.has(operation.id) && !facts.reportedAt.has(operation.id))
    .sort((a, b) => a.seq - b.seq)
}

/** Nothing to print for these bundles: every scanned operation has its coupon (or was reported). */
export function nothingToCoupon(bundles: number): BundleRefusal {
  return { code: 'NOTHING_TO_COUPON', message: `Every scanned operation of ${bundles === 1 ? 'this bundle' : `these ${plural(bundles, 'bundle')}`} has its coupon already, or was reported: nothing to print. Reprint a lost coupon instead.` }
}

/** Why a coupon may not be reprinted (a new code; the old one VOID) or voided, or null. */
export function couponChangeRefusal(facts: {
  readonly coupon: CouponFacts
  readonly bundle: CouponBundle
  readonly workOrder: { readonly number: string; readonly status: WorkOrderStatus }
  readonly reprint: boolean
}): BundleRefusal | null {
  if (facts.coupon.status === 'VOID') return { code: 'COUPON_VOIDED', message: `Coupon ${facts.coupon.code} is voided already: ${facts.reprint ? 'reprint the coupon that replaced it, if any' : 'nothing to do'}.` }
  if (facts.reprint && facts.bundle.status !== 'ACTIVE') return { code: 'VOIDED', message: `Bundle ${facts.bundle.code} is voided: its coupons are not printed again.` }
  if (!CUTTABLE_STATUSES.includes(facts.workOrder.status)) {
    return { code: 'WORK_ORDER_NOT_OPEN', message: `Work order ${facts.workOrder.number} is ${facts.workOrder.status}; its coupons change only while it is RELEASED or IN_PROGRESS.` }
  }
  return null
}

/**
 * What a scanned coupon means for a report (the scans module's hook, apps/factory-api bundles/store.ts couponForScan):
 * the operation it reports, or why it takes nothing. A VOID coupon is refused: REPLACED with the coupon that replaced
 * it (an old stub), else VOIDED; a coupon of another operation than the one the device named is NOT_AN_OPERATION.
 */
export type CouponScan =
  | { readonly ok: true; readonly operationId: string }
  | { readonly ok: false; readonly code: 'REPLACED' | 'VOIDED' | 'NOT_AN_OPERATION'; readonly message: string; readonly fix: string }

export function couponScan(facts: {
  readonly coupon: CouponFacts
  /** The ACTIVE coupon that replaced it (same bundle and operation), when it is VOID. */
  readonly replacement: { readonly code: string } | null
  readonly operation: Pick<CouponOperation, 'seq' | 'name' | 'code'> | null
  /** The operation the device named, or null (the coupon's own is used). */
  readonly named: { readonly id: string; readonly seq: number; readonly name: string; readonly code: string } | null
}): CouponScan {
  const { coupon } = facts
  if (coupon.status === 'VOID') {
    return facts.replacement
      ? { ok: false, code: 'REPLACED', message: `Coupon ${coupon.code} was replaced by ${facts.replacement.code}: use the new coupon.`, fix: `Discard it and scan the new coupon ${facts.replacement.code}.` }
      : { ok: false, code: 'VOIDED', message: `Coupon ${coupon.code} is voided: no scan takes it.`, fix: 'Discard it and ask your team leader for a new coupon.' }
  }
  if (facts.named && facts.named.id !== coupon.workOrderOperationId) {
    const own = facts.operation ? operationWords(facts.operation) : 'another operation'
    return { ok: false, code: 'NOT_AN_OPERATION', message: `Coupon ${coupon.code} is for operation ${own}, not ${operationWords(facts.named)}.`, fix: `Scan the coupon of operation ${operationWords(facts.named)}, or report ${own} with this one.` }
  }
  return { ok: true, operationId: coupon.workOrderOperationId }
}

// ---- the coupon's label ----------------------------------------------------------------------------------------------------

/** A coupon as printed: the bundle's ticket content, the coupon's own code and the one operation it is for. */
export interface CouponTicket {
  readonly code: string
  readonly bundleCode: string
  readonly operation: { readonly seq: number; readonly code: string; readonly name: string }
  readonly ticket: Pick<BundleTicket, 'language' | 'maker' | 'workOrder' | 'style' | 'colourway' | 'size' | 'quantity' | 'part'>
}

const COUPON_TITLE: Readonly<Record<LabelLanguage, (seq: number, name: string) => string>> = {
  it: (seq, name) => `Fase ${seq} · ${name}`,
  en: (seq, name) => `Operation ${seq} · ${name}`,
}

/**
 * The coupon as factory-domain/labels' BUNDLE label (its code as the barcode; the operation as the title; the bundle's
 * work order, style, size, colour and pieces as fields; the operation field names the bundle's ticket it belongs to).
 * The same LabelInput is the PDF fallback and, through labels' ZPL, the label printer's coupon. No money, no person.
 */
export function couponLabel(coupon: CouponTicket): LabelInput {
  const { ticket } = coupon
  return {
    kind: 'BUNDLE',
    language: ticket.language,
    scanId: coupon.code,
    maker: ticket.maker,
    title: COUPON_TITLE[ticket.language](coupon.operation.seq, coupon.operation.name || coupon.operation.code),
    fields: {
      workOrder: ticket.workOrder.batchNumber ? `${ticket.workOrder.number} · ${ticket.workOrder.batchNumber}` : ticket.workOrder.number,
      style: ticket.style.code,
      size: ticket.size,
      colour: [ticket.colourway.code, ticket.colourway.name].filter((part) => part !== '').join(' '),
      pieces: ticket.part ? `${ticket.quantity} · ${ticket.part}` : String(ticket.quantity),
      operation: `${coupon.operation.seq} · ${coupon.bundleCode}`,
    },
  }
}
