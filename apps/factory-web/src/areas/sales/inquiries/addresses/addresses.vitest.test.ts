import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../lib/i18n/messages'
import type { AddressesAnswer } from './api'
import { addHeld, doorLine, INQUIRY_ADDRESS_LIMIT, rowProblem, savedList, saveHeld, saveProblem, scopeOf, scopeWords, type AddressesModel } from './model'

/**
 * B-TH-285 (threads plan TH-8; O-SAL-INQ-LIST.band-F04/F05; wall W22, W23): Incoming's ⋯ "Inquiry addresses" — problems in words before
 * Save, the API's refusal by row in the same words, a version clash read again, the list a company edits (its own, else the shared
 * one), and the band's line while the orders@ door is not open. An address belongs to one company (the API refuses another's).
 */

const words = (locale: (typeof LOCALES)[number]) => CATALOGUE[locale]['sales-inquiries']!
const COMPANY = '0190f0e2-1111-7000-8000-000000000001'
const answer = (over: Partial<AddressesAnswer> = {}): AddressesAnswer => ({ addresses: ['orders@demo.example.com'], source: 'COMPANY', version: 3, hasOwnSettings: true, mayManage: true, ...over })
const model = (over: Partial<AddressesModel> = {}): AddressesModel => ({ loaded: { status: 'ready', value: { companyId: COMPANY, answer: answer() } }, draft: ['orders@demo.example.com'], adding: '', domains: ['demo.example.com'], live: false, busy: false, problem: null, saved: false, offline: false, ...over })

describe('B-TH-285 inquiry addresses', () => {
  it('each address in words before Save: an e-mail, once, at a receiving domain of the company (when the domains are known)', () => {
    const list = ['orders@demo.example.com', 'ORDERS@demo.example.com ', 'sales@elsewhere.example.org', 'not an address']
    expect(rowProblem(list, 0, ['demo.example.com'])).toBeNull()
    expect(rowProblem(list, 1, ['demo.example.com'])).toEqual({ key: 'addresses.problem.twice' })
    expect(rowProblem(list, 2, ['demo.example.com'])).toEqual({ key: 'addresses.problem.domain', params: { domains: 'demo.example.com' } })
    expect(rowProblem(list, 2, null)).toBeNull() // the domains unknown to this reader: the API checks them
    expect(rowProblem(list, 3, null)).toEqual({ key: 'addresses.problem.format' })
    expect(savedList([' Orders@Demo.example.com', 'orders@demo.example.com', ''])).toEqual(['orders@demo.example.com'])
  })

  it('Save is held with its reason: the right, a row, the most addresses, nothing changed, offline', () => {
    expect(saveHeld(model())).toEqual({ key: 'addresses.held.same' })
    expect(saveHeld(model({ draft: ['orders@demo.example.com', 'info@demo.example.com'] }))).toBeNull()
    expect(saveHeld(model({ draft: ['orders@demo.example.com', 'x'] }))).toEqual({ key: 'addresses.held.row', params: { n: 2 } })
    expect(saveHeld(model({ draft: Array.from({ length: INQUIRY_ADDRESS_LIMIT + 1 }, (_, n) => `a${n}@demo.example.com`) }))).toEqual({ key: 'addresses.problem.many', params: { max: 20 } })
    expect(saveHeld(model({ loaded: { status: 'ready', value: { companyId: COMPANY, answer: answer({ mayManage: false }) } } }))).toEqual({ key: 'addresses.held.right' })
    expect(saveHeld(model({ draft: ['info@demo.example.com'], offline: true }))).toEqual({ key: 'held.offline' })
    expect(addHeld(['orders@demo.example.com'], 'orders@demo.example.com', null)).toEqual({ key: 'addresses.problem.twice' })
    expect(addHeld([], '  ', null)).toEqual({ key: 'addresses.held.type' })
  })

  it('a refused save names its rows in our words (another company\'s address, a foreign domain); a version clash reads again', () => {
    const refused = new ApiError('invalid', 400, 'invalid', 'x', null, [
      { path: 'body/addresses/0', message: 'Another company’s inquiries come to this address.' },
      { path: 'body/addresses/1', message: 'An address at one of the company’s receiving domains (where its mail arrives).' },
    ])
    expect(saveProblem(refused)).toEqual({ phrase: { key: 'addresses.problem.rows' }, rows: { 0: { key: 'addresses.problem.taken' }, 1: { key: 'addresses.problem.domainApi' } }, stale: false })
    expect(saveProblem(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ phrase: { key: 'addresses.problem.stale' }, rows: {}, stale: true })
    expect(saveProblem(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/companyId', message: 'x' }])).phrase).toEqual({ key: 'addresses.problem.followsTenant' })
    expect(saveProblem(new ApiError('forbidden', 403, 'forbidden', 'x')).phrase).toEqual({ key: 'addresses.held.right' })
  })

  it('a company without settings of its own edits the shared list (and says so); with its own, its own', () => {
    const tenant = answer({ addresses: ['orders@demo.example.com'], source: 'TENANT', version: 5, hasOwnSettings: true })
    expect(scopeOf(answer(), tenant, COMPANY)).toEqual({ companyId: COMPANY, answer: answer() })
    const follows = answer({ source: 'TENANT', hasOwnSettings: false, version: null })
    expect(scopeOf(follows, tenant, COMPANY)).toEqual({ companyId: null, answer: tenant })
    expect(scopeWords({ companyId: null, answer: tenant })).toEqual({ key: 'addresses.scope.tenant' })
    expect(scopeWords({ companyId: COMPANY, answer: answer() })).toEqual({ key: 'addresses.scope.company' })
  })

  it('the band says the orders@ door is not open while mail is not received live; nothing when unknown or open', () => {
    expect(doorLine(['orders@demo.example.com'], false, ['demo.example.com'])).toEqual({ key: 'addresses.door.notLive', params: { count: 1 } })
    expect(doorLine(['orders@demo.example.com'], true, ['demo.example.com'])).toBeNull()
    expect(doorLine(['orders@demo.example.com'], null, null)).toBeNull()
    expect(doorLine([], false, [])).toBeNull()
    expect(doorLine(['orders@demo.example.com'], false, [])).toEqual({ key: 'addresses.door.noDomain' })
  })

  it('every word exists in both languages, and says plainly that unknown senders arrive as prospects', () => {
    for (const locale of LOCALES) {
      const all = words(locale)
      for (const key of ['addresses.menu', 'addresses.intro', 'addresses.problem.taken', 'addresses.problem.stale', 'addresses.door.notLive_other', 'addresses.door.noDomain', 'addresses.scope.tenant', 'addresses.belongs']) expect(all[key], `${locale} ${key}`).toBeTruthy()
    }
    expect(words('en')['addresses.intro']).toMatch(/unknown senders/i)
  })
})
