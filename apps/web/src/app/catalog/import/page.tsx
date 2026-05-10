import { redirect } from 'next/navigation'

// Phase 4 cleanup: /catalog/import was a stub; the real bulk-upload
// flow lives at /products/upload (IM.1 — relocated from /inventory).
export default function Page() {
  redirect('/products/upload')
}
