'use client'

/**
 * SLOT — owner: S3 (owb-ss8); filled by ss8 step 8.4 (the customer part "How its orders are handled": the rules that name this customer, New rule for this customer…).
 * Placed by the base (owb-b5 w5.5) with its FINAL export name and props, so the owner edits only this file. Until it is filled it
 * draws nothing (null). Where: MOUNTED by the base on the customer page's Terms & requirements tab, last (areas/sales/customers/record/view/terms/TermsTab.tsx). Office only: the customer never reaches it.
 */
export interface CustomerStructurePartProps {
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The customer (Party id). */
  readonly partyId: string
}

export function CustomerStructurePart(_props: CustomerStructurePartProps): null {
  return null
}
