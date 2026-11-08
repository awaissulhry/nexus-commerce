import { describe, expect, it } from 'vitest'
import { ADDRESS_APPROVALS, ADDRESS_APPROVAL_WORDS, ADDRESS_SHORT_MAX, addressInShort, addressUseProblem, approvalView, checkProblem, defaultProblem, refuseReasonProblem, usableForOrders } from './address-approval'

describe('the check of a delivery address a customer added (B-W2b-F13b)', () => {
  it('an order uses the office’s own addresses and approved ones, never one waiting or refused', () => {
    expect([null, undefined, 'APPROVED', 'WAITING', 'REFUSED'].map((approval) => usableForOrders(approval))).toEqual([true, true, true, false, false])
    expect(addressUseProblem(null)).toBeNull()
    expect(addressUseProblem('APPROVED')).toBeNull()
    expect(addressUseProblem('WAITING')).toMatch(/waits for our check: approve it first/)
    expect(addressUseProblem('REFUSED')).toMatch(/was refused/)
  })

  it('a waiting address is never the default', () => {
    expect(defaultProblem('WAITING')).toMatch(/once we approved it/)
    expect(defaultProblem(null)).toBeNull()
    expect(defaultProblem('APPROVED')).toBeNull()
  })

  it('the office decides a WAITING, active address once, and a refusal says why in 3 to 500 characters', () => {
    expect(checkProblem({ approvalStatus: 'WAITING', status: 'ACTIVE' })).toBeNull()
    expect(checkProblem({ approvalStatus: 'WAITING', status: 'ARCHIVED' })).toMatch(/took this address back/)
    expect(checkProblem({ approvalStatus: null, status: 'ACTIVE' })).toMatch(/never checked/)
    expect(checkProblem({ approvalStatus: 'APPROVED', status: 'ACTIVE' })).toMatch(/approved already/)
    expect(checkProblem({ approvalStatus: 'REFUSED', status: 'ARCHIVED' })).toMatch(/refused already/)
    expect(refuseReasonProblem('  no ')).toMatch(/Say why/)
    expect(refuseReasonProblem('Not a delivery point we serve.')).toBeNull()
    expect(refuseReasonProblem('x'.repeat(501))).toMatch(/At most 500/)
  })

  it('the portal reads the check in both languages, the reason only of a refusal', () => {
    for (const approval of ADDRESS_APPROVALS) expect(ADDRESS_APPROVAL_WORDS[approval].it.length * ADDRESS_APPROVAL_WORDS[approval].en.length).toBeGreaterThan(0)
    expect(approvalView({ approvalStatus: null, refuseReason: null })).toBeNull()
    expect(approvalView({ approvalStatus: 'WAITING', refuseReason: null })).toMatchObject({ status: 'WAITING', refuseReason: null })
    expect(approvalView({ approvalStatus: 'REFUSED', refuseReason: 'Outside our delivery area.' })).toMatchObject({ status: 'REFUSED', words: { en: 'Not accepted' }, refuseReason: 'Outside our delivery area.' })
  })
})

describe('the address in short (B-W2b-F15: the customer is told of our check)', () => {
  it('names the address, the street and the place; at most 120 characters', () => {
    expect(addressInShort({ name: 'Seed warehouse two', line1: 'Via Esempio 12', postalCode: '40100', city: 'Bologna' })).toBe('Seed warehouse two, Via Esempio 12, 40100 Bologna')
    expect(addressInShort({ name: null, line1: 'Via Esempio 12', postalCode: '', city: 'Bologna' })).toBe('Via Esempio 12, Bologna')
    const long = addressInShort({ name: 'x'.repeat(200), line1: 'Via Esempio 12', postalCode: '40100', city: 'Bologna' })
    expect(long).toHaveLength(ADDRESS_SHORT_MAX)
    expect(long.endsWith('…')).toBe(true)
  })
})
