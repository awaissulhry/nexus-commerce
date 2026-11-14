import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CLOSE_REASONS as DOMAIN_REASONS, CLOSE_REFUSALS as DOMAIN_REFUSALS, UNDO_SECONDS } from '@nexus/factory-domain/costing/close/rules'
import { NOT_SPLIT_CODES as DOMAIN_NOT_SPLIT, VARIANCE_CATEGORIES as DOMAIN_CATEGORIES } from '@nexus/factory-domain/costing/variances/split'
import { createApiClient } from '../../../../lib/api/client'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { workOrder as workOrderOf } from '../../_shared/fixtures'
import { designScreen as varianceScreen } from '../labour/variance/fixtures'
import { earlierCloses, entriesOf, explainedOf, lineUnit, liveClose, orderedLines, varianceState, type VarianceModel } from '../labour/variance/model'
import { CLOSE_REASONS, CLOSE_REFUSALS, closeWorkOrder, getCloseCheck, NOT_SPLIT_CODES, reopenWorkOrder, undoClose, VARIANCE_CATEGORIES } from './api'
import { BEYOND_CHECK, closeCheck, closeRecord, designScreen as closeScreen, SPLIT, withoutCost } from './fixtures'
import { FiguresTable } from './view/CloseParts'
import { checksClose, closeCanOf, closeHeld, closeInput, closeTouches, CLOSE_NS, reasonKey, reopenHeld, reopenOpenHeld, undoShownUntil, UNDO_ON_SCREEN_MS, writeProblem } from './model'

/**
 * B-W2b-424 — Close work order (SCR-460) and the variance at close (SCR-461) on B-W2b-411's API: the lists equal
 * factory-domain's, why Close is held (never a dead button), the body the API takes (a reason only beyond the tolerance),
 * the Undo's few seconds within the API's limit, the reopen's reason, refusals in words, the calls as the API takes them,
 * the variance card's rules, and every design case drawn in Italian and English with no key or placeholder left — and no
 * amount for a person without the cost grain.
 */

describe('the lists mirror factory-domain', () => {
  it('close reasons, refusals, variance categories, not-split codes; the Undo shows within the API limit', () => {
    expect(CLOSE_REASONS).toEqual(DOMAIN_REASONS)
    expect(CLOSE_REFUSALS).toEqual(DOMAIN_REFUSALS)
    expect(VARIANCE_CATEGORIES).toEqual(DOMAIN_CATEGORIES)
    expect(NOT_SPLIT_CODES).toEqual(DOMAIN_NOT_SPLIT)
    expect(UNDO_ON_SCREEN_MS).toBeLessThan(UNDO_SECONDS * 1000)
  })
})

describe('who may do what, and why Close is held', () => {
  it('close, reopen and the cost from the permissions', () => {
    expect(closeCanOf(['workorders.manage', 'workorders.reopen', 'costing.view', 'money.cost'])).toEqual({ manage: true, reopen: true, costView: true, cost: true })
    expect(closeCanOf(['workorders.view'])).toEqual({ manage: false, reopen: false, costView: false, cost: false })
    expect(checksClose('COMPLETED')).toBe(true)
    expect(checksClose('CLOSED')).toBe(true)
    expect(checksClose('IN_PROGRESS')).toBe(false)
  })

  it('held while reading, without the right, while costs wait, without a reason beyond the tolerance, OTHER without words', () => {
    const none = { reason: null, note: '' }
    expect(closeHeld(null, none, false)?.key).toBe('held.reading')
    expect(closeHeld(closeCheck({ workOrder: { ...closeCheck().workOrder, status: 'IN_PROGRESS' }, refusal: { code: 'NOT_COMPLETED' } }), none, false)?.key).toBe('held.notCompleted')
    expect(closeHeld(closeCheck({ closable: false }), none, false)).toEqual({ key: 'held.noManage', params: { permission: 'workorders.manage' } })
    const waiting = closeCheck({ waiting: [{ code: 'NO_RATE', sourceType: 'OperationScan', sourceId: 'x' }] })
    expect(closeHeld(waiting, none, false)).toEqual({ key: 'held.costsWaiting', params: { count: 1 } })
    // While the switch is off the close goes on and lists what waits.
    expect(closeHeld({ ...waiting, settles: false }, none, false)).toBeNull()
    expect(closeHeld(BEYOND_CHECK, none, false)?.key).toBe('held.reasonNeeded')
    expect(closeHeld(BEYOND_CHECK, { reason: 'OTHER', note: '  ' }, false)?.key).toBe('held.noteNeeded')
    expect(closeHeld(BEYOND_CHECK, { reason: 'OTHER', note: 'Seams redone by hand' }, false)).toBeNull()
    expect(closeHeld(BEYOND_CHECK, { reason: 'LEATHER_YIELD', note: '' }, false)).toBeNull()
    expect(closeHeld(BEYOND_CHECK, { reason: 'LEATHER_YIELD', note: 'x'.repeat(1001) }, false)?.key).toBe('held.noteLong')
    expect(closeHeld(closeCheck(), none, true)?.key).toBe('held.busy')
    expect(closeHeld(closeCheck(), none, false)).toBeNull()
  })

  it('the body: a reason code only when the check asks for one, the note when typed', () => {
    expect(closeInput(closeCheck(), 7, { reason: 'OTHER', note: '  ' })).toEqual({ version: 7, reasonCode: null, reasonNote: null })
    expect(closeInput(BEYOND_CHECK, 7, { reason: 'LEATHER_YIELD', note: ' recut ' })).toEqual({ version: 7, reasonCode: 'LEATHER_YIELD', reasonNote: 'recut' })
  })

  it('Undo shows a few seconds after the close, never past the API limit, only for the closer', () => {
    const now = Date.parse('2026-10-29T09:00:00.000Z')
    expect(undoShownUntil(closeRecord({ can: { undo: true, reopen: true }, undoUntil: '2026-10-29T09:01:00.000Z' }), now)).toBe(now + UNDO_ON_SCREEN_MS)
    expect(undoShownUntil(closeRecord({ can: { undo: true, reopen: true }, undoUntil: '2026-10-29T09:00:05.000Z' }), now)).toBe(now + 5000)
    expect(undoShownUntil(closeRecord({ can: { undo: false, reopen: true }, undoUntil: '2026-10-29T09:01:00.000Z' }), now)).toBeNull()
    expect(undoShownUntil(closeRecord({ can: { undo: true, reopen: true }, undoUntil: '2026-10-29T08:59:00.000Z' }), now)).toBeNull()
  })

  it('Reopen: held without a close record, without workorders.reopen, until the reason is 3 to 1,000 characters', () => {
    const closed = (live: ReturnType<typeof closeRecord> | null) => closeCheck({ live })
    expect(reopenOpenHeld(closed(null), false)?.key).toBe('held.noRecord')
    expect(reopenOpenHeld(closed(closeRecord({ can: { undo: false, reopen: false } })), false)).toEqual({ key: 'held.noReopen', params: { permission: 'workorders.reopen' } })
    expect(reopenOpenHeld(closed(closeRecord()), false)).toBeNull()
    expect(reopenHeld(closed(closeRecord()), 'no', false)?.key).toBe('reopen.reasonShort')
    expect(reopenHeld(closed(closeRecord()), 'x'.repeat(1001), false)?.key).toBe('reopen.reasonLong')
    expect(reopenHeld(closed(closeRecord()), 'Counted again', false)).toBeNull()
  })

  it('a refusal in words by its code; a moved version; a reason this screen does not know', () => {
    const refusal = (code: string) => new ApiError('conflict', 409, 'CONFLICT', 'x', 'r', [{ path: `refusal/${code}`, message: 'x' }])
    expect(writeProblem(refusal('UNDO_TOO_LATE'))).toEqual({ key: 'refusal.UNDO_TOO_LATE' })
    expect(writeProblem(refusal('SOMETHING_NEW'))).toEqual({ key: 'refusal.other' })
    expect(writeProblem(new ApiError('conflict', 409, 'CONFLICT', 'x', 'r'))).toEqual({ key: 'problem.changed' })
    expect(writeProblem(new Error('x'))).toEqual({ key: 'problem.internal' })
    expect(reasonKey('LEATHER_YIELD')).toBe('reason.LEATHER_YIELD')
    expect(reasonKey('A_NEW_ONE')).toBe('reason.unknown')
    expect(closeTouches({ type: 'work_order_close.changed', fields: { workOrderId: 'w1' } }, 'w1')).toBe(true)
    expect(closeTouches({ type: 'work_order_close.changed', fields: { workOrderId: 'w2' } }, 'w1')).toBe(false)
  })
})

describe('the calls as the API takes them', () => {
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
  const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name)

  it('the check; the close with and without a reason, one Idempotency-Key per attempt; undo; reopen with the reason', async () => {
    const check = recording(BEYOND_CHECK)
    await getCloseCheck(check.api, 'w1')
    expect(check.calls[0]!.url).toBe('http://api.test/production/work-orders/w1/close-check')
    const record = closeRecord()
    const workOrder = workOrderOf('CLOSED')
    const close = recording({ workOrder, close: record, split: SPLIT, waits: null })
    await closeWorkOrder(close.api, 'w1', { version: 7, reasonCode: 'LEATHER_YIELD', reasonNote: 'recut' }, 'key-1')
    expect(close.calls[0]!.url).toBe('http://api.test/production/work-orders/w1/close')
    expect(JSON.parse(String(close.calls[0]!.init.body))).toEqual({ version: 7, reasonCode: 'LEATHER_YIELD', reasonNote: 'recut' })
    expect(header(close.calls[0]!.init, 'idempotency-key')).toBe('key-1')
    await closeWorkOrder(close.api, 'w1', { version: 7, reasonCode: null, reasonNote: null })
    expect(JSON.parse(String(close.calls[1]!.init.body))).toEqual({ version: 7 })
    const back = recording({ workOrder, close: record })
    await undoClose(back.api, 'w1', 8)
    expect(back.calls[0]!.url).toBe('http://api.test/production/work-orders/w1/close/undo')
    expect(JSON.parse(String(back.calls[0]!.init.body))).toEqual({ version: 8 })
    await reopenWorkOrder(back.api, 'w1', { version: 8, reason: '  Counted again ' })
    expect(back.calls[1]!.url).toBe('http://api.test/production/work-orders/w1/reopen')
    expect(JSON.parse(String(back.calls[1]!.init.body))).toEqual({ version: 8, reason: 'Counted again' })
  })
})

describe('the variance at close', () => {
  const settled = varianceScreen.cases.find((item) => item.id === 'settled')!.model.record.variance as VarianceModel
  it('what the card shows from the state', () => {
    expect(varianceState({ ...settled, status: 'IN_PROGRESS' })).toBe('notYet')
    expect(varianceState(settled)).toBe('settled')
    expect(varianceState({ ...settled, closes: { value: null, problem: null } })).toBe('loading')
    expect(varianceState({ ...settled, closes: { value: null, problem: 'problem.unavailable' } })).toBe('failed')
    expect(varianceState({ ...settled, status: 'COMPLETED', preview: { split: SPLIT, settles: true, problem: null } })).toBe('preview')
    expect(varianceState({ ...settled, status: 'COMPLETED', preview: { split: SPLIT, settles: false, problem: null } })).toBe('previewWaits')
    const history = varianceScreen.cases.find((item) => item.id === 'history')!.model.record.variance as VarianceModel
    expect(liveClose(history.closes!.value!)?.live).toBe(true)
    expect(earlierCloses(history.closes!.value!)).toHaveLength(2)
    expect(entriesOf(earlierCloses(history.closes!.value!)[0]!)).toEqual({ written: 2, reversals: 2 })
  })

  it('the lines in the order of the categories, their units and what they explain (302.40 = the balance)', () => {
    const lines = orderedLines([...SPLIT.lines].reverse())
    expect(lines.map((line) => line.category)).toEqual(['MATERIAL_PRICE', 'MATERIAL_USAGE', 'LABOUR_EFFICIENCY', 'LABOUR_RATE', 'SCRAP'])
    expect(lineUnit(SPLIT.lines[0]!)).toBe('FT2')
    expect(lineUnit(SPLIT.lines[3]!)).toBe('MIN')
    expect(lineUnit({ category: 'OVERHEAD', item: null })).toBe('PCS')
    expect(explainedOf(SPLIT.lines)).toBe(SPLIT.balance)
    expect(explainedOf([{ amount: 100 }, {}])).toBeNull()
  })
})

const LEFT_KEY = /\b(?:common|figure|dialog|settle|waits|reason|held|reopen|undo|closed|refusal|problem|notice|variance|category|notSplit|history|costState|ppv)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission and grain names are said on purpose. */
const SAID = /\b(?:workorders\.manage|workorders\.reopen|workorders\.view|costing\.view|money\.cost)\b/g
const AMOUNT = /€\s?\d|\d\s?€/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key or placeholder left on screen', () => {
  for (const screen of [closeScreen, varianceScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  // The dialogs open in a portal (the DS Modal), which a server render does not draw: their table is drawn here alone.
  const figures = (check: typeof BEYOND_CHECK, locale: (typeof LOCALES)[number] = 'en') =>
    renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, [CLOSE_NS]) }, createElement(FiguresTable, { figures: check.figures, beyond: check.beyond, tolerancePct: check.tolerancePct })))

  it('money only by grain: no amount in the figures or the tab without the cost grain; amounts with it', () => {
    const none = figures(withoutCost(BEYOND_CHECK))
    expect(none).toContain('Needs the cost grain')
    expect(none.match(AMOUNT)?.[0] ?? null).toBeNull()
    expect(figures(BEYOND_CHECK)).toContain('€2,690.00')
    const tab = varianceScreen.cases.find((item) => item.id === 'no-cost')!
    expect(render(varianceScreen as unknown as DesignScreen<unknown>, tab.model, 'en').match(AMOUNT)?.[0] ?? null).toBeNull()
    const full = render(varianceScreen as unknown as DesignScreen<unknown>, varianceScreen.cases.find((item) => item.id === 'settled')!.model, 'en')
    expect(full).toContain('+€156.00')
    expect(full).toContain('Variance at close')
  })

  it('the figures say what is beyond the tolerance; the closed banner names who and offers Reopen; the preview waits for the accountant', () => {
    const beyond = figures(BEYOND_CHECK)
    expect(beyond.match(/Beyond/g)).toHaveLength(3)
    expect(beyond).toContain('Tolerance ±5 %')
    expect(figures(BEYOND_CHECK, 'it')).toContain('Oltre')
    const closed = render(closeScreen as unknown as DesignScreen<unknown>, closeScreen.cases.find((item) => item.id === 'closed')!.model, 'en')
    expect(closed).toContain('Alex Demo')
    expect(closed).toContain('Reopen…')
    const undo = render(closeScreen as unknown as DesignScreen<unknown>, closeScreen.cases.find((item) => item.id === 'undo')!.model, 'en')
    expect(undo).toContain('Undo')
    const waits = render(varianceScreen as unknown as DesignScreen<unknown>, varianceScreen.cases.find((item) => item.id === 'preview-waits')!.model, 'en')
    expect(waits).toContain('Waits for the accountant')
  })

  it('the dynamic words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [CLOSE_NS])[CLOSE_NS]!)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const code of CLOSE_REASONS) has(`reason.${code}`)
      for (const code of CLOSE_REFUSALS) has(`refusal.${code}`)
      for (const category of VARIANCE_CATEGORIES) has(`category.${category}`)
      for (const code of NOT_SPLIT_CODES) has(`notSplit.${code}`)
      for (const figure of ['quantity', 'material', 'minutes', 'scrap']) has(`figure.row.${figure}`)
      for (const kind of ['changed', 'signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'invalid', 'conflict', 'internal']) has(`problem.${kind}`)
      for (const key of ['closed', 'closedSettled', 'undone', 'reopened']) has(`notice.${key}`, { number: 'WO-1' })
    }
  })
})
