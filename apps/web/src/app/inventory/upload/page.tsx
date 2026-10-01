// IM.1 — bookmarks and stale internal links land here and bounce to the
// Products page's "Import & export" page (/products/upload retired 2026-10-01).
import { redirect } from 'next/navigation'

export default function InventoryUploadRedirectPage() {
  redirect('/products/catalog-transfer')
}
