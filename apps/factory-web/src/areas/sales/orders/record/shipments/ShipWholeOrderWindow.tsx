'use client'

/**
 * SLOT — owner: S3 (owb-ss3); filled by ss3 step 3.1 (the window "Ship the whole order…": alone · together · to our warehouse first).
 * Placed by the base (owb-b5 w5.5) with its FINAL export name and props, so the owner edits only this file. Until it is filled it
 * draws nothing (null). Where: the band opens it as its next act on an order ready to ship (S2 of5 mounts it); not mounted by the base. Office only: the customer never reaches it.
 */
export interface ShipWholeOrderWindowProps {
  readonly open: boolean
  readonly onClose: () => void
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The order (SalesOrder id). */
  readonly orderId: string
}

export function ShipWholeOrderWindow(_props: ShipWholeOrderWindowProps): null {
  return null
}
