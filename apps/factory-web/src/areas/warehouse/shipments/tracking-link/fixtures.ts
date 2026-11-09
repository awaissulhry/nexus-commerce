import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { TrackingLinks } from './api'
import { initialCard, type TrackingLinkCardModel } from './model'
import { TrackingLinkCardView } from './view/TrackingLinkCardView'

/**
 * SCR-067-tracking-link — the shipment record's Tracking & delivery tab, its tracking-page card (B-W2b-170; design
 * warehouse.shipments page.conn "the tracking link (links.tracking)"; a section of SCR-067, named like SCR-014-branding).
 * Made-up data only: shipment SH-26-0042 of a made-up customer, its orders contact "Bianca Demo".
 */

const uid = (n: number) => `0190f0e2-7067-7000-8000-${String(n).padStart(12, '0')}`

const read = (over: Partial<TrackingLinks> = {}): TrackingLinks => ({
  shipment: { id: uid(1), number: 'SH-26-0042', status: 'SHIPPED', partyId: uid(2) },
  recipients: [{ contactId: uid(3), name: 'Bianca Demo', email: 'ordini@cliente-demo.example' }],
  links: [
    { id: uid(12), email: null, via: 'PORTAL', state: 'LIVE', createdAt: '2026-11-11T08:00:00.000Z', endsAt: '2027-05-10T08:00:00.000Z', lastOpenedAt: '2026-11-11T09:12:00.000Z', revokedAt: null, automatic: false },
    { id: uid(11), email: 'ordini@cliente-demo.example', via: 'SHIPPED', state: 'LIVE', createdAt: '2026-11-10T15:06:00.000Z', endsAt: '2027-05-09T15:06:00.000Z', lastOpenedAt: '2026-11-12T07:40:00.000Z', revokedAt: null, automatic: true },
  ],
  searches: { count: 0, lastAt: null },
  held: null,
  mayManage: true,
  ...over,
})

const card = (over: Partial<TrackingLinkCardModel> = {}, data: Partial<TrackingLinks> = {}): TrackingLinkCardModel => ({ ...initialCard, state: 'ready', read: read(data), ...over })

export const designScreen = defineDesignScreen<TrackingLinkCardModel>({
  screen: 'SCR-067-tracking-link',
  title: 'Shipment › Tracking & delivery: the customer\'s tracking page (send, pass on, withdraw)',
  view: TrackingLinkCardView,
  part: true,
  cases: [
    { id: 'links', label: 'Two links: mailed when the goods left, copied in the portal', model: card(), note: 'A section of SCR-067 (the shipment record), on its Tracking & delivery tab.' },
    { id: 'none', label: 'Packed, no link yet: the orders contact gets it when the goods leave', model: card({}, { links: [], shipment: { id: uid(1), number: 'SH-26-0042', status: 'PACKED', partyId: uid(2) } }) },
    { id: 'pass-on', label: 'A link to pass on: copied, shown this once', model: card({ passOn: { url: 'https://factory.example/l#token=made-up-token-for-the-design', copied: true } }) },
    { id: 'other-address', label: 'To another address: the field says what is wrong', model: card({ other: { open: true, email: 'negozio@', problem: 'FORMAT' } }) },
    { id: 'sent', label: 'Sent to the orders contact', model: card({ outcome: { kind: 'sent', count: 1 } }) },
    { id: 'withdrawn', label: 'A withdrawn link and an ended one; the search\'s links as one line', model: card({}, { links: [{ ...read().links[0]!, state: 'REVOKED', revokedAt: '2026-11-12T10:00:00.000Z' }, { ...read().links[1]!, state: 'ENDED' }], searches: { count: 3, lastAt: '2026-11-12T18:20:00.000Z' } }) },
    { id: 'no-recipients', label: 'No orders contact with an address: Send held with why', model: card({}, { recipients: [] }) },
    { id: 'read-only', label: 'A viewer: every button held with why', model: card({}, { mayManage: false }) },
    { id: 'cancelled', label: 'A cancelled shipment: nothing to track', model: card({}, { links: [], held: 'CANCELLED', shipment: { id: uid(1), number: 'SH-26-0042', status: 'CANCELLED', partyId: uid(2) } }) },
    { id: 'refused', label: 'A refused send, in words', model: card({ outcome: { kind: 'failed', why: 'refused' } }) },
    { id: 'loading', label: 'Loading', model: { ...initialCard } },
    { id: 'error', label: 'Could not be read: Try again', model: { ...initialCard, state: 'error' } },
  ],
})
