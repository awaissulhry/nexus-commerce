// IM.1 — canonical home moved to /products/upload. Bookmarks
// + stale internal links (and /catalog/upload, /catalog/import)
// land here and bounce to the new home.
import { redirect } from 'next/navigation'

export default function InventoryUploadRedirectPage() {
  redirect('/products/upload')
}
