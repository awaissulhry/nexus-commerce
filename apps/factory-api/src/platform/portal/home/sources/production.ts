import { can } from '@nexus/factory-domain/core/permissions'
import { PORTAL_PRODUCTION_VIEW } from '@nexus/factory-domain/production-brand/permissions'
import { PRODUCTION_HOME_LIVE, productionCounts } from '../../../../modules/production/brand-portal/read'
import { portalReader } from '../../../../modules/sales/portal-orders/access'
import type { HomeSource } from './index'

/**
 * B-PR-20 (production plan §5 Portal › Home; F-PR-15 draws the tiles; wall test PW-P07): a customer's Home counts of its OWN
 * orders in production, the same rules as My production's chips (modules/production/brand-portal read.ts productionCounts):
 *
 *   production.waiting_on_you   orders where it acts next ("Waiting on you")
 *   production.at_risk          orders whose health is At risk (computed, or raised by us with a reason code)
 *   production.on_hold          orders on hold, or paused at its own request
 *
 * Read in the party's scope first (row-level security), then the office's facts of exactly those orders: never a count of
 * another customer, a place in our queue, a person or a figure of ours. Null for a person whose role does not see production
 * (fails closed: the tile shows nothing). The Home reads them again on the production events of the partner live channel
 * (`live`): stage reached, health, urgency, hold — each only to its own party (factory-domain portal/notifications/live.ts).
 */
export const PRODUCTION_COUNTS: HomeSource = Object.freeze<HomeSource>({
  name: 'production',
  counts: [
    { key: 'production.waiting_on_you', area: 'production', kinds: ['CUSTOMER'], words: { it: 'In produzione: tocca a te', en: 'In production: waiting on you' } },
    { key: 'production.at_risk', area: 'production', kinds: ['CUSTOMER'], words: { it: 'In produzione: a rischio', en: 'In production: at risk' } },
    { key: 'production.on_hold', area: 'production', kinds: ['CUSTOMER'], words: { it: 'In produzione: in sospeso', en: 'In production: on hold' } },
  ],
  live: PRODUCTION_HOME_LIVE,
  async read(app, request, now) {
    const reader = portalReader(app, request)
    const none = { 'production.waiting_on_you': null, 'production.at_risk': null, 'production.on_hold': null }
    if (!can(reader.actor, PORTAL_PRODUCTION_VIEW, { companyId: reader.session.company.id, partyId: reader.session.partyId })) return none
    const counts = await productionCounts(app, request, now)
    return { 'production.waiting_on_you': counts.waitingOnYou, 'production.at_risk': counts.atRisk, 'production.on_hold': counts.onHold }
  },
})
