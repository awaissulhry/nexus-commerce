'use client'

import { use } from 'react'
import { CustomerStyleSheetPage } from '../../../../../../../portal/customer/catalogue/StyleSheetPage'

/**
 * `/p/<party code>/catalogue/<styleId>/sheet` — one style on one sheet in a new tab (B-W2b-194; design
 * portal.customer.neworder tab:style-sheet): to read beside the draft, or to print and save as PDF.
 */
export default function PortalStyleSheetPage({ params }: { params: Promise<{ styleId: string }> }) {
  const { styleId } = use(params)
  return <CustomerStyleSheetPage styleId={styleId} />
}
