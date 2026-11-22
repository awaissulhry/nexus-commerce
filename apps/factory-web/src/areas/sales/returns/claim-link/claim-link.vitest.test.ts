import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { claimLinkBody, claimLinkHeld, claimLinkRefusal, OTHER_ADDRESS } from './model'

/**
 * F-OS-303 (order SHIPMENTS tab, 10-design §5 / §6) — Send a claim link…, pure: to whom (a contact of the customer, or an address typed),
 * what holds Send, the request (always mailed), a refusal in words. Made-up data only (addresses on example.com).
 */

const record = { type: 'Shipment' as const, id: 'sh-12', number: 'SEED-SH-0012' }

describe('Send a claim link…', () => {
  it('held until someone is picked, and a typed address looks like one; never while sending', () => {
    expect(claimLinkHeld({ to: '', email: '', busy: false })).toBe('claim.held.pickTo')
    expect(claimLinkHeld({ to: OTHER_ADDRESS, email: 'lia.cliente', busy: false })).toBe('claim.held.email')
    expect(claimLinkHeld({ to: OTHER_ADDRESS, email: ' lia.cliente@example.com ', busy: false })).toBeNull()
    expect(claimLinkHeld({ to: 'contact-1', email: '', busy: false })).toBeNull()
    expect(claimLinkHeld({ to: 'contact-1', email: '', busy: true })).toBe('door.held.busy')
  })

  it('the request names the shipment (or the order) and the contact, or the address typed; it is always mailed', () => {
    expect(claimLinkBody({ record, to: 'contact-1', email: '' })).toEqual({ recordType: 'Shipment', recordId: 'sh-12', contactId: 'contact-1', send: true })
    expect(claimLinkBody({ record: { type: 'SalesOrder', id: 'so-2', number: 'SEED-SO-0002' }, to: OTHER_ADDRESS, email: ' lia.cliente@example.com ' })).toEqual({ recordType: 'SalesOrder', recordId: 'so-2', email: 'lia.cliente@example.com', send: true })
  })

  it('a refusal in words: a bounced address, an address refused, a record it cannot find; else try again', () => {
    expect(claimLinkRefusal(new Error('offline'))).toBe('claim.refusal.other')
    // The factory API names a refusal `refusal/<CODE>` and a field `body/<name>` (one string each).
    expect(claimLinkRefusal(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/SUPPRESSED', message: 'x' }]))).toBe('claim.refusal.SUPPRESSED')
    expect(claimLinkRefusal(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/email', message: 'x' }]))).toBe('claim.refusal.email')
    expect(claimLinkRefusal(new ApiError('not_found', 404, 'not_found', 'x'))).toBe('claim.refusal.notFound')
  })
})
