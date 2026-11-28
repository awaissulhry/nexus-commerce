'use client'

/**
 * SLOT — owner: S3 (owb-ss8); filled by ss8 step 8.4 (the part "Order structure": each line's structure and its rule, Another structure for this order…).
 * Placed by the base (owb-b5 w5.5) with its FINAL export name and props, so the owner edits only this file. Until it is filled it
 * draws nothing (null). Where: MOUNTED by the base in the office order page's Production tab (areas/sales/orders/record/view/ProductionTab.tsx), after Materials. Office only: the customer never reaches it.
 */
export interface OrderStructurePartProps {
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The order (SalesOrder id). */
  readonly orderId: string
}

export function OrderStructurePart(_props: OrderStructurePartProps): null {
  return null
}
