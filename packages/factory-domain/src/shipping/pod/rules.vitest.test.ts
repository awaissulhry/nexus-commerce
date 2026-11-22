import { describe, expect, it } from 'vitest'
import { podProblems, signerOf, type PodFacts } from './rules'
import { deliveryWayOf, type EndEvent } from './rules' // B-OS-003

/** The proof of delivery (B-W2b-398; LOG-065): only on a delivered shipment, each part once, the time between the goods leaving and now. */

const NOW = new Date('2026-11-14T09:00:00.000Z')
const facts = (over: Partial<PodFacts> = {}): PodFacts => ({ status: 'DELIVERED', shippedAt: new Date('2026-11-12T08:00:00.000Z'), kept: { signedBy: null, signedAt: null, fileId: null }, ...over })

describe('recording a proof of delivery', () => {
  it('takes who signed and when on a delivered shipment', () => {
    expect(podProblems({ signedBy: '  M. Demo ', signedAt: new Date('2026-11-13T10:00:00.000Z'), fileId: null }, facts(), NOW)).toEqual([])
    expect(signerOf('  M. Demo ')).toBe('M. Demo')
  })

  it('refuses one before delivery, a part changed once set, a time in the future or before the goods left, a two-line signer, nothing at all', () => {
    expect(podProblems({ signedBy: 'M. Demo', signedAt: null, fileId: null }, facts({ status: 'SHIPPED' }), NOW).map((issue) => issue.path)).toEqual(['refusal/NOT_DELIVERED'])
    expect(podProblems({ signedBy: 'Another', signedAt: null, fileId: null }, facts({ kept: { signedBy: 'M. Demo', signedAt: null, fileId: null } }), NOW).map((issue) => issue.path)).toEqual(['refusal/KEPT'])
    expect(podProblems({ signedBy: 'M. Demo', signedAt: null, fileId: null }, facts({ kept: { signedBy: 'M. Demo', signedAt: null, fileId: null } }), NOW)).toEqual([])
    expect(podProblems({ signedBy: null, signedAt: new Date('2026-11-15T10:00:00.000Z'), fileId: null }, facts(), NOW).map((issue) => issue.path)).toEqual(['body/signedAt'])
    expect(podProblems({ signedBy: null, signedAt: new Date('2026-11-11T10:00:00.000Z'), fileId: null }, facts(), NOW).map((issue) => issue.path)).toEqual(['body/signedAt'])
    expect(podProblems({ signedBy: 'two\nlines', signedAt: null, fileId: null }, facts(), NOW).map((issue) => issue.path)).toEqual(['body/signedBy'])
    expect(podProblems({ signedBy: null, signedAt: null, fileId: null }, facts(), NOW).map((issue) => issue.path)).toEqual(['body'])
  })
})

// ---- B-OS-003 (order shipments tab; H3-B1, O6): how a journey ended — the carrier, typed by a person, collected by the customer ----
describe('how a shipment was delivered or came back (B-OS-003)', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 20, 10, minutes))
  const event = (id: string, status: string, source: EndEvent['source'], minutes: number, description: string | null = null): EndEvent => ({ id, status, source, description, recordedAt: at(minutes) })
  const facts = (status: string, events: EndEvent[], over: { transportBy?: string; carrierLabelled?: boolean } = {}) => ({ status, transportBy: over.transportBy ?? 'CARRIER', carrierLabelled: over.carrierLabelled ?? false, events })

  it('the carrier delivered it: CARRIER, never by hand', () => {
    expect(deliveryWayOf(facts('DELIVERED', [event('e1', 'DELIVERED', 'POLL', 1)], { carrierLabelled: true }))).toEqual({ deliveredVia: 'CARRIER', byHand: null, carrierLater: null })
  })

  it('the customer collected it: COLLECTED, never by hand (its collection is its delivery)', () => {
    expect(deliveryWayOf(facts('DELIVERED', [event('e1', 'DELIVERED', 'MANUAL', 1, 'Collected by the customer.')], { transportBy: 'RECIPIENT' }))).toEqual({ deliveredVia: 'COLLECTED', byHand: null, carrierLater: null })
  })

  it('typed by a person: TYPED with its words; over a carrier’s labels it overrode them; a later carrier event is said, never a move', () => {
    expect(deliveryWayOf(facts('DELIVERED', [event('e1', 'DELIVERED', 'MANUAL', 1, ' Left at the reception. ')], { transportBy: 'SENDER' }))).toEqual({ deliveredVia: 'TYPED', byHand: { reason: 'Left at the reception.', overrode: false }, carrierLater: null })
    const overrode = deliveryWayOf(facts('DELIVERED', [event('e2', 'RETURNED', 'WEBHOOK', 9), event('e1', 'DELIVERED', 'MANUAL', 1, 'The customer signed our paper.')], { carrierLabelled: true }))
    expect(overrode).toEqual({ deliveredVia: 'TYPED', byHand: { reason: 'The customer signed our paper.', overrode: true }, carrierLater: 'RETURNED' })
    // A carrier event recorded BEFORE the person's move is no "later".
    expect(deliveryWayOf(facts('DELIVERED', [event('e0', 'RETURNED', 'POLL', 0), event('e1', 'DELIVERED', 'MANUAL', 1, '')], { carrierLabelled: true })).carrierLater).toBeNull()
    expect(deliveryWayOf(facts('DELIVERED', [event('e1', 'DELIVERED', 'MANUAL', 1, '')])).byHand).toEqual({ reason: null, overrode: false })
  })

  it('came back: no delivered way; typed by a person it is by hand; the first recorded event of the final status moved it', () => {
    expect(deliveryWayOf(facts('RETURNED', [event('e1', 'RETURNED', 'MANUAL', 1, 'Refused at the door.')], { transportBy: 'SENDER' }))).toEqual({ deliveredVia: null, byHand: { reason: 'Refused at the door.', overrode: false }, carrierLater: null })
    expect(deliveryWayOf(facts('DELIVERED', [event('e2', 'DELIVERED', 'MANUAL', 5, 'typed later'), event('e1', 'DELIVERED', 'POLL', 1)]))).toEqual({ deliveredVia: 'CARRIER', byHand: null, carrierLater: null })
    // Not arrived, or nothing to say it: nothing.
    expect(deliveryWayOf(facts('SHIPPED', [event('e1', 'DELIVERED', 'POLL', 1)]))).toEqual({ deliveredVia: null, byHand: null, carrierLater: null })
    expect(deliveryWayOf(facts('DELIVERED', []))).toEqual({ deliveredVia: null, byHand: null, carrierLater: null })
  })
})
// ---- end B-OS-003
