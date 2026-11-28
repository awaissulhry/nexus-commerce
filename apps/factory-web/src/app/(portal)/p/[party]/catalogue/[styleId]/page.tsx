'use client'

import { use } from 'react'
import { CustomerProductPage } from '../../../../../../portal/customer/catalogue/product/ProductPage'

/**
 * `/p/<party code>/catalogue/<styleId>?tab=overview|sizes` — owb-pd4 step 4.5 (gap G9; design § 5q "Customer"): the customer's product
 * page — its own design or the range priced for it — with two tabs, Overview and Sizes. A catalogue card opens it.
 */
export default function PortalProductPage({ params }: { params: Promise<{ styleId: string }> }) {
  const { styleId } = use(params)
  return <CustomerProductPage styleId={decodeURIComponent(styleId)} />
}
