/** ACR.6 — Family Cockpit route. Reached from the Portfolios list; no sidebar entry. */
import { FamilyCockpitClient } from './FamilyCockpitClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return <FamilyCockpitClient />
}
