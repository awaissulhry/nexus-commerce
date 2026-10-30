import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { COMPLAINT_ACTIONS, HELD_CODES } from '@nexus/factory-domain/quality/complaints/rules'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, RECORD_PAGES } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { complaintOf, ROWS, SAFETY_ALERT, SAFETY_ID, TODAY } from './demo/fixtures'
import { designScreen as listScreen } from './fixtures'
import {
  addressOf,
  addressText,
  alertGarment,
  answerDueWords,
  blankLogDraft,
  complaintsCan,
  complaintsCsv,
  dayInstant,
  heldKey,
  isFiltered,
  isStale,
  logBody,
  logProblems,
  nextInQueue,
  primaryAction,
  queryOf,
  raisesSafety,
  refusalKey,
  rowStep,
  stepOf,
  triageDraftOf,
  triageProblems,
  withPreview,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'

const params = (query: string) => new URLSearchParams(query)
const en = CATALOGUE.en.complaints ?? {}
const word = (key: string, params: Record<string, string | number> = {}) => {
  const text = en[key] ?? en[`${key}_other`]
  if (text === undefined) throw new Error(`no words for ${key}`)
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
}

describe('the list address is the API’s own filters', () => {
  it('reads the view, the terms and the ids a link carries; the default view is left out', () => {
    const address = addressOf(params('view=safety&q=jacket&category=SAFETY&owner=me&partyId=p1&open=c1'))
    expect(address).toMatchObject({ view: 'safety', q: 'jacket', category: 'SAFETY', mine: true, partyId: 'p1', open: 'c1', log: false })
    expect(addressOf(params('view=nonsense')).view).toBe('open')
    expect(addressText(addressOf(null))).toBe('')
    expect(addressText({ ...addressOf(null), view: 'new', log: true })).toBe('?view=new&new=1')
    expect(queryOf(address, 50)).toMatchObject({ view: 'safety', q: 'jacket', category: 'SAFETY', owner: 'me', partyId: 'p1', limit: 50, cursor: null })
    expect(isFiltered(addressOf(null))).toBe(false)
    expect(isFiltered(addressOf(params('shipmentId=s1')))).toBe(true)
  })
})

describe('words of the answer due and of the safety banner', () => {
  it('overdue, today, soon or later; nothing before triage; just the day once answered', () => {
    expect(answerDueWords({ status: 'TRIAGED', answerDueOn: '2026-10-27' }, '2026-10-29')).toEqual({ words: { key: 'due.overdue', params: { count: 2 } }, tone: 'danger' })
    expect(answerDueWords({ status: 'INVESTIGATING', answerDueOn: '2026-10-29' }, '2026-10-29')?.words.key).toBe('due.today')
    expect(answerDueWords({ status: 'TRIAGED', answerDueOn: '2026-11-01' }, '2026-10-29')).toEqual({ words: { key: 'due.inDays', params: { count: 3 } }, tone: 'warning' })
    expect(answerDueWords({ status: 'TRIAGED', answerDueOn: '2026-11-09' }, '2026-10-29')?.tone).toBe('neutral')
    expect(answerDueWords({ status: 'ANSWERED', answerDueOn: '2026-10-27' }, '2026-10-29')?.words.key).toBe('due.set')
    expect(answerDueWords({ status: 'NEW', answerDueOn: null }, '2026-10-29')).toBeNull()
  })

  it('the banner names the style and the batch or serial', () => {
    expect(alertGarment(SAFETY_ALERT)).toEqual({ key: 'banner.batchStyle', params: { style: 'JK-DEMO-100', batch: 'B-DEMO-0142' } })
    expect(alertGarment({ style: null, batchNumber: null, serial: 'S1' })).toEqual({ key: 'banner.serial', params: { serial: 'S1' } })
    expect(alertGarment({ style: null, batchNumber: null, serial: null })).toEqual({ key: 'banner.noGarment' })
  })
})

describe('each step held with its reason in our words', () => {
  const safety = complaintOf(ROWS.find((row) => row.id === SAFETY_ID)!)
  it('a missing permission names the step; a held code its own words; offline holds every allowed step', () => {
    expect(heldKey('acknowledge', 'NO_PERMISSION')).toBe('held.NO_PERMISSION.acknowledge')
    expect(heldKey('close', 'SAFETY_NOT_ACKNOWLEDGED')).toBe('held.SAFETY_NOT_ACKNOWLEDGED')
    expect(stepOf(safety, 'close')).toEqual({ allowed: false, held: 'held.SAFETY_NOT_ACKNOWLEDGED' })
    expect(stepOf(safety, 'acknowledge')).toEqual({ allowed: true, held: null })
    expect(stepOf(safety, 'acknowledge', true)).toEqual({ allowed: false, held: 'held.offline' })
  })

  it('every held code and every missing permission has words in both languages', () => {
    for (const code of HELD_CODES) if (code !== 'NO_PERMISSION') expect(en[`held.${code}`], code).toBeTruthy()
    for (const action of [...COMPLAINT_ACTIONS, 'log']) {
      expect(en[`held.NO_PERMISSION.${action}`], action).toBeTruthy()
      expect(CATALOGUE.it.complaints?.[`held.NO_PERMISSION.${action}`], action).toBeTruthy()
    }
  })

  it('the band’s primary step follows the status', () => {
    expect(['NEW', 'TRIAGED', 'INVESTIGATING', 'ANSWERED', 'CLOSED'].map((status) => primaryAction(status as never))).toEqual(['triage', 'startInvestigation', 'markAnswered', 'close', null])
  })

  it('a row’s verbs: triage needs manage, the register a style and no entry yet', () => {
    const owner = complaintsCan(['quality.complaints.manage', 'compliance.register.manage', 'quality.ncr.raise'])
    const sales = complaintsCan(['quality.complaints.view', 'quality.complaints.log'])
    const row = ROWS.find((entry) => entry.status === 'NEW')!
    expect(rowStep(row, 'triage', owner).allowed).toBe(true)
    expect(rowStep(row, 'triage', sales).held).toBe('held.NO_PERMISSION.triage')
    expect(rowStep(ROWS.find((entry) => entry.id === SAFETY_ID)!, 'register', owner).held).toBe('held.IN_REGISTER')
    expect(rowStep({ ...row, style: null }, 'register', owner).held).toBe('held.NO_STYLE')
  })
})

describe('the triage', () => {
  const fresh = complaintOf(ROWS.find((row) => row.status === 'NEW')!)
  it('opens with the suggested answer day and me as the owner when I may be one', () => {
    expect(triageDraftOf(fresh, 'me', [{ id: 'me' }])).toMatchObject({ category: null, ownerId: 'me', answerDueOn: fresh.suggestedAnswerDueOn })
    expect(triageDraftOf(fresh, 'me', [{ id: 'other' }]).ownerId).toBe('')
  })

  it('says what is missing; a safety complaint needs a style; the answer is not due before it came in', () => {
    const draft = { ...triageDraftOf(fresh, 'me', null), category: 'SAFETY' as const, severity: null, answerDueOn: '2026-01-01', styleId: '' }
    expect(triageProblems(draft, { ...fresh, style: null }).map((problem) => problem.field)).toEqual(['severity', 'answerDueOn', 'styleId'])
    expect(triageProblems({ ...draft, severity: 'MAJOR', answerDueOn: '2026-11-10', styleId: 's1' }, { ...fresh, style: null })).toEqual([])
  })

  it('only the first Safety triage asks first; the queue walks on, else back, else ends', () => {
    expect(raisesSafety({ ...triageDraftOf(fresh, 'me', null), category: 'SAFETY' }, fresh)).toBe(true)
    expect(raisesSafety({ ...triageDraftOf(fresh, 'me', null), category: 'SAFETY' }, { ...fresh, safety: { ...fresh.safety, state: 'RAISED' } })).toBe(false)
    expect(nextInQueue(['a', 'b', 'c'], 'b')).toBe('c')
    expect(nextInQueue(['a', 'b'], 'b')).toBe('a')
    expect(nextInQueue(['a'], 'a')).toBeNull()
  })
})

describe('Log complaint', () => {
  it('needs the customer and the words; the day is today or earlier; the body leaves empty fields null', () => {
    const blank = blankLogDraft('2026-10-29')
    expect(logProblems(blank, '2026-10-29').map((problem) => problem.field)).toEqual(['partyId', 'description'])
    expect(logProblems({ ...blank, partyId: 'p', description: 'x', receivedOn: '2026-10-30' }, '2026-10-29').map((problem) => problem.field)).toEqual(['receivedOn'])
    const body = logBody({ ...blank, partyId: 'p', description: '  Zip broke  ', serial: ' S1 ' }, 'c', '2026-10-29', new Date('2026-10-29T08:00:00Z'))
    expect(body).toMatchObject({ companyId: 'c', partyId: 'p', description: 'Zip broke', serial: 'S1', styleId: null, receivedAt: '2026-10-29T08:00:00.000Z' })
    expect(dayInstant('2026-10-20', '2026-10-29')).toBe('2026-10-20T10:00:00.000Z')
  })

  it('the preview fills only what is empty', () => {
    const draft = { ...blankLogDraft('2026-10-29'), styleId: 'mine' }
    const filled = withPreview(draft, { ok: true, problems: [], warnings: [], draft: { companyId: null, partyId: 'p', styleId: 'theirs', size: '50', batchNumber: 'B1', shipmentId: 's', salesOrderId: 'o' }, garment: null, others: [] })
    expect(filled).toMatchObject({ partyId: 'p', styleId: 'mine', size: '50', batchNumber: 'B1', shipmentId: 's', salesOrderId: 'o' })
  })
})

describe('the API’s refusals in our words', () => {
  it('a held code, a stale version, a field, or the kind', () => {
    expect(refusalKey(new ApiError('conflict', 409, 'invalid_state', 'x', null, [{ path: 'held/SAFETY_NOT_ACKNOWLEDGED', message: 'x' }]))).toBe('held.SAFETY_NOT_ACKNOWLEDGED')
    const stale = new ApiError('conflict', 409, 'conflict', 'x')
    expect([refusalKey(stale), isStale(stale)]).toEqual(['refusal.conflict', true])
    expect(refusalKey(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/styleId', message: 'x' }]))).toBe('refusal.field.styleId')
    expect(refusalKey(new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path: 'body/whatever', message: 'x' }]))).toBe('refusal.invalid')
    expect(refusalKey(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('quality:problem.forbidden')
    expect(refusalKey(new Error('x'))).toBe('quality:problem.unavailable')
  })
})

describe('the CSV of a view', () => {
  it('names the columns in the person’s language and the order’s value only with the price grain', () => {
    const t = (key: string) => (key.startsWith('csv.') || key.startsWith('channel.') || key.startsWith('status.') || key.startsWith('category.') || key.startsWith('severity.') ? word(key) : key)
    const without = complaintsCsv(ROWS.slice(0, 1), [], t, false).split('\r\n')
    expect(without[0]).toContain('Complaint,Received,Channel')
    expect(without[0]).not.toContain('Order value')
    const withPrice = complaintsCsv(ROWS.slice(0, 1), [], t, true).split('\r\n')
    expect(withPrice[0]).toContain('Order value')
    expect(withPrice[1]).toContain('1834.00')
  })
})

describe('the navigation knows the page', () => {
  it('the list and the record are built, a complaint opens its record, the API list its page', () => {
    expect(OFFICE_PAGES.has('/quality/complaints')).toBe(true)
    expect(OFFICE_PAGES.has('/quality/complaints/[id]')).toBe(true)
    expect(RECORD_PAGES.Complaint).toBe('/quality/complaints/[id]')
    expect(LIST_PAGES['/quality/complaints']).toBe('/quality/complaints')
  })
})

// ---- every design case, both languages, no key on screen -------------------------------------------------------------------

const PREFIXES = [...new Set(Object.keys(en).map((key) => key.split('.')[0]!))].filter((prefix) => prefix.length > 2)
const LEFT_KEY = new RegExp(`\\b(?:${PREFIXES.join('|')})\\.[a-zA-Z][a-zA-Z0-9_]*(?:\\.[a-zA-Z0-9_]+)*`)

describe('every design case draws in both languages with no key left on screen', () => {
  const render = (screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]) => {
    const View = screen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  }
  for (const screen of [listScreen, recordScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale).replace(/(?:href|src|id|class|aria-[a-z]+|data-[a-z-]+|name|for|value)="[^"]*"/g, '')
          expect(html.length, item.id).toBeGreaterThan(300)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html, `${screen.screen}/${item.id} (${locale})`).not.toMatch(/\{[a-z]+\}/i)
        }
      })
    }
  }

  it('the price grain: a role without it sees no amount', () => {
    const sales = listScreen.cases.find((item) => item.id === 'read-only')!
    expect(render(listScreen as DesignScreen<unknown>, sales.model, 'en')).not.toMatch(/€\s?\d|\d\s?€/)
  })

  it('today’s design day is the fixtures’ own', () => {
    expect(TODAY).toBe('2026-10-29')
  })
})
