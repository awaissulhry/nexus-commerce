import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { IN_PROCESS_KINDS } from '@nexus/factory-domain/quality/inprocess/rules'
import { AMENDED_RECORDS } from '@nexus/factory-domain/quality/amendments/rules'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import en from '../../../../../messages/en/inspections-depth.json'
import { designScreen as incomingScreen } from '../incoming/fixtures'
import { designScreen as inlineScreen } from '../inline/fixtures'
import { designScreen as reportsScreen } from '../report/bulk/fixtures'
import { designScreen as reportScreen } from '../report/fixtures'
import { AMENDED_KINDS, INLINE_KINDS, type AmendField } from './api'
import { AMENDMENTS, DEPTH_ROWS, INCOMING_ROWS, INLINE_ROWS, PLANS, PLANS_NONE, SHEET } from './demo/fixtures'
import {
  afterOf,
  amendHeld,
  amendProblems,
  answerHeld,
  chartPages,
  decimalOf,
  depthCan,
  idsFromAddress,
  inputOf,
  kindChipHeld,
  kindFromAddress,
  kindsRead,
  measurementBody,
  measurementDefect,
  planPick,
  planProblems,
  printHeld,
  reportAddress,
  reportHeld,
  rowKey,
  sampleOf,
  signHoldsOf,
  unionRows,
  type ListRow,
} from './model'

const ALL = { inspectionsView: true, incomingView: true, inprocessView: true }
const params = (query: string) => new URLSearchParams(query)

describe('the web keeps the domain lists it cannot import (their rule files reach node:crypto)', () => {
  it('in-line kinds and amended records are the domain’s', () => {
    expect([...INLINE_KINDS]).toEqual([...IN_PROCESS_KINDS])
    expect([...AMENDED_KINDS]).toEqual([...AMENDED_RECORDS])
  })
})

describe('one list: final, incoming and in-line rows (design qi-grid; plan §12 "Inspection kinds")', () => {
  it('reads every kind the person sees in Every inspection and Open, final only elsewhere', () => {
    expect(kindsRead('all', 'all', ALL)).toEqual(['INCOMING', 'INLINE', 'FINAL'])
    expect(kindsRead('open', 'INLINE', ALL)).toEqual(['INLINE'])
    expect(kindsRead('waiting', 'all', ALL)).toEqual(['FINAL'])
    expect(kindsRead('waiting', 'INCOMING', ALL)).toEqual([])
    expect(kindsRead('all', 'all', { inspectionsView: true, incomingView: false, inprocessView: true })).toEqual(['INLINE', 'FINAL'])
    expect(kindChipHeld('INCOMING', 'waiting', ALL)).toBe('kind.held.view')
    expect(kindChipHeld('INLINE', 'all', { ...ALL, inprocessView: false })).toBe('kind.held.inline')
    expect(kindChipHeld('FINAL', 'waiting', ALL)).toBeNull()
  })

  it('the kind is the list’s own address term', () => {
    expect(kindFromAddress(params('kind=incoming'))).toBe('INCOMING')
    expect(kindFromAddress(params('kind=inline'))).toBe('INLINE')
    expect(kindFromAddress(params('kind=other'))).toBe('all')
  })

  it('merges newest first, keys by kind and id, and stops at the page', () => {
    const rows = unionRows({ final: DEPTH_ROWS, incoming: INCOMING_ROWS, inline: INLINE_ROWS }, 50)
    expect(rows.length).toBe(DEPTH_ROWS.length + INCOMING_ROWS.length + INLINE_ROWS.length)
    for (let at = 1; at < rows.length; at += 1) expect(rows[at - 1]!.createdAt >= rows[at]!.createdAt).toBe(true)
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
    expect(unionRows({ final: DEPTH_ROWS, incoming: INCOMING_ROWS, inline: INLINE_ROWS }, 4)).toHaveLength(4)
    expect(rows.find((row) => row.kind === 'INCOMING')!.key).toBe(rowKey('INCOMING', rows.find((row) => row.kind === 'INCOMING')!.id))
  })

  it('"Sample n of N": counted on a plan, the sample alone for W1, done of sample for incoming', () => {
    const [planned, w1] = [DEPTH_ROWS[0]!, DEPTH_ROWS[1]!]
    expect(sampleOf({ key: '', kind: 'FINAL', id: planned.id, createdAt: planned.createdAt, row: planned })).toEqual({ key: 'sample.nOf', params: { done: 3, sample: planned.sampleSize } })
    expect(sampleOf({ key: '', kind: 'FINAL', id: w1.id, createdAt: w1.createdAt, row: w1 }).key).toBe('sample.only')
    expect(sampleOf({ key: '', kind: 'INCOMING', id: INCOMING_ROWS[0]!.id, createdAt: '', row: INCOMING_ROWS[0]! })).toEqual({ key: 'sample.nOf', params: { done: 2, sample: 5 } })
  })
})

describe('the report: one, many, shared (B-W2b-123)', () => {
  const entries = unionRows({ final: DEPTH_ROWS, incoming: INCOMING_ROWS }, 50)
  const final = (status: string): ListRow => entries.find((entry) => entry.kind === 'FINAL' && entry.row.status === status)!
  it('a report is of a signed final inspection; Print N holds every other row with its reason', () => {
    expect(reportHeld(final('PASSED'))).toBeNull()
    expect(reportHeld(final('FAILED'))).toBeNull()
    expect(reportHeld(final('OPEN'))).toBe('report.held.notSigned')
    expect(reportHeld(entries.find((entry) => entry.kind === 'INCOMING')!)).toBe('report.held.kind')
    expect(printHeld([])).toBe('report.held.none')
    expect(printHeld([final('PASSED'), final('FAILED')])).toBeNull()
    expect(printHeld([final('PASSED'), final('OPEN')])).toBe('report.held.notSignedSome')
    expect(printHeld([final('PASSED'), entries.find((entry) => entry.kind === 'INCOMING')!])).toBe('report.held.kindSome')
    expect(printHeld(Array.from({ length: 21 }, () => final('PASSED')))).toBe('report.held.tooMany')
  })
  it('the report windows are static addresses (window pages); the bulk address keeps at most 20 ids, each once', () => {
    expect(reportAddress('/w/DEMO', 'a b')).toBe('/w/DEMO/quality/inspections/report?id=a%20b')
    expect(reportAddress('/w/DEMO', 'x', { share: true })).toBe('/w/DEMO/quality/inspections/report?id=x&share=1')
    const id = '0190f0e2-7701-7000-8000-000000000010'
    expect(idsFromAddress(params(`ids=${id},${id},nope`))).toEqual([id])
  })
})

describe('the plan on the record: holds, measurements, the chart (B-W2b-97)', () => {
  it('says what holds a pass from the sheet’s facts (its own reasons are English)', () => {
    expect(signHoldsOf(SHEET, 'en').map((hold) => hold.key)).toEqual(['hold.mandatory', 'hold.identityFails', 'hold.photos', 'hold.sample'])
    expect(signHoldsOf(SHEET, 'it')[0]!.params).toMatchObject({ checks: 'Mezzo torace', count: 1 })
  })
  it('a typed value with a comma is a decimal; a plan check is written by its code, a typed point by its point code', () => {
    expect(decimalOf('58,4')).toBe('58.4')
    expect(decimalOf('abc')).toBeNull()
    expect(measurementBody(SHEET.chart.points[0]!, 2, '59.8')).toEqual({ checkCode: 'CHEST', size: '52', sampleIndex: 2, measured: '59.8' })
    expect(measurementBody(SHEET.chart.points[1]!, 1, null)).toEqual({ pointCode: 'BACK', size: '52', sampleIndex: 1, measured: null })
    expect(chartPages(23)).toEqual([{ from: 1, to: 10 }, { from: 11, to: 20 }, { from: 21, to: 23 }])
  })
  it('"Create defect" adds a MAJOR measurement line, one more on it the second time', () => {
    const once = measurementDefect([], SHEET.chart.points[0]!, 'Chest ½, unit 2: 59.8 cm (over by 0.8 cm)')
    expect(once).toEqual([{ defectClass: 'MAJOR', code: 'MEAS-CHEST', quantity: 1, workOrderSizeId: null, note: 'Chest ½, unit 2: 59.8 cm (over by 0.8 cm)', defectCodeId: null, zone: null }])
    expect(measurementDefect(once, SHEET.chart.points[0]!, 'again')[0]!.quantity).toBe(2)
  })
})

describe('amendments (pop:ins-amend, B-W2b-123)', () => {
  const field = (name: string): AmendField => AMENDMENTS.fields.find((entry) => entry.field === name)!
  it('the input follows the field’s kind; a decimal goes with a dot; an empty nullable field clears', () => {
    expect(inputOf(field('note'))).toBe('textarea')
    expect(inputOf(field('zone'))).toBe('zone')
    expect(inputOf(field('causeCodeId'))).toBe('cause')
    expect(inputOf(field('measured'))).toBe('decimal')
    expect(afterOf(field('measured'), '58,6')).toBe('58.6')
    expect(afterOf(field('note'), '  ')).toBeNull()
  })
  it('says every problem at once: no field, the same value, not a number, the reason', () => {
    expect(amendProblems({ field: '', value: '', reason: '' }, null)).toEqual(['amend.problem.field'])
    expect(amendProblems({ field: 'x', value: '58.400', reason: 'ok' }, field('measured'))).toEqual(['amend.problem.same', 'amend.problem.reason'])
    expect(amendProblems({ field: 'x', value: 'abc', reason: 'Read wrong.' }, field('measured'))).toEqual(['amend.problem.decimal'])
    expect(amendProblems({ field: 'x', value: '', reason: 'Read wrong.' }, field('measured'))).toEqual(['amend.problem.empty'])
    expect(amendProblems({ field: 'x', value: '58.6', reason: 'Read wrong.' }, field('measured'))).toEqual([])
  })
  it('holds Amend and the countersign with their reasons (who asked never answers)', () => {
    expect(amendHeld(AMENDMENTS, { amendRequest: false })).toBe('amend.held.noRight')
    expect(amendHeld({ ...AMENDMENTS, record: { ...AMENDMENTS.record, signed: false } }, { amendRequest: true })).toBe('amend.held.notSigned')
    expect(amendHeld(AMENDMENTS, { amendRequest: true })).toBeNull()
    expect(amendHeld({ ...AMENDMENTS, fields: AMENDMENTS.fields.map((entry) => ({ ...entry, waiting: 'w' })) }, { amendRequest: true })).toBe('amend.held.allWaiting')
    const waiting = AMENDMENTS.corrections[1]!
    expect(answerHeld({ ...waiting, mine: true }, { sign: true })).toBe('amend.held.mine')
    expect(answerHeld(waiting, { sign: false })).toBe('amend.held.noSign')
    expect(answerHeld(waiting, { sign: true })).toBeNull()
    expect(answerHeld(AMENDMENTS.corrections[0]!, { sign: true })).toBe('amend.held.answered')
  })
})

describe('New inspection: In-line and the plan of a final one', () => {
  it('the suggested plan by default; another one needs the reason; none applies: type by hand', () => {
    expect(planPick(PLANS, null)).toEqual({ id: PLANS.suggestedId, other: false })
    expect(planPick(PLANS, PLANS.plans[1]!.id)).toEqual({ id: PLANS.plans[1]!.id, other: true })
    expect(planProblems(PLANS, PLANS.plans[1]!.id, '')).toEqual(['new.plan.problem.reason'])
    expect(planProblems(PLANS, PLANS.plans[1]!.id, 'The customer asked for photos.')).toEqual([])
    expect(planProblems(PLANS_NONE, null, '')).toEqual(['new.plan.problem.none'])
  })
  it('the W2b rights come from the person’s permissions', () => {
    expect(depthCan(['quality.inprocess.record', 'quality.amendments.sign'])).toMatchObject({ inprocessRecord: true, amendSign: true, amendRequest: false })
  })
})

// ---- every new screen's design case, both languages, no key or placeholder left on screen --------------------------------------

const NAMESPACES = Object.keys(en).filter((name) => /^[a-zA-Z]+$/.test(name) && name !== 'text' && name !== 'none')
const LEFT_KEY = new RegExp(`\\b(?:${NAMESPACES.join('|')})\\.[a-zA-Z_]+(?:\\.[a-zA-Z_]+)*\\b`)
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs quality.inspections.view"). */
const SAID = /\b(?:quality|shipping|workorders)\.[a-zA-Z.]+/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'ds-words']) }, createElement(View, { model })))
    .replace(/(?:href|src|id|class|aria-[a-z]+|data-[a-z-]+|name|for)="[^"]*"/g, '')
    .replace(SAID, '')
}

describe('SCR-076-report, -reports, -incoming, -inline: every design case in both languages, no key left', () => {
  for (const screen of [reportScreen, reportsScreen, incomingScreen, inlineScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(300)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
          expect(html, `${screen.screen}/${item.id} money`).not.toMatch(/€|EUR\b/)
        }
      }
    })
  }

  it('the Italian page speaks Italian', () => {
    const incoming = render(incomingScreen as unknown as DesignScreen<unknown>, incomingScreen.cases[1]!.model, 'it')
    expect(incoming).toContain('Passo successivo')
    expect(incoming).toContain('Rettifiche')
    const report = render(reportScreen as unknown as DesignScreen<unknown>, reportScreen.cases[0]!.model, 'it')
    expect(report).toContain('Condividi link al rapporto')
  })
})
