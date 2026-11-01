import type { WorkOrderStatus } from './machine'
import type { ReleaseCheck, ReleaseCheckCode } from './release'

/**
 * Bulk actions on work orders (B-W2b-51; MES-017 "Bulk actions on work orders"; design production.workorders h.act
 * "Release… (selection-aware, W2b bulk)", wo-grid selection row "'Release 4 work orders' (W2b, ReviewChangesModal with
 * per-row blockers) · 'Change priority' (W2b)", h.more "Print travellers (W2b)"), pure. They go through the list frame's
 * bulk preview and apply (apps/factory-api platform/views/bulk, one target per action), each row through the work
 * order's OWN command:
 *
 *   release          the list `production.work-orders.release`, field `status` → RELEASED: each selected DRAFT with its
 *                    release check (THE check of the record and the release command); a row the check holds is refused
 *                    with the codes of the checks that block it (`reasons`: CERTIFICATE, MATERIAL, …), which the
 *                    screen says in its own words; a row already released counts as already so. No material override in
 *                    bulk: a shortage is released one work order at a time, with the planner's reason.
 *   change priority  the list `production.work-orders`, fields `priority` and `rush` (beside the due date of B-W2b-13).
 *   travellers       one PDF for the selected work orders (GET /production/work-orders/travellers?ids=…).
 *
 * The release check reads a lot per work order (stock, certificates, deposits, the plan), so one bulk release reaches at
 * most RELEASE_BULK_LIMIT rows; the preview checks each row against today's stock on its own, so two selected work
 * orders that need the same short material both show releasable and the second is refused at Save (MATERIAL).
 */

export const RELEASE_BULK_LIMIT = 50

/** At most this many travellers in one PDF. */
export const TRAVELLER_BULK_LIMIT = 50

/** The codes of the checks that hold a release (BLOCKED), in the checklist's order. */
export function blockingCodes(checks: readonly Pick<ReleaseCheck, 'code' | 'state'>[]): ReleaseCheckCode[] {
  return checks.filter((check) => check.state === 'BLOCKED').map((check) => check.code)
}

/** A work order before its release: a DRAFT, or a DRAFT put on hold (its check shows the hold as a blocker). */
export function beforeRelease(row: { readonly status: WorkOrderStatus; readonly heldFromStatus?: WorkOrderStatus | null }): boolean {
  return row.status === 'DRAFT' || (row.status === 'ON_HOLD' && row.heldFromStatus === 'DRAFT')
}

/** What the bulk release's `status` field reads on a row: its status before the release; RELEASED once released (whatever came after), CANCELLED. */
export function releaseFieldOf(row: { readonly status: WorkOrderStatus; readonly heldFromStatus?: WorkOrderStatus | null }): WorkOrderStatus {
  if (beforeRelease(row) || row.status === 'CANCELLED') return row.status
  return 'RELEASED'
}
