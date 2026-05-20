import { Suspense } from 'react'
import ProductsClient from './_components/ProductsClient'

export const dynamic = 'force-dynamic'

export default function InsightsProductsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-500">Loading product performance…</div>}>
      <ProductsClient />
    </Suspense>
  )
}
