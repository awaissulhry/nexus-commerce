'use client'

import { AccountantRoute } from '../../../../../portal/guest/accountant/AccountantPage'

/**
 * `/p/<party code>/accounting?period=` — the accountant's room (B-W2b-201, SCR-268; design portal.guest.accountant): the
 * periods finance handed over, their accounting exports, e-invoices and registers, files only, and Ask finance. Only the
 * guest (adviser) portal opens it; any other person reaching the address is told it is not part of their access.
 */
export default function PortalAccountingPage() {
  return <AccountantRoute />
}
