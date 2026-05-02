import { redirect } from 'next/navigation'

// Phase 4 cleanup: /catalog/[id] is consolidated into /products/[id]
// (canonical product detail page). Redirect shell for back-compat.
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  redirect(`/products/${id}`)
}
