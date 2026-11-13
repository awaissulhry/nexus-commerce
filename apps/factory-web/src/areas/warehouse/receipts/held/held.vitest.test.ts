import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { recordedSchema } from '../api'
import { CANCELLED_RECEIPT, HELD_RECEIPT, heldModel, REFUSED_REQUESTS, RELEASED_RECEIPT, TASK_ID } from './demo/fixtures'
import { designScreen as recordScreen } from './fixtures'
import { cancelReasonOf, heldActionHeld, heldLinesOf, heldProblem, heldStateOf, noApproverOf, requestHref, requestWordsOf, taskOf } from './model'
import { designScreen as receiveScreen } from './receive/fixtures'

/**
 * B-W2b-382 (the screen gap B-W2b-377 left): POST /inventory/receipts may answer 202 with `held[]`: the office's goods-receipt
 * screens say the receipt WAITS for a yes (which lines, why, who is asked), offer Cancel, and show it posted after the last yes
 * — never "posted" while it waits.
 */

describe('a receipt that waits for a yes', () => {
  it('reads the 202 with its held lines (and a 201 with none)', () => {
    const answer = recordedSchema.parse({ receipt: HELD_RECEIPT, notes: [], moves: [], held: [{ lineId: HELD_RECEIPT.lines[0]!.id, seq: 20, taskId: TASK_ID }] })
    expect(answer.held).toHaveLength(1)
    expect(recordedSchema.parse({ receipt: RELEASED_RECEIPT, notes: [] }).held).toEqual([])
    expect(heldLinesOf(answer.receipt).map((line) => line.seq)).toEqual([20])
  })
  it('waits while a line is held; refused when its yes was refused; released once no line is held', () => {
    expect(heldStateOf(HELD_RECEIPT)).toBe('waiting')
    expect(heldStateOf(HELD_RECEIPT, REFUSED_REQUESTS)).toBe('refused')
    expect(heldStateOf(RELEASED_RECEIPT)).toBe('released')
    expect(heldStateOf({ ...RELEASED_RECEIPT, status: 'POSTED' })).toBe('none')
    expect(heldStateOf(CANCELLED_RECEIPT)).toBe('none')
    expect(heldStateOf({ ...HELD_RECEIPT, purchaseOrder: null })).toBe('none')
  })
  it('names who is asked, or only that it waits when the reader cannot see the request', () => {
    const pending = heldModel().requests![HELD_RECEIPT.lines[0]!.id]
    expect(requestWordsOf(pending)).toEqual({ key: 'held.state.PENDING', params: { who: 'Acquisti' } })
    expect(requestWordsOf(REFUSED_REQUESTS![HELD_RECEIPT.lines[0]!.id])).toEqual({ key: 'held.state.REJECTED' })
    expect(requestWordsOf(undefined)).toEqual({ key: 'held.state.unread' })
    expect(taskOf(HELD_RECEIPT.lines[0]!.id, [], null)).toBeNull()
    expect(requestHref('/w/DEMO', TASK_ID)).toBe(`/w/DEMO/home/approvals?open=${TASK_ID}`)
  })
  it('holds Cancel and Post with why; a reason is needed to cancel', () => {
    expect(heldActionHeld({ receive: false, offline: false, busy: false })).toBe('held.noReceive')
    expect(heldActionHeld({ receive: true, offline: true, busy: false })).toBe('held.offline')
    expect(heldActionHeld({ receive: true, offline: false, busy: false })).toBeNull()
    expect(cancelReasonOf('   ')).toEqual({ problem: 'held.problem.reason' })
    expect(cancelReasonOf(' Doppio ')).toEqual({ reason: 'Doppio' })
  })
  it('says the API’s refusals in words', () => {
    expect(heldProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'lines/20/held', message: 'A line waits' }]))).toEqual({ key: 'held.problem.held', reload: true })
    expect(heldProblem(new ApiError('conflict', 409, 'invalid_state', 'x'))).toEqual({ key: 'held.problem.state', reload: true })
    expect(heldProblem(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ key: 'held.noReceive', reload: false })
    expect(noApproverOf(['refusal/NO_APPROVER'])).toBe(true)
  })
})

describe('the screens say it in both languages, with no key and never "posted" while it waits', () => {
  const render = (screen: { view: unknown }, model: unknown, locale: 'it' | 'en') =>
    renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(screen.view as ComponentType<{ model: unknown }>, { model })))
      .replace(/(?:href|id|aria-[a-z]+|for|class|data-[a-z-]+)="[^"]*"/g, '')
  const screens = [recordScreen, receiveScreen] as const
  it.each(screens.flatMap((screen) => screen.cases.map((item) => [screen.screen, item.id] as const)))('%s · %s', (sid, id) => {
    const screen = screens.find((entry) => entry.screen === sid)!
    const model = (screen.cases as readonly { id: string; model: unknown }[]).find((item) => item.id === id)!.model
    for (const locale of ['it', 'en'] as const) {
      const html = render(screen, model, locale)
      expect(html).not.toMatch(/\b(?:held|rc|uom|problem)\.[a-zA-Z]+/)
      expect(html).not.toMatch(/\{[a-zA-Z]+\}/)
    }
  })
  it('the record says which line waits, why, and who is asked', () => {
    const en = render(recordScreen, recordScreen.cases.find((item) => item.id === 'waiting')!.model, 'en')
    expect(en).toContain('Waits for a yes before it is posted')
    expect(en).toContain('Line 20')
    expect(en).toContain('30 of 24 pcs: 6 pcs more than expected')
    expect(en).toContain('Waits for a yes from Acquisti')
    expect(en).toContain('Cancel this receipt')
  })
  it('right after Post receipt (202) the page never says posted', () => {
    const it_ = render(receiveScreen, receiveScreen.cases.find((item) => item.id === 'held')!.model, 'it')
    expect(it_).toContain('Il ricevimento GR-2026-0024 aspetta un sì')
    expect(it_).not.toContain('Registrato GR-2026-0024')
    const en = render(receiveScreen, receiveScreen.cases.find((item) => item.id === 'held')!.model, 'en')
    expect(en).not.toContain('Posted GR-2026-0024')
  })
})
