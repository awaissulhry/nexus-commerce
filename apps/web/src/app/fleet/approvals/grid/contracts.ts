/**
 * Approvals grid (docs/approvals-grid/PLAN.md, wave 2) — the seams between the page's parts, so they can be built
 * side by side: the page (ApprovalsGrid + approvalActions), the side drawer (ApprovalDrawer) and the Automate modal
 * (AutomateModal). The wire types come from `@nexus/shared/approval-queue`; nothing here is fetched.
 */
import type { QueueRow, QueueTrustLevel } from '@nexus/shared/approval-queue'

/**
 * Every decision the page can make, in ONE place (approvalActions.ts). The grid's row verbs, the toolbar's bulk
 * buttons, the keyboard shortcuts and the drawer all call these, so a decision behaves the same wherever it starts.
 * Each one shows its own error next to the row (never cleared by the next refresh) and refreshes the queue after.
 */
export interface ApprovalActions {
  /** Approve one request: it is parked for the 20 s stop window, then runs (the server re-checks it first). */
  approve(row: QueueRow): Promise<void>
  /** Reject one request; the reason is optional and goes back to Claude. */
  reject(row: QueueRow, reason?: string): Promise<void>
  /** Take back an approve inside the stop window. */
  undo(row: QueueRow): Promise<void>
  /** Hold an approved request for 10 more minutes. */
  hold(row: QueueRow): Promise<void>
  /** Run a failed or handed-back request again: the same as approving it again. */
  retry(row: QueueRow): Promise<void>
  /** Open the "Automate this kind…" modal for this row's kind. */
  openAutomate(row: QueueRow): void
  /** Re-read the queue now (after the drawer changed something itself, e.g. an edit or an undo of a change). */
  refresh(): void
  /** Ids with a decision in flight: only THOSE rows are locked, never the page. */
  busyIds: ReadonlySet<string>
  /** The last error per row id, shown until the person closes it. */
  errors: ReadonlyMap<string, string>
  dismissError(id: string): void
}

/** apps/web/src/app/fleet/approvals/grid/ApprovalDrawer.tsx */
export interface ApprovalDrawerProps {
  /** The request to show; the drawer is closed when null. */
  id: string | null
  /** The row as the grid knows it (for the header while the detail loads); may be null on a deep link. */
  row: QueueRow | null
  actions: ApprovalActions
  /** Changes whenever the queue was re-read, so the drawer re-reads its detail too (plans show live step counts). */
  refreshKey: number
  onClose(): void
  /**
   * The drawer moved to another request it caused: the new request after an edit or a smaller plan replaced this one,
   * or the undo it asked for. The page makes that id the open one (its `?item=` and the row it hands back follow).
   */
  onFollow?(id: string): void
}

/** What the person chose in the Automate modal. */
export interface AutomateResult {
  /** The level now saved for this kind. */
  level: QueueTrustLevel
  /** The person ticked "Also approve this one": the PAGE approves the row through ApprovalActions.approve. */
  alsoApprove: boolean
}

/** apps/web/src/app/fleet/approvals/grid/AutomateModal.tsx */
export interface AutomateModalProps {
  /** The row it was opened from; the modal is closed when null. */
  row: QueueRow | null
  onClose(): void
  onSaved(result: AutomateResult): void
}
