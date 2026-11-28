import { defineDesignScreen } from '../../../../../../lib/design/design-screen'
import type { Leg } from './api'
import { EMPTY_SEND_ON } from './model'
import { LegActView, type LegActViewModel } from './view/LegActView'

/**
 * owb-ss3 step 3.2 — the warehouse leg's window in the design index (`/design/SCR-owb-warehouse-leg`): It arrived at the warehouse; Send on
 * to the customer without the customer's label (a yellow line, never a stop); after the payment warning (Send it anyway); two shipments
 * to pick from; nothing to do. Made-up data only (example numbers).
 */

const leg = (state: Leg['state'], over: Partial<Leg> = {}): Leg => ({
  shipmentId: 'sh-1',
  version: 4,
  warehouse: { siteId: 'wh-1', name: 'Milan warehouse', city: 'Milan' },
  state,
  arrivedAt: state === 'ON_THE_WAY' ? null : '2026-11-24T09:00:00.000Z',
  forwardedAt: null,
  forwardedWithoutLabel: false,
  label: null,
  may: { arrived: state === 'ON_THE_WAY', sendOn: state === 'AT_OUR_WAREHOUSE', label: true },
  ...over,
})
const choice = { shipmentId: 'sh-1', number: 'SH-2026-0041', pieces: 12, place: 'Milan warehouse, Milan' }
const base: LegActViewModel = {
  open: true,
  act: 'SEND_ON',
  state: 'ready',
  readProblem: null,
  choices: [choice],
  picked: 'sh-1',
  leg: leg('AT_OUR_WAREHOUSE'),
  href: '/w/DEMO/warehouse/shipments/sh-1',
  form: EMPTY_SEND_ON,
  warnings: null,
  busy: false,
  writeProblem: null,
}

export const designScreen = defineDesignScreen<LegActViewModel>({
  screen: 'SCR-owb-warehouse-leg',
  title: 'The warehouse leg — It arrived at the warehouse · Send on to the customer (owb-ss3)',
  view: LegActView,
  cases: [
    { id: 'arrived', label: 'It arrived at the warehouse', model: { ...base, act: 'ARRIVED', leg: leg('ON_THE_WAY') }, note: 'One line and Confirm.' },
    { id: 'send-on-no-label', label: 'Send on, no label from the customer yet', model: base, note: 'A yellow line; it goes on, and the history keeps it.' },
    { id: 'send-on-label', label: 'Send on with the customer’s label', model: { ...base, leg: leg('AT_OUR_WAREHOUSE', { label: { sentAt: '2026-11-25T09:00:00.000Z', byCustomer: true, fileId: 'file-1' } }), form: { carrier: 'GLS', trackingNumber: 'GLS-EXAMPLE-1' } } },
    { id: 'send-on-warning', label: 'A payment due before shipping is open', model: { ...base, warnings: ['PAYMENT_DUE_AT_SHIP'] }, note: 'The act says "Send it anyway"; no amount.' },
    { id: 'pick', label: 'Two shipments at our warehouse', model: { ...base, choices: [choice, { shipmentId: 'sh-2', number: 'SH-2026-0042', pieces: 4, place: 'Lisbon warehouse, Lisbon' }] } },
    { id: 'none', label: 'Nothing to send on', model: { ...base, state: 'none', choices: [], picked: null, leg: null, href: null } },
  ],
})
