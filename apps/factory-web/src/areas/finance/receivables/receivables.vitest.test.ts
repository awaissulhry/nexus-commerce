import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AGEING_FILTERS as DOMAIN_FILTERS, REMINDER_VIEWS as DOMAIN_VIEWS } from '@nexus/factory-domain/receivables/contracts'
import { LATE_INTEREST_MODES as DOMAIN_INTEREST, REMINDER_ACTIONS as DOMAIN_ACTIONS, SWITCH_BLOCKERS as DOMAIN_BLOCKERS } from '@nexus/factory-domain/receivables/ladder'
import { AGEING_BUCKETS as DOMAIN_BUCKETS, MOVEMENT_KINDS as DOMAIN_KINDS } from '@nexus/factory-domain/receivables/ledger'
import {
  HELD_REASONS as DOMAIN_HELD,
  MAX_BULK_REMINDERS as DOMAIN_MAX,
  MAX_REMINDER_TEXT as DOMAIN_TEXT,
  REMINDER_REFUSALS as DOMAIN_REFUSALS,
  REMINDER_STATUSES as DOMAIN_STATUSES,
} from '@nexus/factory-domain/receivables/reminders'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { RECORD_PAGES, LIST_PAGES } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import {
  AGEING_BUCKETS,
  AGEING_FILTERS,
  HELD_REASONS,
  LATE_INTEREST_MODES,
  MAX_BULK_REMINDERS,
  MAX_REMINDER_TEXT,
  MOVEMENT_KINDS,
  REMINDER_ACTIONS,
  REMINDER_REFUSALS,
  REMINDER_STATUSES,
  REMINDER_VIEWS,
  SWITCH_BLOCKERS,
  ageingSchema,
  reminderSchema,
  statementSchema,
} from './api'
import { AGEING, REMINDERS, ROWS, STATEMENT, withoutPrice } from './demo/fixtures'
import { designScreen as receivablesScreen } from './fixtures'
import {
  addressOf,
  ageingCsv,
  ageingQueryOf,
  ageSegments,
  bulkApprovePhrase,
  bulkRefusalsOf,
  latePhrase,
  liveTouches,
  readProblem,
  receivablesCanOf,
  receivablesHref,
  refusalOf,
  reminderSelectable,
  rowStatement,
  statementKey,
  statementOfAddress,
  statementPdfAddressOf,
  statementPdfHref,
  stepPhrase,
  tileAmount,
  tileFilter,
  TILE_IDS,
} from './model'
import { designScreen as statementPdfScreen } from './statement/fixtures'
import { EMAIL_STATUSES } from './view/ReminderDialog'

/**
 * Finance › Receivables & credit (SCR-151) and its statement PDF tab (B-W2a-81 on B-W2a-55's API): the lists equal
 * factory-domain's, the answers' shapes accept the made-up data (with and without the price grain), the pure rules (who
 * sees what, the address both ways, the tiles, the age bar adding up, the reminders a person may tick, the refusals by
 * code, the CSV by grain, the live events), the page and record links, and every design case drawn in Italian and
 * English with no key or placeholder left on screen — and no amount for a person without the price grain.
 */

describe('the lists mirror factory-domain', () => {
  it('buckets, filters, movements, actions, statuses, views, warnings, refusals, blockers, interest, limits', () => {
    expect(AGEING_BUCKETS).toEqual(DOMAIN_BUCKETS)
    expect(AGEING_FILTERS).toEqual(DOMAIN_FILTERS)
    expect(MOVEMENT_KINDS).toEqual(DOMAIN_KINDS)
    expect(REMINDER_ACTIONS).toEqual(DOMAIN_ACTIONS)
    expect(REMINDER_STATUSES).toEqual(DOMAIN_STATUSES)
    expect(REMINDER_VIEWS).toEqual(DOMAIN_VIEWS)
    expect(HELD_REASONS).toEqual(Object.keys(DOMAIN_HELD))
    expect(REMINDER_REFUSALS).toEqual(Object.keys(DOMAIN_REFUSALS))
    expect(SWITCH_BLOCKERS).toEqual(Object.keys(DOMAIN_BLOCKERS))
    expect(LATE_INTEREST_MODES).toEqual(DOMAIN_INTEREST)
    expect(MAX_BULK_REMINDERS).toBe(DOMAIN_MAX)
    expect(MAX_REMINDER_TEXT).toEqual(DOMAIN_TEXT)
  })
})

describe('the answers', () => {
  it('accept the made-up data with the price grain and without it (amounts absent, never zero)', () => {
    expect(ageingSchema.parse(AGEING).customers).toHaveLength(4)
    const bare = ageingSchema.parse(withoutPrice(AGEING))
    expect(bare.customers[0]!.open).toBeUndefined()
    expect(bare.tiles[0]!.buckets).toBeUndefined()
    expect(statementSchema.parse(withoutPrice(STATEMENT)).lines[0]!.balance).toBeUndefined()
    const reminder = reminderSchema.parse(withoutPrice(REMINDERS[0]))
    expect(reminder.text).toBeUndefined()
    expect(reminder.amountDue).toBeUndefined()
  })
})

describe('who sees what', () => {
  it('the page with receivables.view; amounts with the price grain; moves with their own permission', () => {
    expect(receivablesCanOf(['receivables.view', 'money.price'])).toMatchObject({
      view: true,
      price: true,
      approve: false,
      manage: false,
      sendStatements: false,
    })
    expect(receivablesCanOf(['receivables.view', 'receivables.reminders.approve']).approve).toBe(true)
    expect(receivablesCanOf([]).view).toBe(false)
  })

  it('a reminder is ticked only when it waits for approval and the reader may approve', () => {
    const prepared = REMINDERS[0]!
    expect(reminderSelectable(prepared, { approve: true })).toBeNull()
    expect(reminderSelectable(prepared, { approve: false })).toEqual({
      key: 'held.approve',
      params: { permission: 'receivables.reminders.approve' },
    })
    expect(reminderSelectable({ ...prepared, status: 'APPROVED' }, { approve: true })).toEqual({ key: 'held.notPrepared' })
    expect(bulkApprovePhrase(3, true)).toEqual({
      key: 'bulk.approveSend',
      params: { count: 3 },
    })
    expect(bulkApprovePhrase(3, false)).toEqual({
      key: 'bulk.approve',
      params: { count: 3 },
    })
  })
})

describe('the address', () => {
  it("reads and writes the API's own filters, the statement and the reminder", () => {
    const party = ROWS[0]!.customer.id
    const company = ROWS[0]!.company.id
    const address = addressOf(new URLSearchParams(`bucket=D61_90&q=gamma&asOf=2026-09-30&statement=${party}&company=${company}&currency=EUR&reminders=waiting`))
    expect(address).toMatchObject({
      bucket: 'D61_90',
      q: 'gamma',
      asOf: '2026-09-30',
      statement: party,
      company,
      currency: 'EUR',
      reminders: 'waiting',
      reminder: null,
    })
    expect(addressOf(new URLSearchParams('bucket=NOPE&asOf=2026-13-01&reminders=x&statement=nope'))).toMatchObject({
      bucket: null,
      asOf: null,
      reminders: 'toApprove',
      statement: null,
    })
    expect(receivablesHref('/w/DEMO', address)).toBe(`/w/DEMO/finance/receivables?bucket=D61_90&q=gamma&asOf=2026-09-30&statement=${party}&company=${company}&currency=EUR&reminders=waiting`)
    expect(receivablesHref('/w/DEMO', addressOf(null))).toBe('/w/DEMO/finance/receivables')
    expect(ageingQueryOf(address, 'c1')).toEqual({ companyId: 'c1', partyId: null, asOf: '2026-09-30', q: 'gamma', bucket: 'D61_90', limit: 100, cursor: null })
    expect(ageingQueryOf(addressOf(new URLSearchParams(`party=${party}`)), null).partyId).toBe(party)
    expect(receivablesHref('/w/DEMO', addressOf(new URLSearchParams(`party=${party}&bucket=OVERDUE`)))).toBe(`/w/DEMO/finance/receivables?bucket=OVERDUE&party=${party}`)
    expect(statementOfAddress(address, null)).toEqual({
      partyId: party,
      companyId: company,
      currency: 'EUR',
    })
    expect(statementOfAddress({ ...address, company: null }, null)).toBeNull()
  })

  it('the PDF tab names each statement and the period, at most 10', () => {
    const refs = ROWS.map(rowStatement)
    const href = statementPdfHref('/w/DEMO', refs, { to: '2026-09-30' })
    const back = statementPdfAddressOf(new URL(`http://x${href}`).searchParams)
    expect(back.refs).toEqual(refs)
    expect(back.to).toBe('2026-09-30')
    expect(back.from).toBeNull()
    const many = Array.from({ length: 12 }, (_, index) => ({
      ...refs[0]!,
      partyId: `0190f0e2-2121-7000-8000-${String(100 + index).padStart(12, '0')}`,
    }))
    expect(statementPdfAddressOf(new URL(`http://x${statementPdfHref('/w/DEMO', many)}`).searchParams).refs).toHaveLength(10)
    expect(new Set(ROWS.map((row) => statementKey(rowStatement(row)))).size).toBe(ROWS.length)
  })
})

describe('tiles, age bar, words', () => {
  it("each tile filters by the API's bucket; Open shows everyone; amounts by tile", () => {
    expect(TILE_IDS.map(tileFilter)).toEqual([null, 'OVERDUE', 'D1_30', 'D31_60', 'D61_90', 'OVER_90'])
    const tile = AGEING.tiles[0]!
    expect(tileAmount(tile, 'OPEN')).toBe(2318000)
    expect(tileAmount(tile, 'OVERDUE')).toBe(1525000)
    expect(tileAmount(tile, 'OVER_90')).toBe(183000)
    expect(tileAmount(withoutPrice(tile), 'OPEN')).toBeNull()
    expect(AGEING_BUCKETS.reduce((sum, bucket) => sum + tile.buckets![bucket], 0)).toBe(tile.open)
  })

  it('the age bar: only buckets with money, shares adding up to 100', () => {
    const segments = ageSegments(ROWS[0]!.buckets)
    expect(segments.map((segment) => segment.bucket)).toEqual(['NOT_DUE', 'D1_30', 'D61_90'])
    expect(Math.round(segments.reduce((sum, segment) => sum + segment.pct, 0) * 10) / 10).toBe(100)
    expect(segments[0]!.pct).toBe(20)
    expect(ageSegments(undefined)).toEqual([])
    expect(ageSegments({ NOT_DUE: 0, D1_30: 0, D31_60: 0, D61_90: 0, OVER_90: 0 })).toEqual([])
  })

  it('late and level in words', () => {
    expect(latePhrase(61, '2026-08-31')).toEqual({
      key: 'row.daysLate',
      params: { count: 61 },
    })
    expect(latePhrase(null, '2026-11-30')).toEqual({ key: 'row.notLate' })
    expect(latePhrase(null, null)).toEqual({ key: 'row.noDue' })
    expect(stepPhrase(REMINDERS[1]!)).toEqual({
      key: 'level.late',
      params: { count: 7 },
    })
    expect(
      stepPhrase({
        level: 1,
        step: { offsetDays: -3, words: { en: '', it: '' } },
      }),
    ).toEqual({ key: 'level.beforeDue', params: { count: 3 } })
    expect(stepPhrase({ level: 5, step: null })).toEqual({
      key: 'level.number',
      params: { level: 5 },
    })
  })
})

describe("the API in this page's words", () => {
  it("a refusal by its code; a bulk approval's refusals per row; else the kind", () => {
    const switchedOff = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'reminder/SWITCHED_OFF', message: 'x' }])
    expect(refusalOf(switchedOff)).toBe('SWITCHED_OFF')
    expect(readProblem(switchedOff)).toBe('refusal.SWITCHED_OFF')
    const bulk = new ApiError('invalid', 400, 'validation_failed', 'x', null, [
      { path: 'body/items/0/CHANGED', message: 'x' },
      { path: 'body/items/2/version', message: 'x' },
    ])
    expect(bulkRefusalsOf(bulk)).toEqual([
      { index: 0, code: 'CHANGED' },
      { index: 2, code: 'version' },
    ])
    expect(readProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/version', message: 'x' }]))).toBe('problem.conflict')
    expect(readProblem(new ApiError('unavailable', 0, 'network', 'x'))).toBe('problem.unavailable')
    expect(readProblem(new Error('x'))).toBe('problem.internal')
    expect(readProblem(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'company/vatNumber', message: 'x' }]))).toBe('problem.companyLegal')
  })

  it('the live events that change the page', () => {
    for (const type of ['payment_reminder.prepared', 'payment.allocated', 'invoice.issued', 'receivables_settings.changed', 'refund.paid']) expect(liveTouches({ type }), type).toBe(true)
    expect(liveTouches({ type: 'work_order.released' })).toBe(false)
  })

  it('the CSV: amounts only with the price grain; Italian decimals', () => {
    const header = (column: string) => column
    const priced = ageingCsv(ROWS.slice(0, 1), { price: true }, { header }, 'it').split('\n')
    expect(priced[0]).toContain('open;overdue;NOT_DUE')
    expect(priced[1]).toContain('12200,00;9760,00;2440,00')
    const bare = ageingCsv(withoutPrice(ROWS.slice(0, 1)), { price: false }, { header }, 'en').split('\n')
    expect(bare[0]).toBe('customerCode,customer,company,currency,invoices,oldestDueDate,daysLate,lastPaymentOn,remindersSent')
  })
})

describe('pages and links', () => {
  it('the pages are built and a supplier invoice / a reminder open where they belong', () => {
    for (const page of ['/finance/receivables', '/finance/receivables/statement']) expect(OFFICE_PAGES).toContain(page)
    expect(RECORD_PAGES.PaymentReminder).toBe('/finance/receivables?reminder=[id]')
    expect(LIST_PAGES['/receivables/ageing']).toBe('/finance/receivables')
  })
})

const LEFT_KEY =
  /\b(?:noAccess|band|live|tiles|tile|bucket|bar|list|filter|col|row|bulk|reminders|switch|level|action|language|status|heldReason|reminder|emailStatus|edit|skip|cancel|call|statement|kind|send|pdf|held|keys|notice|problem|refusal|csv|common)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
const SAID = /\b(?:receivables\.view|receivables\.reminders\.approve|receivables\.reminders\.manage|receivables\.statements\.send|money\.price)\b/g
const EURO = /€\s?\d|\d\s?€/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key or placeholder left on screen', () => {
  for (const screen of [receivablesScreen, statementPdfScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.length, item.id).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('read-only: no euro amount anywhere on the page; finance sees them', () => {
    const screen = receivablesScreen as unknown as DesignScreen<unknown>
    const bare = render(screen, screen.cases.find((entry) => entry.id === 'read-only')!.model, 'en')
    expect(bare.slice(bare.indexOf('fw-frv'))).not.toMatch(EURO)
    const full = render(screen, screen.cases.find((entry) => entry.id === 'finance')!.model, 'en')
    expect(full).toContain('€23,180.00')
  })

  it('the dynamic words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['finance-receivables'])['finance-receivables']!)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const tile of [...TILE_IDS, 'NOT_DUE']) has(`tile.${tile}`)
      for (const bucket of AGEING_BUCKETS) has(`bucket.${bucket}`)
      for (const kind of MOVEMENT_KINDS) has(`kind.${kind}`, { reference: 'X' })
      for (const action of REMINDER_ACTIONS) has(`action.${action}`)
      for (const status of REMINDER_STATUSES) has(`status.${status}`)
      for (const view of REMINDER_VIEWS) has(`reminders.empty.${view}`)
      for (const held of HELD_REASONS) has(`heldReason.${held}`)
      for (const refusal of REMINDER_REFUSALS) has(`refusal.${refusal}`)
      for (const blocker of SWITCH_BLOCKERS) has(`switch.blocker.${blocker}`)
      for (const status of [...EMAIL_STATUSES, 'OTHER']) has(`emailStatus.${status}`)
      for (const kind of ['companyLegal', 'conflict', 'signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'invalid', 'internal']) has(`problem.${kind}`)
      for (const column of ['customerCode', 'customer', 'company', 'currency', 'open', 'overdue', ...AGEING_BUCKETS, 'invoices', 'oldestDueDate', 'daysLate', 'lastPaymentOn', 'remindersSent'])
        has(`csv.${column}`)
      for (const key of [
        'row.daysLate',
        'level.late',
        'level.beforeDue',
        'bulk.approve',
        'bulk.approveSend',
        'bulk.print',
        'bulk.export',
        'notice.approvedSent',
        'notice.approvedWaiting',
        'notice.statementSent',
        'reminders.count',
        'list.count',
        'tiles.customers',
        'tiles.invoices',
      ])
        has(key, { count: 2 })
    }
  })
})
