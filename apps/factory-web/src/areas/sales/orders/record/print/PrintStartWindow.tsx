'use client'

/**
 * SLOT — owner: S3 (owb-ss4); filled by ss4 step 4.1 (the window "Print and start the work": what prints, the problems in words, Print and start the work).
 * Placed by the base (owb-b5 w5.5) with its FINAL export name and props, so the owner edits only this file. Until it is filled it
 * draws nothing (null). Where: the order page's band opens it as its next act on a confirmed order (S2 of5 mounts it); not mounted by the base. Office only: the customer never reaches it.
 */
export interface PrintStartWindowProps {
  readonly open: boolean
  readonly onClose: () => void
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The order (SalesOrder id). */
  readonly orderId: string
}

export function PrintStartWindow(_props: PrintStartWindowProps): null {
  return null
}
