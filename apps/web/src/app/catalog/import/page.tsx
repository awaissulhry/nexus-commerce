import { redirect } from 'next/navigation'

// Phase 4 cleanup: /catalog/import was a stub. Files are imported on the
// Products page's "Import & export" page (/products/upload retired 2026-10-01).
export default function Page() {
  redirect('/products/catalog-transfer')
}
