import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MYDAY_CLOSE_AFTER_MS } from '@nexus/factory-domain/people/myday/rules'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LOCALES } from '../../../lib/i18n/locales'
import { FLOOR_NAMESPACES } from '../routes'
import { designScreen } from './fixtures'
import type { Mine } from './api'
import { canGoBack, canGoForward, CLOSE_IDLE_MS, CLOSE_WARN_MS, firstOfMonth, monthAfter, monthBefore, printHeld, ringShare, rowHeld, rowsOf, sendHeld, unreadAnswers } from './model'
import { MyDayScreen, type MyDayViewModel } from './view/MyDayScreen'

/**
 * My day (SCR-171; B-W2b-68): what may be on a screen other people can see (Owner answers F1, F2; Statuto dei Lavoratori art. 4;
 * GDPR art. 15; c.c. art. 2101), each rule held in the words it is made of.
 */

const draw = (model: MyDayViewModel, locale: (typeof LOCALES)[number] = 'en'): string => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, FLOOR_NAMESPACES) }, createElement(MyDayScreen, { model })))
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const caseOf = (id: string): MyDayViewModel => designScreen.cases.find((item) => item.id === id)!.model

const report = (scanId: string, at: string, workDate: string, more: Partial<Mine['records'][number]> = {}): Mine['records'][number] => ({ scanId, at, workDate, workOrder: { number: 'WO-1' }, bundle: { code: 'B-1' }, operation: { seq: 10, name: 'Op' }, counts: { good: 1, scrap: 0, rework: 0 }, state: 'STANDING', minutes: null, enteredByLead: false, disputable: true, dispute: null, ...more })
const mine = (records: Mine['records'], blocks: Mine['blocks'] = []): Mine => ({ subject: 'WORKER', from: '2026-10-01', to: '2026-10-29', minutesShown: false, records, blocks, disputes: [], edits: [], reasons: { OperationScan: [], OffStandardEntry: [] } })

describe('what leaves the screen, and when', () => {
  it('the figures go 60 seconds after the last touch, the last 10 saying so', () => {
    expect(MYDAY_CLOSE_AFTER_MS).toBe(60_000)
    expect(CLOSE_IDLE_MS + CLOSE_WARN_MS).toBe(60_000)
  })

  it('the PIN screen draws no figure of anyone (nothing was read yet)', () => {
    const html = text(draw(caseOf('pin')))
    expect(html).toContain('Only you')
    expect(html).not.toMatch(/\d+ pieces|€|Efficiency/)
  })

  it('holds offline with the reason: own figures are not stored on the tablet, in both languages', () => {
    expect(text(draw(caseOf('offline'), 'en'))).toContain('not stored on this tablet')
    expect(text(draw(caseOf('offline'), 'it'))).toContain('non sono salvati su questo tablet')
  })

  it('keeps no figure anywhere: the screen\'s code has no memory, cache or storage for them (only the ids of answers read)', () => {
    const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
    for (const file of ['./MyDay.tsx', './api.ts', './view/MyDayScreen.tsx', './badge.ts']) {
      const code = read(file)
      expect(code, file).not.toMatch(/AsOfMemory|localStorage|sessionStorage|indexedDB|queue\.enqueue/)
    }
    expect(read('./model.ts').match(/localStorage\.setItem\([^,]*/g)).toEqual(['localStorage.setItem(SEEN_KEY'])
  })
})

describe('Today: only one\'s own, each figure only where it may show', () => {
  it('with the PERFORMANCE gate off: pieces, the reason in words, no minutes, no efficiency, no pace', () => {
    const html = text(draw(caseOf('gate-off')))
    expect(html).toContain('Pieces')
    expect(html).toContain('legal basis')
    expect(html).not.toMatch(/Standard minutes|Efficiency|Your pace/)
  })

  it('with piece pay off: no money at all, in any language', () => {
    for (const locale of LOCALES) expect(text(draw(caseOf('gate-on-no-pay'), locale))).not.toMatch(/€|Earned today|Guadagnato/)
  })

  it('with both on: minutes, efficiency, money, the ring in numbers and words', () => {
    const html = text(draw(caseOf('today')))
    expect(html).toMatch(/Standard minutes earned/)
    expect(html).toContain('€')
    expect(html).toContain('96%')
    expect(html).toContain('96 of 100 pieces so far')
    expect(html).toContain('On the line')
  })

  it('compares with nobody: the case that names the line shows its target, never its output, an average, a rank or a person', () => {
    for (const item of designScreen.cases) {
      for (const locale of LOCALES) {
        const html = text(draw(item.model, locale))
        expect(html, item.id).not.toMatch(/\baverage\b|\bmedia\b|\brank|\bposizione\b|colleagu|colleghi|the best|il migliore/i)
      }
    }
    expect(text(draw(caseOf('today')))).toContain('Nobody is compared with you')
  })

  it('the ring never overflows and says nothing without a target', () => {
    expect(ringShare(130)).toBe(100)
    expect(ringShare(null)).toBe(0)
    expect(ringShare(-5)).toBe(0)
    expect(ringShare(64)).toBe(64)
  })

  it('this site records stations: no personal list, the design\'s words', () => {
    expect(text(draw(caseOf('station')))).toContain('This site records stations, not people')
  })
})

describe('records and disputes', () => {
  const rows = mine(
    [report('a', '2026-10-29T08:00:00.000Z', '2026-10-29'), report('b', '2026-10-20T08:00:00.000Z', '2026-10-20'), report('c', '2026-10-29T09:00:00.000Z', '2026-10-29', { state: 'UNDONE', disputable: false }), report('d', '2026-10-29T07:00:00.000Z', '2026-10-29', { dispute: { id: 'x', status: 'OPEN' } })],
    [{ id: 'k', code: { code: 'C', labelIt: 'I', labelEn: 'E', labelI18n: {} }, workDate: '2026-10-29', startedAt: '2026-10-29T08:30:00.000Z', minutes: 5, status: 'OPEN', disputable: false, dispute: null }],
  )

  it('lists today or the period, newest first, reports and blocks together', () => {
    expect(rowsOf(rows, 'today', '2026-10-29').map((row) => row.key)).toEqual(['r:c', 'b:k', 'r:a', 'r:d'])
    expect(rowsOf(rows, 'period', '2026-10-29').map((row) => row.key)).toContain('r:b')
  })

  it('a row is held with its reason: undone, still running, already disputed', () => {
    const of = (key: string) => rowHeld(rowsOf(rows, 'today', '2026-10-29').find((row) => row.key === key)!)
    expect([of('r:a'), of('r:c'), of('b:k'), of('r:d')]).toEqual([null, 'undone', 'running', 'open'])
  })

  it('Send waits for a reason, and for words with Other', () => {
    expect(sendHeld({ reason: null, words: '' })).toBe('reason')
    expect(sendHeld({ reason: 'OTHER', words: '  ' })).toBe('words')
    expect(sendHeld({ reason: 'OTHER', words: 'Not my bundle' })).toBeNull()
    expect(sendHeld({ reason: 'NOT_ME', words: '' })).toBeNull()
  })

  it('the badge counts answers not opened on this tablet', () => {
    expect(unreadAnswers(['a', 'b'], ['a'])).toBe(1)
    expect(unreadAnswers([], ['a'])).toBe(0)
  })
})

describe('the statement', () => {
  it('prints only what is approved, on a known printer', () => {
    const day = caseOf('statement').data!.statement
    const statement = day.pay!.statement
    expect(printHeld(day, statement)).toBeNull()
    expect(printHeld(day, { ...statement!, status: 'DRAFT' })).toBe('draft')
    expect(printHeld(day, null)).toBe('draft')
    expect(printHeld({ ...day, printer: false }, statement)).toBe('noPrinter')
  })

  it('a kiosk tablet prints and a phone opens the PDF, never the other way round', () => {
    expect(text(draw(caseOf('statement')))).toContain('Print at the office')
    expect(text(draw(caseOf('statement')))).not.toContain('Open as PDF')
    expect(text(draw(caseOf('statement-phone')))).toContain('Open as PDF')
    expect(text(draw(caseOf('statement-phone')))).not.toContain('Print at the office')
  })

  it('steps a year back, never into the future', () => {
    expect(canGoForward('2026-10', '2026-10-29')).toBe(false)
    expect(canGoForward('2026-09', '2026-10-29')).toBe(true)
    expect(canGoBack('2025-10', '2026-10-29')).toBe(false)
    expect(canGoBack('2025-11', '2026-10-29')).toBe(true)
    expect(monthBefore('2026-01')).toBe('2025-12')
    expect(monthAfter('2026-12')).toBe('2027-01')
    expect(firstOfMonth('2026-10-29')).toBe('2026-10-01')
  })
})
