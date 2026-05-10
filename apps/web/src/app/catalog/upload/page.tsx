import { redirect } from 'next/navigation'

// Phase 4 cleanup: this is a back-compat redirect, not a real page.
// It exists explicitly so that /catalog/upload doesn't get caught by
// the /catalog/[id] catch-all redirect. Target updated to the IM.1
// relocation under /products/upload (was /inventory/upload).
export default function Page() {
  redirect('/products/upload')
}
