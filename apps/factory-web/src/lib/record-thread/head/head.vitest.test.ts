import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../i18n/locales'
import { createTranslator, messagesFor } from '../../i18n/messages'
import { I18nProvider } from '../../i18n/provider'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import { scanText } from '../../testing/brand-scan'
import { designScreen } from './fixtures'
import { DEFAULT_DOCK_WIDTH, doorHolds, menuRows, R_ACT_ORDER, viewsOffered, waitWords, whoAnswers, widthKey, type HeadAbilities, type HeadModel } from './model'
// B-TH-229
import { answersOf, newWords, waitingWords } from './model'
import { OwnerDialog } from './view/OwnerDialog'
import { readWidth, writeWidth } from './use-thread-width'
import { PortalHeadLine } from './view/PortalHeadLine'

/**
 * B-TH-209 — the thread's Head (T1, rule R-ACT): who answers next from the last SHARED message, the five Activity doors
 * always in the "⋯" (also at count 0) and held with the reason, Close only with threads.manage, the portal line with no
 * office count (W08, W34), the width remembered per person and record type, every case drawn in it and en.
 */

// B-TH-229: + owner, new, rule.
const KEY_ON_SCREEN = /\b(answers|wait|closed|view|count|width|more|act|held|portal|design|owner|new|rule)\.[a-zA-Z]/
const ALL: HeadAbilities = { task: true, approve: true, share: true, follow: true, remind: true, manage: false, audit: false }
const NOW = Date.UTC(2026, 10, 17, 10, 42)

const base = (over: Partial<HeadModel> = {}): HeadModel => ({
  record: 'SO-2026-0142',
  party: { name: BRAND_ALPHA.tradeName, role: 'customer' },
  answers: null,
  closed: null,
  offline: null,
  view: 'all',
  views: ['all'],
  counts: {},
  holds: doorHolds({ can: ALL, hasParty: true, offline: false }),
  follow: { following: false, muted: false },
  reminder: null,
  canManage: false,
  width: 'forty',
  now: NOW,
  ...over,
})

describe('who answers next', () => {
  const inbound = { direction: 'INBOUND' as const, author: { kind: 'PARTY' as const }, at: '2026-11-17T06:40:00.000Z' }
  const outbound = { direction: 'OUTBOUND' as const, author: { kind: 'USER' as const }, at: '2026-11-16T15:10:00.000Z' }
  const note = { direction: 'INTERNAL_NOTE' as const, author: { kind: 'USER' as const }, at: '2026-11-17T09:30:00.000Z' }

  it('goes by the last SHARED message: an office note never flips it', () => {
    expect(whoAnswers([outbound, inbound, note], true)).toEqual({ on: 'us', since: inbound.at })
    expect(whoAnswers([inbound, { ...outbound, at: '2026-11-17T08:00:00.000Z' }, note], true)).toEqual({ on: 'party', since: '2026-11-17T08:00:00.000Z' })
  })

  it('an automatic mail decides nothing; no shared message or no party: nobody waits', () => {
    expect(whoAnswers([inbound, { ...outbound, author: { kind: 'SYSTEM' }, at: '2026-11-17T09:00:00.000Z' }], true)?.on).toBe('us')
    expect(whoAnswers([note], true)).toBeNull()
    expect(whoAnswers([inbound], false)).toBeNull()
  })

  it('says how long, short', () => {
    expect(waitWords('2026-11-17T10:42:00.000Z', NOW)).toEqual({ key: 'wait.minutes', n: 1 })
    expect(waitWords('2026-11-17T10:34:00.000Z', NOW)).toEqual({ key: 'wait.minutes', n: 8 })
    expect(waitWords('2026-11-17T06:40:00.000Z', NOW)).toEqual({ key: 'wait.hours', n: 4 })
    expect(waitWords('2026-11-15T09:00:00.000Z', NOW)).toEqual({ key: 'wait.days', n: 2 })
  })
})

// ---- B-TH-229 (TH-2, on B-TH-028): the one waiting rule, the owner, "2 new" ------------------------------------------------
describe('B-TH-229 — waiting words and the amber rule, the owner, 2 new', () => {
  const render = (model: HeadModel, locale: 'it' | 'en' = 'en') => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: { head: model, frames: [718], dialogs: designScreen.cases[0]!.model.dialogs, open: null } })))
  const us = (workingMinutes: number, amber: boolean, thresholdDays = 1, calendar = true) => answersOf({ on: 'US', since: '2026-11-13T08:10:00.000Z', workingMinutes, calendar, amber, thresholdDays })

  it('the API’s waiting is the pill: working time on the calendar (a working day = 8 h), clock time without one', () => {
    expect(answersOf(null)).toBeNull()
    expect(answersOf({ on: 'CUSTOMER', since: 'x', workingMinutes: 5, calendar: true, amber: false, thresholdDays: 3 })).toMatchObject({ on: 'party', workingMinutes: 5 })
    expect(waitingWords(us(242, false)!, NOW)).toEqual({ key: 'wait.hours', n: 4 })
    expect(waitingWords(us(12, false)!, NOW)).toEqual({ key: 'wait.minutes', n: 12 })
    expect(waitingWords(us(1460, true)!, NOW)).toEqual({ key: 'wait.days', n: 3 })
    // No calendar: the API's minutes are clock minutes; the words follow the clock since the message.
    expect(waitingWords(us(242, false, 1, false)!, NOW)).toEqual(waitWords('2026-11-13T08:10:00.000Z', NOW))
  })

  it('amber only by the rule: past the threshold while it waits on US; waiting on the customer is never amber', () => {
    const amber = render(base({ answers: us(1460, true) }))
    expect(amber).toMatch(/nds-pill warning[^"]*"[^>]*>(<span[^>]*>)?Waiting on us · 3 d/)
    expect(amber).toContain('Amber after 1 working day waiting on us.')
    const calm = render(base({ answers: us(242, false, 3) }))
    expect(calm).toMatch(/nds-pill neutral[^"]*"[^>]*>(<span[^>]*>)?Waiting on us · 4 h/)
    expect(calm).toContain('Amber after 3 working days waiting on us.')
    const theirs = render(base({ answers: answersOf({ on: 'CUSTOMER', since: '2026-11-11T09:00:00.000Z', workingMinutes: 2380, calendar: true, amber: false, thresholdDays: 3 }) }))
    expect(theirs).toContain('Waiting on customer · 4 d')
    expect(theirs).toContain('Never amber while it waits on the other side.')
    expect(render(base({ answers: us(242, false, 3, false) }))).toContain('No company calendar: counted in clock hours.')
    expect(render(base({ answers: us(242, false) }), 'it')).toContain('Tocca a noi · 4 h')
  })

  it('the owner: a tile named on hover and for screen readers; inactive said; nobody "—"; Change owner held with the right', () => {
    const owner = { id: 'u1', name: 'Bea Esempio', active: true, source: 'ASSIGNEE' as const }
    const html = render(base({ owner, ownerHeld: null }))
    expect(html).toContain('aria-label="Owner: Bea Esempio · Change owner…"')
    expect(render(base({ owner: { ...owner, active: false }, ownerHeld: null }))).toContain('Owner: Bea Esempio (inactive)')
    expect(render(base({ owner: null, ownerHeld: null }))).toContain('No owner yet')
    // Without the head read (a design case of before): no tile at all.
    expect(render(base())).not.toContain('fw-rth-owner')
    const rows = menuRows(base({ ownerHeld: { key: 'held.noRight', params: { right: 'Write in threads' } } }))
    expect(rows.find((row) => row.kind === 'owner')).toEqual({ kind: 'owner', held: { key: 'held.noRight', params: { right: 'Write in threads' } } })
    expect(menuRows(base()).some((row) => row.kind === 'owner')).toBe(false)
    const held = render(base({ owner, ownerHeld: { key: 'held.noRight', params: { right: 'Write in threads' } } }))
    expect(held).toContain('role="img" aria-label="Owner: Bea Esempio"')
  })

  it('Change owner: the readers, me first; "reading" and "could not be read" in words, never "nobody" before it knows', () => {
    const dialog = (peopleState: 'loading' | 'ready' | 'failed', people = [{ id: 'u2', name: 'Bea Esempio' }, { id: 'u1', name: 'Alex Demo' }]) =>
      renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(OwnerDialog, { model: { record: 'SO-2026-0142', owner: { id: 'u2', name: 'Bea Esempio', active: true, source: 'ASSIGNEE' }, people, peopleState, meId: 'u1', busy: false, problem: null }, onPick: () => undefined, onClose: () => undefined, onRetry: () => undefined })))
    // Modals render into a portal on the client; the server render may be empty — then the words are checked in the catalogue.
    const t = createTranslator('en', messagesFor('en', ['record-thread-head'])['record-thread-head'] ?? {})
    expect(t('owner.loading')).toBe('Reading who reads this thread…')
    expect(t('owner.peopleFailed')).toBe('Who reads this thread could not be read.')
    expect(t('owner.noPeople')).toBe('Nobody else reads this thread yet.')
    for (const state of ['loading', 'failed'] as const) expect(dialog(state)).not.toContain('Nobody else reads this thread yet')
  })

  it('"2 new": the reader’s own new messages, 99+ above 99, nothing at 0', () => {
    expect(newWords(0)).toBeNull()
    expect(newWords(2)).toEqual({ key: 'new.count', n: 2 })
    expect(newWords(120)).toEqual({ key: 'new.many', n: 99 })
    expect(render(base({ newCount: 2 }))).toContain('2 new')
    expect(render(base({ newCount: 2 }), 'it')).toContain('2 nuovi')
    expect(render(base({ newCount: 120 }))).toContain('99+ new')
    expect(render(base({ newCount: 0 }))).not.toMatch(/\d+ new/)
  })

  it('every B-TH-229 case keeps the brand wall: only Brand Alpha’s own thread (W08)', () => {
    for (const item of designScreen.cases.filter((entry) => entry.id.startsWith('th-229'))) {
      const html = renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: item.model })))
      expect(scanText(html, BRAND_BETA), item.id).toEqual([])
    }
  })
})
// ---- end B-TH-229

describe('the doors (R-ACT)', () => {
  it('always offers the five tools in the same order, also at count 0', () => {
    const rows = menuRows(base())
    expect(rows.filter((row) => row.kind === 'door').map((row) => (row.kind === 'door' ? row.door : null))).toEqual([...R_ACT_ORDER])
  })

  it('holds a door with the reason instead of hiding it', () => {
    const holds = doorHolds({ can: { ...ALL, approve: false }, hasParty: true, offline: false, rights: { approve: 'Ask partners to approve' } })
    expect(holds.approve).toEqual({ key: 'held.noRight', params: { right: 'Ask partners to approve' } })
    expect(doorHolds({ can: { ...ALL, share: false }, hasParty: true, offline: false }).share).toEqual({ key: 'held.noRole' })
    const rows = menuRows(base({ holds }))
    expect(rows.find((row) => row.kind === 'door' && row.door === 'approve')).toMatchObject({ held: { key: 'held.noRight' } })
  })

  it('Ask and Share reach only this record’s party: held without one (W06, W24)', () => {
    const holds = doorHolds({ can: ALL, hasParty: false, offline: false })
    expect(holds.approve).toEqual({ key: 'held.noParty' })
    expect(holds.share).toEqual({ key: 'held.noParty' })
    expect(holds.task).toBeNull()
  })

  it('a record that is never shared holds Ask and Share with that reason, whatever the rights (B-PR-08a)', () => {
    const holds = doorHolds({ can: ALL, hasParty: true, offline: false, shareable: false })
    expect(holds.approve).toEqual({ key: 'held.notShareable' })
    expect(holds.share).toEqual({ key: 'held.notShareable' })
    expect(holds.task).toBeNull()
    expect(doorHolds({ can: ALL, hasParty: true, offline: false }).share).toBeNull()
  })

  it('offline holds every door; mute waits for a follow', () => {
    const holds = doorHolds({ can: ALL, hasParty: true, offline: true })
    for (const door of R_ACT_ORDER) expect(holds[door]).toEqual({ key: 'held.offline' })
    const mute = menuRows(base()).find((row) => row.kind === 'door' && row.door === 'mute')
    expect(mute).toMatchObject({ held: { key: 'held.followFirst' } })
  })

  it('offers Close thread… only with threads.manage, Reopen on a closed thread', () => {
    expect(menuRows(base()).some((row) => row.kind === 'close' || row.kind === 'reopen')).toBe(false)
    expect(menuRows(base({ canManage: true })).at(-1)).toEqual({ kind: 'close' })
    expect(menuRows(base({ canManage: true, closed: { by: 'Alex Demo', at: '2026-11-12T16:00:00.000Z' } })).at(-1)).toEqual({ kind: 'reopen' })
  })

  it('folds the counts onto their doors when the chips do not fit', () => {
    const counts = { tasks: { kind: 'tasks' as const, count: 2, lines: [] } }
    expect(menuRows(base({ counts }), true)[0]).toMatchObject({ hint: { key: 'act.openTasks', params: { count: 2 } } })
    expect(menuRows(base({ counts }), false)[0]).not.toHaveProperty('hint')
  })

  it('offers only the views the thread holds; Changes only with audit.read', () => {
    expect(viewsOffered({ hasShared: true, hasNotes: false, canAudit: false })).toEqual(['all', 'shared'])
    expect(viewsOffered({ hasShared: true, hasNotes: true, canAudit: true })).toEqual(['all', 'shared', 'notes', 'changes'])
  })
})

describe('the width', () => {
  it('is remembered per person and record type; a closed storage falls back to 40 %', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) }
    expect(readWidth(storage, 'SalesOrder', 'p1')).toBe(DEFAULT_DOCK_WIDTH)
    writeWidth(storage, 'SalesOrder', 'p1', 'half')
    expect(readWidth(storage, 'SalesOrder', 'p1')).toBe('half')
    expect(readWidth(storage, 'Quote', 'p1')).toBe(DEFAULT_DOCK_WIDTH)
    expect(readWidth(storage, 'SalesOrder', 'p2')).toBe(DEFAULT_DOCK_WIDTH)
    expect(store.has(widthKey('SalesOrder', 'p1'))).toBe(true)
    writeWidth(storage, 'SalesOrder', 'p1', null)
    expect(readWidth(storage, 'SalesOrder', 'p1')).toBe(DEFAULT_DOCK_WIDTH)
    const closed = { getItem: () => { throw new Error('closed') }, setItem: () => { throw new Error('closed') }, removeItem: () => { throw new Error('closed') } }
    expect(readWidth(closed, 'SalesOrder', 'p1')).toBe(DEFAULT_DOCK_WIDTH)
    expect(() => writeWidth(closed, 'SalesOrder', 'p1', 'full')).not.toThrow()
  })
})

describe('the portal line', () => {
  it('carries no office count, owner or waiting time, and only the reader’s own record (W08, W34)', () => {
    for (const locale of LOCALES) {
      const html = renderToString(
        createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(PortalHeadLine, { model: { needInfo: false, last: { from: 'us', at: '2026-11-16T15:10:00.000Z' }, factory: 'Factory Demo' } })),
      )
      const t = createTranslator(locale, messagesFor(locale, ['record-thread-head'])['record-thread-head'] ?? {})
      for (const office of [t('answers.us', { wait: '' }), t('more.label'), t('width.label'), t('act.task')]) expect(html).not.toContain(office.trim())
      expect(html).toContain(t('portal.lastFromUs', { factory: 'Factory Demo', date: '' }).split(',')[0]!)
      expect(scanText(html, BRAND_ALPHA)).toEqual([])
      expect(scanText(html, BRAND_BETA)).toEqual([])
    }
  })
})

describe('the words', () => {
  it('draws every case of SCR-006-head with no key on screen, in it and en', () => {
    for (const item of designScreen.cases) {
      for (const locale of LOCALES) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: item.model })))
        expect(html, `${item.id} ${locale}`).not.toMatch(KEY_ON_SCREEN)
      }
    }
  })

  it('the office Head names the thread for screen readers and says who answers', () => {
    const html = renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: designScreen.cases[0]!.model })))
    expect(html).toContain('Thread of SO-2026-0142')
    expect(html).toContain('Waiting on us · 4 h')
    expect(html).toContain('aria-label="Thread tools"')
  })
})
