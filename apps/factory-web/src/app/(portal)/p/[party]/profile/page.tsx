import { SupplierProfileRoute } from '../../../../../portal/supplier/profile/ProfilePage'

/**
 * `/p/<party code>/profile` — a supplier's or a workshop's Profile (B-W2b-193, SCR-191; design portal.supplier.profile):
 * company and contacts (changes go to the buyer for a check), portal users, e-mail settings, sign-in and sessions. The
 * frame (the layout) comes with it; anyone else is told the page is not part of their access.
 */
export default function PortalProfilePage() {
  return <SupplierProfileRoute />
}
