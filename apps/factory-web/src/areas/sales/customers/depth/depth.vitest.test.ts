import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HOLD_REASONS } from '@nexus/factory-domain/parties/holds/holds'
import { LAWFUL_BASES } from '@nexus/factory-domain/parties/contact-privacy/privacy'
import { REQUIREMENT_KINDS, REQUIREMENT_STAGES } from '@nexus/factory-domain/parties/requirements/requirements'
import { REPAIR_KINDS, REPAIR_STAGES } from '@nexus/factory-domain/sales/repairs/rules'
import { SAMPLE_KINDS, SAMPLE_STAGES } from '@nexus/factory-domain/sales/samples/rules'
import { ApiError } from '../../../../lib/api/errors'
import { createApiClient, type ApiClient } from '../../../../lib/api/client'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as listScreen } from '../fixtures'
import { designScreen as recordScreen } from '../record/fixtures'
import { addRequirement, eraseContact, placeHold, readGlance, releaseHold, setLawfulBasis, setPoNumberRequired } from './api'
import { ALL_CAN, glanceOf, HELD_GLANCE, HOLDS, PRIVACY, READ_CAN, REQUIREMENTS, TERMS, TODAY, withoutPrices } from './_demo/fixtures'
import {
  basisBody,
  basisProblems,
  blankRequirement,
  copyCounts,
  creditTile,
  depthCan,
  dueWords,
  holdDraftProblem,
  holdRefusal,
  KEPT_KINDS,
  keptKey,
  NS,
  poChanges,
  poHeld,
  poRows,
  privacyHeld,
  privacyRefusal,
  promisesTile,
  requirementBody,
  requirementDraftOf,
  requirementProblems,
  shownOnKeys,
  toggleHeld,
  wordsProblem,
  writeHeld,
  type Words,
} from './model'

/**
 * Customer 360 and customers in depth (B-W2b-324): the glance's words (free credit by grain, promises, due days), the
 * hold, requirement, PO-number and personal-data drafts and what each still needs, the refusals in words, the calls as
 * the API takes them (version and Idempotency-Key), every word in both languages, and every new design case of SCR-032
 * and SCR-033 drawn with no key left on screen.
 */

const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2)}`
const day = (value: string) => value

describe('the customer at a glance', () => {
  it('says free credit by the price grain: the amount, over by, no limit, or words only', () => {
    expect(creditTile(glanceOf('MODA-DEMO').credit, money)).toEqual({ value: { key: 'credit.available', params: { amount: 'EUR 18800.00' } }, hint: { key: 'credit.ofLimit', params: { limit: 'EUR 50000.00' } } })
    expect(creditTile(glanceOf('MODA-DEMO', HELD_GLANCE).credit, money).value).toEqual({ key: 'credit.overBy', params: { amount: 'EUR 3100.00' } })
    expect(creditTile(withoutPrices(glanceOf('MODA-DEMO', HELD_GLANCE)).credit, money)).toEqual({ value: { key: 'credit.over' }, hint: { key: 'credit.noPrice' } })
    expect(creditTile(withoutPrices(glanceOf('MODA-DEMO')).credit, money).value).toEqual({ key: 'credit.within' })
    expect(creditTile(glanceOf('PILOTA-DEMO').credit, money).value).toEqual({ key: 'credit.noLimit' })
    expect(creditTile(null, money).hint).toEqual({ key: 'numbers.creditWithheld' })
  })

  it('says the promises: late, on time, the next one, none', () => {
    expect(promisesTile({ open: 4, late: 1, noPromise: 0, next: '2026-11-14' }, day)).toEqual({ value: { key: 'promises.late', params: { count: 1 } }, hint: { key: 'promises.next', params: { date: '2026-11-14' } } })
    expect(promisesTile({ open: 2, late: 0, noPromise: 2, next: null }, day)).toEqual({ value: { key: 'promises.onTime', params: { count: 2 } }, hint: { key: 'promises.without', params: { count: 2 } } })
    expect(promisesTile({ open: 0, late: 0, noPromise: 0, next: null }, day).value).toEqual({ key: 'promises.none' })
    expect(promisesTile(null, day).hint).toEqual({ key: 'numbers.promisesWithheld' })
  })

  it('says a round late, due today, due on a day, or without a due day', () => {
    expect(dueWords({ dueDate: '2026-10-24', daysLate: 5 }, day)).toEqual({ key: 'samples.late', params: { count: 5 } })
    expect(dueWords({ dueDate: '2026-10-29', daysLate: 0 }, day)).toEqual({ key: 'samples.dueToday' })
    expect(dueWords({ dueDate: '2026-11-06', daysLate: -8 }, day)).toEqual({ key: 'samples.due', params: { date: '2026-11-06' } })
    expect(dueWords({ dueDate: null, daysLate: null }, day)).toEqual({ key: 'samples.noDue' })
  })

})

describe('the hold and the PO number', () => {
  it('asks a reason and words to place, words to release', () => {
    expect(holdDraftProblem({ reason: null, words: 'x' }, 'place')).toEqual({ key: 'hold.problem.reason' })
    expect(holdDraftProblem({ reason: 'CREDIT', words: '  ' }, 'place')).toEqual({ key: 'hold.problem.why' })
    expect(holdDraftProblem({ words: '' }, 'release')).toEqual({ key: 'hold.problem.whyRelease' })
    expect(holdDraftProblem({ reason: 'LEGAL', words: 'x'.repeat(2001) }, 'place')).toEqual({ key: 'problem.tooLong', params: { max: 2000 } })
    expect(holdDraftProblem({ reason: 'LEGAL', words: 'A made-up dispute.' }, 'place')).toBeNull()
  })

  it('holds the toggle with several holds in force, and every write without its right', () => {
    expect(toggleHeld(HOLDS.holds, null)).toBeNull()
    expect(toggleHeld([HOLDS.holds[0]!, { ...HOLDS.holds[0]!, id: 'x' }], null)).toBe('hold.toggleMany')
    expect(writeHeld(READ_CAN, 'hold', 'ACTIVE')).toBe('held.hold')
    expect(writeHeld(ALL_CAN, 'hold', 'ARCHIVED')).toBe('held.archived')
    expect(writeHeld(ALL_CAN, 'manage', 'ACTIVE')).toBeNull()
  })

  it('names a refused hold in words', () => {
    expect(holdRefusal(new ApiError('conflict', 409, 'conflict', 'English', null, [{ path: 'body/reason', message: 'x' }]))).toBe('hold.refused.same')
    expect(holdRefusal(new ApiError('invalid', 400, 'validation', 'English', null, [{ path: 'body/companyId', message: 'x' }]))).toBe('hold.refused.company')
    expect(holdRefusal(new ApiError('unavailable', 503, 'unavailable', 'English', null, []))).toBe('problem.offline')
  })

  it('reads the PO number per company and sends only what changed', () => {
    const rows = poRows(TERMS)
    expect(rows.map((row) => [row.code, row.required, row.own, row.version])).toEqual([
      ['DEMO', true, true, 2],
      ['ESEMPIO', false, false, null],
    ])
    expect(poChanges(rows, { [rows[0]!.companyId]: true, [rows[1]!.companyId]: true }).map((row) => row.code)).toEqual(['ESEMPIO'])
    expect(poHeld({ ...rows[0]!, mayChange: false }, ALL_CAN, 'ACTIVE')).toBe('held.manageCompany')
    expect(poHeld(rows[0]!, READ_CAN, 'ACTIVE')).toBe('held.manage')
  })
})

describe('requirements', () => {
  it('says what a rule still needs and sends the stages in the design order, no styles for all orders', () => {
    expect(Object.keys(requirementProblems({ ...blankRequirement(null), appliesAt: [], everyStyle: false }))).toEqual(['words', 'appliesAt', 'styles'])
    const draft = { ...blankRequirement('c1'), words: '  Pallets ≤ 1.6 m  ', appliesAt: ['SHIPMENT', 'ORDER'] as const }
    expect(requirementBody({ ...draft, appliesAt: [...draft.appliesAt] })).toEqual({ companyId: 'c1', kind: 'PACKING', words: 'Pallets ≤ 1.6 m', appliesAt: ['ORDER', 'SHIPMENT'], styleIds: [], fileId: null })
    const replaced = requirementDraftOf(REQUIREMENTS.inForce[2]!)
    expect(replaced).toMatchObject({ everyStyle: false, styles: [{ code: 'JKT-DEMO-01' }], reason: '' })
    expect(requirementBody(replaced).styleIds).toHaveLength(1)
    expect(shownOnKeys(['SHIPMENT', 'QUOTE'])).toEqual(['stage.QUOTE', 'stage.SHIPMENT'])
  })
})

describe('personal data', () => {
  it('asks when and how for consent, never in the future', () => {
    expect(Object.keys(basisProblems({ contactId: 'c', basis: null, consentDay: '', consentSource: '' }, TODAY))).toEqual(['basis'])
    expect(Object.keys(basisProblems({ contactId: 'c', basis: 'CONSENT', consentDay: '', consentSource: '' }, TODAY))).toEqual(['consentDay', 'consentSource'])
    expect(basisProblems({ contactId: 'c', basis: 'CONSENT', consentDay: '2026-12-01', consentSource: 'Form' }, TODAY).consentDay).toEqual({ key: 'privacy.problem.future' })
    expect(basisProblems({ contactId: 'c', basis: 'CONTRACT', consentDay: '', consentSource: '' }, TODAY)).toEqual({})
    const now = new Date('2026-10-29T09:00:00Z')
    expect(basisBody({ contactId: 'c', basis: 'CONSENT', consentDay: '2026-10-29', consentSource: ' Form ' }, 4, now)).toEqual({ version: 4, lawfulBasis: 'CONSENT', consentAt: now.toISOString(), consentSource: 'Form' })
    expect(basisBody({ contactId: 'c', basis: 'CONSENT', consentDay: '2026-10-03', consentSource: 'Form' }, 4, now).consentAt).toBe('2026-10-03T12:00:00.000Z')
    expect(basisBody({ contactId: 'c', basis: 'CONTRACT', consentDay: '2026-10-03', consentSource: 'Form' }, 4, now)).toMatchObject({ consentAt: null, consentSource: null })
    expect(wordsProblem(' ')).toEqual({ key: 'privacy.problem.words' })
  })

  it('holds each act with its reason: erased, objected, no right, no erase right for sales', () => {
    const [plain, , objected, erased] = PRIVACY.contacts
    expect(privacyHeld(erased!, 'copy', ALL_CAN, 'ACTIVE')).toBe('held.erased')
    expect(privacyHeld(objected!, 'objection', ALL_CAN, 'ACTIVE')).toBe('held.objected')
    expect(privacyHeld(plain!, 'erase', { ...ALL_CAN, erase: false }, 'ACTIVE')).toBe('held.erase')
    expect(privacyHeld(plain!, 'basis', READ_CAN, 'ACTIVE')).toBe('held.privacy')
    expect(privacyHeld(plain!, 'copy', ALL_CAN, 'ARCHIVED')).toBeNull()
    expect(privacyHeld(plain!, 'erase', ALL_CAN, 'ACTIVE')).toBeNull()
  })

  it('says a refused erasure in words, a portal user pointing to Portal access', () => {
    expect(privacyRefusal(new ApiError('conflict', 409, 'conflict', 'English', null, [{ path: 'privacy/PORTAL_USER', message: 'x' }]))).toEqual({ key: 'privacy.refused.portalUser', portal: true })
    expect(privacyRefusal(new ApiError('conflict', 409, 'conflict', 'English', null, [{ path: 'privacy/CONTACT_ERASED', message: 'x' }]))).toEqual({ key: 'held.erased', portal: false })
    expect(privacyRefusal(new ApiError('forbidden', 403, 'forbidden', 'English', null, []))).toEqual({ key: 'problem.forbidden', portal: false })
  })

  it('counts an access copy kind by kind and names every kept kind', () => {
    const counts = copyCounts({ records: { quotes: [1], inquiries: [], returns: [1, 2], complaints: [] }, mailsReceived: [1], mailsSent: [], messages: [], links: [], measurementProfiles: [], portalUsers: [], changes: [1] })
    expect(counts.filter((row) => row.count > 0).map((row) => row.key)).toEqual(['copy.quotes', 'copy.returns', 'copy.mailsReceived', 'copy.changes'])
    expect(keptKey('documents')).toBe('erase.kept.documents')
    expect(keptKey('somethingNew')).toBe('erase.kept.other')
  })

  it("reads the rights from the person's permissions", () => {
    expect(depthCan(['parties.hold', 'money.price'])).toMatchObject({ hold: true, price: true, manage: false, erase: false })
  })
})

describe('the calls', () => {
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
  const holds = { holds: HOLDS }

  it('reads the glance for the company and writes at the version read, with an Idempotency-Key', async () => {
    const glance = glanceOf('MODA-DEMO')
    const { api, calls } = recorder({ [`/customer-360/${glance.party.id}`]: glance, '/holds': holds, '/release': holds, '/requirements': { requirements: REQUIREMENTS }, '/company-terms/c1': { terms: TERMS }, '/lawful-basis': { privacy: PRIVACY }, '/erase': { privacy: PRIVACY, kept: [] } })
    expect((await readGlance(api, glance.party.id, 'co')).samples?.count).toBe(3)
    await placeHold(api, 'p', { companyId: null, reason: 'LEGAL', words: 'w' }, 'k1')
    await releaseHold(api, 'p', 'h', { version: 2, words: 'w' }, 'k2')
    await addRequirement(api, 'p', requirementBody({ ...blankRequirement(null), words: 'w' }), 'k3')
    await setPoNumberRequired(api, 'p', 'c1', { version: 2, poNumberRequired: false }, 'k4')
    await setLawfulBasis(api, 'p', 'c', { version: 3, lawfulBasis: 'CONTRACT', consentAt: null, consentSource: null }, 'k5')
    await eraseContact(api, 'p', 'c', { version: 3, words: 'w' }, 'k6')
    expect(calls.map((call) => [call.method, new URL(call.url, 'http://x').pathname + new URL(call.url, 'http://x').search, call.key])).toEqual([
      ['GET', `/api/sales/customer-360/${glance.party.id}?companyId=co`, null],
      ['POST', '/api/parties/p/holds', 'k1'],
      ['POST', '/api/parties/p/holds/h/release', 'k2'],
      ['POST', '/api/parties/p/requirements', 'k3'],
      ['PUT', '/api/parties/p/company-terms/c1', 'k4'],
      ['PUT', '/api/parties/p/contacts/c/lawful-basis', 'k5'],
      ['POST', '/api/parties/p/contacts/c/erase', 'k6'],
    ])
    expect(calls[2]!.body).toEqual({ version: 2, words: 'w' })
    expect(calls[4]!.body).toEqual({ version: 2, poNumberRequired: false })
  })
})

const LEFT_KEY = /\b(?:problem|read|dialog|held|numbers|credit|promises|glance|now|samples|profiles|riders|repairs|status|team|reqSide|hold|reason|po|req|kind|stage|privacy|basis|basisArticle|basisWhy|objection|copy|erase|sampleKind|sampleStage|repairKind|repairStage|partyStatus|contactStatus|withheld)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*/

describe('every word in both languages', () => {
  it('has words for every reason, kind, stage, basis, sample, repair and kept kind', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [NS])[NS] ?? {})
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const reason of HOLD_REASONS) has(`reason.${reason}`)
      for (const kind of REQUIREMENT_KINDS) has(`kind.${kind}`)
      for (const stage of REQUIREMENT_STAGES) has(`stage.${stage}`)
      for (const basis of LAWFUL_BASES) for (const key of ['basis', 'basisArticle', 'basisWhy']) has(`${key}.${basis}`)
      for (const kind of SAMPLE_KINDS) has(`sampleKind.${kind}`)
      for (const stage of SAMPLE_STAGES) has(`sampleStage.${stage}`)
      for (const kind of REPAIR_KINDS) has(`repairKind.${kind}`)
      for (const stage of REPAIR_STAGES) has(`repairStage.${stage}`)
      for (const kind of [...KEPT_KINDS, 'other']) {
        has(`erase.kept.${kind}.what`, { count: 2 })
        has(`erase.kept.${kind}.why`)
      }
      for (const right of ['manage', 'hold', 'privacy', 'erase'] as const) has(writeHeld(READ_CAN, right, 'ACTIVE')!)
      for (const part of ['samples', 'profiles', 'repairs']) has(`withheld.${part}`)
      const said = (words: Words) => t(words.key, words.params)
      expect(said(creditTile(glanceOf('MODA-DEMO').credit, money).hint)).not.toMatch(/\{/)
    }
  })

  it('knows every key the depth says (no key without its words)', () => {
    const catalogue = (locale: 'it' | 'en') => createTranslator(locale, messagesFor(locale, [NS])[NS] ?? {})
    const files = readdirSync(join(__dirname, 'view')).map((name) => join(__dirname, 'view', name))
    const keys = new Set<string>()
    for (const file of [...files, join(__dirname, 'model.ts'), join(__dirname, 'use-depth.ts')]) {
      for (const match of readFileSync(file, 'utf8').matchAll(/(?:\bt|say)\('([a-zA-Z]+(?:\.[a-zA-Z]+)+)'/g)) keys.add(match[1]!)
      for (const match of readFileSync(file, 'utf8').matchAll(/key: '([a-zA-Z]+(?:\.[a-zA-Z]+)+)'/g)) keys.add(match[1]!)
    }
    expect(keys.size).toBeGreaterThan(150)
    for (const locale of LOCALES) {
      const t = catalogue(locale)
      for (const key of keys) expect(t(key, { count: 2, name: 'x', date: 'x', by: 'x', amount: 'x', limit: 'x', max: 1, what: 'x', kind: 'x', company: 'x', reason: 'x', number: 'x', revision: 1, round: 1, permission: 'x', words: 'x' }), `${locale}: ${key}`).not.toBe(key)
    }
  })

  it('every new case of SCR-032 and SCR-033 draws in Italian and English with no key left', () => {
    const screens = [listScreen, recordScreen] as const
    let drawn = 0
    for (const screen of screens) {
      for (const entry of screen.cases.filter((item) => item.id.startsWith('w2b-324-'))) {
        for (const locale of LOCALES) {
          const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(screen.view as ComponentType<{ model: unknown }>, { model: entry.model })))
          const text = html.replace(/[\w.+-]+@[\w.-]+/g, '').replace(/href="[^"]*"/g, '')
          expect(text.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${entry.id} (${locale})`).toBeNull()
          drawn += 1
        }
      }
    }
    expect(drawn).toBeGreaterThan(80)
  })
})
