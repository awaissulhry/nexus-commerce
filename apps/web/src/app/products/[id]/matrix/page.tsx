/**
 * F6 — variant matrix editor.
 *
 * Distinct from /products/[id]/edit/bulk (which is a multi-channel
 * marketplace editor): this route shows the parent product's
 * children laid out as a matrix on the product's own variation axes
 * (e.g. Color × Size). Built for catalog managers who think in 2D
 * grids rather than per-row tables.
 *
 * Server fetches parent + children. Client renders:
 *   - 1 axis  → flat table (rows = variants)
 *   - 2 axes  → pivot grid (rows × cols, each cell = one child SKU)
 *   - 3+ axes → flat table with every axis as a column
 *
 * 404 when the product isn't a parent — the matrix view doesn't make
 * sense for standalones, and the page surfaces a helpful message
 * pointing at /products/[id] for single-SKU edits.
 */

import { notFound } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import MatrixWorkspace from './MatrixWorkspace'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ProductMatrixPage({ params }: PageProps) {
  const { id } = await params
  const backend = getBackendUrl()

  const productRes = await fetch(`${backend}/api/inventory/${id}`, {
    cache: 'no-store',
  })
  if (productRes.status === 404) notFound()
  if (!productRes.ok) {
    throw new Error(`Failed to load product: HTTP ${productRes.status}`)
  }
  const product = await productRes.json()

  if (!product.isParent) {
    return (
      <div className="max-w-2xl mx-auto py-16 px-6 text-center space-y-3">
        <h1 className="text-2xl font-semibold text-slate-900">
          No matrix for this product
        </h1>
        <p className="text-md text-slate-600">
          The matrix view is for parent SKUs that have variations across
          colour / size / etc. <span className="font-mono">{product.sku}</span>{' '}
          is a standalone — open it directly to edit master fields.
        </p>
        <a
          href={`/products/${id}`}
          className="inline-block h-8 px-3 text-base bg-slate-900 text-white rounded hover:bg-slate-800"
        >
          Open product
        </a>
      </div>
    )
  }

  const childrenRes = await fetch(
    `${backend}/api/products/${id}/children`,
    { cache: 'no-store' },
  )
  const childrenJson = childrenRes.ok
    ? await childrenRes.json()
    : { children: [] }

  return (
    <MatrixWorkspace
      product={product}
      initialChildren={childrenJson.children ?? []}
    />
  )
}
