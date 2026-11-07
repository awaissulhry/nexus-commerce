import { can } from '@nexus/factory-domain/core/permissions'
import { PORTAL_COMPLAINTS_VIEW, PORTAL_RETURNS_VIEW } from '@nexus/factory-domain/sales/portal-returns/permissions'
import type { HomeSource } from '../../../platform/portal/home/sources'
import { portalReader } from './access'
import { readComplaints } from './store'
import { listCases } from './views'

/**
 * B-W2b-192: a customer's Home counts of its returns and complaints (design portal.customer.home "Claims waiting for your
 * answer", the rail's Returns & claims badge). Read in the tenant's office scope as the person, for the portal's company and
 * the session's party; null for a person whose role does not see the page (fails closed: the tile shows nothing).
 *
 *   returns.open               cases still open (returns not closed, rejected or cancelled; complaints not closed)
 *   returns.waiting_for_you    open cases whose next step is the customer's (send the goods back, answer our question,
 *                              read our answer)
 *   returns.complaints_open    complaints not closed (the Quality role)
 */
export const RETURN_COUNTS: HomeSource = Object.freeze<HomeSource>({
  name: 'portalReturns',
  counts: [
    { key: 'returns.open', area: 'returns', kinds: ['CUSTOMER'], words: { it: 'Resi e reclami aperti', en: 'Open returns and claims' } },
    { key: 'returns.waiting_for_you', area: 'returns', kinds: ['CUSTOMER'], words: { it: 'In attesa di voi', en: 'Waiting for you' } },
    { key: 'returns.complaints_open', area: 'returns', kinds: ['CUSTOMER'], words: { it: 'Reclami aperti', en: 'Open complaints' } },
  ],
  async read(app, request, now) {
    const reader = portalReader(app, request)
    const sees = can(reader.actor, PORTAL_RETURNS_VIEW, reader.place)
    const quality = can(reader.actor, PORTAL_COMPLAINTS_VIEW, reader.place)
    if (!sees && !quality) return { 'returns.open': null, 'returns.waiting_for_you': null, 'returns.complaints_open': null }
    return reader.inTenant(async (db) => {
      const cases = sees ? await listCases(db, reader.place, { chip: 'ALL' }, { seesPrices: reader.seesPrices, readsComplaints: reader.readsComplaints, now }) : null
      const complaints = quality ? (await readComplaints(db, reader.place)).filter((row) => row.status !== 'CLOSED').length : null
      return {
        'returns.open': cases ? cases.items.filter((item) => item.open).length : null,
        'returns.waiting_for_you': cases ? cases.items.filter((item) => item.open && item.next.forYou).length : null,
        'returns.complaints_open': complaints,
      }
    })
  },
})
