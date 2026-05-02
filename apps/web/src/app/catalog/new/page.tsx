import { redirect } from 'next/navigation'

// Phase 4 cleanup: /catalog/new merged into /catalog/add (the more
// comprehensive new-product form).
export default function Page() {
  redirect('/catalog/add')
}
