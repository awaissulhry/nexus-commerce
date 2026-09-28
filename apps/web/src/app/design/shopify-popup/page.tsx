/**
 * /design/shopify-popup — the Shopify cell pop-up on made-up data (sheet pop-up rebuild P1). Needs no store and no API,
 * like /design/grid-lab: it works in local dev, on Vercel and on production alike.
 */
import { ShopifyPopupLab } from './ShopifyPopupLab'

export const metadata = { title: 'Shopify pop-up lab' }

export default function ShopifyPopupLabPage() {
  return <ShopifyPopupLab />
}
