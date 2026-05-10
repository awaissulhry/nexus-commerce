// IM.1 — canonical home moved to /products/stranded. Bookmarks
// + stale internal links land here and bounce to the new home.
import { redirect } from 'next/navigation'

export default function StrandedInventoryRedirectPage() {
  redirect('/products/stranded')
}
