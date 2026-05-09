import PageHeader from '@/components/layout/PageHeader'
import AutomationClient from './AutomationClient'

export const dynamic = 'force-dynamic'

export default function BulkOperationsAutomationPage() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="Automation rules"
        description="Trigger → conditions → actions · dry-run by default · per-rule daily caps"
        breadcrumbs={[
          { label: 'Bulk Operations', href: '/bulk-operations' },
          { label: 'Automation' },
        ]}
      />
      <AutomationClient />
    </div>
  )
}
