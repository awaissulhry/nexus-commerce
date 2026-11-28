'use client'

/**
 * SLOT — owner: S3 (owb-ss3); filled by ss3 step 3.2 (the warehouse leg: ARRIVED = It arrived at the warehouse · SEND_ON = Send on to the customer).
 * Placed by the base (owb-b5 w5.5) with its FINAL export name and props, so the owner edits only this file. Until it is filled it
 * draws nothing (null). Where: the band opens it at our warehouse (S2 of5 mounts it; S2 ask 23:35); not mounted by the base. Office only: the customer never reaches it.
 */
export interface WarehouseLegWindowProps {
  readonly open: boolean
  readonly onClose: () => void
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The order (SalesOrder id). */
  readonly orderId: string
  /** Which act the window does: the order arrived at our warehouse, or it is sent on to the customer. */
  readonly act: 'ARRIVED' | 'SEND_ON'
}

export function WarehouseLegWindow(_props: WarehouseLegWindowProps): null {
  return null
}
