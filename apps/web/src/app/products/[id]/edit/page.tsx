import { notFound } from 'next/navigation'
import ProductEditClient from './ProductEditClient'
import ProductEditLoader from './ProductEditLoader'
import { loadEditData } from './edit-data'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ProductEditPage({ params }: PageProps) {
  const { id } = await params

  // Fast path: load on the server so the first paint is fully rendered.
  // Under RBAC enforce the server can't read the API-origin session cookie,
  // so this comes back `error` (401) — in which case we hand off to the
  // client loader, which re-runs the SAME fetches in the browser where the
  // credentialed fetch wrapper authenticates them (per-user RBAC intact).
  // all-listings is intentionally NOT loaded here (up to 9s cold, invisible
  // until a channel tab opens) — ProductEditClient streams it in on mount.
  const result = await loadEditData(id)

  if (result.kind === 'notfound') notFound()
  if (result.kind !== 'ok') return <ProductEditLoader id={id} />

  const { data } = result
  return (
    <ProductEditClient
      product={data.product}
      listings={{}}
      marketplaces={data.marketplaces}
      childrenList={data.childrenList}
      parentProduct={data.parentProduct}
      siblings={data.siblings}
      parentListings={{}}
    />
  )
}
