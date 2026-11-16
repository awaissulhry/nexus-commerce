import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DECLARATION_STATES as DOMAIN_STATES } from '@nexus/factory-domain/invoicing/intent/intent'
import { ApiError } from '../../../../lib/api/errors'
import { messagesFor } from '../../../../lib/i18n/messages'
import { RECORD_PAGES, recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { DECLARATION_STATES, intentTouched, type Declaration, type InvoiceIntent } from './api'
import { designScreen } from './fixtures'
import {
  addFieldProblems,
  addHeld,
  addInput,
  addProblems,
  checkHeld,
  emptyAddDraft,
  INTENT_REFUSALS,
  intentAbilitiesOf,
  intentProblem,
  letGoHeld,
  NAMESPACE,
  nameHeld,
  namedWords,
  otherYear,
  pickShown,
  ReceiptHeldError,
  reasonProblem,
  receiptHeld,
  revokeHeld,
  STATE_TONE,
  usedPercent,
  yearsForDate,
  yearsOf,
} from './model'

/**
 * B-W2b-GB02 (G152): the declarations of intent's screen rules. Before this step the folder did not exist: no list, record,
 * check, revocation, new declaration or naming on a draft was on screen (B-W2b-417's gap), so every test here failed.
 */

const FINANCE = ['invoices.view', 'invoices.manage', 'invoices.tax.manage', 'files.upload', 'parties.view', 'money.price']
const can = intentAbilitiesOf(FINANCE)
const reader = intentAbilitiesOf(['invoices.view', 'money.price'])
const TODAY = '2026-11-14'
const refusal = (code: string) => new ApiError('conflict', 409, 'conflict', 'English words', null, [{ path: `refusal/${code}`, message: 'x' }])
const declaration = (over: Partial<Declaration> = {}): Declaration => ({
  id: 'd1',
  version: 1,
  companyId: 'c1',
  partyId: 'p1',
  party: { code: 'C-1', legalName: 'Made-up S.r.l.' },
  protocolNumber: '26000000000000001-000001',
  protocolDate: '2026-01-20',
  year: 2026,
  amount: 1000,
  usedAmount: 250,
  leftAmount: 750,
  state: 'UNCHECKED',
  checkedAt: null,
  checkedById: null,
  receiptFileId: null,
  revokedAt: null,
  revokeReason: null,
  invoices: [],
  ...over,
})

describe('who may do what', () => {
  it('reads the rights and the price grain', () => {
    expect(can).toEqual({ manage: true, manageInvoices: true, upload: true, parties: true, price: true })
    expect(reader).toEqual({ manage: false, manageInvoices: false, upload: false, parties: false, price: true })
    expect(DECLARATION_STATES).toEqual(DOMAIN_STATES)
    expect(Object.keys(STATE_TONE).sort()).toEqual([...DOMAIN_STATES].sort())
  })

  it('holds Add, Check and Revoke with why', () => {
    expect(addHeld(can, false)).toBeNull()
    expect(addHeld(reader, false)).toEqual({ key: 'held.noManage' })
    expect(addHeld({ ...can, price: false }, false)).toEqual({ key: 'held.noPrice' })
    expect(addHeld({ ...can, parties: false }, false)).toEqual({ key: 'held.noParties' })
    expect(addHeld(can, true)).toEqual({ key: 'held.busy' })
    expect(checkHeld(declaration(), can, false)).toBeNull()
    expect(checkHeld(declaration(), { ...can, upload: false }, false)).toEqual({ key: 'held.noUpload' })
    expect(checkHeld(declaration({ state: 'REVOKED', revokedAt: '2026-02-01T10:00:00.000Z' }), can, false)).toEqual({ key: 'held.revoked' })
    expect(checkHeld(declaration({ state: 'CHECKED', checkedAt: '2026-01-21T10:00:00.000Z' }), can, false)).toEqual({ key: 'held.checked' })
    expect(checkHeld(declaration(), reader, false)).toEqual({ key: 'held.noManage' })
    expect(revokeHeld(declaration({ state: 'USED_UP' }), can, false)).toBeNull()
    expect(revokeHeld(declaration({ state: 'REVOKED' }), can, false)).toEqual({ key: 'held.revoked' })
    expect(receiptHeld(null, false)).toEqual({ key: 'check.problem.noFile' })
    expect(receiptHeld({ name: 'r.pdf' }, false)).toBeNull()
    expect(reasonProblem(' no ')).toEqual({ key: 'revoke.problem.short' })
    expect(reasonProblem('x'.repeat(501))).toEqual({ key: 'revoke.problem.long', params: { max: 500 } })
    expect(reasonProblem('The customer withdrew it.')).toBeNull()
  })
})

describe('a new declaration', () => {
  it('checks each field as the API does, before it is sent', () => {
    const draft = { ...emptyAddDraft(TODAY), partyId: 'p1', protocolNumber: '26000000000000001-000001', amount: '12.000,00' }
    expect(addProblems(draft, TODAY)).toEqual({})
    expect(addInput(draft, 'c1', TODAY)).toEqual({ companyId: 'c1', partyId: 'p1', protocolNumber: '26000000000000001-000001', protocolDate: TODAY, year: 2026, amount: 1_200_000 })
    expect(addProblems({ ...draft, partyId: null, protocolNumber: '2600-1', amount: '0' }, TODAY)).toEqual({ partyId: 'add.problem.party', protocolNumber: 'add.problem.protocol', amount: 'add.problem.amount' })
    expect(addProblems({ ...draft, protocolDate: '2026-12-01' }, TODAY)).toEqual({ protocolDate: 'add.problem.future' })
    // A declaration of December may cover the next year, never two years on.
    expect(addProblems({ ...draft, protocolDate: '2025-12-15', year: 2026 }, TODAY)).toEqual({})
    expect(addProblems({ ...draft, protocolDate: '2025-12-15', year: 2027 }, TODAY)).toEqual({ year: 'add.problem.year' })
    expect(addInput({ ...draft, amount: '' }, 'c1', TODAY)).toBeNull()
    expect(yearsForDate('2025-12-15')).toEqual([2025, 2026])
    expect(yearsOf(TODAY)).toEqual([2025, 2026, 2027])
  })

  it('names the fields the API refused, in this screen’s words', () => {
    const invalid = new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/protocolNumber', message: 'x' }, { path: 'body/protocolDate', message: 'x' }])
    expect(addFieldProblems(invalid)).toEqual({ protocolNumber: 'add.problem.protocol', protocolDate: 'add.problem.dateRefused' })
    expect(addFieldProblems(refusal('NOT_CUSTOMER'))).toEqual({})
  })
})

describe('a refused write', () => {
  it('is said in this screen’s words, never the API’s English or a code', () => {
    for (const code of INTENT_REFUSALS) expect(intentProblem(refusal(code)).key).toBe(`${NAMESPACE}:refusal.${code}`)
    expect(intentProblem(refusal('DATABASE')).reload).toBe(false)
    expect(intentProblem(refusal('REVOKED')).reload).toBe(true)
    expect(intentProblem(refusal('SOMETHING_ELSE'))).toEqual({ key: 'problem.write.state', reload: true })
    expect(intentProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'version', message: 'x' }]))).toEqual({ key: 'problem.write.moved', reload: true })
    expect(intentProblem(new ApiError('not_found', 404, 'not_found', 'x'))).toEqual({ key: `${NAMESPACE}:refusal.NOT_FOUND`, reload: true })
    expect(intentProblem(new ReceiptHeldError())).toEqual({ key: `${NAMESPACE}:check.heldByScan`, reload: false })
  })
})

describe('the list', () => {
  it('says how much is used and flags another year', () => {
    expect(usedPercent(declaration())).toBe(25)
    expect(usedPercent(declaration({ usedAmount: 2000 }))).toBe(100)
    expect(usedPercent({ amount: undefined, usedAmount: undefined })).toBeNull()
    expect(otherYear(declaration({ year: 2025 }), TODAY)).toBe(true)
    expect(otherYear(declaration(), TODAY)).toBe(false)
    expect(intentTouched({ type: 'declaration_of_intent.changed' })).toBe(true)
    expect(intentTouched({ type: 'invoice.draft_saved' })).toBe(false)
  })

  it('opens a declaration from its link (audit rows, search) in the invoices’ dialog', () => {
    expect(RECORD_PAGES.DeclarationOfIntent).toBe('/finance/invoices?intent=[id]')
    expect(recordAddress({ type: 'DeclarationOfIntent', id: 'd1' }, OFFICE_PAGES)).toBe('/finance/invoices?intent=d1')
  })
})

describe('the declaration a draft rests on', () => {
  const intent = (over: Partial<InvoiceIntent> = {}): InvoiceIntent => ({
    invoiceId: 'i1',
    status: 'DRAFT',
    switches: { declarationsOfIntentOn: true },
    declarationOfIntent: null,
    declarationCandidates: [{ id: 'd1', protocolNumber: '26000000000000001-000001', year: 2026, state: 'CHECKED' }],
    ...over,
  })
  it('shows only for a type that names one, and a customer that sent one', () => {
    expect(pickShown('TD01', intent())).toBe(true)
    expect(pickShown('TD04', intent())).toBe(false)
    expect(pickShown('TD24', intent({ declarationCandidates: [] }))).toBe(false)
    expect(pickShown('TD02', null)).toBe(false)
  })

  it('holds naming with why; letting one go never waits for the switch', () => {
    expect(nameHeld({ can, switchOn: true, picked: 'd1', named: null, busy: false })).toBeNull()
    expect(nameHeld({ can, switchOn: true, picked: null, named: null, busy: false })).toEqual({ key: 'pick.held.none' })
    expect(nameHeld({ can, switchOn: true, picked: 'd1', named: 'd1', busy: false })).toEqual({ key: 'pick.held.same' })
    expect(nameHeld({ can, switchOn: false, picked: 'd1', named: null, busy: false })).toEqual({ key: 'pick.held.switchOff' })
    expect(nameHeld({ can: reader, switchOn: true, picked: 'd1', named: null, busy: false })).toEqual({ key: 'held.noManageInvoices' })
    expect(letGoHeld(can, false)).toBeNull()
    expect(letGoHeld(reader, false)).toEqual({ key: 'held.noManageInvoices' })
    const named = { id: 'd1', protocolNumber: 'P-1', protocolDate: '2026-01-20', year: 2026, state: 'CHECKED' as const }
    expect(namedWords(named, '4.368,00 €')).toEqual({ key: 'pick.named.CHECKED', params: { protocol: 'P-1', amount: '4.368,00 €' } })
    expect(namedWords(named, null)).toEqual({ key: 'pick.namedNoPrice.CHECKED', params: { protocol: 'P-1' } })
  })
})

describe('the words and the design cases', () => {
  const folder = dirname(fileURLToPath(import.meta.url))
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [join(dir, entry.name)] : []))

  it('has every literal key of the screen in Italian and English, the states’ and refusals’ too', () => {
    const pattern = /['`]((?:add|check|revoke|held|notice|refusal|pick|record|filter|switchOff|empty|state|col)\.[A-Za-z0-9_.]+)['`]/g
    const keys = new Set<string>()
    for (const file of sources(folder)) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) keys.add(match[1]!)
    for (const state of DOMAIN_STATES) for (const prefix of ['state', 'filter', 'record.stateWords', 'pick.named', 'pick.namedNoPrice']) keys.add(`${prefix}.${state}`)
    for (const code of [...INTENT_REFUSALS, 'NOT_FOUND']) keys.add(`refusal.${code}`)
    expect(keys.size).toBeGreaterThan(60)
    for (const locale of ['it', 'en'] as const) {
      const catalogues = messagesFor(locale, [NAMESPACE, 'finance'])
      const missing = [...keys].filter((key) => !catalogues[NAMESPACE]![key] && !catalogues.finance![key])
      expect(missing, locale).toEqual([])
    }
  })

  it('covers every state the screen has, each case with its own id', () => {
    const ids = designScreen.cases.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ['list', 'record-checked', 'record-unchecked', 'record-revoked', 'check', 'revoke', 'add', 'switch-off', 'refused', 'sales', 'no-price', 'empty', 'loading', 'error', 'pick-named', 'pick-choose', 'pick-switch-off', 'pick-error']) expect(ids).toContain(id)
  })
})
