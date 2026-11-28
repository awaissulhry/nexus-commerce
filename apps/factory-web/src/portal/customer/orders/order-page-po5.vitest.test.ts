import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { CATALOGUE } from '../../../lib/i18n/messages'
import type { Locale } from '../../../lib/i18n/locales'
import { orderLogPath } from '../../../lib/change-log/api'
import { orderPicturePath } from '../../../lib/record-picture/api'
import { render, textOf } from '../../../lib/record-thread/parts/testing'
import { chatCountOf, chatOpensAt, chatRowsOf } from '../../shell/chat/model'
import type { OrderRecord } from './api'
import { orderBandOf, orderTabsOf, type OrderBandFacts } from './band'
import { orderRecord, orderWords, PREFIX } from './design-data'
import { RECORD_TABS, tabFor } from './model'
import { ORDER_PAGE_NS } from './page-words'
import { mayBePicture, pictureChoicesOf } from './picture'
import { designScreen as requestScreen, draftOf } from './request/fixtures'
import { quietLineOf, requestFrameOf, requestTabOf, takeBackRefusal } from './request-record'

/**
 * owb-po5 — the order page, part 1 (lead settles 2 + 3; plan § 5i portal row, § 5d Chat): the band (picture, "Your order 12 · <subject>",
 * the life chip, ONE primary per state), five tabs for both records (Money only with the price grain; Money and Shipments one quiet line
 * before Confirm), Asks & changes → All changes, Chat in the top bar. Written, not run (Owner rule: checks at the end).
 */

const FACTS: OrderBandFacts = { ask: { held: null }, cancelHeld: null, reconfirm: null, confirmation: true, pay: null }
const bandOf = (status: OrderRecord['order']['status'], over: Partial<OrderRecord['order']> = {}, locale: Locale = 'en') =>
  orderBandOf({ words: orderWords(locale), record: orderRecord({ status, ...over }), prefix: PREFIX, facts: FACTS, picture: { onOpen: () => undefined } })
const drawRequest = (id: string, locale: Locale = 'en') => render(createElement(requestScreen.view, { model: requestScreen.cases.find((item) => item.id === id)!.model }), locale)

describe('owb-po5.1 — the band: picture · "Your order 12 · subject" · the life chip · ONE primary', () => {
  it('Confirmed…Ready: ONE "Ask for a change…"; shipped, delivered or cancelled: none', () => {
    for (const status of ['REQUESTED', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const) expect(bandOf(status).actions?.map((action) => action.id), status).toEqual(['ask'])
    for (const status of ['SHIPPED', 'DELIVERED', 'CANCELLED'] as const) expect(bandOf(status).actions, status).toEqual([])
  })

  it('the title is the customer\'s own number and the subject (never an office series); without a subject, the number alone', () => {
    const band = bandOf('IN_PRODUCTION', { subject: 'Race suits for the spring team' })
    expect(band.title).toMatch(/· Race suits for the spring team$/)
    expect(band.title).not.toMatch(/SO-|RQ-|SH-/)
    expect(bandOf('IN_PRODUCTION', { subject: null }).title).not.toContain('·')
  })

  it('the status names the life (`{ life, note }`, the nine words) for the shared StateChip; the picture names the order', () => {
    expect(bandOf('IN_PRODUCTION').status).toMatchObject({ life: 'IN_PRODUCTION', note: null })
    expect(bandOf('READY').status?.life).toBe('READY_TO_SHIP')
    expect(bandOf('CANCELLED').status).toMatchObject({ life: 'WITHDRAWN', note: { kind: 'CANCELLED' } })
    const band = bandOf('CONFIRMED')
    expect(band.picture).toMatchObject({ recordId: orderRecord().order.id })
    expect(typeof band.picture?.onOpen).toBe('function')
    // No picture asked: none drawn.
    expect(orderBandOf({ words: orderWords('en'), record: orderRecord(), prefix: PREFIX, facts: FACTS }).picture).toBeUndefined()
  })

  it('the request: Draft "Review and send…", Sent "Take it back"; a Designer sees Send held (no orderRequests.manage); no number before Confirm', () => {
    const draft = drawRequest('draft')
    expect(textOf(draft)).toContain('Review and send…')
    expect(textOf(draft)).toContain('Your order · Race suits for the spring team')
    expect(draft).not.toContain('RQ-2026-0042')
    const sent = drawRequest('sent')
    expect(textOf(sent)).toContain('Take it back')
    expect(sent).not.toContain('RQ-2026-0042')
    // The rule under it: Send by the record's `may` (a Designer fills, never sends); Take it back only while SENT; nothing in a preview.
    const name = { orderName: 'Your order' }
    const buyer = { mayOrder: true, mayDraft: true, preview: false }
    expect(requestFrameOf(draftOf(), name, buyer)).toMatchObject({ primary: 'send', may: { send: true, takeBack: false, picture: true }, title: 'Your order · Race suits for the spring team' })
    expect(requestFrameOf(draftOf({ send: false }), name, { ...buyer, mayOrder: false }).may.send).toBe(false)
    expect(requestFrameOf(draftOf({ status: 'SENT' }), name, buyer)).toMatchObject({ primary: 'takeBack', may: { send: false, takeBack: true } })
    expect(requestFrameOf(draftOf({ status: 'SENT', takeBack: false }), name, buyer).may.takeBack).toBe(false)
    expect(requestFrameOf(draftOf({ status: 'SENT' }), name, { ...buyer, preview: true }).may).toEqual({ send: false, takeBack: false, picture: false })
    expect(requestFrameOf(draftOf(), name, buyer).title).not.toMatch(/RQ-/)
  })

  it('the picture saves through the portal doors (ONE right for both records: portal.orderDrafts.edit)', () => {
    expect(orderPicturePath('portal', 'order', 'o1')).toBe('/portal/sales-orders/o1/picture')
    expect(orderPicturePath('portal', 'request', 'r1')).toBe('/portal/order-requests/r1/picture')
    const page = readFileSync(new URL('./OrderPage.tsx', import.meta.url), 'utf8')
    expect(page).toContain("can('portal.orderDrafts.edit') && !preview")
    expect(page).toContain("orderPicturePath('portal', 'order', record.order.id)")
  })

  it('a file may be the picture only when the customer can open it: an image or a PDF, never a size sheet', () => {
    expect(mayBePicture({ contentType: 'image/png', category: null })).toBe(true)
    expect(mayBePicture({ contentType: 'application/pdf', category: 'ARTWORK' })).toBe(true)
    expect(mayBePicture({ contentType: 'image/png', category: 'MEASUREMENTS' })).toBe(false)
    expect(mayBePicture({ contentType: 'text/csv', category: null })).toBe(false)
    expect(mayBePicture({ contentType: 'application/pdf', kind: 'SHEET' })).toBe(false)
    const file = (id: string, contentType: string, category: string | null) => ({ id, name: `${id}.x`, kind: 'ATTACHMENT', category, contentType }) as never
    expect(pictureChoicesOf({ groups: [{ files: [file('a', 'image/jpeg', null), file('b', 'image/png', 'MEASUREMENTS'), file('a', 'image/jpeg', null)] } as never] }).map((choice) => choice.fileId)).toEqual(['a'])
    expect(pictureChoicesOf(null)).toEqual([])
  })
})

describe('owb-po5.2 — five tabs for both records; old tab names land', () => {
  it('Overview · Lines · Money · Shipments · Files — Money only with the price grain (the customer\'s Designer has no tab)', () => {
    const tabs = (money: boolean) => orderTabsOf({ words: orderWords('en'), record: orderRecord(), prefix: PREFIX, toConfirm: false, files: 0, money }).map((tab) => tab.id)
    expect(tabs(true)).toEqual([...RECORD_TABS])
    expect(tabs(false)).toEqual(['overview', 'lines', 'shipments', 'files'])
    expect(tabFor('money', false)).toBe('overview')
    expect(tabFor('money', true)).toBe('money')
    expect([tabFor('status', true), tabFor('documents', true)]).toEqual(['overview', 'files'])
    expect(requestTabOf('money', false)).toBe('overview')
    expect([requestTabOf('status', true), requestTabOf('documents', true), requestTabOf('nothing', true)]).toEqual(['overview', 'files', 'overview'])
    expect(textOf(drawRequest('designer'))).not.toContain('Money')
  })

  it('before Confirm Money and Shipments say ONE quiet line, in both languages', () => {
    expect([quietLineOf('money'), quietLineOf('shipments'), quietLineOf('files')]).toEqual(['quiet.money', 'quiet.shipments', null])
    expect(textOf(drawRequest('draft-money'))).toContain('Money starts when the factory confirms the order.')
    expect(textOf(drawRequest('draft-shipments'))).toContain('Nothing has left the factory yet.')
    expect(textOf(drawRequest('draft-money', 'it'))).toContain(CATALOGUE.it[ORDER_PAGE_NS]!['quiet.money']!)
  })

  it('the request\'s files by kind; a size sheet is a size file, never a mockup', () => {
    const html = textOf(drawRequest('draft-files'))
    expect(html).toContain('mockup-front.png')
    expect(html).toContain('sizes-team.xlsx')
    expect(html.indexOf('Mockups')).toBeLessThan(html.indexOf('mockup-front.png'))
  })

  it('Take it back refused: our words by the refusal (never the API\'s text)', () => {
    expect(takeBackRefusal(new ApiError('conflict', 409, 'conflict', 'The factory has already started work on this order: ask the factory.'))).toBe('takeBack.started')
    expect(takeBackRefusal(new ApiError('conflict', 409, 'conflict', 'The factory has already answered this order.'))).toBe('takeBack.answered')
    expect(takeBackRefusal(new ApiError('conflict', 409, 'stale', 'Changed meanwhile'))).toBe('takeBack.stale')
    expect(takeBackRefusal(new Error('x'))).toBe('takeBack.failed')
    expect(textOf(drawRequest('sent-refused'))).toContain('The factory has already started work on this order: ask the factory.')
  })

  it('every request case draws in both languages with no raw key and made-up data only', () => {
    for (const locale of ['en', 'it'] as const) {
      for (const entry of requestScreen.cases) {
        const html = render(createElement(requestScreen.view, { model: entry.model }), locale)
        expect(html, `${entry.id} ${locale}`).not.toMatch(/\b(request|tabs|facts|quiet|files|asks|held|band|takeBack|where)\.[a-zA-Z]+/)
        expect(html).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
      }
    }
  })
})

describe('owb-po5.3 — Asks & changes → All changes (the ONE log over the portal route)', () => {
  it('the window reads the portal door of the log (its faces: "The factory", never a worker or an office note — the base\'s allow-list)', () => {
    expect(orderLogPath('portal', 'order', 'o1')).toBe('/portal/sales-orders/o1/log')
    expect(orderLogPath('portal', 'request', 'r1')).toBe('/portal/order-requests/r1/log')
    expect(readFileSync(new URL('./OrderPage.tsx', import.meta.url), 'utf8')).toContain("orderLogReader(api, orderLogPath('portal', 'order', id))")
    expect(readFileSync(new URL('./RequestOrderPage.tsx', import.meta.url), 'utf8')).toContain("orderLogReader(api, orderLogPath('portal', 'request', id))")
    // Never the office's log route from the portal.
    for (const file of ['./OrderPage.tsx', './RequestOrderPage.tsx']) expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toContain("orderLogPath('office'")
  })

  it('the card is "Asks & changes" (the design\'s one name) with "All changes", in both languages', () => {
    expect(CATALOGUE.en['portal-orders']!['overview.requests']).toBe('Asks & changes')
    for (const locale of ['en', 'it'] as const) for (const key of ['asks.all', 'changes.title', 'linked.title', 'designer.title', 'designer.ask']) expect(CATALOGUE[locale][ORDER_PAGE_NS]![key], `${locale} ${key}`).toBeTruthy()
    expect(textOf(drawRequest('draft'))).toContain('All changes')
  })
})

describe('owb-po5.4 — Chat in the top bar: the count, the list → one chat → back', () => {
  const chat = (type: string, id: string, newCount: number, theirRef: string | null = null) => ({ record: { type, id, theirRef, ourRef: null, subtitle: null }, last: { authorName: null, excerpt: 'Hello', at: '2026-11-28T09:00:00.000Z' }, newCount })

  it('the count adds up the new messages (never a made-up 0 before the read; quiet lines are never counted: the server\'s rule)', () => {
    expect(chatCountOf(null)).toBeNull()
    expect(chatCountOf([])).toBe(0)
    expect(chatCountOf([chat('SalesOrder', 'a', 2), chat('ReturnAuthorisation', 'b', 1), chat('Party', 'p', 0)])).toBe(3)
  })

  it('on a record page the panel opens that record\'s chat; elsewhere (and for the account) the list', () => {
    expect(chatOpensAt({ type: 'SalesOrder', id: 'o1', label: 'Your order 12' })).toEqual({ open: true, record: { type: 'SalesOrder', id: 'o1', label: 'Your order 12' } })
    expect(chatOpensAt(null)).toEqual({ open: true, record: null })
    expect(chatOpensAt({ type: 'Party', id: 'p', label: null })).toEqual({ open: true, record: null })
  })

  it('a row is named by their reference, else ours, else its kind; its new messages are said', () => {
    const rows = chatRowsOf([chat('SalesOrder', 'a', 2, 'PO-ALPHA-118'), chat('ReturnAuthorisation', 'b', 0)], (type) => (type === 'ReturnAuthorisation' ? 'Return' : type))
    expect(rows.map((row) => [row.title, row.newCount])).toEqual([['PO-ALPHA-118', 2], ['Return', 0]])
  })

  it('the top bar draws Chat with its count; the words in both languages', () => {
    for (const locale of ['en', 'it'] as const) for (const key of ['chat.title', 'chat.labelNew_other', 'chat.back', 'chat.close', 'chat.none', 'chat.new_other']) expect(CATALOGUE[locale].portal![key], `${locale} ${key}`).toBeTruthy()
    const view = readFileSync(new URL('../../shell/view/PortalShellView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("onClick={() => onOpen?.('chat')}")
    const shell = readFileSync(new URL('../../shell/PortalShell.tsx', import.meta.url), 'utf8')
    expect(shell).toContain('<PortalThread type={chat.record.type} id={chat.record.id} />')
  })
})
