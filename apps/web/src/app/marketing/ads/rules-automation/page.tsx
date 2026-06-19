/** Rules & Automation (Helium 10 Ads / Adtomic match) — R1: the Rules-tab campaign
 *  grid, built on the shared AdsDataGrid + AdsPageHeader. */
import { RulesAutomationClient } from './RulesAutomationClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return <RulesAutomationClient />
}
