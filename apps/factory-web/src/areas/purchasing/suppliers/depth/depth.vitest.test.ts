import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { STATUS_MOVES } from '@nexus/factory-domain/purchasing/suppliers-depth/rules'
import { ApiError } from '../../../../lib/api/errors'
import { createApiClient, type ApiClient } from '../../../../lib/api/client'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { SUPPLIERS } from '../../../parties/_shared/fixtures'
import { designScreen as profileScreen } from '../../../../portal/supplier/profile/fixtures'
import { changeHeld as portalHeld, draftProblems, ibanProblem, masked } from '../../../../portal/supplier/profile/bank/model'
import { designScreen as listScreen } from '../fixtures'
import { designScreen as recordScreen } from '../record/fixtures'
import { expiringRows } from '../list/view/ExpiringSection'
import { importHeldOf } from '../list/SupplierImport'
import { acceptUpload, askForDocuments, callBack, CATEGORIES, KINDS, PILLS, readBank, readProfile, RECEIVES, saveProfile, setReceives, STANDING_CODES, STATUSES, TANNAGE_CODES, verifyBank } from './api'
import { ACTIVE_ACCOUNT, ALL_CAN, CHANGES, ME, profileOf, READ_CAN, summaryOf, vaultOf, WAITING_CALL, WAITING_CHECK } from './demo'
import {
  acceptProblem,
  callBackHeld,
  changeLines,
  clearsTanneryFacts,
  closureDays,
  documentsCell,
  draftOf,
  dueProblem,
  expiryWords,
  gateWords,
  ibanWords,
  maskedTyped,
  newOrderWords,
  nextStepWords,
  NS,
  phoneMatches,
  problemOf,
  profileBody,
  profileProblems,
  proposalProblems,
  reasonProblem,
  receivesHeld,
  refusedOf,
  requestHeld,
  routingWords,
  statusMoves,
  toggled,
  verifyHeld,
  weekKindsOf,
  type Words,
} from './model'

/**
 * Suppliers in depth on screen (B-W2b-334): the pure rules of the Overview's draft (what a save sends, a tannery's facts
 * cleared), the status moves and their reason, the closures as calendar days, what a contact receives and who gets what,
 * the vault in our words, the office review, the bank's held steps and a typed IBAN, the list's documents cell and Request
 * documents — the calls as B-W2b-311's and B-W2b-315's API takes them, every word in both languages, and every new design
 * case drawn with no key left on screen and no real-looking IBAN.
 */

const CONCERIA = SUPPLIERS.find((item) => item.code === 'CONCERIA-DEMO')!
const PROFILE = profileOf(CONCERIA)
const VALID_IBAN = 'IT11 X000 0000 0000 0000 0315 001'

describe('the Overview: kinds, lead time, origin (SCM-002, SCM-016)', () => {
  it('sends only what changed, in one save at the party’s version', () => {
    expect(profileBody(PROFILE, draftOf(PROFILE))).toBeNull()
    const draft = { ...draftOf(PROFILE), kinds: ['TRIMS', 'TANNERY'] as const, leadTimeDays: '25', originRegion: ' Toscana nord ' }
    expect(profileBody(PROFILE, { ...draft, kinds: [...draft.kinds] })).toEqual({ version: PROFILE.version, kinds: ['TANNERY', 'TRIMS'], leadTimeDays: 25, originRegion: 'Toscana nord' })
    // The same kinds in another order are no change.
    expect(profileBody(PROFILE, { ...draftOf(PROFILE), tannages: ['VEGETABLE', 'CHROME'] })).toBeNull()
  })

  it('clears a tannery’s hides and tannages in the same save when TANNERY is no longer ticked', () => {
    const draft = { ...draftOf(PROFILE), kinds: ['TEXTILE_MILL' as const] }
    expect(clearsTanneryFacts(PROFILE, draft)).toBe(true)
    expect(profileBody(PROFILE, draft)).toEqual({ version: PROFILE.version, kinds: ['TEXTILE_MILL'], hideOriginCountries: [], tannages: [] })
  })

  it('says what is wrong per field', () => {
    expect(profileProblems({ ...draftOf(PROFILE), leadTimeDays: '400', originCountry: 'ITA', hideCountries: 'IT, FRA' })).toEqual({
      leadTimeDays: { key: 'profile.problem.leadTime', params: { max: 366 } },
      originCountry: { key: 'profile.problem.country' },
      hideCountries: { key: 'profile.problem.hides' },
    })
    expect(profileProblems(draftOf(PROFILE))).toEqual({})
  })
})

describe('the status (SCM-008)', () => {
  it('offers only the moves the rules allow, a first status any other', () => {
    expect(statusMoves(PROFILE)).toEqual([...STATUS_MOVES.APPROVED])
    expect(statusMoves(profileOf(CONCERIA, { standing: { ...PROFILE.standing, supplierStatus: null, source: 'PARTY', status: 'APPROVED' } }))).toEqual(STATUSES.filter((status) => status !== 'APPROVED'))
  })

  it('asks a reason for conditional, on hold and blocked', () => {
    expect(reasonProblem(null, '')).toEqual({ key: 'status.problem.pick' })
    expect(reasonProblem('ON_HOLD', ' ')).toEqual({ key: 'status.problem.reason' })
    expect(reasonProblem('APPROVED', '')).toBeNull()
    expect(newOrderWords(profileOf(CONCERIA, { standing: { ...PROFILE.standing, status: 'ON_HOLD', supplierStatus: 'ON_HOLD' }, newOrderProblem: 'x' }))).toEqual({ key: 'now.noOrder.ON_HOLD' })
    expect(newOrderWords(PROFILE)).toBeNull()
  })
})

describe('closures (SCM-012)', () => {
  it('draws every day of a closure and the week’s days off', () => {
    const days = closureDays([{ from: '2026-12-30', to: '2027-01-02', kind: 'CLOSURE', name: 'Natale', days: 4 }])
    expect(Object.keys(days)).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'])
    expect(days['2027-01-01']).toEqual({ kind: 'closed', reason: 'Natale' })
    expect(weekKindsOf([6, 7])).toEqual(['work', 'work', 'work', 'work', 'work', 'off', 'off'])
  })
})

describe('what each contact receives (SCM-004)', () => {
  it('sends the contact’s whole list with one kind changed', () => {
    const contact = PROFILE.contacts[0]!
    expect(toggled(contact, 'REMITTANCE', true)).toEqual(['PO', 'CLAIM', 'REMITTANCE'])
    expect(toggled(contact, 'PO', false)).toEqual(['CLAIM'])
  })

  it('holds a box without the right, on an archived supplier, or for a contact with no e-mail', () => {
    const contact = PROFILE.contacts[0]!
    expect(receivesHeld(READ_CAN, contact, 'PO', 'ACTIVE')).toEqual({ key: 'held.manage' })
    expect(receivesHeld(ALL_CAN, contact, 'PO', 'ARCHIVED')).toEqual({ key: 'held.archived' })
    expect(receivesHeld(ALL_CAN, { ...contact, email: null, receives: [] }, 'PO', 'ACTIVE')).toEqual({ key: 'held.noEmail' })
    expect(receivesHeld(ALL_CAN, contact, 'PO', 'ACTIVE')).toBeNull()
  })

  it('says who gets each kind, and why', () => {
    const routes = routingWords(PROFILE)
    expect(routes.map((route) => route.words.key)).toEqual(['routing.receives.PO', 'routing.receives.CLAIM', 'routing.receives.REMITTANCE', 'routing.receives.QUALITY', 'routing.receives.DOCUMENT'])
    expect(routes[0]!.words.params).toEqual({ who: 'Nadia Esempio' })
  })
})

describe('the vault and the office review (SCM-020, B-W2b-189)', () => {
  it('says the next step and the gate in our words', () => {
    const vault = vaultOf(CONCERIA)
    expect(nextStepWords(vault)).toEqual({ key: 'next.waiting', params: { count: 1 } })
    expect(nextStepWords({ ...vault, review: { uploads: [], changes: [] } })).toEqual({ key: 'next.expired', params: { count: 1 } })
    expect(gateWords(vault)).toEqual([{ key: 'gate.CR_VI_TEST_REPORT', params: { codes: 'DEMO-PL-SCAM08', count: 1 } }])
    expect(expiryWords('2026-11-12', '2026-11-30')).toEqual({ key: 'expiry.in', params: { count: 18 } })
    expect(expiryWords('2026-11-12', '2026-11-10')).toEqual({ key: 'expiry.ago', params: { count: 2 } })
  })

  it('never accepts an expired document; a refusal says why', () => {
    expect(acceptProblem({ category: 'DECLARATION', expiresOn: '2026-11-01', replacesFileId: null }, '2026-11-12')).toEqual({ key: 'review.problem.past' })
    expect(acceptProblem({ category: 'DECLARATION', expiresOn: '', replacesFileId: null }, '2026-11-12')).toBeNull()
  })

  it('says a profile change from its facts, never the API’s sentence', () => {
    expect(changeLines(CHANGES[0]!.changes)).toEqual([
      { words: { key: 'change.ADDRESS.CHANGE', params: { what: 'Magazzino pelli' } }, fields: [{ field: 'line1', before: 'Via del Cuoio 8', after: 'Via del Cuoio 10' }] },
      { words: { key: 'change.CONTACT.ADD', params: { what: 'Marta Esempio' } }, fields: [] },
    ])
  })
})

describe('bank details (SCM-007)', () => {
  it('never lets the proposer call back or check; the check waits for the call-back', () => {
    const mine = { ...WAITING_CALL, proposedBy: { id: ME, name: 'Me' } }
    expect(callBackHeld(ALL_CAN, mine, ME)).toEqual({ key: 'bank.held.ownCallBack' })
    expect(callBackHeld(ALL_CAN, WAITING_CALL, ME)).toBeNull()
    expect(callBackHeld(READ_CAN, WAITING_CALL, ME)).toEqual({ key: 'held.bankCallBack' })
    expect(verifyHeld(ALL_CAN, WAITING_CALL, ME)).toEqual({ key: 'bank.held.callBackFirst' })
    expect(verifyHeld(ALL_CAN, WAITING_CHECK, ME)).toBeNull()
    expect(verifyHeld(ALL_CAN, { ...WAITING_CHECK, proposedBy: { id: ME, name: 'Me' } }, ME)).toEqual({ key: 'bank.held.ownCheck' })
    expect(verifyHeld(ALL_CAN, ACTIVE_ACCOUNT, ME)).toEqual({ key: 'bank.held.notWaiting' })
  })

  it('checks a typed IBAN as typed (shape, the country’s length, the check digits)', () => {
    expect(ibanWords(VALID_IBAN)).toBeNull()
    expect(ibanWords('IT11 X000 0000 0000 0000 0315 002')).toEqual({ key: 'bank.problem.ibanDigits' })
    expect(ibanWords('IT11X000000000000000031500')).toEqual({ key: 'bank.problem.ibanLength', params: { country: 'IT', length: 27, typed: 26 } })
    expect(ibanWords('11IT')).toEqual({ key: 'bank.problem.ibanShape' })
    expect(maskedTyped(VALID_IBAN)).toBe('IT** **** **** 5001')
    expect(Object.keys(proposalProblems({ iban: VALID_IBAN, holder: '', bankName: '', bic: 'BAD', currency: 'EU' }))).toEqual(['holder', 'bic', 'currency'])
    expect(phoneMatches('+39 000 000-0003', '+39 000 000 0003')).toBe(true)
    expect(phoneMatches('+39 000 000 0004', '+39 000 000 0003')).toBe(false)
  })

  it('the portal checks the same, and holds a change while one waits', () => {
    expect(ibanProblem(VALID_IBAN)).toBeNull()
    expect(ibanProblem('IT11 X000 0000 0000 0000 0315 002')).toEqual({ key: 'portalBank.problem.ibanDigits' })
    expect(masked(VALID_IBAN)).toBe('IT** **** **** 5001')
    expect(Object.keys(draftProblems({ iban: '', holder: '', bankName: '', bic: '', currency: 'EUR' }))).toEqual(['iban', 'holder'])
    expect(portalHeld({ preview: false, offline: false, mayPropose: true, waiting: true })).toEqual({ key: 'portalBank.held.waiting' })
    expect(portalHeld({ preview: false, offline: false, mayPropose: false, waiting: false })).toEqual({ key: 'portalBank.held.admin' })
    expect(portalHeld({ preview: true, offline: false, mayPropose: true, waiting: false })).toEqual({ key: 'portalBank.held.preview' })
  })
})

describe('the list (documents column, the tile’s view, Request documents)', () => {
  it('says what each supplier holds, and joins the expiring ones to their names', () => {
    expect(documentsCell({ partyId: 'p', code: 'C', valid: 2, expiring: 1, expired: 0, missing: 0 })?.tone).toBe('warning')
    expect(documentsCell({ partyId: 'p', code: 'C', valid: 2, expiring: 0, expired: 0, missing: 1 })?.tone).toBe('danger')
    expect(documentsCell({ partyId: 'p', code: 'C', valid: 0, expiring: 0, expired: 0, missing: 0 })).toBeNull()
    const summary = summaryOf(SUPPLIERS.map((row) => ({ id: row.id, code: row.code })))
    const rows = expiringRows(summary.suppliers, null)
    expect(rows).toHaveLength(summary.expiringIn30Days)
    expect(rows.every((row) => row.docs.expiring > 0)).toBe(true)
  })

  it('holds Request documents without the right, with nothing selected or too many', () => {
    expect(requestHeld(READ_CAN, 2)).toEqual({ key: 'held.ask' })
    expect(requestHeld(ALL_CAN, 0)).toEqual({ key: 'request.held.none' })
    expect(requestHeld(ALL_CAN, 51)).toEqual({ key: 'request.held.max', params: { max: 50 } })
    expect(dueProblem('2026-11-12', '2026-11-12')).toEqual({ key: 'request.problem.future' })
    expect(dueProblem('2027-06-01', '2026-11-12')).toEqual({ key: 'request.problem.far' })
    expect(dueProblem('', '2026-11-12')).toBeNull()
    expect(importHeldOf(['parties.manage', 'imports.run', 'files.upload'], 'parties.parties')).toBeNull()
    expect(importHeldOf(['parties.manage', 'imports.run', 'files.upload'], 'purchasing.supplierPrices')).toBe('held.sources')
  })
})

describe('the calls (B-W2b-311, B-W2b-315, B-W2b-189, partner tasks)', () => {
  function recorder(answers: Record<string, unknown>) {
    const calls: { method: string; url: string; body: unknown; key: string | null }[] = []
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined, key: headers.get('idempotency-key') })
      const path = new URL(url, 'http://x').pathname
      const answer = Object.entries(answers).find(([suffix]) => path.endsWith(suffix))?.[1] ?? {}
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const api: ApiClient = createApiClient({ baseUrl: '/api', fetch: fetchFn, csrfToken: () => 'csrf' })
    return { api, calls }
  }
  const bank = { supplier: { id: CONCERIA.id, code: CONCERIA.code, name: 'Conceria Demo', companyId: null }, accounts: [ACTIVE_ACCOUNT, WAITING_CALL], payable: [], may: { propose: true } }

  it('reads and writes at the version read, with an Idempotency-Key', async () => {
    const { api, calls } = recorder({ '/profile': { supplier: PROFILE }, '/receives': { supplier: PROFILE }, '/bank': bank, '/call-back': bank, '/verify': bank, '/accept': { fileId: 'f', documentFileId: 'g' }, '/tasks': { made: true } })
    expect((await readProfile(api, CONCERIA.id)).kinds).toEqual(['TANNERY'])
    await saveProfile(api, CONCERIA.id, { version: 3, leadTimeDays: 25 }, 'k1')
    await setReceives(api, CONCERIA.id, 'c1', { version: 2, receives: ['PO'] }, 'k2')
    expect((await readBank(api, CONCERIA.id)).accounts).toHaveLength(2)
    await callBack(api, CONCERIA.id, 'a1', { version: 1, contactId: 'c1', phone: '+39 000 000 0003' }, 'k3')
    await verifyBank(api, CONCERIA.id, 'a1', 2, 'k4')
    await acceptUpload(api, 'f1', { category: 'DECLARATION', expiresOn: '2027-11-02', replacesFileId: null, version: 1 }, 'k5')
    expect((await askForDocuments(api, CONCERIA.id, { dueAt: null, companyId: 'co' }, 'k6')).made).toBe(true)
    const base = `/api/purchasing/suppliers/${CONCERIA.id}`
    expect(calls.map((call) => [call.method, new URL(call.url, 'http://x').pathname, call.key])).toEqual([
      ['GET', `${base}/profile`, null],
      ['PATCH', `${base}/profile`, 'k1'],
      ['PUT', `${base}/contacts/c1/receives`, 'k2'],
      ['GET', `${base}/bank`, null],
      ['POST', `${base}/bank/a1/call-back`, 'k3'],
      ['POST', `${base}/bank/a1/verify`, 'k4'],
      ['POST', '/api/purchasing/supplier-documents/f1/accept', 'k5'],
      ['POST', `/api/partners/${CONCERIA.id}/tasks`, 'k6'],
    ])
    expect(calls[7]!.body).toEqual({ kind: 'UPLOAD_DOCUMENT', recordType: 'Party', recordId: CONCERIA.id, dueAt: null, companyId: 'co' })
  })

  it('names a refusal by its kind and the fields a 400 named, never its English', () => {
    expect(problemOf(new ApiError('conflict', 409, 'conflict', 'English', null, []))).toBe('problem.conflict')
    expect(problemOf(new ApiError('step_up', 403, 'forbidden', 'English', null, []))).toBe('problem.stepUp')
    expect(refusedOf(new ApiError('invalid', 400, 'validation', 'English', null, [{ path: 'body/hideOriginCountries', message: 'x' }]))).toEqual(['hideOriginCountries'])
  })
})

const LEFT_KEY = /\b(?:portalBank|bank|vault|review|qual|quality|receives|routing|profile|closures|now|expiring|request|held|status|kind|tannage|doc|ask|gate|category|source|expiry|next|change|field|work|material|evidence|standing|claim|receipt|stepUp|problem|read|dialog|notice|list|tile|import)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*/

describe('every word in both languages', () => {
  it('has words for every kind, status, tannage, receives kind, category, pill, standing and doc code', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [NS])[NS] ?? {})
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const kind of KINDS) has(`kind.${kind}`)
      for (const status of STATUSES) {
        has(`status.${status}`)
        has(`now.noOrder.${status}`)
      }
      for (const tannage of TANNAGE_CODES) has(`tannage.${tannage}`)
      for (const kind of RECEIVES) {
        has(`receives.kind.${kind}`)
        for (const by of ['receives', 'role', 'none']) has(`routing.${by}.${kind}`)
      }
      for (const category of CATEGORIES) has(`category.${category}`)
      for (const pill of PILLS) has(`bank.pill.${pill}`)
      for (const standing of STANDING_CODES) has(`standing.${standing}`)
      for (const code of ['CR_VI_TEST_REPORT', 'REACH_DECLARATION', 'LWG_AUDIT', 'AZO_TEST_REPORT', 'EN_1621_CERTIFICATE', 'DECLARATION_OF_CONFORMITY', 'DURC', 'CODE_OF_CONDUCT', 'CARRIER_INSURANCE']) has(`doc.${code}`)
      const said = (words: Words) => t(words.key, words.params)
      expect(said(gateWords(vaultOf(CONCERIA))[0]!)).not.toMatch(/\{/)
    }
  })

  it('every new case of SCR-056, SCR-057 and SCR-191 draws in Italian and English with no key left and test IBANs only', () => {
    const screens = [listScreen, recordScreen, profileScreen] as const
    let drawn = 0
    for (const screen of screens) {
      for (const entry of screen.cases.filter((item) => item.id.startsWith('w2b-334-'))) {
        for (const locale of LOCALES) {
          const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(screen.view as ComponentType<{ model: unknown }>, { model: entry.model })))
          const text = html.replace(/[\w.+-]+@[\w.-]+/g, '')
          expect(text.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${entry.id} (${locale})`).toBeNull()
          // A whole IBAN only as a made-up Italian test IBAN (ABI and CAB 00000).
          for (const iban of text.match(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g) ?? []) expect(iban.replace(/ /g, ''), `${entry.id}`).toMatch(/^IT\d\d[A-Z]0000000000\d{12}$/)
          drawn += 1
        }
      }
    }
    expect(drawn).toBeGreaterThan(80)
  })
})
