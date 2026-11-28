'use client'

/**
 * SLOT — owner: S5 (owb-fl9); filled by fl9 step 4 (the part "From the floor": floor photos, Changed on the floor, Will be late with its answer).
 * Placed by the base (owb-b5 w5.5) with its FINAL export name and props, so the owner edits only this file. Until it is filled it
 * draws nothing (null). Where: MOUNTED by the base in the office order page's Production tab (areas/sales/orders/record/view/ProductionTab.tsx), right after Work orders (the baskets). Office only: the customer never reaches it.
 */
export interface FromTheFloorPartProps {
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The order (SalesOrder id). */
  readonly orderId: string
}

export function FromTheFloorPart(_props: FromTheFloorPartProps): null {
  return null
}
