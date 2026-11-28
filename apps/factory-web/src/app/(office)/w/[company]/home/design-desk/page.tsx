import type { Metadata } from 'next'
import { NotBuiltYet } from '../../../../../../shell/office/NotBuiltYet'

export const metadata: Metadata = { title: 'Design desk · Nexus Factory' }

/**
 * Home › Design desk (owb- order workflow, base settle 7; areas/home/nav.ts, permission orders.view.own): a DECLARED page — its route, its nav row
 * and its place in the approved tree are placed by the base; S2 (of7) replaces this file with the page. Its address joins
 * OFFICE_PAGES at that land (shell/nav/office-nav.ts: DECLARED_PAGES → OFFICE_PAGES), so until then no row shows it.
 */
export default function HomeDesignDeskPage() {
  return <NotBuiltYet />
}
