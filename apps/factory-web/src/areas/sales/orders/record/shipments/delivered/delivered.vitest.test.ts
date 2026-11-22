import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { deliveriesSchema, type Deliveries } from './api'
import { proofFileOf } from './model'

/**
 * B-W2b-398 → F-OS-104 (order SHIPMENTS tab; 18-lead-settles L5) — the order's deliveries READ stays; its card "Delivered (from carrier)"
 * went: each Shipments row draws its delivery in its Dates cell (shipments/rows.ts `datesOf`, tested in rows.vitest.test.ts). Made-up data.
 */

const answer = (over: Partial<Deliveries['shipments'][number]> = {}): unknown => ({
  order: { id: 'so-1', number: 'SEED-SO-0031', status: 'DELIVERED', deliveredAt: '2026-11-13T10:42:00.000Z' },
  shipments: [{ id: 'sh-1', number: 'SEED-SH-0040', status: 'DELIVERED', carrierName: 'Seed Carrier', shippedAt: '2026-11-10T15:05:00.000Z', deliveredAt: '2026-11-12T09:31:00.000Z', deliveredVia: 'CARRIER', pod: { signedBy: 'FAKE RECIPIENT', signedAt: '2026-11-12T09:31:00.000Z', image: true }, openProblems: 0, mayOpen: true, ...over }],
  steps: [{ id: 'st-1', seq: 20, status: 'OPEN', dueDate: '2026-12-13' }],
})

describe('the deliveries read (kept: L5)', () => {
  it('an older answer and the new one (B-OS-003) both parse: by hand, the carrier\'s later word, came back, the typed arrival', () => {
    expect(() => deliveriesSchema.parse(answer())).not.toThrow()
    const read = deliveriesSchema.parse(answer({ deliveredVia: 'COLLECTED', byHand: { reason: 'The customer confirmed by phone.', overrode: true }, carrierLater: 'RETURNED', returned: null, expectedDeliveryAt: '2026-11-12T00:00:00.000Z', etaByHand: true }))
    expect(read.shipments[0]).toMatchObject({ deliveredVia: 'COLLECTED', byHand: { reason: 'The customer confirmed by phone.', overrode: true }, carrierLater: 'RETURNED', etaByHand: true })
    // A way of delivery the server adds later never breaks the read (a plain string).
    expect(() => deliveriesSchema.parse(answer({ deliveredVia: 'SOMETHING_NEW' }))).not.toThrow()
  })
})

// ---- B-SA-0xxb / F-SA-266b (10-order-page §6.4 "Viewer: … POD"): the proof opens in the thread's ONE viewer, not a download
describe('B-SA-0xxb: the proof of delivery opens in the thread\'s ONE viewer when the reader has its file', () => {
  const file = { id: '00000000-0000-4000-8000-0000000000f1', name: 'proof-of-delivery-SH-26-0040.pdf', contentType: 'application/pdf', sizeBytes: 48211 }

  it('the API\'s file (files.read on the shipment) is the viewer\'s; none: no file', () => {
    const read = deliveriesSchema.parse(answer({ pod: { signedBy: 'FAKE RECIPIENT', signedAt: null, image: true, file } }))
    expect(proofFileOf(read.shipments[0]!)).toEqual(file)
    expect(proofFileOf(deliveriesSchema.parse(answer()).shipments[0]!)).toBeNull()
    expect(proofFileOf({ pod: null })).toBeNull()
  })

  it('the row\'s Proof › hands the proof to the frame\'s viewer (openFiles), as the order\'s other files; the card is gone', () => {
    const row = readFileSync(new URL('../view/ShipmentRow.tsx', import.meta.url), 'utf8')
    expect(row).toContain('openFiles({ files: [proof], fileId: proof.id, returnTo: document.activeElement as HTMLElement | null })')
    expect(existsSync(new URL('./Deliveries.tsx', import.meta.url))).toBe(false)
    expect(existsSync(new URL('./view/DeliveriesView.tsx', import.meta.url))).toBe(false)
  })
})
// ---- end B-SA-0xxb
