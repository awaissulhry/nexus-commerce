import { redirect } from 'next/navigation'

// Phase 4 cleanup: /catalog/import was a stub; the real bulk-upload
// flow lives at /inventory/upload.
export default function Page() {
  redirect('/inventory/upload')
}
