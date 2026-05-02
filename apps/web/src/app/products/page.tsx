import { getBackendUrl } from '@/lib/backend-url'
import ProductsClient, {
  type ProductRow,
  type ProductStats,
} from './ProductsClient'

export const dynamic = 'force-dynamic'

interface ApiResponse {
  products?: ProductRow[]
  total?: number
  page?: number
  totalPages?: number
  limit?: number
  stats?: ProductStats
  error?: string
}

const FALLBACK: {
  products: ProductRow[]
  stats: ProductStats
  total: number
  totalPages: number
} = {
  products: [],
  stats: { total: 0, active: 0, draft: 0, inStock: 0, outOfStock: 0 },
  total: 0,
  totalPages: 1,
}

export default async function ProductsPage() {
  const backend = getBackendUrl()
  let initial = FALLBACK
  let loadError: string | null = null
  try {
    const res = await fetch(`${backend}/api/products?page=1&limit=50`, {
      cache: 'no-store',
    })
    if (!res.ok) {
      loadError = `Initial fetch failed (HTTP ${res.status})`
    } else {
      const data = (await res.json()) as ApiResponse
      if (data.error) {
        loadError = data.error
      } else {
        initial = {
          products: data.products ?? [],
          stats: data.stats ?? FALLBACK.stats,
          total: data.total ?? 0,
          totalPages: data.totalPages ?? 1,
        }
      }
    }
  } catch (err: any) {
    loadError = err?.message ?? String(err)
  }

  return (
    <ProductsClient
      initialProducts={initial.products}
      initialStats={initial.stats}
      initialTotal={initial.total}
      initialTotalPages={initial.totalPages}
      initialError={loadError}
    />
  )
}
