import { readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { deskSchema, type DeskRead } from './api'
import { DESK_SECTIONS, deskHrefOf, deskTilesOf, mayAnswerFloor, mayPlaceCode, placedOf } from './model'
import { DESK_NS, DesignDeskView, type DesignDeskModel } from './view/DesignDeskView'

/**
 * owb-of7 step 1 — the Design desk (design plan § 5f; prototype office.js designDesk): four sections in the kit — Asked · Waits for
 * approval · Scan codes · From the floor; the page lists only what the read gives (the designer: his orders, owb-of2 walls them);
 * every empty list is one quiet line; `codes: null` (before S3's placements) one quiet line; no price anywhere. Written, not run.
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const html = (node: ReactElement): string => renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', [DESK_NS, 'orders', 'stock']) }, node))
const EMPTY: DeskRead = { asked: [], approvals: [], codes: [], floor: [] }
const MINE: DeskRead = {
  asked: [{ kind: 'ORDER', id: 'o-1', number: 'SO-2026-0042', subject: 'Team jackets', party: { code: 'SEED', name: 'Seed Racing' }, why: 'HELP_ASKED', since: '2026-11-27T09:00:00Z', picture: null }],
  approvals: [{ approvalId: 'a-1', orderId: 'o-1', number: 'SO-2026-0042', subject: 'Team jackets', kind: 'ARTWORK', sentAt: '2026-11-27T10:00:00Z', state: 'OPEN' }],
  codes: [{ orderId: 'o-1', number: 'SO-2026-0042', subject: 'Team jackets', placed: 1, pages: 3 }],
  floor: [{ callId: 'c-1', orderNumber: 'SO-2026-0042', what: 'The logo is not clear', since: '2026-11-28T08:00:00Z', state: 'ASKED' }],
}
const model = (value: DeskRead, over: Partial<DesignDeskModel> = {}): DesignDeskModel => ({ prefix: '/w/demo', companyId: 'company-1', read: { status: 'ready', value }, pictures: null, mayPlace: true, mayAnswer: true, answer: null, taking: null, problem: null, place: null, ...over })

describe('owb-of7 step 1: the designer\'s page lists only his orders (what the read gives)', () => {
  it('each section draws the read\'s rows: Asked (why, Open), Waits for approval, Scan codes "1 of 3 placed", From the floor (I take it)', () => {
    const drawn = html(createElement(DesignDeskView, { model: model(MINE) }))
    expect(drawn).toContain('SO-2026-0042 · Team jackets')
    expect(drawn).toContain('help is asked')
    expect(drawn).toContain('1 of 3 placed')
    expect(drawn).toContain('The logo is not clear')
    expect(drawn).toContain('I take it')
    expect(drawn).not.toMatch(/€|price/i)
  })
  it('the read holds no price key (the Shape) and the rows open the order (a request: the draft page)', () => {
    expect(Object.keys(deskSchema.shape).sort()).toEqual(['approvals', 'asked', 'codes', 'floor'])
    expect(JSON.stringify(MINE)).not.toMatch(/price|amount/i)
    expect(deskHrefOf('/w/demo', { kind: 'ORDER', id: 'o-1' })).toBe('/w/demo/sales/orders/o-1')
    expect(deskHrefOf('/w/demo', { kind: 'REQUEST', id: 'r-1' })).toBe('/w/demo/sales/orders/new?draft=r-1')
  })
})

describe('owb-of7 step 1: empty lists = one quiet line each', () => {
  it('four quiet lines; codes null says the placements come with the print part', () => {
    const drawn = html(createElement(DesignDeskView, { model: model(EMPTY) }))
    for (const words of ['Nobody asks for help now.', 'No design waits for approval.', 'No confirmed order waits for the print.', 'No worker waits for you.']) expect(drawn).toContain(words)
    expect(html(createElement(DesignDeskView, { model: model({ ...EMPTY, codes: null }) }))).toContain('The scan code places come with the print part')
  })
  it('the tiles count each section (codes: the orders not yet all placed; null before the placements), in the design order', () => {
    expect(DESK_SECTIONS).toEqual(['asked', 'approvals', 'codes', 'floor'])
    expect(deskTilesOf(MINE).map((tile) => tile.count)).toEqual([1, 1, 1, 1])
    expect(deskTilesOf({ ...EMPTY, codes: null })[2]!.count).toBeNull()
    expect(placedOf({ placed: 3, pages: 3 }).done).toBe(true)
  })
  it('doors only for who may: Place the scan code (print.start or the designer), the floor\'s acts (production.calls.answer)', () => {
    expect(mayPlaceCode(['orders.view.own'])).toBe(true)
    expect(mayPlaceCode(['orders.view'])).toBe(false)
    expect(mayAnswerFloor(['production.calls.answer'])).toBe(true)
    expect(html(createElement(DesignDeskView, { model: model(MINE, { mayAnswer: false, mayPlace: false }) }))).not.toContain('I take it')
  })
  it('the stub page is replaced; the floor acts go through today\'s call routes; every word in English and Italian', () => {
    expect(read('../../../app/(office)/w/[company]/home/design-desk/page.tsx')).toContain('<DesignDeskPage />')
    const api = read('./api.ts')
    expect(api).toContain('/on-the-way')
    expect(api).toContain("resolutionCode: 'ANSWERED'")
    const en = CATALOGUE.en[DESK_NS] ?? {}
    for (const locale of LOCALES) for (const key of Object.keys(en)) expect(CATALOGUE[locale][DESK_NS]?.[key], `${locale} ${key}`).toBeTruthy()
  })
})
