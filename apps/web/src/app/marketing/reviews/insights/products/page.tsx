// /marketing/reviews/insights/products — Reviews › Insights › Products (build spec §3.4): each product's rating, top
// complaint and return rate by family, and one product's pop-up (`?product=<id>`). ProductsClient reads the address on
// the client and renders its own PageHeader inside the Reviews shell.
import type { Metadata } from 'next'
import { Suspense } from 'react'
import { InsightsSkeleton } from '../_shared/InsightsSkeleton'
import { ProductsClient } from './ProductsClient'

export const metadata: Metadata = { title: 'Reviews · Insights · Products' }

export default function ReviewsInsightsProductsPage() {
  return (
    <Suspense fallback={<InsightsSkeleton label="Loading the products" />}>
      <ProductsClient />
    </Suspense>
  )
}
