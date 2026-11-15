import { describe, expect, it } from 'vitest'
import { accountNumberProblem, carrierCodeProblem, contractFor, contractWords, customerAccountProblems, liveContractOf, numberEndOf, serviceCodeProblem } from './rules'

const contract = (id: string, siteId: string | null, carrierCode = 'brt', active = true) => ({ id, companyId: 'A', siteId, carrierCode, active })

describe('our own carrier contracts (LOG-033)', () => {
  it('a label takes the site’s live contract, else the company’s (every site); a switched-off one never', () => {
    const rows = [contract('old', 'A1', 'brt', false), contract('company', null), contract('a2', 'A2'), contract('gls', null, 'gls')]
    expect(contractFor(rows, { companyId: 'A', siteId: 'A1', carrierCode: 'brt' })?.id).toBe('company')
    expect(contractFor(rows, { companyId: 'A', siteId: 'A2', carrierCode: 'brt' })?.id).toBe('a2')
    expect(contractFor(rows, { companyId: 'A', siteId: 'A1', carrierCode: 'dpd' })).toBeNull()
    expect(contractFor(rows, { companyId: 'A', siteId: 'A1', carrierCode: null })).toBeNull()
    expect(contractFor(rows, { companyId: 'B', siteId: 'A1', carrierCode: 'brt' })).toBeNull()
    expect(liveContractOf(rows, { companyId: 'A', siteId: 'A1', carrierCode: 'brt' })).toBeNull()
  })

  it('checks the carrier code and the account number; answers only the last four characters', () => {
    expect(carrierCodeProblem(' BRT ')).toBeNull()
    expect(carrierCodeProblem('dhl express')).not.toBeNull()
    expect(accountNumberProblem('IT-1234/567')).toBeNull()
    expect(accountNumberProblem('12')).not.toBeNull()
    expect(accountNumberProblem('1234\n5678')).not.toBeNull()
    expect(numberEndOf('IT-1234 5678')).toBe('5678')
    expect(serviceCodeProblem(undefined)).toBeNull()
    expect(serviceCodeProblem('made-up\nservice')).not.toBeNull()
  })

  it('says what a contract covers in words', () => {
    expect(contractWords({ siteId: null, carrierCode: 'brt', active: true, ownRatesOnly: true }, null)).toBe('Our own contract with BRT, for every site of the company: labels for it are bought only on this contract ("use only our rates").')
    expect(contractWords({ siteId: 'A1', carrierCode: 'gls', active: true, ownRatesOnly: false }, 'A1')).toBe('Our own contract with GLS, for site A1 only.')
    expect(contractWords({ siteId: null, carrierCode: 'gls', active: false, ownRatesOnly: false }, null)).toMatch(/switched off/)
  })
})

describe("the customer's carrier account (LOG-038)", () => {
  it('COLLECT and THIRD_PARTY need the account; the account and the default service need the carrier', () => {
    expect(customerAccountProblems({ carrierCode: 'ups', accountOnFile: true, freightBilling: 'COLLECT', defaultService: 'made-up-saver' })).toEqual([])
    expect(customerAccountProblems({ carrierCode: 'ups', accountOnFile: false, freightBilling: 'THIRD_PARTY', defaultService: null }).map((problem) => problem.path)).toEqual(['body/freightBilling'])
    expect(customerAccountProblems({ carrierCode: null, accountOnFile: true, freightBilling: 'SENDER', defaultService: 'x' }).map((problem) => problem.path)).toEqual(['body/carrierCode', 'body/defaultCarrierService'])
  })
})
