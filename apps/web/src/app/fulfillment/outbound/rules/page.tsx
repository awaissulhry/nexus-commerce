import RulesClient from './RulesClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * O.16 — Shipping rules admin. Operator defines WHEN <conditions>
 * THEN <actions> rules that the bulk-create-shipments path consults
 * to pick a carrier + service. First-match-wins, walked in priority
 * ASC order.
 */
export default function ShippingRulesPage() {
  return <RulesClient />
}
