import { redirect } from 'next/navigation'

// /inventory has been replaced by /products. Bookmarks and stale
// internal links land here and bounce to the new home.
export default function InventoryRedirectPage() {
  redirect('/products')
}
