'use client'

import { CustomerReturnsPage } from '../../../../../portal/customer/returns/ReturnsPage'

/**
 * `/p/<party code>/returns?chip=&q=&start=` — the customer's Returns & claims (B-W2b-197, SCR-187; design
 * portal.customer.returns): every case with its next step, the Quality role's complaints, "Start a return or claim". The
 * frame (the layout) comes with it; a person without the page reads "not part of your access".
 */
export default function PortalReturnsPage() {
  return <CustomerReturnsPage />
}
