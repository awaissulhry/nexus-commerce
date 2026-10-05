import { shopifyStatusLabel } from '@nexus/shared/shopify-information'

/** Wave 2 D4 — a new product is created with the Status column's choice (Active, or a Draft); Not listed creates nothing. */
export const newProductWords = (status: string | null | undefined) =>
  status ? `${shopifyStatusLabel(status)} (the Status column's choice)` : 'not created: its Status is Not listed'
