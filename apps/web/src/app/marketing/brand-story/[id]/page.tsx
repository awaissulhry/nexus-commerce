// MC.9.2 — Brand Story builder page.
//
// Hands off to the client builder via BrandStoryBuilderLoader — the
// cross-site API session cookie means server fetches can never
// authenticate, so the detail loads client-side. The page stays a server
// component so the builder's router.refresh() calls mint a new
// refreshToken and re-trigger the loader.

import BrandStoryBuilderLoader from './BrandStoryBuilderLoader'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function BrandStoryBuilderPage({ params }: PageProps) {
  const { id } = await params
  return <BrandStoryBuilderLoader id={id} refreshToken={Date.now()} />
}
