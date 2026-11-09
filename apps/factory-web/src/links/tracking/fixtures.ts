import { defineDesignScreen } from '../../lib/design/design-screen'
import type { TrackingPage } from './api'
import { EMPTY_SEARCH, initialTracking, type SearchModel, type TrackingViewModel } from './model'
import { TrackingView } from './view/TrackingView'

/**
 * SCR-194 Track an order (design links.tracking; LOG-062; B-W2b-170) — made-up data only (PLAN §3.1): an invented customer
 * order "4500-1234" (our SO-26-0042) shipped as SH-26-0042 in two parcels by "Demo Express" to Bologna 40100, its packing
 * list and the Declaration of Conformity and user information of a made-up style "DEMO-JKT-01 Giacca Demo". The link's
 * page (`/l#token=…`, the sender's brand around it on the live page) and the public search (`/t`). Phone first: open a
 * case with `?width=phone`.
 */

const uid = (n: number) => `0190f0e2-7194-7000-8000-${String(n).padStart(12, '0')}`
const CARRIER = 'https://tracking.demo-express.invalid/track?id=DX00000042'

const page = (over: Partial<TrackingPage> = {}): TrackingPage => ({
  shipment: {
    number: 'SH-26-0042',
    status: 'SHIPPED',
    transportBy: 'CARRIER',
    carrierName: 'Demo Express',
    packedAt: '2026-11-10T08:10:00.000Z',
    shippedAt: '2026-11-10T15:05:00.000Z',
    deliveredAt: null,
    returnedAt: null,
    expectedDeliveryAt: '2026-11-13T11:00:00.000Z',
  },
  order: { customerRef: '4500-1234', number: 'SO-26-0042' },
  pill: 'IN_TRANSIT',
  problem: null,
  steps: [
    { code: 'PACKED', state: 'DONE', at: '2026-11-10T08:10:00.000Z' },
    { code: 'COLLECTED', state: 'DONE', at: '2026-11-10T15:05:00.000Z' },
    { code: 'IN_TRANSIT', state: 'CURRENT', at: '2026-11-11T06:40:00.000Z' },
    { code: 'OUT_FOR_DELIVERY', state: 'TODO', at: null },
    { code: 'DELIVERED', state: 'TODO', at: null },
  ],
  parcels: [
    { seq: 1, trackingNumber: 'DX00000042', carrierPage: CARRIER, status: 'IN_TRANSIT' },
    { seq: 2, trackingNumber: 'DX00000043', carrierPage: CARRIER, status: 'IN_TRANSIT' },
  ],
  events: [
    { id: uid(3), status: 'IN_TRANSIT', place: 'Bologna Interporto', occurredAt: '2026-11-12T04:15:00.000Z', parcelSeq: null },
    { id: uid(2), status: 'IN_TRANSIT', place: 'Milano Hub', occurredAt: '2026-11-11T06:40:00.000Z', parcelSeq: null },
    { id: uid(1), status: 'LABEL_CREATED', place: null, occurredAt: '2026-11-10T09:00:00.000Z', parcelSeq: null },
  ],
  delivery: { city: 'Bologna', postcode: '40100', country: 'IT' },
  papers: {
    shown: true,
    files: [
      { fileId: uid(11), kind: 'PACKING_LIST', number: 'SH-26-0042/2', style: null, language: 'it', originalName: 'Packing list SH-26-0042-2.pdf', contentType: 'application/pdf', sizeBytes: 38_204 },
      { fileId: uid(12), kind: 'DECLARATION_OF_CONFORMITY', number: null, style: { code: 'DEMO-JKT-01', name: 'Giacca Demo' }, language: 'it', originalName: 'Dichiarazione UE DEMO-JKT-01.pdf', contentType: 'application/pdf', sizeBytes: 51_877 },
      { fileId: uid(13), kind: 'USER_INFORMATION', number: null, style: { code: 'DEMO-JKT-01', name: 'Giacca Demo' }, language: 'en', originalName: 'User information DEMO-JKT-01.pdf', contentType: 'application/pdf', sizeBytes: 102_430 },
    ],
  },
  claim: { held: null },
  link: { endsAt: '2027-05-09T15:05:00.000Z', via: 'SHIPPED' },
  timeZone: 'Europe/Rome',
  ...over,
})

const ready = (over: Partial<TrackingPage> = {}, model: Partial<TrackingViewModel> = {}): TrackingViewModel => ({ ...initialTracking(null), load: 'ready', page: page(over), readAt: '2026-11-12T09:30:00.000Z', ...model })

const delivered = page({
  shipment: { ...page().shipment, status: 'DELIVERED', deliveredAt: '2026-11-13T10:42:00.000Z', expectedDeliveryAt: null },
  pill: 'DELIVERED',
  steps: [
    { code: 'PACKED', state: 'DONE', at: '2026-11-10T08:10:00.000Z' },
    { code: 'COLLECTED', state: 'DONE', at: '2026-11-10T15:05:00.000Z' },
    { code: 'IN_TRANSIT', state: 'DONE', at: '2026-11-11T06:40:00.000Z' },
    { code: 'OUT_FOR_DELIVERY', state: 'DONE', at: '2026-11-13T06:20:00.000Z' },
    { code: 'DELIVERED', state: 'DONE', at: '2026-11-13T10:42:00.000Z' },
  ],
  parcels: page().parcels.map((parcel) => ({ ...parcel, status: 'DELIVERED' as const })),
  events: [
    { id: uid(5), status: 'DELIVERED', place: 'Bologna', occurredAt: '2026-11-13T10:42:00.000Z', parcelSeq: null },
    { id: uid(4), status: 'OUT_FOR_DELIVERY', place: 'Bologna', occurredAt: '2026-11-13T06:20:00.000Z', parcelSeq: null },
    ...page().events,
  ],
  link: { endsAt: '2027-01-12T10:42:00.000Z', via: 'SHIPPED' },
})

const packed = page({
  shipment: { ...page().shipment, status: 'PACKED', shippedAt: null },
  pill: 'PACKED',
  steps: [
    { code: 'PACKED', state: 'CURRENT', at: '2026-11-10T08:10:00.000Z' },
    { code: 'COLLECTED', state: 'TODO', at: null },
    { code: 'IN_TRANSIT', state: 'TODO', at: null },
    { code: 'OUT_FOR_DELIVERY', state: 'TODO', at: null },
    { code: 'DELIVERED', state: 'TODO', at: null },
  ],
  parcels: page().parcels.map((parcel) => ({ ...parcel, status: null })),
  events: [],
  claim: { held: 'NOT_LEFT' },
  link: { endsAt: '2027-05-09T08:10:00.000Z', via: 'OFFICE' },
})

const search = (over: Partial<SearchModel> = {}): SearchModel => ({
  ...EMPTY_SEARCH,
  head: 'ready',
  sender: { companyId: uid(90), name: 'Officina Demo', logoUrl: null, logoDarkUrl: null, accent: null, contactEmail: 'ordini@officina-demo.example' },
  reference: '4500-1234',
  postcode: '40100',
  ...over,
})
const searching = (over: Partial<SearchModel> = {}, model: Partial<TrackingViewModel> = {}): TrackingViewModel => ({ ...initialTracking(search(over)), ...model })

export const designScreen = defineDesignScreen<TrackingViewModel>({
  screen: 'SCR-194',
  title: 'Track an order (link): where it is, carrier events, delivery, papers, a problem; Find your order (/t)',
  view: TrackingView,
  cases: [
    { id: 'in-transit', label: 'In transit, two parcels: the tracker, the expected day, the carrier\'s events in our words, papers', model: ready(), note: 'The page of the link mailed when the goods left. Phone first: ?width=phone. Live: read again every minute while on the way.' },
    { id: 'packed', label: 'Packed, waiting for the carrier: no scans yet; a problem cannot be reported before it leaves', model: ready(packed) },
    { id: 'out-for-delivery', label: 'Out for delivery today', model: ready({ pill: 'OUT_FOR_DELIVERY', steps: page().steps.map((step) => (step.code === 'OUT_FOR_DELIVERY' ? { ...step, state: 'CURRENT', at: '2026-11-13T06:20:00.000Z' } : step.code === 'IN_TRANSIT' ? { ...step, state: 'DONE' } : step)), events: [{ id: uid(4), status: 'OUT_FOR_DELIVERY', place: 'Bologna', occurredAt: '2026-11-13T06:20:00.000Z', parcelSeq: null }, ...page().events] }) },
    { id: 'delivered', label: 'Delivered: when and where, the page open until 60 days after', model: ready(delivered) },
    { id: 'delayed', label: 'Problem: the carrier reports a delay on parcel 2', model: ready({ pill: 'PROBLEM', problem: 'DELAYED', parcels: [page().parcels[0]!, { ...page().parcels[1]!, status: 'EXCEPTION' }], events: [{ id: uid(6), status: 'EXCEPTION', place: 'Bologna Interporto', occurredAt: '2026-11-12T17:00:00.000Z', parcelSeq: 2 }, ...page().events] }) },
    { id: 'returned', label: 'Problem: the goods came back to us (no claim from here)', model: ready({ shipment: { ...page().shipment, status: 'RETURNED', returnedAt: '2026-11-18T09:00:00.000Z', expectedDeliveryAt: null }, pill: 'PROBLEM', problem: 'RETURNED', claim: { held: 'RETURNED' }, events: [{ id: uid(7), status: 'RETURNED', place: 'Milano Hub', occurredAt: '2026-11-17T08:00:00.000Z', parcelSeq: null }, ...page().events] }) },
    { id: 'one-parcel', label: 'One parcel: "Track on the carrier\'s site" in the head', model: ready({ parcels: [page().parcels[0]!] }) },
    { id: 'own-van', label: 'Our own van: no carrier, no scans, no carrier site', model: ready({ shipment: { ...page().shipment, transportBy: 'SENDER', carrierName: null, expectedDeliveryAt: null }, parcels: [{ seq: 1, trackingNumber: null, carrierPage: null, status: null }], events: [] }) },
    { id: 'no-scans', label: 'Left us, no carrier scan yet', model: ready({ events: [], steps: page().steps.map((step) => (step.code === 'COLLECTED' ? { ...step, state: 'CURRENT' } : step.code === 'IN_TRANSIT' ? { ...step, state: 'TODO', at: null } : step)), pill: 'COLLECTED' }) },
    { id: 'copied', label: 'A tracking number copied', model: ready({}, { copied: 'DX00000042' }) },
    { id: 'paper-downloading', label: 'A paper being downloaded (logged, never a use)', model: ready({}, { papers: { [uid(11)]: 'busy' } }) },
    { id: 'paper-failed', label: 'A paper\'s download failed: Try again', model: ready({}, { papers: { [uid(12)]: 'failed' } }) },
    { id: 'no-papers', label: 'No papers yet', model: ready({ papers: { shown: true, files: [] } }) },
    { id: 'claim-opening', label: 'Report a problem: the form opening', model: ready({}, { claim: 'busy' }) },
    { id: 'claim-opened', label: 'Report a problem: the form opened in a new tab', model: ready({}, { claim: 'opened' }) },
    { id: 'claim-too-many', label: 'Report a problem: forms opened already (held with why)', model: ready({}, { claim: 'too-many' }) },
    { id: 'claim-failed', label: 'Report a problem: the form did not open', model: ready({}, { claim: 'failed' }) },
    { id: 'loading', label: 'Loading: the shape of the content', model: { ...initialTracking(null) } },
    { id: 'loading-slow', label: 'Still loading after a second', model: { ...initialTracking(null), slow: true } },
    { id: 'error', label: 'Could not be read: in words, with Try again (never drawn as empty)', model: { ...initialTracking(null), load: 'error' } },
    { id: 'dead', label: 'The link was withdrawn or the page ended: Ask for a new link', model: { ...initialTracking(null), load: 'dead' } },
    { id: 'dead-asked', label: 'Dead link · a new link asked (one answer, whatever the link was)', model: { ...initialTracking(null), load: 'dead', ask: 'done' } },
    { id: 'dead-ask-failed', label: 'Dead link · asking did not reach us', model: { ...initialTracking(null), load: 'dead', ask: 'failed' } },
    { id: 'search', label: '/t Find your order: the empty form', model: searching({ reference: '', postcode: '' }), note: 'The public search: order reference + delivery postcode, Enter searches, rate-limited, one answer for a miss.' },
    { id: 'search-problems', label: '/t Find your order: the fields say what is missing', model: searching({ reference: '', postcode: '40/100', problems: { reference: 'EMPTY', postcode: 'FORMAT' } }) },
    { id: 'search-searching', label: '/t Searching (held)', model: searching({ state: 'searching' }) },
    { id: 'search-checking', label: '/t A quick browser check after suspicious traffic (proof of work)', model: searching({ state: 'checking' }) },
    { id: 'search-miss', label: '/t No shipment found for these details (the same for every miss)', model: searching({ state: 'miss' }) },
    { id: 'search-wait', label: '/t Too many searches: wait (held with the minutes)', model: searching({ state: 'wait', waitMinutes: 4 }) },
    { id: 'search-error', label: '/t The search did not reach us', model: searching({ state: 'error' }) },
    {
      id: 'search-several',
      label: '/t The order left in two shipments: choose one',
      model: searching({ state: 'several', found: [{ token: 'made-up-1', number: 'SH-26-0042', status: 'SHIPPED', shippedAt: '2026-11-10T15:05:00.000Z' }, { token: 'made-up-2', number: 'SH-26-0051', status: 'PACKED', shippedAt: null }] }),
    },
    { id: 'search-found', label: '/t Found: the tracking of a search link (no papers, no claim: our e-mail\'s link has them)', model: searching({}, { load: 'ready', page: page({ papers: { shown: false, files: [] }, claim: { held: 'SEARCH' }, link: { endsAt: '2026-11-13T09:30:00.000Z', via: 'SEARCH' } }), readAt: '2026-11-12T09:30:00.000Z' }) },
    { id: 'search-missing', label: '/t The address names no company', model: searching({ head: 'missing', sender: null }) },
    { id: 'search-loading', label: '/t Loading whose search it is (held)', model: searching({ head: 'loading', sender: null, reference: '', postcode: '' }) },
  ],
})
