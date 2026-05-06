import PageHeader from '@/components/layout/PageHeader'
import RoutingRulesClient from './RoutingRulesClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Order routing rules — rule-based warehouse assignment for inbound
 * orders. Pre-this, shipments were always created against a fixed
 * default warehouse — fine for single-warehouse setups, broken for
 * multi-warehouse (audit's #1 critical operations gap).
 *
 * Rules are evaluated by priority (ascending). First match wins.
 * Empty match criteria are wildcards. Test routing decisions with the
 * dry-run preview below the table.
 */
export default function RoutingRulesPage() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="Order Routing Rules"
        description="Rule-based warehouse assignment for new shipments · evaluated by priority, first match wins, falls back to default warehouse"
        breadcrumbs={[
          { label: 'Fulfillment', href: '/fulfillment' },
          { label: 'Routing Rules' },
        ]}
      />
      <RoutingRulesClient />
    </div>
  )
}
