import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DDT_REQUIRED_REFUSALS } from '@nexus/factory-domain/shipping/ddt'
import { HAND_OVER_LIMITS as DOMAIN_HAND_OVER } from '@nexus/factory-domain/shipping/shipments'
import type { Transport } from '../booking/api'
import { etaBody, etaDialogOf, etaHeld, etaProblem, overridesLabels, statusBody, statusProblem } from '../booking/model'
import { DDT_REQUIRED_REFUSAL_CODES, ddtRequiredBody, ddtRequiredHeld, defaultPlaceOf, receiveHeld } from './doors'
import { HAND_OVER_LIMITS, handOverBody, handOverTimeProblem } from './hand-over'

/**
 * F-OS-203 (order SHIPMENTS tab, 10-design §7; 13-backend B-OS-014 … B-OS-017; 18-lead-settles L1, L3, L13) — the new hand windows of a
 * shipment, pure: hand over at a time (why when not now), travels without a DDT and back (a reason; a live DDT refuses it), receive the
 * garments back (a place), Mark delivered / Mark returned over a carrier's labels (a reason, D5), the expected arrival by hand. One
 * component each on both pages. Made-up data only.
 */

const NOW = new Date('2026-11-22T10:00:00.000Z')

describe('Mark handed over at a time (B-OS-014)', () => {
  it('now asks nothing; a time before packing or the DDT, ahead of now or 60 days back is refused; long ago says why', () => {
    expect(HAND_OVER_LIMITS).toEqual(DOMAIN_HAND_OVER)
    const facts = { packedAt: '2026-11-21T08:00:00.000Z', ddtAt: '2026-11-21T09:00:00.000Z' }
    expect(handOverTimeProblem({ when: null, reason: '' }, facts, NOW)).toBeNull()
    expect(handOverTimeProblem({ when: '2026-11-22T09:50:00.000Z', reason: '' }, facts, NOW)).toBeNull() // 10 minutes ago: no reason
    expect(handOverTimeProblem({ when: '2026-11-21T16:30:00.000Z', reason: '' }, facts, NOW)).toEqual({ key: 'door.handOver.why' })
    expect(handOverTimeProblem({ when: '2026-11-21T16:30:00.000Z', reason: 'The driver left before it was recorded.' }, facts, NOW)).toBeNull()
    expect(handOverTimeProblem({ when: '2026-11-21T08:30:00.000Z', reason: 'x'.repeat(10) }, facts, NOW)).toEqual({ key: 'door.handOver.beforeDdt' })
    expect(handOverTimeProblem({ when: '2026-11-21T07:00:00.000Z', reason: 'x'.repeat(10) }, facts, NOW)).toEqual({ key: 'door.handOver.beforePacked' })
    expect(handOverTimeProblem({ when: '2026-11-22T11:00:00.000Z', reason: '' }, facts, NOW)).toEqual({ key: 'door.handOver.future' })
    expect(handOverTimeProblem({ when: '2026-08-01T10:00:00.000Z', reason: 'x'.repeat(10) }, { packedAt: null, ddtAt: null }, NOW)).toEqual({ key: 'door.handOver.tooOld', params: { days: 60 } })
    expect(handOverBody(null)).toEqual({})
    expect(handOverBody({ shippedAt: '2026-11-21T16:30:00.000Z', reason: 'The driver left before it was recorded.' })).toEqual({ shippedAt: '2026-11-21T16:30:00.000Z', reason: 'The driver left before it was recorded.' })
  })
})

describe('This shipment travels without a DDT… / Put back the DDT (B-OS-017, L3, L13)', () => {
  const packed = { status: 'PACKED' as const, origin: 'NEXUS' as const, ddtRequired: true, version: 5 }
  it('a Nexus shipment before it leaves, the tick (L3) and a reason; back to a DDT needs no tick', () => {
    expect(DDT_REQUIRED_REFUSAL_CODES).toEqual(DDT_REQUIRED_REFUSALS)
    expect(ddtRequiredHeld(packed, { ticked: false, reason: 'Export from Pakistan.' }, false)).toEqual({ key: 'door.ddt.held.tick' })
    expect(ddtRequiredHeld(packed, { ticked: true, reason: '' }, false)).toEqual({ key: 'move.held.reasonShort', params: { min: 3 } })
    expect(ddtRequiredHeld(packed, { ticked: true, reason: 'Export from Pakistan.' }, false)).toBeNull()
    expect(ddtRequiredHeld({ ...packed, ddtRequired: false }, { ticked: false, reason: 'The DDT travels after all.' }, false)).toBeNull()
    expect(ddtRequiredHeld({ ...packed, status: 'SHIPPED' }, { ticked: true, reason: 'Export from Pakistan.' }, false)).toEqual({ key: 'door.ddt.held.left' })
    expect(ddtRequiredHeld({ ...packed, origin: 'ELSEWHERE' }, { ticked: true, reason: 'Export from Pakistan.' }, false)).toEqual({ key: 'door.ddt.held.elsewhere' })
    expect(ddtRequiredBody(packed, { ticked: true, reason: '  Export from Pakistan.  ' })).toEqual({ version: 5, required: false, reason: 'Export from Pakistan.' })
    expect(ddtRequiredBody({ ...packed, ddtRequired: false }, { ticked: false, reason: 'Back.' })).toEqual({ version: 5, required: true, reason: 'Back.' })
  })
})

describe('Receive the garments back… (H3-B11)', () => {
  const read = { state: 'AWAITED', garments: 70, places: [{ id: 'p1', code: 'FG', name: 'Finished goods' }], defaultLocationId: null }
  it('a shipment the carrier brought back, not received yet, into a finished-goods place (the site\'s one chosen for the person)', () => {
    expect(defaultPlaceOf(read)).toBe('p1')
    expect(receiveHeld(read, { locationId: 'p1', note: '' }, false)).toBeNull()
    expect(receiveHeld(read, { locationId: null, note: '' }, false)).toEqual({ key: 'door.receive.held.pickPlace' })
    expect(receiveHeld({ ...read, state: 'RECEIVED' }, { locationId: 'p1', note: '' }, false)).toEqual({ key: 'door.receive.held.received' })
    expect(receiveHeld({ ...read, state: 'NOT_RETURNED' }, { locationId: 'p1', note: '' }, false)).toEqual({ key: 'door.receive.held.notReturned' })
    expect(receiveHeld({ ...read, places: [] }, { locationId: null, note: '' }, false)).toEqual({ key: 'door.receive.held.noPlace' })
  })
})

const transport = (over: { labels?: number; status?: Transport['shipment']['status']; expected?: string | null; shippedAt?: string | null } = {}): Transport => ({
  shipment: { id: 'sh-11', number: 'SEED-SH-0011', status: over.status ?? 'SHIPPED', version: 3, transportBy: 'CARRIER', carrierCode: 'brt', carrierName: 'BRT', serviceCode: null, manualTrackingNumber: null, manualTrackingUrl: null, ddtRequired: true, shippedAt: over.shippedAt === undefined ? '2026-11-12T08:00:00.000Z' : over.shippedAt, deliveredAt: null, returnedAt: null, expectedDeliveryAt: over.expected ?? null },
  arrangement: 'CARRIER',
  ddt: { id: 'd1', number: '144/2026' },
  labels: { carrier: over.labels ?? 0, test: 0 },
  may: { arrange: { allowed: true, refusal: null }, track: { allowed: true, refusal: null }, status: { allowed: true, refusal: null } },
  events: [],
})

describe('Mark delivered… / Mark returned… over a carrier\'s labels (B-OS-015, Owner D5; L1)', () => {
  it('a labelled shipment says why (3 to 500), kept as the event\'s words; our van or a carrier booked by hand: no reason asked', () => {
    const dialog = { kind: 'status' as const, status: 'DELIVERED' as const, occurredAt: null, description: '', location: '', reason: '' }
    expect(overridesLabels(dialog, transport({ labels: 2 }))).toBe(true)
    expect(overridesLabels({ status: 'IN_TRANSIT' }, transport({ labels: 2 }))).toBe(false)
    expect(statusProblem(dialog, transport({ labels: 2 }))).toEqual({ key: 'door.status.why', params: { min: 3 } })
    expect(statusProblem({ ...dialog, reason: 'The customer confirmed by phone.' }, transport({ labels: 2 }))).toBeNull()
    expect(statusProblem(dialog, transport())).toBeNull()
    expect(statusBody({ ...dialog, reason: ' The customer confirmed by phone. ' }, transport({ labels: 2 }), 'DELIVERED')).toEqual({ version: 3, status: 'DELIVERED', description: null, location: null, reason: 'The customer confirmed by phone.' })
    expect(statusBody({ ...dialog, reason: 'unused' }, transport(), 'DELIVERED')).toEqual({ version: 3, status: 'DELIVERED', description: null, location: null })
  })
})

describe('Set expected arrival… (B-OS-016)', () => {
  it('a day not before the goods left, at most a year ahead; empty clears it; a carrier\'s feed refuses it in words', () => {
    const now = new Date('2026-11-22T10:00:00.000Z')
    expect(etaDialogOf(transport({ expected: '2026-11-20T12:00:00.000Z' }))).toEqual({ kind: 'eta', day: '2026-11-20', reason: '' })
    expect(etaProblem({ kind: 'eta', day: '2026-11-25', reason: '' }, transport(), now)).toBeNull()
    expect(etaProblem({ kind: 'eta', day: '', reason: '' }, transport(), now)).toEqual({ key: 'door.eta.pickDay' })
    expect(etaProblem({ kind: 'eta', day: '', reason: '' }, transport({ expected: '2026-11-20T12:00:00.000Z' }), now)).toBeNull()
    expect(etaProblem({ kind: 'eta', day: '2026-11-01', reason: '' }, transport(), now)).toEqual({ key: 'door.eta.beforeLeft' })
    expect(etaProblem({ kind: 'eta', day: '2028-01-01', reason: '' }, transport(), now)).toEqual({ key: 'door.eta.tooFar' })
    expect(etaBody({ kind: 'eta', day: '2026-11-25', reason: ' Phoned the carrier. ' }, transport())).toEqual({ version: 3, expectedDeliveryAt: '2026-11-25T12:00:00.000Z', reason: 'Phoned the carrier.' })
    expect(etaBody({ kind: 'eta', day: '', reason: '' }, transport())).toEqual({ version: 3, expectedDeliveryAt: null })
    expect(etaHeld({ allowed: false, refusal: { code: 'CARRIER_FED' } }, true)).toEqual({ key: 'door.eta.refusal.CARRIER_FED' })
    expect(etaHeld({ allowed: true, refusal: null }, false)).toEqual({ key: 'transport.held.noManage' })
    expect(etaHeld(undefined, true)).toEqual({ key: 'transport.held.notNow' })
  })
})

describe('extracted, never copied (13-backend §7): the tab mounts Warehouse\'s own windows', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  it('ShipmentDoor draws Warehouse\'s exported dialogs; the record still draws them in its own switch', () => {
    const door = source('./ShipmentDoor.tsx')
    expect(door).toContain("import { CancelDialog, TakeOffDialog, UnpackDialog, type DoorActions, type DoorModel } from './view/Dialogs'")
    const dialogs = source('./view/Dialogs.tsx')
    for (const name of ['export function UnpackDialog(', 'export function CancelDialog(', 'export function TakeOffDialog(', 'export function HandOverDialog(']) expect(dialogs, name).toContain(name)
    for (const name of ["return <UnpackDialog {...props} />", "return <CancelDialog {...props} />", "return <TakeOffDialog {...props} salesOrderId={dialog.salesOrderId} />", "return <HandOverDialog {...props} />"]) expect(dialogs, name).toContain(name)
    const tab = source('../../../sales/orders/record/use-shipments-acts.ts')
    for (const name of ['ShipmentDoor', 'HoldsDoor', 'DeliveryDoor', 'ShipmentTransportDoor', 'Split', 'Move']) expect(tab, name).toContain(`createElement(${name},`)
    // No dialog is drawn by the tab's own views: every window is Warehouse's.
    for (const file of ['ShipmentsSection.tsx', 'ShipmentRow.tsx', 'WhereSection.tsx', 'AfterSalesSection.tsx']) expect(source(`../../../sales/orders/record/shipments/view/${file}`), file).not.toMatch(/DepthDialog|<Frame\b/)
  })
})

describe('every word the shared windows name exists in it and en (the lane\'s namespace, L11)', () => {
  it('each key, or its plural forms; each refusal code worded', async () => {
    const { CATALOGUE } = await import('../../../../lib/i18n/messages')
    const { LOCALES } = await import('../../../../lib/i18n/locales')
    const { ETA_REFUSALS } = await import('@nexus/factory-domain/shipping/own-transport/rules')
    const { MOVE_REFUSALS, TAKE_OFF_REFUSALS } = await import('@nexus/factory-domain/shipping/split/split')
    const files = ['./ShipmentDoor.tsx', './doors.ts', './hand-over.ts', './view/Dialogs.tsx', './view/DoorDialogs.tsx', '../queue/move/model.ts', '../queue/move/Move.tsx', '../queue/move/view/MoveDialog.tsx', '../booking/model.ts', '../booking/view/TransportView.tsx', '../booking/CarrierDepth.tsx', '../queue/record-depth.tsx', '../../../sales/orders/record/use-shipments-acts.ts', '../../../sales/orders/record/shipments/doors.ts']
    const source = files.map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n')
    // The prefixes handed to writeWords are not keys (a refusal's code completes them: `made` below).
    const prefixes = new Set(['move.refusal', 'door.ddt.refusal', 'door.eta.refusal', 'door.receive.refusal'])
    const keys = [...new Set([...source.matchAll(/'((?:door|move|ships)\.[a-zA-Z.]+)'/g)].map((match) => match[1]!))].filter((key) => !prefixes.has(key))
    const made = [
      ...['unpack', 'cancel', 'takeOff', 'ddtRequired', 'receiveBack'].map((kind) => `door.title.${kind}`),
      ...DDT_REQUIRED_REFUSALS.map((code) => `door.ddt.refusal.${code}`),
      ...ETA_REFUSALS.map((code) => `door.eta.refusal.${code}`),
      ...[...MOVE_REFUSALS, ...TAKE_OFF_REFUSALS].map((code) => `move.refusal.${code}`),
      ...['split', 'arrange', 'eta', 'delivered', 'returned', 'placeHold', 'releaseHold', 'proof', 'resolve'].map((act) => `ships.done.${act}`),
      'move.done.moved',
      'move.done.merged',
    ]
    expect(keys.length).toBeGreaterThan(40)
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['order-shipments'] ?? {}
      for (const key of [...keys, ...made]) expect(words[key] ?? words[`${key}_other`], `${locale} ${key}`).toBeTruthy()
      // L1: one Italian word for RETURNED on the order's tab and in Warehouse (Rientrata; Resa sits next to Reso).
      if (locale === 'it') for (const ns of ['shipments', 'warehouse-shipments-depth']) expect(CATALOGUE.it[ns]?.['status.RETURNED'], ns).toBe('Rientrata')
    }
  })
})
