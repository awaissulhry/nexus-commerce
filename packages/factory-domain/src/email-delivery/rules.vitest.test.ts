import { describe, expect, it } from 'vitest'
import { addressOfSuppression, deliveryStateOf, deliveryTimeOf, isUnblocked, maskAddress, unblockedAddress, unblockProblems } from './rules'

describe('the delivery log (PLT-149)', () => {
  it('puts each status in one of five states', () => {
    expect(['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'FAILED'].map((status) => deliveryStateOf(status as never))).toEqual(['WAITING', 'WAITING', 'SENT', 'DELIVERED', 'PROBLEM', 'PROBLEM', 'FAILED'])
  })

  it('shows the time of the latest state', () => {
    const queuedAt = new Date('2026-10-30T08:00:00Z')
    const sentAt = new Date('2026-10-30T08:01:00Z')
    const bouncedAt = new Date('2026-10-30T08:05:00Z')
    const row = { queuedAt, sentAt, deliveredAt: null, bouncedAt, complainedAt: null, failedAt: null }
    expect(deliveryTimeOf({ ...row, status: 'BOUNCED' })).toEqual(bouncedAt)
    expect(deliveryTimeOf({ ...row, status: 'SENT' })).toEqual(sentAt)
    expect(deliveryTimeOf({ ...row, status: 'QUEUED' })).toEqual(queuedAt)
  })

  it('masks an address but keeps its domain', () => {
    expect(maskAddress('ada.esempio@cliente.example')).toBe('a•••@cliente.example')
    expect(maskAddress('not an address')).toBe('•••')
  })

  it('moves an unblocked address aside, still readable, and refuses a second unblock or no reason', () => {
    const stored = unblockedAddress('0190a000-0000-7000-8000-000000000001', 'ada@cliente.example')
    expect(isUnblocked(stored)).toBe(true)
    expect(isUnblocked('ada@cliente.example')).toBe(false)
    expect(addressOfSuppression(stored)).toBe('ada@cliente.example')
    expect(addressOfSuppression('ada@cliente.example')).toBe('ada@cliente.example')
    expect(unblockProblems({ address: stored, reason: 'fixed' }).map((issue) => issue.path)).toEqual(['suppression/unblocked'])
    expect(unblockProblems({ address: 'ada@cliente.example', reason: ' ' }).map((issue) => issue.path)).toEqual(['body/reason'])
    expect(unblockProblems({ address: 'ada@cliente.example', reason: 'The customer fixed the mailbox' })).toEqual([])
  })
})
