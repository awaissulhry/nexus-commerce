'use client'

/**
 * SLOT — owner: S3 (owb-ss4); filled by ss4 step 4.4 (the window "Place the scan code": the page, the code dragged and sized, ≥ 20 mm).
 * Placed by the base (owb-b5 w5.5) with its FINAL export name and props, so the owner edits only this file. Until it is filled it
 * draws nothing (null). Where: Production › What we make it to and the Design desk open it (S2 of6, of7 mount it); not mounted by the base. Office only: the customer never reaches it.
 */
export interface PlaceScanCodeWindowProps {
  readonly open: boolean
  readonly onClose: () => void
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The order (SalesOrder id). */
  readonly orderId: string
}

export function PlaceScanCodeWindow(_props: PlaceScanCodeWindowProps): null {
  return null
}
