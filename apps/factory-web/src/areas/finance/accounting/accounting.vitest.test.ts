import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CHECK_CODES as DOMAIN_CHECK_CODES, checksFor as domainChecksFor, MAX_EXPLANATION as DOMAIN_MAX } from '@nexus/factory-domain/accounting/checks'
import { INTRASTAT_FLAG_CODES as DOMAIN_FLAGS } from '@nexus/factory-domain/accounting/intrastat'
import { MANIFEST_CHANGES as DOMAIN_CHANGES } from '@nexus/factory-domain/accounting/manifest'
import { ACCOUNTING_PACKAGES as DOMAIN_PACKAGES, EXPORT_STATUSES as DOMAIN_STATUSES, LOCK_LEVELS as DOMAIN_LEVELS, LOCK_STATUSES as DOMAIN_LOCK_STATUSES, PACKAGE_RULES as DOMAIN_RULES } from '@nexus/factory-domain/accounting/packages'
import { createApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, recordAddress } from '../../../lib/records/record-links'
import { OFFICE_NAV, OFFICE_PAGES } from '../../../shell/nav/office-nav'
import {
  ACCOUNTING_PACKAGES,
  CHECK_CODES,
  createExport,
  EXPORT_STATUSES,
  getPeriod,
  INTRASTAT_FLAG_CODES,
  liftLock,
  lockMonth,
  LOCK_LEVELS,
  LOCK_STATUSES,
  MANIFEST_CHANGES,
  MAX_EXPLANATION,
  PACKAGE_RULES,
} from './api'
import { AUGUST, canAs, EXPORT_DONE, HISTORY, LOCK_AUGUST, LOCK_SEPTEMBER, OCTOBER, OCTOBER_FIXED, PERIODS_2025, PERIODS_2026, SEPTEMBER } from './demo/fixtures'
import { designScreen as filesScreen } from './files/fixtures'
import { designScreen as accountingScreen } from './fixtures'
import {
  accountingCanOf,
  addressOf,
  askablePackages,
  batchPackages,
  cancelHeld,
  checksFor,
  checksOf,
  continueHeld,
  defaultPackages,
  exportBody,
  exportHeld,
  fileHeld,
  filesAddressOf,
  filesHref,
  fixedSince,
  historyTouches,
  liftHeld,
  lockHeld,
  packageHeld,
  periodChanged,
  periodTouches,
  phraseFor,
  phraseOk,
  phraseState,
  recentMonths,
  reExportHeld,
  REFUSAL_CODES,
  rowSelectable,
  shiftMonth,
  showMeStep,
  stepsFor,
  unexplainedOf,
  wizardHref,
  writeProblem,
  type WizardFacts,
} from './model'

/**
 * Finance › Close › Accounting export (SCR-156, SCR-156-files; B-W2a-51 on B-W2a-39's API): the lists equal
 * factory-domain's, the pure rules (who may do what, the address, the packages a person may put in and the default
 * ones, the checks they carry, what holds each step and Export, the export's body, a re-export's packages, the lock and
 * its typed phrase, lifting, the history's actions), the calls as the API takes them, the navigation and record links,
 * and every design case drawn in Italian and English with no message key or placeholder left on screen.
 */

describe('the lists mirror factory-domain', () => {
  it('packages and their rules, statuses, lock levels, checks, Intrastat flags, manifest changes', () => {
    expect(ACCOUNTING_PACKAGES).toEqual(DOMAIN_PACKAGES)
    for (const pkg of ACCOUNTING_PACKAGES) expect(PACKAGE_RULES[pkg], pkg).toEqual({ wave: DOMAIN_RULES[pkg].wave, grain: DOMAIN_RULES[pkg].grain, scope: DOMAIN_RULES[pkg].scope })
    expect(EXPORT_STATUSES).toEqual(DOMAIN_STATUSES)
    expect(LOCK_LEVELS).toEqual(DOMAIN_LEVELS)
    expect(LOCK_STATUSES).toEqual(DOMAIN_LOCK_STATUSES)
    expect(CHECK_CODES).toEqual(DOMAIN_CHECK_CODES)
    expect(INTRASTAT_FLAG_CODES).toEqual(DOMAIN_FLAGS)
    expect(MANIFEST_CHANGES).toEqual(DOMAIN_CHANGES)
    expect(MAX_EXPLANATION).toBe(DOMAIN_MAX)
  })

  it('the checks a set of packages carries are the domain\'s', () => {
    for (const set of [[], ['SALES_JOURNAL'], ['INTRASTAT'], ['YEAR_END_STOCK', 'PAYMENTS'], [...ACCOUNTING_PACKAGES]] as const) expect(checksFor(set), set.join(',')).toEqual(domainChecksFor(set))
  })
})

const finance = canAs('finance')
const facts = (over: Partial<WizardFacts> = {}): WizardFacts => ({ month: '2026-10', answer: OCTOBER, problem: null, chosen: defaultPackages(OCTOBER, finance), explanations: {}, can: finance, ...over })
const EXPLAINED = { PERIOD_ENDED: 'a', SHIPMENTS_INVOICED: 'b', PAYMENTS_PLACED: 'c', INTRASTAT_COMPLETE: 'd' }

describe('who may do what', () => {
  it('reading, exporting, locking, lifting a final close, and the grains', () => {
    expect(accountingCanOf(['accounting.view'])).toEqual({ view: true, export: false, lock: false, unlock: false, price: false, cost: false })
    expect(canAs('owner').unlock).toBe(true)
    expect(finance.unlock).toBe(false)
  })
})

describe('the address', () => {
  it('the history, or the wizard on a month and step; the lock dialog; filters', () => {
    expect(addressOf(null)).toEqual({ wizard: false, month: null, step: 'period', status: null, year: null, lock: null })
    expect(addressOf(new URLSearchParams('new=1'))).toMatchObject({ wizard: true, month: null, step: 'period' })
    expect(addressOf(new URLSearchParams('month=2026-10'))).toMatchObject({ wizard: true, month: '2026-10', step: 'checks' })
    expect(addressOf(new URLSearchParams('month=2026-13&step=bogus&status=DONE&year=1999&lock=maybe'))).toEqual({ wizard: false, month: null, step: 'period', status: null, year: null, lock: null })
    expect(addressOf(new URLSearchParams('status=EXPORTED&year=2026&lock=2026-09'))).toMatchObject({ status: 'EXPORTED', year: 2026, lock: '2026-09' })
    expect(wizardHref('/w/DEMO', '2026-10', 'review')).toBe('/w/DEMO/finance/accounting?month=2026-10&step=review')
    expect(wizardHref('/w/DEMO', null)).toBe('/w/DEMO/finance/accounting?new=1')
  })

  it('the files tab: one batch or several (at most 20, real ids only)', () => {
    expect(filesHref('/w/DEMO', ['a'])).toBe('/w/DEMO/finance/accounting/files?export=a')
    const ids = [HISTORY[1]!.id, HISTORY[3]!.id]
    expect(filesAddressOf(new URLSearchParams(`exports=${ids.join(',')},nope`))).toEqual(ids)
    expect(filesAddressOf(new URLSearchParams(`export=${ids[0]}&exports=${ids[0]}`))).toEqual([ids[0]])
  })

  it('months: shifting across a year', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-10', 3)).toBe('2027-01')
    expect(recentMonths('2026-10-30', [PERIODS_2026, PERIODS_2025]).map((entry) => [entry.month, entry.state, entry.exported])).toEqual([
      ['2026-10', 'open', null],
      ['2026-09', 'soft', 'EXP-2026-0003'],
      ['2026-08', 'hard', 'EXP-2026-0001'],
    ])
  })
})

describe('the packages', () => {
  it('W2b packages, the year-end pack outside the year end and a missing grain are held in words', () => {
    expect(packageHeld('COST_OF_SALES', { yearEnd: false }, finance)).toEqual({ key: 'contents.held.w2b' })
    expect(packageHeld('YEAR_END_STOCK', { yearEnd: false }, finance)).toEqual({ key: 'contents.held.yearEnd' })
    expect(packageHeld('YEAR_END_STOCK', { yearEnd: true }, finance)).toBeNull()
    expect(packageHeld('PURCHASES_JOURNAL', { yearEnd: false }, canAs('financePrice'))).toEqual({ key: 'contents.held.grain.cost' })
    expect(askablePackages(false, finance)).toEqual(['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'INTRASTAT'])
    expect(askablePackages(true, canAs('financePrice'))).toEqual(['SALES_JOURNAL', 'PAYMENTS', 'INTRASTAT'])
  })

  it('ticked by default: the journals, Intrastat when the month has EU sales, the year-end pack at the year end', () => {
    expect(defaultPackages(OCTOBER, finance)).toEqual(['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'INTRASTAT'])
    expect(defaultPackages({ ...OCTOBER, intrastat: { rows: 0, fileRows: 0, blocking: 0, warnings: 0 } }, finance)).toEqual(['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS'])
    expect(defaultPackages({ ...OCTOBER, yearEnd: true, intrastat: null }, finance)).toEqual(['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'YEAR_END_STOCK'])
    expect(defaultPackages(OCTOBER, canAs('financePrice'))).toEqual(['SALES_JOURNAL', 'PAYMENTS', 'INTRASTAT'])
  })

  it('the checks follow the packages chosen; a re-export carries only the packages that changed', () => {
    expect(checksOf(OCTOBER, ['SALES_JOURNAL']).map((check) => check.code)).not.toContain('INTRASTAT_COMPLETE')
    expect(checksOf(OCTOBER, ['SALES_JOURNAL', 'INTRASTAT']).map((check) => check.code)).toContain('INTRASTAT_COMPLETE')
    expect(stepsFor(['SALES_JOURNAL'])).toEqual(['period', 'checks', 'contents', 'review', 'export'])
    expect(stepsFor(['INTRASTAT'])).toEqual(['period', 'checks', 'contents', 'intrastat', 'review', 'export'])
    expect(batchPackages(SEPTEMBER, ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'INTRASTAT'])).toEqual(['SALES_JOURNAL', 'INTRASTAT'])
    expect(batchPackages(OCTOBER, ['SALES_JOURNAL', 'PAYMENTS'])).toEqual(['SALES_JOURNAL', 'PAYMENTS'])
    expect(batchPackages(AUGUST, ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS'])).toEqual([])
  })
})

describe('what holds each step (held, never greyed out)', () => {
  it('no month; reading; a failed read', () => {
    expect(continueHeld('period', facts({ month: null }))).toEqual({ key: 'held.chooseMonth' })
    expect(continueHeld('period', facts({ answer: null, chosen: null }))).toEqual({ key: 'held.reading' })
    expect(continueHeld('checks', facts({ answer: null, problem: 'problem.read.unavailable' }))).toEqual({ key: 'held.readFailed' })
    expect(continueHeld('period', facts())).toBeNull()
  })

  it('2 · Checks: the count of failing checks without an explanation; Show me opens them', () => {
    expect(unexplainedOf(checksOf(OCTOBER, facts().chosen!), {}).map((check) => check.code)).toEqual(['PERIOD_ENDED', 'SHIPMENTS_INVOICED', 'PAYMENTS_PLACED', 'INTRASTAT_COMPLETE'])
    expect(continueHeld('checks', facts())).toEqual({ key: 'held.checks', params: { count: 4 } })
    expect(continueHeld('checks', facts({ explanations: { ...EXPLAINED, PAYMENTS_PLACED: '   ' } }))).toEqual({ key: 'held.checks', params: { count: 1 } })
    expect(continueHeld('checks', facts({ explanations: EXPLAINED }))).toBeNull()
    expect(continueHeld('checks', facts({ explanations: { ...EXPLAINED, PERIOD_ENDED: 'x'.repeat(2001) } }))).toEqual({ key: 'held.checks', params: { count: 1 } })
    expect(showMeStep('review', facts())).toBe('checks')
    expect(showMeStep('checks', facts())).toBeNull()
  })

  it('3 · Contents: at least one package; Intrastat: fixed or explained; 4 · Review: all of it, and something to send', () => {
    expect(continueHeld('contents', facts({ explanations: EXPLAINED, chosen: [] }))).toEqual({ key: 'held.noPackage' })
    expect(continueHeld('intrastat', facts({ explanations: { ...EXPLAINED, INTRASTAT_COMPLETE: '' } }))).toEqual({ key: 'held.intrastat' })
    expect(continueHeld('review', facts({ explanations: EXPLAINED }))).toBeNull()
    const august = facts({ month: '2026-08', answer: AUGUST, chosen: ['SALES_JOURNAL', 'PAYMENTS'] })
    expect(continueHeld('review', august)).toEqual({ key: 'held.nothingChanged', params: { number: 'EXP-2026-0001' } })
  })

  it('Export: the permission, a running export, then everything Review holds', () => {
    expect(exportHeld({ ...facts({ explanations: EXPLAINED }), busy: false })).toBeNull()
    expect(exportHeld({ ...facts({ explanations: EXPLAINED }), busy: true })).toEqual({ key: 'held.busy' })
    expect(exportHeld({ ...facts({ explanations: EXPLAINED, can: canAs('reader') }), busy: false })).toEqual({ key: 'held.noExport' })
    expect(exportHeld({ ...facts(), busy: false })).toEqual({ key: 'held.checks', params: { count: 4 } })
  })
})

describe('the export', () => {
  it('a first export: the chosen packages, the failing checks\' explanations, the files\' language, a note', () => {
    expect(exportBody({ companyId: 'c1', month: '2026-10', answer: OCTOBER, chosen: ['SALES_JOURNAL', 'PAYMENTS'], explanations: { ...EXPLAINED, NO_INVOICE_REJECTED: 'passes: not sent' }, note: '  per lo studio ', language: 'it' })).toEqual({
      companyId: 'c1',
      month: '2026-10',
      packages: ['SALES_JOURNAL', 'PAYMENTS'],
      explanations: [
        { code: 'PERIOD_ENDED', explanation: 'a' },
        { code: 'SHIPMENTS_INVOICED', explanation: 'b' },
        { code: 'PAYMENTS_PLACED', explanation: 'c' },
      ],
      note: 'per lo studio',
      language: 'it',
    })
  })

  it('a re-export names the batch it amends and carries only the packages that changed', () => {
    const body = exportBody({ companyId: 'c1', month: '2026-09', answer: SEPTEMBER, chosen: ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'INTRASTAT'], explanations: {}, note: '', language: 'en' })
    expect(body).toEqual({ companyId: 'c1', month: '2026-09', packages: ['SALES_JOURNAL', 'INTRASTAT'], explanations: [], supersedesId: SEPTEMBER.reExportOf!.id, language: 'en' })
  })

  it('live: "2 checks fixed since you opened this"; a newer read that differs', () => {
    expect(fixedSince(OCTOBER, OCTOBER_FIXED, facts().chosen!)).toEqual(['SHIPMENTS_INVOICED', 'PAYMENTS_PLACED'])
    expect(periodChanged(OCTOBER, OCTOBER_FIXED)).toBe(true)
    expect(periodChanged(OCTOBER, { ...OCTOBER })).toBe(false)
    expect(periodTouches({ type: 'invoice.issued' })).toBe(true)
    expect(periodTouches({ type: 'production.scan_recorded' })).toBe(false)
    expect(historyTouches({ type: 'accounting_export.exported' })).toBe(true)
    expect(historyTouches({ type: 'period_lock.locked' })).toBe(true)
  })
})

describe('the lock', () => {
  it('the typed phrase of the final close, in either language, case and spaces free (Owner answer P1)', () => {
    expect(phraseFor('2026-10', 'en')).toBe('close October 2026')
    expect(phraseFor('2026-10', 'it')).toBe('chiudi ottobre 2026')
    expect(phraseOk('2026-10', '  Close   OCTOBER 2026 ')).toBe(true)
    expect(phraseOk('2026-10', 'chiudi ottobre 2026')).toBe(true)
    expect(phraseOk('2026-10', 'close September 2026')).toBe(false)
    expect(phraseState('2026-10', '', 'en')).toBe('empty')
    expect(phraseState('2026-10', 'close Oct', 'en')).toBe('partial')
    expect(phraseState('2026-10', 'chiudi ott', 'en')).toBe('partial')
    expect(phraseState('2026-10', 'close Nov', 'en')).toBe('mismatch')
    expect(phraseState('2026-10', 'close october 2026', 'it')).toBe('match')
  })

  it('locking is held: the permission, the same level again, a final close made soft, the phrase', () => {
    const base = { month: '2026-09', phrase: '', current: null, can: finance, busy: false } as const
    expect(lockHeld({ ...base, level: 'SOFT' })).toBeNull()
    expect(lockHeld({ ...base, level: 'SOFT', can: { lock: false } })).toEqual({ key: 'lock.held.noLock' })
    expect(lockHeld({ ...base, level: 'SOFT', current: LOCK_SEPTEMBER })).toEqual({ key: 'lock.held.alreadySoft' })
    expect(lockHeld({ ...base, level: 'HARD', current: LOCK_SEPTEMBER })).toEqual({ key: 'lock.held.phrase' })
    expect(lockHeld({ ...base, level: 'HARD', current: LOCK_SEPTEMBER, phrase: 'chiudi settembre 2026' })).toBeNull()
    expect(lockHeld({ ...base, month: '2026-08', level: 'SOFT', current: LOCK_AUGUST })).toEqual({ key: 'lock.held.hardFirst' })
    expect(lockHeld({ ...base, month: '2026-08', level: 'HARD', current: LOCK_AUGUST })).toEqual({ key: 'lock.held.alreadyHard' })
  })

  it('lifting: a soft lock with accounting.lock, a final close only with accounting.unlock; a reason', () => {
    expect(liftHeld(LOCK_SEPTEMBER, 'reason', finance, false)).toBeNull()
    expect(liftHeld(LOCK_SEPTEMBER, ' ', finance, false)).toEqual({ key: 'lift.held.reason' })
    expect(liftHeld(LOCK_AUGUST, 'reason', finance, false)).toEqual({ key: 'lift.held.noUnlock' })
    expect(liftHeld(LOCK_AUGUST, 'reason', canAs('owner'), false)).toBeNull()
    expect(liftHeld(null, 'reason', canAs('owner'), false)).toEqual({ key: 'lift.held.notLocked' })
  })
})

describe('the history', () => {
  it('re-export: only the latest exported batch, when something changed; cancel: only a draft', () => {
    const [draft, latest, amended, august] = HISTORY as [typeof HISTORY[0], typeof HISTORY[0], typeof HISTORY[0], typeof HISTORY[0]]
    expect(reExportHeld(latest, finance)).toBeNull()
    expect(reExportHeld(amended, finance)).toEqual({ key: 'history.held.notLatest', params: { number: 'EXP-2026-0003' } })
    expect(reExportHeld(august, finance)).toEqual({ key: 'history.held.nothingChanged', params: { number: 'EXP-2026-0001' } })
    expect(reExportHeld(draft, finance)).toEqual({ key: 'history.held.notExported' })
    expect(reExportHeld(latest, canAs('reader'))).toEqual({ key: 'held.noExport' })
    expect(cancelHeld(draft, finance)).toBeNull()
    expect(cancelHeld(latest, finance)).toEqual({ key: 'history.held.notDraft' })
    expect(rowSelectable(draft)).toEqual({ key: 'history.unselectable.draft' })
    expect(rowSelectable(latest)).toBeNull()
  })

  it('a file is downloaded with its package\'s grain', () => {
    expect(fileHeld(EXPORT_DONE.files[1]!, canAs('financePrice'))).toEqual({ key: 'contents.held.grain.cost' })
    expect(fileHeld(EXPORT_DONE.files[0]!, canAs('financePrice'))).toBeNull()
  })
})

describe('the API\'s refusals in words', () => {
  const refused = (kind: ConstructorParameters<typeof ApiError>[0], status: number, path: string) => new ApiError(kind, status, 'x', 'x', null, [{ path, message: 'English words the screen never shows' }])
  it('a refusal code, an unexplained check, the phrase, a moved record, a changed month', () => {
    expect(writeProblem(refused('conflict', 409, 'problem/ALREADY_EXPORTED'))).toEqual({ key: 'refusal.ALREADY_EXPORTED', reload: true })
    expect(writeProblem(refused('conflict', 409, 'problem/HARD_LOCKED'))).toEqual({ key: 'refusal.HARD_LOCKED', reload: false })
    expect(writeProblem(refused('invalid', 400, 'body/explanations/PAYMENTS_PLACED'))).toEqual({ key: 'problem.write.explain', reload: true })
    expect(writeProblem(refused('invalid', 400, 'body/phrase'))).toEqual({ key: 'problem.write.phrase', reload: false })
    expect(writeProblem(refused('conflict', 409, 'body/version'))).toEqual({ key: 'problem.write.moved', reload: true })
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ key: 'problem.write.changedWhile', reload: true })
    expect(writeProblem(new ApiError('step_up', 403, 'forbidden', 'x'))).toEqual({ key: 'problem.write.step_up', reload: false })
  })
})

describe('the calls', () => {
  const recording = (answer: unknown) => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const api = createApiClient({
      baseUrl: 'http://api.test',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
      csrfToken: () => 'csrf',
    })
    return { api, calls }
  }

  it('reads a month with the packages, exports and locks with an Idempotency-Key, lifts at the version', async () => {
    const read = recording(OCTOBER)
    await getPeriod(read.api, 'c1', '2026-10', ['SALES_JOURNAL', 'INTRASTAT'])
    expect(read.calls[0]!.url).toBe('http://api.test/accounting/periods/2026-10?companyId=c1&packages=SALES_JOURNAL%2CINTRASTAT')
    const made = recording({ export: EXPORT_DONE })
    const body = exportBody({ companyId: 'c1', month: '2026-10', answer: OCTOBER, chosen: ['SALES_JOURNAL'], explanations: EXPLAINED, note: '', language: 'it' })
    await createExport(made.api, body, 'key-1')
    expect(JSON.parse(String(made.calls[0]!.init.body))).toEqual(body)
    expect(new Headers(made.calls[0]!.init.headers).get('idempotency-key')).toBe('key-1')
    const locked = recording({ lock: LOCK_SEPTEMBER, warnings: [{ code: 'INVOICE_REJECTED', message: 'x' }] })
    const answer = await lockMonth(locked.api, { companyId: 'c1', month: '2026-09', level: 'HARD', phrase: 'close September 2026', version: 1 }, 'key-2')
    expect(answer.warnings).toEqual([{ code: 'INVOICE_REJECTED' }])
    expect(JSON.parse(String(locked.calls[0]!.init.body))).toEqual({ companyId: 'c1', month: '2026-09', level: 'HARD', phrase: 'close September 2026', version: 1 })
    const lifted = recording({ lock: { ...LOCK_AUGUST, status: 'UNLOCKED' } })
    await liftLock(lifted.api, LOCK_AUGUST.id, { version: 2, reason: 'r' }, 'key-3')
    expect(lifted.calls[0]!.url).toBe(`http://api.test/accounting/locks/${LOCK_AUGUST.id}/lift`)
  })
})

describe('navigation and record links', () => {
  it('Finance › Close › Accounting export with accounting.view; the files tab is built; a batch opens there', () => {
    const area = OFFICE_NAV.areas.find((entry) => entry.id === 'finance')!
    const close = (area.sections ?? []).find((section) => section.id === 'finance-close')!
    expect(close.items.map((item) => [item.href, item.permission])).toEqual([['/finance/accounting', 'accounting.view']])
    expect(OFFICE_PAGES.has('/finance/accounting')).toBe(true)
    expect(OFFICE_PAGES.has('/finance/accounting/files')).toBe(true)
    expect(recordAddress({ type: 'AccountingExport', id: 'e1' }, OFFICE_PAGES)).toBe('/finance/accounting/files?export=e1')
    expect(LIST_PAGES['/accounting/exports']).toBe('/finance/accounting')
  })
})

const LEFT_KEY =
  /\b(?:noAccess|band|layout|notice|live|common|keys|status|lockState|package|contents|sum|history|cancel|wizard|step|held|period|check|checks|fix|field|intrastat|flag|review|export|files|lock|lift|stepUp|aside|problem|refusal)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission and grain names are said on purpose ("needs accounting.export", "the cost grain (money.cost)"). */
const SAID = /\b(?:accounting\.(?:view|export|lock|unlock)|money\.(?:price|cost))\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key or placeholder left on screen', () => {
  for (const screen of [accountingScreen, filesScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('the dynamic words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['finance-accounting'])['finance-accounting']!)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const pkg of ACCOUNTING_PACKAGES) {
        has(`package.${pkg}.title`)
        has(`package.${pkg}.body`)
      }
      for (const code of CHECK_CODES) {
        has(`check.${code}.title`)
        has(`check.${code}.pass`, { count: 0, month: 'm', end: 'e' })
        has(`check.${code}.fail`, { count: 1, month: 'm', end: 'e' })
        has(`check.${code}.fail`, { count: 3, month: 'm', end: 'e' })
      }
      for (const code of INTRASTAT_FLAG_CODES) has(`flag.${code}`)
      for (const code of REFUSAL_CODES) has(`refusal.${code}`)
      for (const status of EXPORT_STATUSES) has(`status.${status}`)
      for (const state of ['open', 'soft', 'hard', 'lifted']) {
        has(`lockState.${state}`)
        has(`lock.short.${state}`, { month: 'm' })
      }
      for (const state of ['empty', 'partial', 'mismatch', 'match']) has(`lock.phrase.${state}`)
      for (const step of ['period', 'checks', 'contents', 'intrastat', 'review', 'export']) has(`step.${step}.title`)
      for (const key of ['TAXABLE', 'VAT', 'GROSS', 'RECEIVED', 'REFUNDED', 'NOT_PLACED', 'VALUE']) has(`sum.${key}`)
      for (const type of ['Ddt', 'Invoice', 'Payment', 'Style', 'Party', 'StockCount', 'Site', 'other']) has(`fix.${type}`, { number: 'n' })
      for (const field of ['hsCode', 'originCountry', 'netMassKg', 'taxIdentity', 'incoterm']) has(`field.${field}`)
      for (const kind of ['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'invalid', 'internal']) has(`problem.read.${kind}`)
      for (const kind of ['signed_out', 'forbidden', 'not_found', 'rate_limited', 'unavailable', 'step_up', 'invalid', 'internal', 'explain', 'phrase', 'moved', 'changedWhile']) has(`problem.write.${kind}`)
      for (const grain of ['price', 'cost']) has(`contents.held.grain.${grain}`)
      has('refusal.other')
    }
  })
})
