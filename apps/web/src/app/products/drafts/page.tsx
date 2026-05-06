// /products/drafts shell. Surfaces in-progress ListingWizard sessions
// (status='DRAFT') so users can resume work without remembering the
// per-product URL. Backed by GET /api/listing-wizard/drafts.

import DraftsClient from './DraftsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default function ListingWizardDraftsPage() {
  return <DraftsClient />
}
