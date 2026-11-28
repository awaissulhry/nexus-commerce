import type { Metadata } from 'next'
import { NotBuiltYet } from '../../../../../../shell/office/NotBuiltYet'

export const metadata: Metadata = { title: 'People by customer · Nexus Factory' }

/**
 * People › People by customer (owb- order workflow, base settle 7; areas/people/nav.ts, permission roles.assign): a DECLARED page — its route, its nav row
 * and its place in the approved tree are placed by the base; S2 (of4) replaces this file with the page. Its address joins
 * OFFICE_PAGES at that land (shell/nav/office-nav.ts: DECLARED_PAGES → OFFICE_PAGES), so until then no row shows it.
 */
export default function PeopleByCustomerPage() {
  return <NotBuiltYet />
}
