// PD.5 — new-product development board. Lives inside the Suppliers area
// (reached via an in-page tab from /fulfillment/suppliers), so there's
// no new sidebar link. Concept → sourcing → sampling → … → launched.

export const dynamic = 'force-dynamic'

import DevelopmentClient from './DevelopmentClient'

export default function DevelopmentPage() {
  return <DevelopmentClient />
}
