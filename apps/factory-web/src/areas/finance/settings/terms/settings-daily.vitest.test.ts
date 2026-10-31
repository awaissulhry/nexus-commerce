import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { COSTING_METHODS as DOMAIN_METHODS, DECIDED_METHODS as DOMAIN_DECIDED } from '@nexus/factory-domain/costing/ledger/entries'
import { checkPaymentTerms, INSTALMENT_EVENTS } from '@nexus/factory-domain/sales/terms/terms'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { permissionsOf } from '../../invoices/daily/demo/fixtures'
import { COSTING_METHODS, DECIDED_METHODS } from '../costing/api'
import { chooseHeld, chooseProblem, confirmProblems, costingAbilitiesOf, lockWords, methodState } from '../costing/model'
import { designScreen as settingsScreen } from '../fixtures'
import { METHOD_CHOSEN, METHOD_LOCKED, METHOD_UNDECIDED, TERMS } from './demo/fixtures'
import { archiveHeld, draftOf, emptyTerms, fieldsOf, hasProblems, patchOf, previewOf, rulesChanged, shareTotal, TERMS_ROWS, termsAbilitiesOf, termsProblems, termsStatusOf, termsWriteProblem } from './model'

describe('B-W2a-80 payment terms — who may; rows', () => {
  it('finance manages, sales reads', () => {
    expect(termsAbilitiesOf(permissionsOf('finance'))).toEqual({ view: true, manage: true })
    expect(termsAbilitiesOf(permissionsOf('sales'))).toEqual({ view: true, manage: false })
    expect(TERMS_ROWS.map(termsStatusOf)).toEqual(['ACTIVE', 'ARCHIVED', 'ALL'])
  })
})

describe('the terms dialog checks as factory-domain does', () => {
  it('a new entry starts valid: 100% 30 days end of month, bank transfer', () => {
    const draft = { ...emptyTerms(), code: 'bb30fm', name: 'Bonifico 30 gg fine mese' }
    expect(hasProblems(termsProblems(draft))).toBe(false)
    expect(fieldsOf(draft)).toMatchObject({ code: 'BB30FM', method: 'MP05', instalments: [{ sharePct: '100', from: 'INVOICE', days: 30, endOfMonth: true }], earlyPaymentDiscountPct: null, earlyPaymentDays: null })
    expect(checkPaymentTerms(fieldsOf(draft)).ok).toBe(true)
    expect(previewOf(draft, 'en')).toMatch(/30/)
  })
  it('shares that do not total 100, two on the order, a bad code, a discount without days', () => {
    const base = { ...emptyTerms(), code: 'X1', name: 'X' }
    expect(termsProblems({ ...base, instalments: [{ sharePct: '50', from: 'INVOICE', days: '30', endOfMonth: true }, { sharePct: '40', from: 'INVOICE', days: '60', endOfMonth: true }] }).instalments).toBe('terms.problem.total')
    expect(shareTotal({ ...base, instalments: [{ sharePct: '50,5', from: 'INVOICE', days: '30', endOfMonth: true }, { sharePct: '40', from: 'INVOICE', days: '60', endOfMonth: true }] })).toBe(90.5)
    expect(termsProblems({ ...base, instalments: [{ sharePct: '50', from: 'ORDER', days: '0', endOfMonth: false }, { sharePct: '50', from: 'ORDER', days: '7', endOfMonth: false }] }).instalments).toBe('terms.problem.oneOrder')
    expect(termsProblems({ ...base, code: 'a b' }).code).toBe('terms.problem.code')
    expect(termsProblems({ ...base, discountPct: '2' }).discount).toBe('terms.problem.discount')
    expect(termsProblems({ ...base, instalments: [{ sharePct: '100', from: 'INVOICE', days: 'x', endOfMonth: false }] }).lines[0]).toBe('terms.problem.days')
    expect(previewOf({ ...base, instalments: [{ sharePct: '100', from: 'INVOICE', days: 'x', endOfMonth: false }] }, 'it')).toBeNull()
  })
  it('edit sends the names always and the rules only when they changed; copy starts without a code', () => {
    const stored = TERMS[1]!
    const same = draftOf(stored, 'it')
    expect(same.instalments[0]!.sharePct).toBe('50')
    expect(rulesChanged(stored, same)).toBe(false)
    expect(Object.keys(patchOf(stored, { ...same, name: 'Nuovo nome' }))).toEqual(['name', 'nameI18n'])
    const changed = { ...same, instalments: same.instalments.map((item, index) => (index === 1 ? { ...item, days: '90' } : item)) }
    expect(rulesChanged(stored, changed)).toBe(true)
    expect(patchOf(stored, changed)).toHaveProperty('instalments')
    expect(draftOf(stored, 'en', true).code).toBe('')
    expect(draftOf(TERMS[2]!, 'it').discountPct).toBe('2')
  })
  it('archive is held while a customer has them as default; in-use rules are a refusal that offers new terms', () => {
    const can = { view: true, manage: true }
    expect(archiveHeld(TERMS[0]!, can)).toEqual({ key: 'terms.held.customers', params: { count: 2 } })
    expect(archiveHeld(TERMS[2]!, can)).toBeNull()
    expect(archiveHeld(TERMS[3]!, can)?.key).toBe('terms.held.archived')
    expect(archiveHeld(TERMS[2]!, { view: true, manage: false })?.key).toBe('terms.held.noManage')
    const conflict = new ApiError('conflict', 409, 'conflict', 'rules fixed', null, [])
    expect(termsWriteProblem(conflict, true)).toEqual({ key: 'terms.problem.inUse', inUse: true, reload: false })
    expect(termsWriteProblem(conflict, false).inUse).toBe(false)
    expect(termsWriteProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/version' }]), true).key).toBe('terms.problem.moved')
    expect(termsWriteProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/code' }]), false).key).toBe('terms.problem.codeTaken')
  })
})

describe('the costing method per company', () => {
  it('the methods mirror factory-domain', () => {
    expect([...COSTING_METHODS]).toEqual([...DOMAIN_METHODS])
    expect([...DECIDED_METHODS]).toEqual([...DOMAIN_DECIDED])
  })
  it('state words; finance may choose, sales reads', () => {
    expect(methodState(METHOD_UNDECIDED)).toEqual({ key: 'costing.state.undecided', tone: 'warning' })
    expect(methodState(METHOD_CHOSEN).key).toBe('costing.state.chosen')
    expect(methodState(METHOD_LOCKED).key).toBe('costing.state.locked')
    expect(costingAbilitiesOf(permissionsOf('finance'))).toEqual({ view: true, choose: true })
    expect(costingAbilitiesOf(permissionsOf('sales'))).toEqual({ view: true, choose: false })
  })
  it('the choice is held once locked (with why), without the right, before a pick, or for the method in force', () => {
    const can = { view: true, choose: true }
    expect(chooseHeld(METHOD_UNDECIDED, can, 'STANDARD')).toBeNull()
    expect(chooseHeld(METHOD_LOCKED, can, 'FIFO')?.key).toBe('costing.held.locked')
    expect(chooseHeld(METHOD_UNDECIDED, { view: true, choose: false }, 'FIFO')?.key).toBe('costing.held.noRight')
    expect(chooseHeld(METHOD_UNDECIDED, can, null)?.key).toBe('costing.held.pick')
    expect(chooseHeld(METHOD_CHOSEN, can, 'STANDARD')?.key).toBe('costing.held.same')
    expect(chooseHeld(null, can, 'FIFO')?.key).toBe('costing.held.reading')
  })
  it('GATE-ACCOUNTANT: the person confirms the accountant chose it; a reason is optional, 3 to 500', () => {
    expect(confirmProblems({ accountant: false, reason: '' })).toEqual({ accountant: 'costing.problem.accountant' })
    expect(confirmProblems({ accountant: true, reason: 'ok' })).toEqual({ reason: 'costing.problem.reasonShort' })
    expect(confirmProblems({ accountant: true, reason: '' })).toEqual({})
  })
  it('why it is locked: since when entries exist, when it locked, how many rely on it', () => {
    expect(lockWords(METHOD_UNDECIDED)).toBeNull()
    expect(lockWords(METHOD_LOCKED)).toEqual({ since: '2026-10-03T08:15:00.000Z', lockedAt: '2026-10-03T08:15:00.000Z', entries: 128 })
    expect(chooseProblem(new ApiError('conflict', 409, 'conflict', 'locked', null, [])).key).toBe('costing.problem.locked')
    expect(chooseProblem(new ApiError('step_up', 403, 'stepUp', 'x', null, [])).key).toBe('costing.problem.stepUp')
  })
})

const LEFT_KEY = /\b(?:terms|costing|settings|bank|common|held|list|notice|stepUp|method)\.[a-zA-Z]+(?:\.[a-zA-Z0-9_]+)*\b/
const PERMISSION = /\b(?:invoices|payments|paymentterms|costing|companies|integrations)\.(?:view|manage|issue|record|void|bank|method)\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every W2a settings design case draws in both languages with no key on screen', () => {
  it('SCR-083 w2a cases × it, en', () => {
    const cases = settingsScreen.cases.filter((item) => item.id.startsWith('w2a-'))
    expect(cases.length).toBeGreaterThan(15)
    for (const item of cases) {
      for (const locale of LOCALES) {
        const html = render(settingsScreen as unknown as DesignScreen<unknown>, item.model, locale)
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(html, `${item.id} (${locale})`).not.toMatch(PERMISSION)
      }
    }
  })
  it('the library and the Costing card are on the page; the lock reason is said', () => {
    const locked = settingsScreen.cases.find((entry) => entry.id === 'w2a-costing-locked')!
    const html = render(settingsScreen as unknown as DesignScreen<unknown>, locked.model, 'en')
    expect(html).toContain('Payment terms')
    expect(html).toContain('Locked: cost entries rely on it.')
    expect(html).toContain('Add terms')
  })
  it('the dynamic words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['finance-daily'])['finance-daily']!)
      const has = (key: string, count?: number) => expect(t(key, count === undefined ? undefined : { count }), `${locale}: ${key}`).not.toBe(key)
      for (const event of INSTALMENT_EVENTS) has(`terms.event.${event}`)
      for (const rows of TERMS_ROWS) has(`terms.rows.${rows}`)
      for (const status of ['ACTIVE', 'ARCHIVED']) has(`terms.status.${status}`)
      for (const move of ['archive', 'reactivate']) has(`terms.moved.${move}`, 2)
      for (const method of DECIDED_METHODS) has(`costing.about.${method}`)
      for (const from of ['COMPANY', 'TENANT', 'DEFAULT']) has(`costing.from.${from}`)
      for (const source of ['MANUAL', 'TERMS', 'ADVANCE']) has(`terms.source.${source}`)
    }
  })
})
