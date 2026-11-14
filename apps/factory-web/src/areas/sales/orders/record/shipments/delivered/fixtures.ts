import { defineDesignScreen } from '../../../../../../lib/design/design-screen'
import type { Deliveries } from './api'
import { initialDeliveries, type DeliveriesModel } from './model'
import { DeliveriesView } from './view/DeliveriesView'

/**
 * SCR-039-delivered — the sales order's Shipments tab, its card "Delivered (from carrier)" (B-W2b-398; LOG-065, LOG-067;
 * design sales.orders record › `order.ship.list` "Delivered (W2b, from carrier)"; a section of SCR-039). Made-up data only:
 * order SO-26-0031 of a made-up customer; the signer "FAKE RECIPIENT" is the fake carrier's.
 */

const uid = (n: number) => `0190f0e2-7039-7000-8000-${String(n).padStart(12, '0')}`
const PREFIX = '/w/DEMO'

const read = (over: Partial<Deliveries> = {}): Deliveries => ({
  order: { id: uid(1), number: 'SO-26-0031', status: 'DELIVERED', deliveredAt: '2026-11-13T10:42:00.000Z' },
  shipments: [
    { id: uid(11), number: 'SH-26-0040', status: 'DELIVERED', carrierName: 'Fake Carrier', shippedAt: '2026-11-10T15:05:00.000Z', deliveredAt: '2026-11-12T09:31:00.000Z', deliveredVia: 'CARRIER', pod: { signedBy: 'FAKE RECIPIENT', signedAt: '2026-11-12T09:31:00.000Z', image: true }, openProblems: 0, mayOpen: true },
    { id: uid(12), number: 'SH-26-0042', status: 'DELIVERED', carrierName: null, shippedAt: '2026-11-12T08:00:00.000Z', deliveredAt: '2026-11-13T10:42:00.000Z', deliveredVia: 'TYPED', pod: null, openProblems: 0, mayOpen: true },
  ],
  steps: [{ id: uid(21), seq: 20, status: 'OPEN', dueDate: '2026-12-13' }],
  ...over,
})

const model = (over: Partial<DeliveriesModel> = {}, data: Partial<Deliveries> = {}): DeliveriesModel => ({ ...initialDeliveries(PREFIX), state: 'ready', read: read(data), ...over })
const travelling = { ...read().shipments[1]!, status: 'SHIPPED', deliveredAt: null, deliveredVia: null, carrierName: 'Fake Carrier', openProblems: 1 }

export const designScreen = defineDesignScreen<DeliveriesModel>({
  screen: 'SCR-039-delivered',
  title: 'Sales order › Shipments: Delivered (from carrier), the proof and the terms from delivery',
  view: DeliveriesView,
  part: true,
  cases: [
    { id: 'delivered', label: 'Every shipment arrived: the order delivered, a step due from delivery', model: model(), note: 'A section of SCR-039 (the order record), on its Shipments tab, below the shipments list.' },
    { id: 'travelling', label: 'One arrived, one still on its way with a tracking problem', model: model({}, { order: { id: uid(1), number: 'SO-26-0031', status: 'SHIPPED', deliveredAt: null }, shipments: [read().shipments[0]!, travelling], steps: [{ id: uid(21), seq: 20, status: 'OPEN', dueDate: null }] }) },
    { id: 'no-steps', label: 'Delivered, no payment step runs from delivery', model: model({}, { steps: [] }) },
    { id: 'returned', label: 'A shipment came back', model: model({}, { order: { id: uid(1), number: 'SO-26-0031', status: 'PARTLY_SHIPPED', deliveredAt: null }, shipments: [{ ...read().shipments[0]!, status: 'RETURNED', deliveredAt: null, deliveredVia: null, pod: null }] }) },
    { id: 'downloading', label: 'Downloading the proof', model: model({ downloading: uid(11) }) },
    { id: 'download-failed', label: 'The proof could not be downloaded', model: model({ problem: 'dv.downloadFailed' }) },
    { id: 'no-right', label: 'A sales person without shipping rights: the download held with why', model: model({}, { shipments: read().shipments.map((row) => ({ ...row, mayOpen: false })) }) },
    { id: 'offline', label: 'Offline: the download held with the reason', model: model({ offline: true }) },
    { id: 'empty', label: 'Nothing shipped yet', model: model({}, { order: { id: uid(1), number: 'SO-26-0031', status: 'CONFIRMED', deliveredAt: null }, shipments: [], steps: [] }) },
    { id: 'loading', label: 'Loading', model: initialDeliveries(PREFIX) },
    { id: 'error', label: 'Could not be read: Try again', model: { ...initialDeliveries(PREFIX), state: 'error' } },
  ],
})
