/**
 * Shared render for a loaded matrix result — used by both page.tsx (server
 * fast path) and MatrixLoader (client fallback) so the not-a-parent message
 * and the workspace render live in one place. No server-only imports, so it
 * is safe in both module graphs.
 */

import MatrixWorkspace from './MatrixWorkspace'

export default function MatrixResult({
  id,
  product,
  initialChildren,
}: {
  id: string
  product: any
  initialChildren: any[]
}) {
  // 404-in-spirit: the matrix view is meaningless for a standalone SKU.
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
          href={`/products/${id}/edit`}
          className="inline-block h-8 px-3 text-base bg-slate-900 text-white rounded hover:bg-slate-800"
        >
          Open product
        </a>
      </div>
    )
  }

  return <MatrixWorkspace product={product} initialChildren={initialChildren} />
}
