import { redirect } from 'next/navigation'
export const dynamic = 'force-dynamic'
export default function BulkOperationsImportsPage() {
  redirect('/products/catalog-transfer?tab=sources')
}
