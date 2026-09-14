import { redirect } from 'next/navigation'
import { studioEditHref, type EditSearchParams } from './_studio/legacy-edit-redirect'

export const dynamic = 'force-dynamic'

/** Existing product links and bookmarks now open the rebuilt editor. */
export default async function ProductEditPage({ params, searchParams }: {
  params: Promise<{ id: string }>
  searchParams: Promise<EditSearchParams>
}) {
  const [{ id }, search] = await Promise.all([params, searchParams])
  redirect(studioEditHref(id, search))
}
