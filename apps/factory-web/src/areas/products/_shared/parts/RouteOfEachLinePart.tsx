'use client'

/**
 * SLOT — owner: S4 (owb-pd6); filled by pd6 step 6.4 (the part "Route of each line": each line's steps as a DeptBar, where it comes from, the pick and the exception route).
 * Placed by the base (owb-b5 w5.5) with its FINAL export name and props, so the owner edits only this file. Until it is filled it
 * draws nothing (null). Where: MOUNTED by the base in the office order page's Production tab (areas/sales/orders/record/view/ProductionTab.tsx), after Team. Office only: the customer never reaches it.
 */
export interface RouteOfEachLinePartProps {
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The order (SalesOrder id). */
  readonly orderId: string
}

export function RouteOfEachLinePart(_props: RouteOfEachLinePartProps): null {
  return null
}
