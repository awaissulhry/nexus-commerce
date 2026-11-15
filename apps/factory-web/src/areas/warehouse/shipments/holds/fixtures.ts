import { createElement, Fragment } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Holds } from './api'
import { initialHolds, type BulkHoldModel, type HoldsPanelModel } from './model'
import { BulkHoldDialog } from './view/BulkHoldDialog'
import { HoldBanner } from './view/HoldBanner'
import { HoldsDialogsView, HoldsPanelView } from './view/HoldsPanelView'

/**
 * SCR-592 — a shipment's holds (B-W2b-410 on B-W2b-386; design sh-ready "W2b: no hold", the selection row "Hold"): the band's
 * line, "No hold" in Ready to ship with each hold in force and who releases it, Place a hold, Release with the words why,
 * the list's Hold N. Made-up data only: shipment SH-26-0107 of a made-up customer; people "Marta Demo" and "Luca Prova".
 */

const uid = (n: number) => `0190f0e2-7410-7000-8000-${String(n).padStart(12, '0')}`
const CHOICES: Holds['reasonChoices'] = [
  { reason: 'CREDIT', wordsRequired: false, releasedBy: 'shipping.holds.release' },
  { reason: 'DEPOSIT', wordsRequired: false, releasedBy: 'shipping.holds.release' },
  { reason: 'BALANCE_UNPAID', wordsRequired: false, releasedBy: 'shipping.holds.release' },
  { reason: 'QUALITY', wordsRequired: false, releasedBy: 'shipping.holds.manage' },
  { reason: 'CUSTOMER_REQUEST', wordsRequired: false, releasedBy: 'shipping.holds.manage' },
  { reason: 'OTHER', wordsRequired: true, releasedBy: 'shipping.holds.manage' },
]

const free: Holds = { shipmentId: uid(1), number: 'SH-26-0107', status: 'PACKED', held: false, reasons: [], holds: [], mayPlace: true, reasonChoices: CHOICES }

const held: Holds = {
  ...free,
  held: true,
  reasons: ['BALANCE_UNPAID', 'CUSTOMER_REQUEST'],
  holds: [
    { id: uid(11), reason: 'BALANCE_UNPAID', words: null, inForce: true, bySystem: true, placedAt: '2026-11-14T08:05:00.000Z', placedBy: null, releasedAt: null, releasedBySystem: false, releasedBy: null, releaseWords: null, version: 1, mayRelease: false },
    { id: uid(12), reason: 'CUSTOMER_REQUEST', words: 'The customer asks us to wait for their new warehouse address.', inForce: true, bySystem: false, placedAt: '2026-11-14T09:40:00.000Z', placedBy: 'Marta Demo', releasedAt: null, releasedBySystem: false, releasedBy: null, releaseWords: null, version: 1, mayRelease: true },
    { id: uid(13), reason: 'QUALITY', words: 'Final inspection re-check on size 52.', inForce: false, bySystem: false, placedAt: '2026-11-12T10:00:00.000Z', placedBy: 'Luca Prova', releasedAt: '2026-11-13T15:20:00.000Z', releasedBySystem: false, releasedBy: 'Luca Prova', releaseWords: 'Re-check passed.', version: 2, mayRelease: true },
  ],
}

const WAREHOUSE = { holdsManage: true, holdsRelease: false }
const FINANCE = { holdsManage: true, holdsRelease: true }
const READER = { holdsManage: false, holdsRelease: false }
const panel = (over: Partial<HoldsPanelModel> = {}, holds: Holds = held): HoldsPanelModel => ({ ...initialHolds, can: WAREHOUSE, holds: { state: 'ready', value: holds }, ...over })
const financeView = (holds: Holds): Holds => ({ ...holds, holds: holds.holds.map((hold) => ({ ...hold, mayRelease: true })) })

const bulk = (over: Partial<BulkHoldModel> = {}): BulkHoldModel => ({
  picked: [
    { id: uid(21), number: 'SH-26-0107', status: 'PACKED' },
    { id: uid(22), number: 'SH-26-0108', status: 'DRAFT' },
    { id: uid(23), number: 'SH-26-0099', status: 'SHIPPED' },
  ],
  reason: null,
  text: '',
  busy: false,
  problem: null,
  outcome: null,
  ...over,
})

interface HoldsCase {
  readonly panel?: HoldsPanelModel
  readonly bulk?: BulkHoldModel
}

function HoldsDesign({ model }: { model: HoldsCase }) {
  return createElement(
    Fragment,
    null,
    model.panel ? createElement(HoldBanner, { holds: model.panel.holds.state === 'ready' ? model.panel.holds.value : null, holdsHref: '#holds' }) : null,
    model.panel ? createElement(HoldsPanelView, { model: model.panel }) : null,
    model.panel ? createElement(HoldsDialogsView, { model: model.panel }) : null,
    model.bulk ? createElement(BulkHoldDialog, { model: model.bulk }) : null,
  )
}

export const designScreen = defineDesignScreen<HoldsCase>({
  screen: 'SCR-592',
  title: 'Shipment › holds: no hold, place, release (who may), the list\'s Hold N',
  view: HoldsDesign,
  part: true,
  cases: [
    { id: 'no-hold', label: 'No hold: the check is green, Place a hold offered', model: { panel: panel({}, free) }, note: 'Lines & cartons › Ready to ship (rail) of SCR-067.' },
    { id: 'held-warehouse', label: 'Held (warehouse): the balance by the system (finance releases it, held with why) and a customer request', model: { panel: panel() } },
    { id: 'held-finance', label: 'Held (finance): every hold may be released', model: { panel: panel({ can: FINANCE }, financeView(held)) } },
    { id: 'place', label: 'Place a hold: the reasons left, who releases each, Other needs words', model: { panel: panel({ dialog: { kind: 'place', reason: 'OTHER', text: '' } }) } },
    { id: 'place-quality', label: 'Place a hold: quality, with words', model: { panel: panel({ dialog: { kind: 'place', reason: 'QUALITY', text: 'Stitching to re-check on two jackets.' } }, free) } },
    { id: 'release', label: 'Release the customer request: the words why', model: { panel: panel({ dialog: { kind: 'release', holdId: uid(12), text: 'New address received by mail.' } }) } },
    { id: 'release-system', label: 'Finance releases the system\'s balance hold: it will not come back for this cause', model: { panel: panel({ can: FINANCE, dialog: { kind: 'release', holdId: uid(11), text: '' } }, financeView(held)) } },
    { id: 'refused', label: 'A refused release, in words (only finance)', model: { panel: panel({ dialog: { kind: 'release', holdId: uid(12), text: 'Ok.' }, problem: { key: 'holds.refusal.MAY_NOT_RELEASE' } }) } },
    { id: 'read-only', label: 'A reader without the holds right: buttons held with why', model: { panel: panel({ can: READER }, { ...held, mayPlace: false, holds: held.holds.map((hold) => ({ ...hold, mayRelease: false })) }) } },
    { id: 'shipped', label: 'Shipped: no hold can be placed (nothing offered)', model: { panel: panel({}, { ...free, status: 'SHIPPED' }) } },
    { id: 'bulk', label: 'List › Hold 2: one shipped left out before anything is sent', model: { bulk: bulk() } },
    { id: 'bulk-ready', label: 'List › Hold 2: customer request picked', model: { bulk: bulk({ reason: 'CUSTOMER_REQUEST', text: 'Customer asked to wait.' }) } },
    { id: 'bulk-done', label: 'List › Hold: placed one, skipped one already held', model: { bulk: bulk({ reason: 'CUSTOMER_REQUEST', outcome: { placed: [{ shipmentId: uid(22), number: 'SH-26-0108', holdId: uid(31) }], skipped: [{ shipmentId: uid(21), number: 'SH-26-0107', code: 'ALREADY_HELD' }] } }) } },
    { id: 'loading', label: 'Loading', model: { panel: { ...initialHolds, can: WAREHOUSE } } },
    { id: 'error', label: 'Could not be read: Try again', model: { panel: { ...initialHolds, can: WAREHOUSE, holds: { state: 'error', problem: { key: 'problem.read.unavailable' } } } } },
  ],
})
