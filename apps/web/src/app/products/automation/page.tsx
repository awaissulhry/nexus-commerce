import PageHeader from '@/components/layout/PageHeader'
import AutomationClient from './AutomationClient'

export const dynamic = 'force-dynamic'

// OL.D.4 — Listing automation rules. Cross-market price / inventory sync
// (and, later, health nudges + content cascade) on the shared
// AutomationRule engine. Dry-run by default; per-rule daily caps.
export default function ProductsAutomationPage() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="Listing automation"
        description="Trigger → conditions → actions · dry-run by default · per-rule daily caps · 5-min undo window"
        breadcrumbs={[
          { label: 'Products', href: '/products' },
          { label: 'Automation' },
        ]}
      />
      <AutomationClient />
    </div>
  )
}
