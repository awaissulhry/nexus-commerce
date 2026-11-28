'use client'

/**
 * SLOT — owner: S3 (owb-ss4); filled by ss4 step 4.3 (the window "Print again": the same codes, ticked pages and cards, a reason).
 * Placed by the base (owb-b5 w5.5) with its FINAL export name and props, so the owner edits only this file. Until it is filled it
 * draws nothing (null). Where: Production › Baskets and Place the scan code open it (S2 of6 mounts it); not mounted by the base. Office only: the customer never reaches it.
 */
export interface PrintAgainWindowProps {
  readonly open: boolean
  readonly onClose: () => void
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The order (SalesOrder id). */
  readonly orderId: string
}

export function PrintAgainWindow(_props: PrintAgainWindowProps): null {
  return null
}
