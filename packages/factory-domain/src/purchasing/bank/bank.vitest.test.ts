import { describe, expect, it } from 'vitest'
import { callBackCandidates, callBackProblems, checkProblems, ibanProblem, maskedIban, normaliseIban, payableAccount, pillOf, planProposal, proposalConflict, type AccountFacts, type OnFile } from './rules'

// Made-up test IBANs only: Italian, bank and branch codes of zeros, their check digits right.
const IBAN_A = 'IT11X0000000000000000315001'
const IBAN_B = 'IT81X0000000000000000315002'

const account = (over: Partial<AccountFacts> = {}): AccountFacts => ({
  id: '00000000-0000-4000-8000-000000000001',
  status: 'PROPOSED',
  iban: IBAN_B,
  currency: 'EUR',
  proposedById: 'proposer',
  createdById: 'proposer',
  proposedAt: new Date('2026-11-10T10:00:00Z'),
  callBackAt: null,
  ...over,
})

const onFile = (over: Partial<OnFile> = {}): OnFile => ({ kind: 'CONTACT', id: 'c1', label: 'Order desk', phone: '+39 000 0000315', createdAt: new Date('2026-10-01T08:00:00Z'), updatedAt: new Date('2026-10-01T08:00:00Z'), active: true, ...over })

describe('bank details (SCM-007)', () => {
  it('checks an IBAN: its shape, its country length and its check digits', () => {
    expect(normaliseIban(' it11 x000 0000 0000 0000 0315 001 ')).toBe(IBAN_A)
    expect(ibanProblem(IBAN_A)).toBeNull()
    expect(ibanProblem('IT12X0000000000000000315001')).toMatch(/check digits/)
    expect(ibanProblem(IBAN_A.slice(0, 25))).toMatch(/27 characters/)
    expect(ibanProblem('XX')).toMatch(/two letters of the country/)
    expect(maskedIban('IT', '5001')).toBe('IT** **** **** 5001')
  })

  it('plans a proposal or names each problem at its field', () => {
    expect(planProposal({ iban: IBAN_A.toLowerCase(), holder: '  Made-up Tannery  S.r.l. ', bic: 'seeditm1xxx' })).toEqual({ ok: true, proposal: { iban: IBAN_A, holder: 'Made-up Tannery S.r.l.', bankName: null, bic: 'SEEDITM1XXX', currency: 'EUR' } })
    const bad = planProposal({ iban: 'IT00X0000000000000000315001', holder: ' ', bic: 'NOPE', currency: 'euro' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.issues.map((issue) => issue.path)).toEqual(['body/iban', 'body/holder', 'body/bic', 'body/currency'])
  })

  it('refuses a second open change of a currency, the account in use and one proposed already', () => {
    const proposal = { iban: IBAN_A, holder: 'X', bankName: null, bic: null, currency: 'EUR' }
    expect(proposalConflict(proposal, [{ status: 'ACTIVE', iban: IBAN_A, currency: 'EUR' }])).toMatch(/already use/)
    expect(proposalConflict(proposal, [{ status: 'PROPOSED', iban: IBAN_A, currency: 'EUR' }])).toMatch(/proposed already/)
    expect(proposalConflict(proposal, [{ status: 'PROPOSED', iban: IBAN_B, currency: 'EUR' }])).toMatch(/decide that one first/)
    expect(proposalConflict(proposal, [{ status: 'ACTIVE', iban: IBAN_B, currency: 'EUR' }, { status: 'REFUSED', iban: IBAN_A, currency: 'EUR' }])).toBeNull()
  })

  it('offers only a number on file before the proposal, unchanged since, for the call-back', () => {
    const proposedAt = new Date('2026-11-10T10:00:00Z')
    const { usable, held } = callBackCandidates(
      [onFile(), onFile({ id: 'c2', updatedAt: new Date('2026-11-10T11:00:00Z') }), onFile({ id: 'c3', createdAt: new Date('2026-11-10T10:00:00Z'), updatedAt: new Date('2026-11-10T10:00:00Z') }), onFile({ id: 'c4', phone: '12' })],
      proposedAt,
    )
    expect(usable.map((row) => row.id)).toEqual(['c1'])
    expect(held.map((row) => [row.id, row.hold])).toEqual([['c2', 'CHANGED_AFTER'], ['c3', 'ADDED_AFTER'], ['c4', 'NO_PHONE']])
  })

  it('never lets who proposed or wrote it call back or check it; the check comes after the call-back', () => {
    expect(callBackProblems({ account: account(), byId: 'proposer', candidate: onFile(), phone: '+39 000 0000315' })[0]?.path).toBe('refusal/OWN_CHANGE')
    expect(callBackProblems({ account: account(), byId: 'other', candidate: onFile(), phone: '+39 000 0000999' })[0]?.path).toBe('body/phone')
    expect(callBackProblems({ account: account(), byId: 'other', candidate: onFile(), phone: '(+39) 000-0000315' })[0]).toBeUndefined()
    expect(callBackProblems({ account: account(), byId: 'other', candidate: onFile({ updatedAt: new Date('2026-11-10T12:00:00Z') }), phone: '+39 000 0000315' })[0]?.path).toBe('body/onFile')
    expect(checkProblems(account(), 'second')[0]?.path).toBe('refusal/NOT_CALLED_BACK')
    const calledBack = account({ callBackAt: new Date('2026-11-10T12:00:00Z') })
    expect(checkProblems(calledBack, 'proposer')[0]?.path).toBe('refusal/OWN_CHANGE')
    expect(checkProblems({ ...calledBack, createdById: 'writer' }, 'writer')[0]?.path).toBe('refusal/OWN_CHANGE')
    expect(checkProblems(calledBack, 'second')).toEqual([])
  })

  it('says the pill and pays only the ACTIVE account of the currency', () => {
    expect(pillOf({ status: 'PROPOSED', callBackAt: null })).toBe('WAITING_CALL_BACK')
    expect(pillOf({ status: 'PROPOSED', callBackAt: new Date() })).toBe('WAITING_SECOND_CHECK')
    expect(pillOf({ status: 'ACTIVE', callBackAt: new Date() })).toBe('USABLE')
    const rows = [
      { id: 'a', status: 'RETIRED' as const, currency: 'EUR' },
      { id: 'b', status: 'PROPOSED' as const, currency: 'EUR' },
      { id: 'c', status: 'ACTIVE' as const, currency: 'EUR' },
    ]
    expect(payableAccount(rows, 'EUR')?.id).toBe('c')
    expect(payableAccount(rows, 'USD')).toBeNull()
  })
})
