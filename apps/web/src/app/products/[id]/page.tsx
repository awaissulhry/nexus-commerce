/**
 * /products/[id] — operator workspace catch-all.
 *
 * Was a storefront-style preview page (image gallery + buy box + spec
 * table) that imported `@nexus/database` directly and rendered with
 * mock review data. It crashed under production deploy with a
 * "Server Components render" error and was unused by any operator
 * workflow — every internal navigation goes to /edit, /matrix,
 * /datasheet, /recover, or /list-wizard.
 *
 * Operators landing here (typically via a stale "Back to product"
 * link from /matrix or a dashboard card) want the edit workspace,
 * not a storefront mock. Redirect there so every entry-point
 * converges on the canonical surface and the route stops bleeding
 * 500s.
 *
 * If a real customer-facing preview lands later, mount it under
 * /products/[id]/preview and leave this redirect untouched — every
 * existing operator link continues to resolve.
 */
import { redirect } from 'next/navigation'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ProductDetailPage({ params }: PageProps) {
  const { id } = await params
  redirect(`/products/${id}/edit`)
}
