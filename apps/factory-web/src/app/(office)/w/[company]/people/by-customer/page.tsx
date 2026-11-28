import type { Metadata } from 'next'
import { PeopleByCustomerPage } from '../../../../../../areas/people/by-customer/PeopleByCustomerPage'

export const metadata: Metadata = { title: 'People by customer · Nexus Factory' }

/**
 * People › People by customer (owb- order workflow, base settle 7; areas/people/nav.ts, permission roles.assign): which office people
 * work for which customer, and their extra rights (owb-of4). Still a DECLARED page until lead 88's nav flip (shell/nav/office-nav.ts:
 * DECLARED_PAGES → OFFICE_PAGES), so no menu row shows it before that.
 */
export default function PeopleByCustomerRoute() {
  return <PeopleByCustomerPage />
}
