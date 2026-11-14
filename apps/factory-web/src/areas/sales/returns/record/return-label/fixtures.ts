import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { ReturnLabelRow, ReturnLabels } from './api'
import { firstDraft, initialModel, type ReturnLabelsModel } from './model'
import { ReturnLabelsView } from './view/ReturnLabelsView'

/**
 * SCR-112-return-label — the RMA's Shipments tab, its return labels (B-W2b-398; LOG-112; design sales.returns RMA ›
 * Shipments `rma.ship.list` "Return label or link (W2b)", "Make return label (W2b)"; a section of SCR-112, named like
 * SCR-067-tracking-link). Made-up data only: return RMA-26-0007 of a made-up customer, its orders contact "Bianca Demo".
 */

const uid = (n: number) => `0190f0e2-7112-7000-8000-${String(n).padStart(12, '0')}`
const PREFIX = '/w/DEMO'

const booked: ReturnLabelRow = {
  id: uid(21),
  status: 'BOOKED',
  mode: 'LABEL',
  carrierCode: 'brt',
  bookingReference: 'FK1A2B3C4D5E6F',
  file: { id: uid(31), name: 'return-label-RMA-26-0007-FK1A2B3C4D5E6F.pdf' },
  link: null,
  usedAt: null,
  createdAt: '2026-11-12T09:10:00.000Z',
  changedAt: '2026-11-12T09:10:00.000Z',
}
const offered: ReturnLabelRow = {
  id: uid(22),
  status: 'OFFERED',
  mode: 'LINK',
  carrierCode: 'brt',
  bookingReference: null,
  file: null,
  link: { email: 'ordini@cliente-demo.example', expiresAt: '2026-12-12T09:30:00.000Z', revoked: false, lastOpenedAt: '2026-11-12T18:02:00.000Z' },
  usedAt: null,
  createdAt: '2026-11-12T09:30:00.000Z',
  changedAt: '2026-11-12T09:30:00.000Z',
}

const read = (over: Partial<ReturnLabels> = {}): ReturnLabels => ({
  return: { id: uid(1), number: 'RMA-26-0007', status: 'AUTHORISED' },
  labels: [booked, offered],
  make: { held: null, shipment: { id: uid(41), number: 'SH-26-0042' }, shipments: [{ id: uid(41), number: 'SH-26-0042' }], carrierCode: 'brt', linkDays: 30 },
  recipients: [{ contactId: uid(3), name: 'Bianca Demo', email: 'ordini@cliente-demo.example' }],
  mayManage: true,
  ...over,
})

const model = (over: Partial<ReturnLabelsModel> = {}, data: Partial<ReturnLabels> = {}): ReturnLabelsModel => ({ ...initialModel(PREFIX), state: 'ready', read: read(data), ...over })
const twoShipments = { shipments: [{ id: uid(41), number: 'SH-26-0042' }, { id: uid(42), number: 'SH-26-0039' }], shipment: { id: uid(41), number: 'SH-26-0042' } }

export const designScreen = defineDesignScreen<ReturnLabelsModel>({
  screen: 'SCR-112-return-label',
  title: 'Return › Shipments: return label or link (make, open the PDF, withdraw)',
  view: ReturnLabelsView,
  part: true,
  cases: [
    { id: 'labels', label: 'A label booked now and a link offered to the orders contact', model: model(), note: 'A section of SCR-112 (the RMA record), on its Shipments tab, below the receipts and DDTs.' },
    { id: 'none', label: 'Nothing booked yet: Make return label', model: model({}, { labels: [] }) },
    { id: 'make-label', label: 'Make return label: book the label now', model: model({ dialog: firstDraft(read({ make: { ...read().make, ...twoShipments } })) }, { make: { ...read().make, ...twoShipments } }) },
    { id: 'make-link', label: 'Make return label: send a link, mailed to the orders contact', model: model({ dialog: { mode: 'LINK', shipmentId: uid(41), send: true } }, { labels: [] }) },
    { id: 'make-link-no-contact', label: 'A link to mail with no orders contact: the confirm held with why', model: model({ dialog: { mode: 'LINK', shipmentId: uid(41), send: true } }, { labels: [], recipients: [] }) },
    { id: 'making', label: 'Booking the label', model: model({ dialog: { mode: 'LABEL', shipmentId: uid(41), send: true }, busy: 'make' }, { labels: [] }) },
    { id: 'booked', label: 'Booked: open its PDF to print or send it', model: model({ outcome: { kind: 'booked' } }, { labels: [booked] }) },
    { id: 'pass-on', label: 'A link to pass on: copied, shown this once', model: model({ passOn: { url: 'https://factory.example/l#token=made-up-token-for-the-design', copied: true } }, { labels: [{ ...offered, link: { ...offered.link!, email: null } }] }) },
    { id: 'used', label: 'The goods came back: the label is used; an older one withdrawn', model: model({}, { return: { id: uid(1), number: 'RMA-26-0007', status: 'RECEIVED' }, labels: [{ ...booked, status: 'USED', usedAt: '2026-11-13T10:20:00.000Z' }, { ...offered, status: 'CANCELLED', changedAt: '2026-11-12T11:00:00.000Z', link: { ...offered.link!, revoked: true } }] }) },
    { id: 'cancel', label: 'Withdraw a booked label: the carrier booking stays in Sendcloud, said before', model: model({ cancel: booked.id }) },
    { id: 'test-mode', label: 'The site is in test mode: Make held with why', model: model({}, { labels: [], make: { ...read().make, held: 'TEST_MODE' } }) },
    { id: 'no-shipment', label: 'No shipment of the order left: Make held with why', model: model({}, { labels: [], make: { ...read().make, held: 'NO_SHIPMENT', shipment: null, shipments: [] } }) },
    { id: 'closed', label: 'An inspected return: no new label', model: model({}, { return: { id: uid(1), number: 'RMA-26-0007', status: 'INSPECTED' }, make: { ...read().make, held: 'RETURN_CLOSED' } }) },
    { id: 'refused', label: 'The carrier did not book it: in words', model: model({ outcome: { kind: 'failed', key: 'rl.held.code.CARRIER' } }) },
    { id: 'read-only', label: 'A viewer (no right to manage returns): every button held with why', model: model({}, { mayManage: false }) },
    { id: 'offline', label: 'Offline: writes held with the reason', model: model({ offline: true }) },
    { id: 'loading', label: 'Loading', model: initialModel(PREFIX) },
    { id: 'error', label: 'Could not be read: Try again', model: { ...initialModel(PREFIX), state: 'error' } },
  ],
})
