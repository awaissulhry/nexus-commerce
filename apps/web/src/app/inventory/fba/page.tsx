// IM.1 — canonical home moved to /products/fba. Bookmarks
// + stale internal links land here and bounce to the new home.
import { redirect } from 'next/navigation'

export default function FBAInventoryRedirectPage() {
  redirect('/products/fba')
}
