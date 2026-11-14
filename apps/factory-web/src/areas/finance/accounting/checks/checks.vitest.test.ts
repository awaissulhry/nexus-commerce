import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { INTEGRITY_CHECK_CODES as DOMAIN_CHECKS, INTEGRITY_FAILURE_CODES as DOMAIN_FAILURES, INTEGRITY_RESULTS as DOMAIN_RESULTS } from '@nexus/factory-domain/accounting/integrity/checks'
import { createApiClient } from '../../../../lib/api/client'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { canAs } from '../demo/fixtures'
import { checksOf, defaultPackages, FIX_TYPES, packageHeld, periodTouches } from '../model'
import { getIntegrity, INTEGRITY_CHECK_CODES, INTEGRITY_FAILURE_CODES, INTEGRITY_RESULTS, runIntegrity } from './api'
import { INTEGRITY_FAILING, INTEGRITY_NEVER, INTEGRITY_PASSED, OCTOBER_BRIDGE, OCTOBER_JOURNALS } from './demo/fixtures'
import { designScreen } from './fixtures'
import { fixAddress, historyPhrase, integrityPhrase, integrityState, integrityTouches, journalsLine, runHeld } from './model'

/**
 * B-W2b-426 — the bridge in the export wizard (SCR-482): the integrity lists equal factory-domain's, the checks the bridge's
 * packages carry (work orders closed with the cost of goods sold; the mapping's two while the journals are on), where a
 * check's record opens, the integrity checks' states and sentences, what holds a run, the journals' line, the calls, the
 * words every code needs in both languages, and every design case drawn with no message key left on screen.
 */

const finance = canAs('finance')
const BRIDGE = ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'COST_OF_SALES', 'VAT_REGISTERS', 'INTRASTAT'] as const

describe('the lists mirror factory-domain', () => {
  it('integrity checks, failures, results', () => {
    expect(INTEGRITY_CHECK_CODES).toEqual(DOMAIN_CHECKS)
    expect(INTEGRITY_FAILURE_CODES).toEqual(DOMAIN_FAILURES)
    expect(INTEGRITY_RESULTS).toEqual(DOMAIN_RESULTS)
  })
})

describe('the bridge’s checks and packages in the wizard', () => {
  it('"Work orders closed" comes with the cost of goods sold; the mapping’s two only while the journals are on', () => {
    expect(checksOf(OCTOBER_BRIDGE, ['SALES_JOURNAL']).map((check) => check.code)).not.toContain('WORK_ORDERS_CLOSED')
    expect(checksOf(OCTOBER_BRIDGE, [...BRIDGE]).map((check) => check.code)).toContain('WORK_ORDERS_CLOSED')
    expect(checksOf(OCTOBER_BRIDGE, [...BRIDGE]).map((check) => check.code)).not.toContain('MAPPING_COMPLETE')
    expect(checksOf(OCTOBER_JOURNALS, ['SALES_JOURNAL']).map((check) => check.code)).toEqual(expect.arrayContaining(['MAPPING_COMPLETE', 'ENTRIES_BALANCE']))
    expect(checksOf(OCTOBER_JOURNALS, ['INTRASTAT']).map((check) => check.code)).not.toContain('MAPPING_COMPLETE')
  })

  it('the cost of goods sold and the VAT registers are offered, not ticked by default; held without a grain', () => {
    expect(packageHeld('COST_OF_SALES', { yearEnd: false }, finance)).toBeNull()
    expect(defaultPackages(OCTOBER_BRIDGE, finance)).toEqual(['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'INTRASTAT'])
  })

  it('the journals’ line only when a chosen package becomes entries', () => {
    expect(journalsLine(OCTOBER_BRIDGE, ['SALES_JOURNAL'])).toEqual({ key: 'journals.contents.off' })
    expect(journalsLine(OCTOBER_JOURNALS, ['COST_OF_SALES'])).toEqual({ key: 'journals.contents.on' })
    expect(journalsLine(OCTOBER_JOURNALS, ['VAT_REGISTERS', 'INTRASTAT'])).toBeNull()
  })

  it('a check’s record opens: a key on the account mapping, a work order on its page, an entry’s document in its panels', () => {
    expect(fixAddress({ recordType: 'AccountMapping', recordId: 'ITEM_GROUP/SALES_FREIGHT', number: 'SALES_FREIGHT' })).toBe('/finance/accounting/mapping?open=ITEM_GROUP%2FSALES_FREIGHT')
    expect(fixAddress({ recordType: 'WorkOrder', recordId: 'w1', number: 'WO-1' })).toBe('/production/work-orders/w1')
    expect(fixAddress({ recordType: 'WorkOrderVariance', recordId: 'v1', number: null })).toBe('/records/WorkOrderVariance/v1')
  })

  it('live: the bridge’s documents and the mapping read the month again; a run of the checks reads them again', () => {
    for (const type of ['supplier_invoice.received', 'refund.paid', 'work_order_close.changed', 'cost_of_sales.posted', 'purchase_price_variance.posted', 'account_mapping.changed', 'accounting_settings.changed']) expect(periodTouches({ type }), type).toBe(true)
    expect(integrityTouches({ type: 'integrity_checks.ran' })).toBe(true)
    expect(integrityTouches({ type: 'invoice.issued' })).toBe(false)
  })
})

describe('the nightly checks', () => {
  it('states for the DS CheckList, the sentence by result, the runs before', () => {
    expect(integrityState('PASSED', false)).toBe('pass')
    expect(integrityState('FAILED', false)).toBe('fail')
    expect(integrityState('ERROR', false)).toBe('unknown')
    expect(integrityState(null, false)).toBe('unknown')
    expect(integrityState('PASSED', true)).toBe('checking')
    const failing = INTEGRITY_FAILING.checks.find((check) => check.code === 'EXPORTED_DOCUMENTS_UNCHANGED')!
    expect(integrityPhrase(failing)).toEqual({ key: 'integrity.check.EXPORTED_DOCUMENTS_UNCHANGED.fail', params: { count: 2 } })
    expect(integrityPhrase(INTEGRITY_PASSED.checks[0]!)).toEqual({ key: 'integrity.check.INVOICE_TOTALS_EQUAL_LINES.pass' })
    expect(integrityPhrase(INTEGRITY_NEVER.checks[0]!)).toEqual({ key: 'integrity.never' })
    expect(historyPhrase(failing)).toEqual({ key: 'integrity.historyAll', params: { count: 5 } })
    expect(historyPhrase({ history: [...failing.history, { ranAt: failing.ranAt!, result: 'FAILED', failureCount: 1 }] })).toEqual({ key: 'integrity.history', params: { passed: 5, failed: 1 } })
    expect(historyPhrase(INTEGRITY_NEVER.checks[0]!)).toBeNull()
  })

  it('running them now: accounting.export, one run at a time', () => {
    expect(runHeld({ run: true }, false)).toBeNull()
    expect(runHeld({ run: false }, false)).toEqual({ key: 'integrity.held.noRun' })
    expect(runHeld({ run: true }, true)).toEqual({ key: 'integrity.held.running' })
  })

  it('reads them and runs them now with an Idempotency-Key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const api = createApiClient({
      baseUrl: 'http://api.test',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return new Response(JSON.stringify({ ...INTEGRITY_FAILING, words: 'English', checks: INTEGRITY_FAILING.checks.map((check) => ({ ...check, title: 'English', words: 'English', errorWords: null })) }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
      csrfToken: () => 'csrf',
    })
    expect((await getIntegrity(api, 'c1')).failing).toBe(2)
    expect(calls[0]!.url).toBe('http://api.test/accounting/integrity?companyId=c1')
    await runIntegrity(api, 'c1', 'key-1')
    expect([calls[1]!.init.method, calls[1]!.url, JSON.parse(String(calls[1]!.init.body)), new Headers(calls[1]!.init.headers).get('idempotency-key')]).toEqual(['POST', 'http://api.test/accounting/integrity/run', { companyId: 'c1' }, 'key-1'])
  })
})

describe('the words every code needs, in both languages', () => {
  it('integrity checks and failures, the bridge’s sums and records, the kinds of keys', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['finance-accounting-depth'])['finance-accounting-depth']!)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const code of INTEGRITY_CHECK_CODES) {
        has(`integrity.check.${code}.title`)
        has(`integrity.check.${code}.pass`)
        has(`integrity.check.${code}.fail`, { count: 1 })
        has(`integrity.check.${code}.fail`, { count: 3 })
      }
      for (const code of INTEGRITY_FAILURE_CODES) has(`integrity.failure.${code}`)
      for (const key of ['COST_OF_SALES', 'VARIANCE', 'PPV', 'SALES_VAT', 'VAT_DUE', 'PURCHASES_VAT']) has(`sum.${key}`)
      const own = createTranslator(locale, messagesFor(locale, ['finance-accounting'])['finance-accounting']!)
      for (const type of FIX_TYPES) expect(own(`fix.${type}`, { number: 'n' }) !== `fix.${type}` || t(`fix.${type}`, { number: 'n' }) !== `fix.${type}`, `${locale}: fix.${type}`).toBe(true)
      for (const kind of ['ITEM_GROUP', 'TAX_CODE', 'COST_CATEGORY', 'PAYMENT_METHOD', 'PARTY_GROUP']) has(`mapping.kind.${kind}`)
    }
  })

  it('the bridge’s catalogue never repeats a key of the export’s (the screens read the export’s first)', () => {
    for (const locale of LOCALES) {
      const own = Object.keys(messagesFor(locale, ['finance-accounting'])['finance-accounting']!)
      const bridge = Object.keys(messagesFor(locale, ['finance-accounting-depth'])['finance-accounting-depth']!)
      expect(bridge.filter((key) => own.includes(key)), locale).toEqual([])
    }
  })
})

const LEFT_KEY = /\b(?:integrity|journals|mapping|hard|sum|fix|check|checks|contents|package|step|held|review|export|files|lock|common|problem)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:accounting\.(?:view|export|lock|unlock|close)|money\.(?:price|cost))\b/g

describe('every design case draws in both languages with no key or placeholder left on screen', () => {
  const screen = designScreen as unknown as DesignScreen<unknown>
  it(`SCR-482: ${screen.cases.length} cases × it, en`, () => {
    const View = screen.view as ComponentType<{ model: unknown }>
    for (const item of screen.cases) {
      for (const locale of LOCALES) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: item.model }))).replace(SAID, '')
        expect(html.length, `SCR-482/${item.id}`).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `SCR-482/${item.id} (${locale})`).toBeNull()
        expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `SCR-482/${item.id} (${locale}) placeholder`).toBeNull()
      }
    }
  })
})
