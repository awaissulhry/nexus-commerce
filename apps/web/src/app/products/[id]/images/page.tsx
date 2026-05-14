// IM.10 — The dedicated /products/[id]/images page is superseded by
// the full-featured ?tab=images workspace on the edit page.
// Redirect permanently so any saved bookmarks or wizard links land correctly.

import { redirect } from 'next/navigation'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ProductImagesRedirectPage({ params }: PageProps) {
  const { id } = await params
  redirect(`/products/${id}/edit?tab=images`)
}
