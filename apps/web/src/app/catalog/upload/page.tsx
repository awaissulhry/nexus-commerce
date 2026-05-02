import { redirect } from 'next/navigation'

// Phase 4 cleanup: this is a back-compat redirect, not a real page.
// It exists explicitly so that /catalog/upload doesn't get caught by
// the /catalog/[id] catch-all redirect (which would forward it to
// /products/upload — that's not a valid product ID).
export default function Page() {
  redirect('/inventory/upload')
}
