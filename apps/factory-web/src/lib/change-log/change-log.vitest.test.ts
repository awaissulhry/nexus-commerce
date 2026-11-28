import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { ACTION_ICONS, ORDER_LOG_ACTIONS } from '@nexus/factory-domain/sales/order-log/faces'
import { fixedDepartments } from '../department/model'
import { departmentWordsFor } from '../department/words'
import { LOCALES } from '../i18n/locales'
import { CATALOGUE } from '../i18n/messages'
import { ReaderProvider } from '../i18n/provider'
import { everyCase, render, textOf } from '../record-thread/parts/testing'
import { orderLogAnswerSchema, orderLogPath, readOrderLog } from './api'
import { FLOOR_ROWS, OFFICE_ROWS, PORTAL_ROWS, designScreen } from './fixtures'
import { LOG_ICONS, logIconOf } from './icons'
import { actionKeyOf, actionWordKeyOf, CHANGE_LOG_START, CHANGE_LOG_WIDE_PX, changeLogFormOf, subjectKeyOf, whoViewOf, withPage, type LogRow } from './model'
import { ChangeLog, type ChangeLogModel } from './view/ChangeLog'
import { changeLogWordsFor } from './words'

/**
 * owb-b4 w4.4 (design § 8 "one history, three faces", § 5zk C, § 5zl; owb-b23 "Shapes" OrderLogAnswer) — the change log: who is drawn
 * from the face ONLY (a name on PERSON alone), each value kind as its chip, one icon per action (unknown: a plain dot), the words of
 * every action the domain names in both languages, a table in a PC's room and a list in a phone's (the part's own room), "Load more"
 * by the cursor, and a portal row never shows a reason (it is null). Made-up data only.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const en = changeLogWordsFor('en')
const departments = fixedDepartments(departmentWordsFor('en'))
const noop = () => undefined
const model = (rows: readonly LogRow[], over: Partial<ChangeLogModel> = {}): ChangeLogModel => ({ rows, status: 'ready', more: 'none', departments, picture: { source: 'order', recordId: 'o-1', number: 'Your order 12', read: null }, ...over })
const draw = (m: ChangeLogModel, reader: 'office' | 'outside' = 'office') => render(createElement(ReaderProvider, { reader }, createElement(ChangeLog, { model: m, actions: { onMore: noop, onRetry: noop } })))
const one = (over: Partial<LogRow>): LogRow => ({ id: 'x', at: '2026-11-27T09:14:00.000Z', who: { face: 'SYSTEM', name: null, departmentNo: null }, action: 'OTHER', icon: 'history', subject: { kind: 'ORDER', label: null }, from: null, to: null, reason: null, ...over })

describe('who: from the face only', () => {
  it('PERSON shows its name; THE_FACTORY, YOU, OFFICE, SYSTEM a word ("Nexus"); DEPARTMENT its chip', () => {
    expect(whoViewOf({ face: 'PERSON', name: ' Sam Sales ', departmentNo: null })).toEqual({ kind: 'name', name: 'Sam Sales' })
    expect(['THE_FACTORY', 'YOU', 'OFFICE', 'SYSTEM'].map((face) => whoViewOf({ face, name: null, departmentNo: null }))).toEqual([{ kind: 'word', key: 'who.THE_FACTORY' }, { kind: 'word', key: 'who.YOU' }, { kind: 'word', key: 'who.OFFICE' }, { kind: 'word', key: 'who.SYSTEM' }])
    expect(['who.THE_FACTORY', 'who.YOU', 'who.OFFICE', 'who.SYSTEM'].map((key) => en.t(key))).toEqual(['The factory', 'You', 'Office', 'Nexus'])
    expect(whoViewOf({ face: 'DEPARTMENT', name: null, departmentNo: 2 })).toEqual({ kind: 'department', no: 2 })
    expect(whoViewOf({ face: 'DEPARTMENT', name: null, departmentNo: null })).toEqual({ kind: 'word', key: 'who.DEPARTMENT' })
  })

  it('a name rides on PERSON alone: any other face never draws one, and a face this web does not know says "Someone"', () => {
    for (const face of ['THE_FACTORY', 'YOU', 'OFFICE', 'SYSTEM', 'DEPARTMENT']) expect(JSON.stringify(whoViewOf({ face, name: 'Wanda Worker', departmentNo: 3 })), face).not.toContain('Wanda')
    expect(whoViewOf({ face: 'WORKER', name: 'Wanda Worker', departmentNo: null })).toEqual({ kind: 'word', key: 'who.someone' })
    expect(whoViewOf({ face: 'PERSON', name: '  ', departmentNo: null })).toEqual({ kind: 'word', key: 'who.someone' })
  })
})

describe('what: the action\'s words, its icon, its subject', () => {
  it('an audit action or the log\'s own key → the key (the domain\'s ONE map); anything else → OTHER ("A change")', () => {
    expect(actionKeyOf('orders.changePromise')).toBe('PROMISE_MOVED')
    expect(actionKeyOf('PROMISE_MOVED')).toBe('PROMISE_MOVED')
    expect(actionKeyOf('orders.picture.set')).toBe('PICTURE_SET')
    // owb-b7 (S5 ask 09:28): a basket's move (its undo, a route change, the route back to normal) reads "Changed on the floor".
    expect(actionKeyOf('production.baskets.move')).toBe('CHANGED_ON_FLOOR')
    expect(actionKeyOf('production.baskets.routeNormal')).toBe('CHANGED_ON_FLOOR')
    expect(actionKeyOf('production.holds.place')).toBe('OTHER')
    expect(actionWordKeyOf('shipping.ship')).toBe('action.SHIPPED')
    expect(en.t('action.OTHER')).toBe('A change')
    expect(en.t('action.CHANGED_ON_FLOOR')).toBe('Changed on the floor')
    expect(changeLogWordsFor('it').t('action.CHANGED_ON_FLOOR')).toBe('Cambiato in reparto')
    // owb-b7 (S2 ask 09:18): the four office acts of an order, each its own word.
    expect(['orders.restrict', 'orders.paymentNotice.answer', 'orders.files.zip', 'orders.designer.give'].map(actionKeyOf)).toEqual(['RESTRICTION_CHANGED', 'NOTICE_ANSWERED', 'FILES_DOWNLOADED', 'DESIGNER_GIVEN'])
  })

  it('every action the domain names has its words in it and en; every icon id it names is a lucide icon; an unknown id is a plain dot', () => {
    for (const locale of LOCALES) for (const key of ORDER_LOG_ACTIONS) expect(CATALOGUE[locale]['change-log']?.[`action.${key}`], `${locale} ${key}`).toBeTruthy()
    for (const id of Object.values(ACTION_ICONS)) expect(logIconOf(id), id).toBe(LOG_ICONS[id])
    for (const id of ['route', '', null, 'toString']) expect(logIconOf(id), String(id)).toBeNull()
  })

  it('the subject\'s words before its label (none for the order itself)', () => {
    expect(['ORDER', 'LINE', 'SHIPMENT', 'FILE', 'BASKET', 'REQUEST', 'ROBOT'].map((kind) => subjectKeyOf({ kind, label: 'x' }))).toEqual([null, 'subject.LINE', 'subject.SHIPMENT', 'subject.FILE', 'subject.BASKET', 'subject.REQUEST', null])
  })
})

describe('the room: a table on a PC, a list on a phone (the part\'s own room, never the window)', () => {
  it('720 px of the part\'s own box: the model and the CSS say the same, by container query', () => {
    expect(CHANGE_LOG_WIDE_PX).toBe(720)
    expect([changeLogFormOf(375), changeLogFormOf(719), changeLogFormOf(720), changeLogFormOf(1440)]).toEqual(['list', 'list', 'table', 'table'])
    const css = readFileSync(join(HERE, 'change-log.css'), 'utf8')
    expect(css).toContain('container: fw-clog / inline-size;')
    expect(css).toMatch(/@container fw-clog \(min-width: 720px\) \{\s*\.fw-clog-list \{\s*display: none;/)
    expect(css).toMatch(/@container fw-clog \(max-width: 719\.98px\) \{\s*\.fw-clog-scroll \{\s*display: none;/)
    expect(css).not.toContain('@media')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  })

  it('both forms are drawn and the room shows one: a table with its four heads, a list of the same rows', () => {
    const html = draw(model(OFFICE_ROWS))
    expect(html).toContain('<table class="fw-clog-table">')
    expect(textOf(html)).toContain('When Who What From → to')
    expect(html.match(/<tr data-row=/g)?.length).toBe(OFFICE_ROWS.length)
    expect(html.match(/<li class="fw-clog-item" data-row=/g)?.length).toBe(OFFICE_ROWS.length)
  })
})

describe('each value kind as its chip', () => {
  const html = draw(model(OFFICE_ROWS))
  it('a life → the StateChip; a department → the DeptChip; a day; a text; a count; a picture → a small RecordPicture; "The design" in words', () => {
    expect(html).toContain('data-life="READY_TO_SHIP"')
    expect(html).toContain('data-life="SHIPPED"')
    expect(html).toContain('fw-dept-chip fw-dept-tone-orange')
    expect(html).toContain('data-dept="4"')
    expect(textOf(html)).toContain('04/12/2026')
    expect(textOf(html)).toContain('Brand Alpha shop, Rotterdam')
    expect(html).toContain('fw-rpic fw-rpic-log')
    expect(textOf(html)).toContain('The design')
    expect(textOf(html)).toMatch(/from\s+0\s+to\s+3/)
  })

  it('who by name in the office, a reason when the answer has one, the subject\'s label, an unknown action "A change" with a plain dot', () => {
    expect(textOf(html)).toContain('Sam Sales')
    expect(html).toContain('<span class="fw-clog-reason">The leather arrives a week later.</span>')
    expect(textOf(html)).toContain('Basket BSK-0042')
    expect(textOf(html)).toContain('A change')
    expect(html).toContain('fw-clog-dot')
  })
})

describe('the three faces, as the server sends them', () => {
  it('a portal row never shows a reason (it is null) and never a name for "The factory"', () => {
    const html = draw(model(PORTAL_ROWS), 'outside')
    expect(PORTAL_ROWS.every((each) => each.reason === null)).toBe(true)
    expect(html).not.toContain('fw-clog-reason')
    expect(textOf(html)).toContain('The factory')
    const hidden = draw(model([one({ who: { face: 'THE_FACTORY', name: 'Wanda Worker', departmentNo: null } })]), 'outside')
    expect(hidden).not.toContain('Wanda')
  })

  it('the floor: "You", "Office", a department — never a name', () => {
    const text = textOf(draw(model(FLOOR_ROWS)))
    expect(text).toContain('You')
    expect(text).toContain('Office')
    expect(draw(model(FLOOR_ROWS))).toContain('data-dept="1"')
  })

  it('the customer reads "At the factory’s warehouse"', () => {
    const row = [one({ action: 'shipping.warehouseLeg.arrived', icon: 'warehouse' })]
    expect(textOf(draw(model(row)))).toContain('At our warehouse')
    expect(textOf(draw(model(row), 'outside'))).toContain('At the factory’s warehouse')
    expect(changeLogWordsFor('en', 'outside').t('action.AT_OUR_WAREHOUSE')).toBe('At the factory’s warehouse')
    expect(changeLogWordsFor('it', 'outside').t('action.AT_OUR_WAREHOUSE')).toBe('Nel magazzino della fabbrica')
  })
})

describe('reads, pages and states', () => {
  it('the answer with this web\'s own zod: the needed fields required, the rest safe defaults; an unknown value kind is none; an unknown face stays a string', () => {
    const answer = orderLogAnswerSchema.parse({ rows: [{ id: 'a', at: '2026-11-27T09:14:00.000Z', who: { face: 'ROBOT' }, action: 'orders.changePromise', from: { kind: 'COLOUR', hex: 'x' }, to: { kind: 'DATE', date: '2026-12-11' } }] })
    expect(answer.nextCursor).toBeNull()
    expect(answer.rows[0]).toEqual({ id: 'a', at: '2026-11-27T09:14:00.000Z', who: { face: 'ROBOT', name: null, departmentNo: null }, action: 'orders.changePromise', icon: '', subject: { kind: 'ORDER', label: null }, from: null, to: { kind: 'DATE', date: '2026-12-11' }, reason: null })
    expect(() => orderLogAnswerSchema.parse({ rows: [{ id: 'a', at: 'x', action: 'y' }] })).toThrow() // no who: refused
  })

  it('the four doors, and one page with its cursor and limit', async () => {
    expect([orderLogPath('office', 'order', 'o-1'), orderLogPath('office', 'request', 'r-1'), orderLogPath('portal', 'order', 'o-1'), orderLogPath('portal', 'request', 'r-1')]).toEqual(['/sales/orders/o-1/log', '/sales/order-requests/r-1/log', '/portal/sales-orders/o-1/log', '/portal/order-requests/r-1/log'])
    const asked: unknown[] = []
    const api = { get: async (path: string, init: { query: unknown; schema: { parse: (value: unknown) => unknown } }) => (asked.push({ path, query: init.query }), init.schema.parse({ rows: [], nextCursor: 'c-2' })) } as unknown as Parameters<typeof readOrderLog>[0]
    expect(await readOrderLog(api, '/sales/orders/o-1/log', null)).toEqual({ rows: [], nextCursor: 'c-2' })
    await readOrderLog(api, '/sales/orders/o-1/log', 'c-2')
    expect(asked).toEqual([{ path: '/sales/orders/o-1/log', query: { cursor: undefined, limit: 50 } }, { path: '/sales/orders/o-1/log', query: { cursor: 'c-2', limit: 50 } }])
  })

  it('a page after the first: its rows after the ones here (none twice); no next cursor: every row is here', () => {
    const first = withPage(CHANGE_LOG_START, { rows: OFFICE_ROWS.slice(0, 3), nextCursor: 'c-2' }, true)
    expect(first).toMatchObject({ status: 'ready', more: 'idle', cursor: 'c-2' })
    const second = withPage(first, { rows: OFFICE_ROWS.slice(2), nextCursor: null }, false)
    expect(second.rows.map((each) => each.id)).toEqual(OFFICE_ROWS.map((each) => each.id))
    expect(second).toMatchObject({ more: 'none', cursor: null })
  })

  it('reading, failed (said, Try again), empty, Load more, a page reading (held), a failed page (said, Try again)', () => {
    expect(draw(model([], { status: 'reading' }))).toContain('role="status"')
    const failed = draw(model([], { status: 'failed' }))
    expect(failed).toContain('role="alert"')
    expect(textOf(failed)).toContain('Try again')
    expect(textOf(draw(model([])))).toContain('No change yet.')
    expect(textOf(draw(model(OFFICE_ROWS, { more: 'idle' })))).toContain('Load more')
    expect(draw(model(OFFICE_ROWS, { more: 'reading' }))).toContain('aria-description="Reading more changes…"')
    const page = draw(model(OFFICE_ROWS, { more: 'failed' }))
    expect(textOf(page)).toContain('More changes could not be read.')
    expect(textOf(page)).toContain('Try again')
    expect(textOf(draw(model(OFFICE_ROWS, { more: 'none' })))).not.toContain('Load more')
  })
})

describe('the words and the design index', () => {
  it('change-log.json has the same keys in it and en', () => {
    const keys = (locale: (typeof LOCALES)[number]) => Object.keys(CATALOGUE[locale]['change-log'] ?? {}).sort()
    expect(keys('it')).toEqual(keys('en'))
  })

  it('every design case draws in both languages with no key left on screen', () => {
    for (const [locale, id, html] of everyCase(designScreen)) expect(html, `${locale} ${id}`).not.toMatch(/\b(action|who|head|subject|fromTo|value)\.[A-Za-z_]+/)
  })
})
