/**
 * F6 — variant matrix editor.
 *
 * Shows the parent product's children laid out as a matrix on the
 * product's own variation axes (e.g. Color × Size). Built for catalog
 * managers who think in 2D grids rather than per-row tables.
 *
 * Server-loads parent + children for the fast first paint. Under RBAC
 * enforce the server can't read the API-origin session cookie, so the load
 * comes back `error` (401) — we then hand off to MatrixLoader, which re-runs
 * the same fetches in the browser where the credentialed fetch wrapper
 * authenticates them (per-user RBAC intact).
 *
 * 404 when the product doesn't exist; a non-parent renders a helpful
 * message (see MatrixResult) pointing at /products/[id] for single-SKU edits.
 */

import { notFound } from 'next/navigation'
import MatrixResult from './MatrixResult'
import MatrixLoader from './MatrixLoader'
import { loadMatrixData } from './matrix-data'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ProductMatrixPage({ params }: PageProps) {
  const { id } = await params

  const result = await loadMatrixData(id)

  if (result.kind === 'notfound') notFound()
  if (result.kind !== 'ok') return <MatrixLoader id={id} />

  return (
    <MatrixResult
      id={id}
      product={result.data.product}
      initialChildren={result.data.children}
    />
  )
}
