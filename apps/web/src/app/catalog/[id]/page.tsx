import { redirect } from 'next/navigation'

// Phase 4 cleanup: /catalog/[id] is consolidated into the canonical
// product editor at /products/[id]/edit. The read-only /products/[id]
// detail page has a pre-existing 500 (uses direct Prisma + imports
// that fail in production); routing to /edit instead until that's
// fixed. Tracked separately from the cleanup pass.
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  redirect(`/products/${id}/edit`)
}
