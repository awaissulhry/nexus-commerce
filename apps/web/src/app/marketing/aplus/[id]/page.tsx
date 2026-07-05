// MC.8.3 — A+ Content visual builder.
//
// Hands off to AplusBuilderClient via AplusBuilderLoader — the cross-site
// API session cookie means server fetches can never authenticate, so the
// document + modules + ASIN attachments load client-side. The page stays
// a server component so the builder's router.refresh() calls mint a new
// refreshToken and re-trigger the loader.

import AplusBuilderLoader from './AplusBuilderLoader'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function AplusBuilderPage({ params }: PageProps) {
  const { id } = await params
  return <AplusBuilderLoader id={id} refreshToken={Date.now()} />
}
