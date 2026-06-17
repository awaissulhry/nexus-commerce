// PRODUCTS REBUILD — universal catalog workspace.
// One client component (ProductsWorkspace) drives 5 lenses: Grid · Hierarchy ·
// Coverage · Health · Drafts. URL-driven state, virtualized table, inline
// quick-edit, faceted filters, saved views, tag + bundle editors, bulk
// actions across channels via /api/listings/bulk-action.

import ProductsWorkspace from './ProductsWorkspace'
import AiCopilot from '@/components/AiCopilot'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default function ProductsPage() {
  return (
    <>
      <ProductsWorkspace />
      {/* ACP.2b/7 — catalog copilot (floating widget) */}
      <AiCopilot
        pageContext={{ route: '/products' }}
        title="Catalog copilot"
        placeholder="Ask about your catalog…"
        suggestions={[
          'Which SKUs are missing images or bullets?',
          'What’s blocking GALE-JACKET from publishing?',
          'Draft better bullets + SEO for a SKU',
        ]}
      />
    </>
  )
}
