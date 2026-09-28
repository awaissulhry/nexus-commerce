/**
 * /design/media-popup — the Product media cell pop-up on made-up data (Lane C). Needs no store and no API, like
 * /design/shopify-popup: it works in local dev, on Vercel and on production alike.
 */
import { MediaPopupLab } from './MediaPopupLab'

export const metadata = { title: 'Product media pop-up lab' }

export default function MediaPopupLabPage() {
  return <MediaPopupLab />
}
