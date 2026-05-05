// PP — single-product create wizard. Shell for the wizard client;
// no auth or product-id-resolution needed since this is the create
// path. Mirrors the listing wizard's page-level structure.

import CreateProductWizard from './CreateProductWizard'

export const dynamic = 'force-dynamic'

export default function NewProductPage() {
  return <CreateProductWizard />
}
