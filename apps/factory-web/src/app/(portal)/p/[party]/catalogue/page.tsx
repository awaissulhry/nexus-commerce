'use client'

import { CustomerCataloguePage } from '../../../../../portal/customer/catalogue/CataloguePage'

/**
 * `/p/<party code>/catalogue?q=&category=&season=&ppe=&range=&view=&style=` — the customer's Catalogue (B-W2b-194, SCR-226;
 * design portal.customer.catalogue): the styles they may buy with their prices, the style's detail, "Add to order". The
 * page says by itself when it is not part of the person's access (a supplier, a role without the catalogue).
 */
export default function PortalCataloguePage() {
  return <CustomerCataloguePage />
}
