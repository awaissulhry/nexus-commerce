'use client'

/**
 * SLOT — owner: S3 (owb-ss7); filled by ss7 step 7.3 (the order's team part: its teams as TeamChips, Give to a team…, Ask for another team).
 * Placed by the base (owb-b5 w5.5) with its FINAL export name and props, so the owner edits only this file. Until it is filled it
 * draws nothing (null). Where: MOUNTED by the base in the office order page's Production tab (areas/sales/orders/record/view/ProductionTab.tsx), after Order structure. Office only: the customer never reaches it.
 */
export interface OrderTeamPartProps {
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The order (SalesOrder id). */
  readonly orderId: string
}

export function OrderTeamPart(_props: OrderTeamPartProps): null {
  return null
}
