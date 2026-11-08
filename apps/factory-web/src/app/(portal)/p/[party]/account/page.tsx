import { AccountRoute } from '../../../../../portal/customer/account/AccountRoute'

/**
 * `/p/<party code>/account` — the customer's Account (B-W2b-196, SCR-188; design portal.customer.account): my profile, e-mail
 * settings, colleagues and roles, delivery addresses, company data, sign-in and sessions. The frame (the layout) comes with it.
 */
export default function PortalAccountPage() {
  return <AccountRoute />
}
