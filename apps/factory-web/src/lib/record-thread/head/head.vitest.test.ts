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
import { answersOf, waitingWords } from './model'
import { OwnerDialog } from './view/OwnerDialog'
import { readWidth, writeWidth } from './use-thread-width'
// B-TH-255
import { viewQuery } from './model'
import { feedKinds } from '../model'
// F-SA-263
import { readFileSync } from 'node:fs'
import { CATALOGUE } from '../../i18n/messages'
import { hiddenKey } from './model'
import { isRemembered, readHidden, writeHidden } from './use-thread-width'

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

  // tw- W2.1 (10-design §8): the waiting is words in the head's ONE line (amber by the rule), the rule for screen readers beside it.
  it('amber only by the rule: past the threshold while it waits on US; waiting on the customer is never amber', () => {
    const amber = render(base({ answers: us(1460, true) }))
    expect(amber).toMatch(/class="fw-rth-linepart is-wait is-amber"[^>]*>Waiting on us · 3 d</)
    expect(amber).toContain('Amber after 1 working day waiting on us.')
    const calm = render(base({ answers: us(242, false, 3) }))
    expect(calm).toMatch(/class="fw-rth-linepart is-wait"[^>]*>Waiting on us · 4 h</)
    expect(calm).toContain('Amber after 3 working days waiting on us.')
    const theirs = render(base({ answers: answersOf({ on: 'CUSTOMER', since: '2026-11-11T09:00:00.000Z', workingMinutes: 2380, calendar: true, amber: false, thresholdDays: 3 }) }))
    expect(theirs).toContain('Waiting on the customer · 4 d')
    expect(theirs).toContain('Never amber while it waits on the other side.')
    expect(render(base({ answers: us(242, false, 3, false) }))).toContain('No company calendar: counted in clock hours.')
    expect(render(base({ answers: us(242, false) }), 'it')).toContain('Tocca a noi · 4 h')
  })

  // tw- W2.1: the owner is words in the line ("Owner: Bea Esempio"); Change owner… is a row of the ⋮, held with the right.
  it('the owner: said in the line; inactive said; nobody "No owner yet"; Change owner held with the right', () => {
    const owner = { id: 'u1', name: 'Bea Esempio', active: true, source: 'ASSIGNEE' as const }
    expect(render(base({ owner, ownerHeld: null }))).toContain('<span class="fw-rth-linepart is-owner">Owner: Bea Esempio</span>')
    expect(render(base({ owner: { ...owner, active: false }, ownerHeld: null }))).toContain('Owner: Bea Esempio (inactive)')
    expect(render(base({ owner: null, ownerHeld: null }))).toContain('No owner yet')
    // Without the head read (a design case of before): no owner words at all.
    expect(render(base())).not.toMatch(/Owner:|No owner yet/)
    const rows = menuRows(base({ ownerHeld: { key: 'held.noRight', params: { right: 'Write in threads' } } }))
    expect(rows.find((row) => row.kind === 'owner')).toEqual({ kind: 'owner', held: { key: 'held.noRight', params: { right: 'Write in threads' } } })
    expect(menuRows(base()).some((row) => row.kind === 'owner')).toBe(false)
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

  // tw- W2.1 (P12): ONE unread count — the feed's band and its down button; the head's "N new" pill went.
  it('no "N new" pill in the head (P12: one unread count, in the feed)', () => {
    expect(render(base({ answers: us(242, false) }))).not.toMatch(/\d+ new|99\+ new/)
    expect(readFileSync(new URL('./view/RecordThreadHead.tsx', import.meta.url), 'utf8')).not.toMatch(/newWords|newCount/)
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
  // tw- W2.1 (10-design §8): ONE order in the ⋮ — Follow · Mute · Remind me · (Change owner) · Ask · Share · Followers · Add task.
  it('always offers the five tools in ONE order, also at count 0', () => {
    const rows = menuRows(base())
    expect(rows.filter((row) => row.kind === 'door').map((row) => (row.kind === 'door' ? row.door : null))).toEqual(['follow', 'mute', 'remind', 'approve', 'share', 'followers', 'task'])
    expect([...R_ACT_ORDER].sort()).toEqual(['approve', 'follow', 'followers', 'mute', 'remind', 'share', 'task'])
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

  // ---- TH-5 follow-up (B-TH-249, PROJ.record-F04): a closed project reopens its thread from its own band (one command); the API refuses
  // the thread's own Reopen, so the head never offers it — closing an open project's thread stays as it was.
  it('a closed project: no Reopen in the head (neither the ⋯ line nor the closed line\'s button); Close thread stays on an open one', () => {
    const render = (model: HeadModel) => renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: { head: model, frames: [718], dialogs: designScreen.cases[0]!.model.dialogs, open: null } })))
    const closed = { by: 'Alex Demo', at: '2026-11-12T16:00:00.000Z' }
    expect(menuRows(base({ canManage: true, closed, reopenWithRecord: true })).some((row) => row.kind === 'reopen' || row.kind === 'close')).toBe(false)
    expect(menuRows(base({ canManage: true, reopenWithRecord: true })).at(-1)).toEqual({ kind: 'close' })
    const html = render(base({ canManage: true, closed, reopenWithRecord: true }))
    expect(html).toContain('Closed by Alex Demo')
    expect(html).not.toContain('>Reopen<')
    // tw- W2.1: Reopen is the ⋮'s last row on a closed thread (the head is one row; its line says Closed by …).
    expect(menuRows(base({ canManage: true, closed })).at(-1)).toEqual({ kind: 'reopen' })
    expect(render(base({ canManage: true, closed }))).toContain('Closed by Alex Demo')
  })
  // ---- end TH-5 follow-up

  // tw- W2.1: the counts are words on their rows ("Add task · 2 open"), never chips in the row.
  it('says the counts on their rows of the ⋮; a count of 0 says nothing', () => {
    const counts = { tasks: { kind: 'tasks' as const, count: 2, lines: [] } }
    expect(menuRows(base({ counts })).find((row) => row.kind === 'door' && row.door === 'task')).toMatchObject({ count: { key: 'act.openTasks', params: { count: 2 } } })
    expect(menuRows(base()).find((row) => row.kind === 'door' && row.door === 'task')).not.toHaveProperty('count')
    expect(readFileSync(new URL('./view/RecordThreadHead.tsx', import.meta.url), 'utf8')).not.toContain('CountPopover')
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

  // ---- F-SA-263 (10-order-page §6.3): "hidden" per person + record type; a private window (closed storage) keeps nothing and never
  // throws. F-OP-301 (walk #5): the chosen width is ONE per person + record type on every tab.
  const memory = () => {
    const store = new Map<string, string>()
    return { store, storage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) } }
  }
  const closedStorage = { getItem: () => { throw new Error('closed') }, setItem: () => { throw new Error('closed') }, removeItem: () => { throw new Error('closed') } }

  it('F-OP-301: a width chosen on any tab is the record type’s one width (never a `.tab` key); "Default width" forgets it', () => {
    const { store, storage } = memory()
    writeWidth(storage, 'SalesOrder', 'p1', 'half')
    expect([...store.keys()]).toEqual([widthKey('SalesOrder', 'p1')])
    expect(readWidth(storage, 'SalesOrder', 'p1')).toBe('half')
    expect(isRemembered(storage, 'SalesOrder', 'p1')).toBe(true)
    // Another person, another record type: nothing chosen there.
    expect(isRemembered(storage, 'SalesOrder', 'p2')).toBe(false)
    expect(isRemembered(storage, 'Quote', 'p1')).toBe(false)
    writeWidth(storage, 'SalesOrder', 'p1', null)
    expect(isRemembered(storage, 'SalesOrder', 'p1')).toBe(false)
    expect(store.size).toBe(0)
    expect(isRemembered(closedStorage, 'SalesOrder', 'p1')).toBe(false)
    expect(() => writeWidth(closedStorage, 'SalesOrder', 'p1', 'half')).not.toThrow()
  })

  it('F-SA-263: "hidden" is kept per person + record type (any tab, the next order too); showing forgets it; a private window keeps nothing', () => {
    const { store, storage } = memory()
    expect(readHidden(storage, 'SalesOrder', 'p1')).toBe(false)
    writeHidden(storage, 'SalesOrder', 'p1', true)
    expect(readHidden(storage, 'SalesOrder', 'p1')).toBe(true)
    expect(store.get(hiddenKey('SalesOrder', 'p1'))).toBe('1')
    expect(readHidden(storage, 'SalesOrder', 'p2')).toBe(false)
    expect(readHidden(storage, 'Quote', 'p1')).toBe(false)
    writeHidden(storage, 'SalesOrder', 'p1', false)
    expect(readHidden(storage, 'SalesOrder', 'p1')).toBe(false)
    expect(store.has(hiddenKey('SalesOrder', 'p1'))).toBe(false)
    expect(readHidden(closedStorage, 'SalesOrder', 'p1')).toBe(false)
    expect(() => writeHidden(closedStorage, 'SalesOrder', 'p1', true)).not.toThrow()
  })

  it('F-SA-263: the hook keeps "hidden" only when asked (and never on a page that docks closed); ⌘J, show and a width choice write it', () => {
    const hook = readFileSync(new URL('./use-thread-width.ts', import.meta.url), 'utf8')
    expect(hook).toContain('const rememberHidden = (options.rememberHidden ?? false) && !options.startHidden')
    expect(hook).toMatch(/if \(rememberHidden\) writeHidden\(storageOf\(\), recordType, personId, next\)\s*setHiddenNow\(next\)/)
    expect(hook).toContain('const toggle = useCallback(() => setHidden(!hiddenNow.current), [setHidden])')
    expect(hook).toContain('const show = useCallback(() => setHidden(false), [setHidden])')
    // F-OP-301: the record type's one width, read before paint (never per tab).
    expect(hook).toMatch(/useLayoutEffect\(\(\) => \{\s*setWidth\(readWidth\(storageOf\(\), recordType, personId\)\)/)
    expect(hook).not.toContain('tabWidthKey')
  })

  it('F-SA-263: the menu’s reset line says "Default width" / "Larghezza predefinita"', () => {
    expect(CATALOGUE.en['record-thread-head']?.['width.reset']).toBe('Default width')
    expect(CATALOGUE.it['record-thread-head']?.['width.reset']).toBe('Larghezza predefinita')
  })
  // ---- end F-SA-263
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

// ---- B-TH-255 (B-TH-079, T1-F05): the View — the choices the thread holds, the chip, and what it asks the API ----------------
describe('B-TH-255 — the View filters by audience: choices by what the thread holds, a chip, the API asked for what it hides', () => {
  const render = (model: HeadModel, locale: 'it' | 'en' = 'en') => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: { head: model, frames: [718], dialogs: designScreen.cases[0]!.model.dialogs, open: null } })))

  it('the view as the API reads it: With the customer = PARTNER, Office notes = OFFICE, Changes = the steps only; All asks nothing', () => {
    expect(viewQuery('shared')).toEqual({ audience: 'PARTNER', kinds: 'message' })
    expect(viewQuery('notes')).toEqual({ audience: 'OFFICE', kinds: 'message' })
    expect(viewQuery('changes')).toEqual({ audience: 'ALL', kinds: 'change' })
    expect(viewQuery('all')).toBeNull()
  })

  it('a choice whose kind the thread lacks is not offered (a thread of shared messages only: no Office notes; notes only: no With the customer)', () => {
    expect(viewsOffered({ ...feedKinds([{ kind: 'theirs' }, { kind: 'ours' }]), canAudit: false })).toEqual(['all', 'shared'])
    expect(viewsOffered({ ...feedKinds([{ kind: 'note' }, { kind: 'floor' }]), canAudit: false })).toEqual(['all', 'notes'])
    expect(viewsOffered({ ...feedKinds([]), canAudit: false })).toEqual(['all'])
    // One choice only (All): no Show rows in the ⋮; with more, a radio row each.
    expect(menuRows(base({ views: ['all'] })).some((row) => row.kind === 'view')).toBe(false)
    expect(menuRows(base({ views: ['all', 'shared'] })).filter((row) => row.kind === 'view')).toEqual([{ kind: 'view', view: 'all', checked: true }, { kind: 'view', view: 'shared', checked: false }])
  })

  // tw- W2.1 (10-design §8): the head's line names the View ("Showing With the customer · Show all"); none on All.
  it('the line names the active view (the party kind’s own words) with Show all; none on All', () => {
    const supplier = textOf(render(base({ party: { name: 'Supplier Demo', role: 'supplier' }, view: 'shared', views: ['all', 'shared'] })))
    expect(supplier).toContain('Showing With the supplier · Show all')
    expect(textOf(render(base({ view: 'notes', views: ['all', 'shared', 'notes'] }), 'it'))).toContain("Mostro Note d'ufficio · Mostra tutto")
    expect(render(base())).not.toContain('Show all')
  })

  it('the hidden-new line belongs to the feed (record-thread-feed), in both languages with the same placeholders', () => {
    for (const locale of LOCALES) {
      const words = messagesFor(locale, ['record-thread-feed'])['record-thread-feed'] ?? {}
      expect(words['hidden.line_one'], locale).toContain('{count}')
      expect(words['hidden.line_other'], locale).toContain('{count}')
      expect(words['hidden.showAll'], locale).toBeTruthy()
    }
  })

  it('the design case of a supplier’s View draws with no key left, in it and en', () => {
    const item = designScreen.cases.find((entry) => entry.id === 'th-255-view-supplier')!
    for (const locale of LOCALES) {
      const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: item.model })))
      expect(html).not.toMatch(KEY_ON_SCREEN)
    }
  })
})
// ---- end B-TH-255

// ---- B-TH-288 (B-TH-093 Done, B-TH-097 search; T1-F08, T1-F13; walls W08, W28) ----------------------------------------------------
import { hitSideKey, markWords, searchReady, type ThreadSearchModel } from './model'
import { RecordThreadHead } from './view/RecordThreadHead'
import { render as drawAll, textOf } from '../parts/testing'

describe('B-TH-288 — Done and search in the thread head', () => {
  const head = (over: Partial<HeadModel> = {}, locale: 'it' | 'en' = 'en') => drawAll(createElement(RecordThreadHead, { model: base(over) }), locale)
  const search = (over: Partial<ThreadSearchModel> = {}): ThreadSearchModel => ({ open: true, query: 'collar', state: 'ready', hits: [{ id: 'm-1', excerpt: 'Collar in yellow piping', direction: 'INBOUND' }], total: 1, words: ['collar'], ...over })

  it('the ⋯ offers Mark done on open work and Open again on done work, held with why; never on a closed thread', () => {
    expect(menuRows(base({ done: null, doneHeld: null }))).toContainEqual({ kind: 'done', done: false, held: null })
    expect(menuRows(base({ done: { at: '2026-11-17T09:00:00.000Z', by: 'Alex Demo' }, doneHeld: null }))).toContainEqual({ kind: 'done', done: true, held: null })
    expect(menuRows(base({ done: null, doneHeld: { key: 'held.offline' } }))).toContainEqual({ kind: 'done', done: false, held: { key: 'held.offline' } })
    expect(menuRows(base({ done: null, closed: { by: 'Alex Demo', at: '2026-11-16T09:00:00.000Z' } })).some((row) => row.kind === 'done')).toBe(false)
    // Not offered at all until the office read says it (a design case without it, a portal line).
    expect(menuRows(base()).some((row) => row.kind === 'done')).toBe(false)
  })

  it('done work says Done with who and when — not closed: the customer can still write — in it and en', () => {
    const done = { at: '2026-11-17T09:00:00.000Z', by: 'Alex Demo' }
    expect(textOf(head({ done, answers: null }))).toContain('Done · Alex Demo')
    expect(textOf(head({ done, answers: null }, 'it'))).toContain('Fatta · Alex Demo')
    const words = createTranslator('en', messagesFor('en', ['record-thread-head'])['record-thread-head'] ?? {})
    expect(words('act.doneHint')).toMatch(/not closed/)
    expect(words('done.tip')).toMatch(/can still write/)
    // A closed thread says Closed, never Done.
    expect(textOf(head({ done, closed: { by: 'Alex Demo', at: '2026-11-16T09:00:00.000Z' } }))).not.toContain('Done ·')
  })

  it('search is offered to the office only: the icon when the container offers it, the field over the row when open', () => {
    expect(head({ search: null })).not.toContain('fw-rth-search')
    const closed = head({ search: search({ open: false, query: '', state: 'idle', hits: [], total: 0, words: [] }) })
    expect(textOf(closed)).not.toContain('Messages that match')
    expect(closed).toContain('aria-keyshortcuts="/"')
    const open = head({ search: search() })
    expect(open).toContain('fw-rth is-searching')
    expect(open).toContain('role="search"')
    expect(textOf(open)).toContain('1 message matches')
    expect(open).toContain('<mark>Collar</mark>')
    // tw- W2.1 (P0-B1): the icon fits every head, the phone's too (Files · Search · ⓘ · ⋮).
    expect(head({ compact: true, search: search({ open: false, query: '', state: 'idle', hits: [], total: 0, words: [] }) })).toContain('aria-keyshortcuts="/"')
  })

  it('says every state in words: hint, too short, searching, none, failed — in it and en, no key left on screen', () => {
    for (const locale of ['en', 'it'] as const) {
      for (const state of ['idle', 'short', 'searching', 'failed'] as const) {
        const html = head({ search: search({ state, hits: [], total: 0 }) }, locale)
        expect(textOf(html)).not.toMatch(/\bsearch\.[a-zA-Z]/)
      }
      expect(textOf(head({ search: search({ hits: [], total: 0 }) }, locale))).toContain(locale === 'en' ? 'No message has these words.' : 'Nessun messaggio contiene queste parole.')
    }
  })

  it('marks the query’s words in a hit (case and accents aside) and names the hit’s side', () => {
    expect(markWords('Collar in yellow piping', ['collar', 'PIPING'])).toEqual([
      { text: 'Collar', hit: true },
      { text: ' in yellow ', hit: false },
      { text: 'piping', hit: true },
    ])
    expect(markWords('Colletto giallo', ['GIALLÒ'.normalize('NFC')]).some((part) => part.hit)).toBe(true)
    expect(markWords('anything', [])).toEqual([{ text: 'anything', hit: false }])
    expect(hitSideKey('INBOUND')).toBe('search.side.theirs')
    expect(hitSideKey('OUTBOUND')).toBe('search.side.ours')
    expect(hitSideKey('INTERNAL_NOTE')).toBe('search.side.note')
    expect(hitSideKey(null)).toBe('search.side.other')
    expect(searchReady('a')).toBe(false)
    expect(searchReady(' ab ')).toBe(true)
  })

  it('a follow-up reminder says “if no answer” on the Remind me line', () => {
    const rows = menuRows(base({ reminder: { at: '2026-11-20T09:00:00.000Z', followUp: true } }))
    expect(rows.find((row) => row.kind === 'door' && row.door === 'remind')).toMatchObject({ count: { key: 'act.followUpSet' } })
    expect(menuRows(base({ reminder: { at: '2026-11-20T09:00:00.000Z' } })).find((row) => row.kind === 'door' && row.door === 'remind')).toMatchObject({ count: { key: 'act.reminderSet' } })
  })
})
// ---- end B-TH-288

// ---- F-OP-204 (order page plan N4; 11-dock §1, §3.1; D6): ONE width menu — the thread's Head and All of <Customer>'s Head draw it ------
describe('F-OP-204 / tw- T.0 — the width is ONE behaviour: ⋮ › Width in the thread Head and in All of <Customer>’s Head', () => {
  const draw = (node: ReturnType<typeof createElement>) => renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, node))
  it('no width button anywhere: the WidthMenu part is gone; All of’s Head builds its ⋮ › Width from the same DOCK_WIDTHS', () => {
    const feed = readFileSync(new URL('../../../areas/_shared/record-thread/all-of-customer/view/FeedHead.tsx', import.meta.url), 'utf8')
    expect(feed).not.toContain('WidthMenu')
    expect(feed).toContain("{ id: 'width-heading', heading: true, label: th('width.title') }")
    expect(feed).toContain('...DOCK_WIDTHS.map((choice) => ({ id: `width-${choice}`')
    expect(feed).toContain("{ id: 'width-hide', label: th('width.hide')")
    expect(feed).toContain("{ id: 'width-reset', label: th('width.reset')")
  })
  // tw- W2.1 (10-design §8): the width is a part of the ⋮ (Width: the four widths, Hide, Default width) — ONE list, from the model.
  it('the thread Head says the widths in its ⋮, from ONE list (DOCK_WIDTHS through menuRows); none without a dock', () => {
    const rows = menuRows(base()).filter((row) => row.kind === 'width')
    expect(rows.map((row) => (row.kind === 'width' ? row.width : null))).toEqual(['third', 'forty', 'half', 'full', 'hide', 'reset'])
    expect(rows.find((row) => row.kind === 'width' && row.width === 'forty')).toMatchObject({ checked: true })
    expect(menuRows(base({ width: null })).some((row) => row.kind === 'width')).toBe(false)
    const head = readFileSync(new URL('./view/RecordThreadHead.tsx', import.meta.url), 'utf8')
    expect(head).not.toContain('<WidthMenu')
    expect(head).not.toContain('DOCK_WIDTHS')
    expect(draw(createElement(RecordThreadHead, { model: base() }))).not.toContain('aria-label="Thread width"')
  })
})
// ---- end F-OP-204

// ---- F-OP-216 (order page plan N4; 11-dock §6.3, §6.4, §8; review R-21): the dock's words — the Head's pill names the thread, All of
// <Customer> says "thread" (tw- W2.5: in Italian too), the door is "Answer in its thread" ----------------
describe('F-OP-216 — the dock\'s words, one word each, the same keys in both languages', () => {
  const flat = (tree: Record<string, unknown>, prefix = ''): Record<string, string> =>
    Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value]] : Object.entries(flat(value as Record<string, unknown>, `${prefix}${key}.`)))))
  const catalogue = (locale: 'en' | 'it', name: string) => flat(JSON.parse(readFileSync(new URL(`../../../../messages/${locale}/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>)
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',')

  // tw- W2.1 (10-design §13): the head's line says whose turn it is, in THIS thread's head ("Waiting on us · 2 d" / "Tocca a noi · 2 g").
  it('the Head\'s line says whose turn it is in THIS thread (R-21: the dock never shows an order-level count)', () => {
    const en = catalogue('en', 'record-thread-head')
    const it = catalogue('it', 'record-thread-head')
    for (const side of ['us', 'customer', 'supplier', 'partner']) {
      expect(en[`answers.${side}`], side).toMatch(/^Waiting on (us|the (customer|supplier|partner)) · \{wait\}$/)
      expect(it[`answers.${side}`], side).toMatch(/^Tocca (a noi|al (cliente|fornitore|partner)) · \{wait\}$/)
    }
    const t = createTranslator('en', messagesFor('en', ['record-thread-head'])['record-thread-head']!)
    expect(t('answers.customer', { wait: '2 d' })).toBe('Waiting on the customer · 2 d')
    // The order dock draws no waiting of its own (the order band and Overview own the order's).
    const dock = readFileSync(new URL('../../../areas/sales/orders/record/dock/OrderDock.tsx', import.meta.url), 'utf8')
    expect(dock).not.toMatch(/waitingOf|requests\.onUs|answers\./)
  })

  // tw- W2.5 (§13: one word set): All of <Customer> says "thread" in both languages now — never "conversation" / "conversazione".
  it('All of <Customer> says "thread" in both languages, never "conversation" / "conversazione"', () => {
    const en = Object.entries(catalogue('en', 'record-thread')).filter(([key]) => key.startsWith('allOfCustomer.'))
    expect(en.length).toBeGreaterThan(20)
    for (const [key, text] of en) expect(text, key).not.toMatch(/conversation/i)
    expect(Object.fromEntries(en)['allOfCustomer.kind.GENERAL']).toBe('General thread')
    expect(Object.fromEntries(en)['allOfCustomer.line']).toContain('To write, pick one thread.')
    const it = Object.fromEntries(Object.entries(catalogue('it', 'record-thread')).filter(([key]) => key.startsWith('allOfCustomer.')))
    for (const [key, text] of Object.entries(it)) expect(text, key).not.toMatch(/conversazion/i)
    expect(it['allOfCustomer.line']).toContain('Per scrivere, scegli un thread.')
    expect(it['allOfCustomer.readOnly']).toBe('Sola lettura: per scrivere, scegli un thread.')
    expect(Object.fromEntries(en)['allOfCustomer.feedLabel']).toBe('Messages with {customer}, oldest first')
  })

  // tw- W2.5 (10-design §9): the door is the bubble's menu row "Answer in its thread" / "Rispondi nel suo thread".
  it('the door is "Answer in its thread" / "Rispondi nel suo thread" — a row of each bubble’s menu', () => {
    const en = catalogue('en', 'record-thread-card')
    const it = catalogue('it', 'record-thread-card')
    expect(en['menu.answerThere']).toBe('Answer in its thread')
    expect(it['menu.answerThere']).toBe('Rispondi nel suo thread')
    expect(catalogue('en', 'record-thread')['allOfCustomer.answer']).toBeUndefined()
  })

  it('catalogue parity: the same keys and the same placeholders in en and it (the Head, All of <Customer>, the frame\'s keys)', () => {
    for (const [name, prefix] of [['record-thread-head', ''], ['record-thread', 'allOfCustomer.'], ['record-frame', 'keys.']] as const) {
      const en = catalogue('en', name)
      const it = catalogue('it', name)
      const keys = (all: Record<string, string>) => Object.keys(all).filter((key) => key.startsWith(prefix)).sort()
      expect(keys(it), name).toEqual(keys(en))
      for (const key of keys(en)) expect(placeholders(it[key]!), `${name} ${key}`).toBe(placeholders(en[key]!))
    }
  })
})
// ---- end F-OP-216

// ---- tw- W2.1 (THE THREAD REBUILD; 10-design §8; W-080 / W-081, Z7, Z14, R12): the head's one row, the ⓘ, the Files icon, the pinned bar ----
import { BAR_MARKS, barPinsOf, barState, barWords, type PinInput } from './pins-bar'
import { PinnedBar } from './view/PinnedBar'
import { HEAD_KEYS, headLine } from './model'

describe('tw- W2.1 — the head: ONE row (title + one line · Files · Search · ⓘ · ⋮), every control inside a 433 px dock (P0-B1)', () => {
  const head = (over: Partial<HeadModel> = {}, locale: 'it' | 'en' = 'en') => drawAll(createElement(RecordThreadHead, { model: base(over) }), locale)

  it('the right holds only Files · Search · ⓘ · ⋮ — no pill, no chip, no View chip, no width menu, no owner tile in the row', () => {
    const html = head({ files: { count: 4 }, search: { open: false, query: '', state: 'idle', hits: [], total: 0, words: [] } })
    const tools = html.slice(html.indexOf('class="fw-rth-tools"'))
    expect(tools.match(/<button/g)?.length).toBe(4)
    expect(tools).toContain('aria-label="Files (4)"')
    expect(tools).toContain('aria-keyshortcuts="/"')
    expect(tools).toContain('fw-rth-keys')
    expect(tools).toContain('aria-label="Thread tools"')
    for (const gone of ['nds-pill', 'fw-rth-viewchip', 'fw-rth-count', 'fw-rth-owner', 'aria-label="Thread width"']) expect(html, gone).not.toContain(gone)
    // No Files icon where the reader may not read files (null); 0 files: the icon without a number.
    expect(head({ files: null })).not.toContain('fw-rth-files')
    expect(head({ files: { count: 0 } })).not.toContain('fw-rth-files-n')
    expect(head({ files: { count: 120 } })).toContain('<span class="fw-rth-files-n">99+</span>')
  })

  it('the line: closed › done › the View › offline › waiting + owner — one at a time, in that order; nothing to say: no line', () => {
    const closed = { by: 'Alex Demo', at: '2026-11-12T16:00:00.000Z' }
    const done = { at: '2026-11-17T09:00:00.000Z', by: 'Alex Demo' }
    expect(headLine(base({ closed, done, view: 'notes', views: ['all', 'notes'] }))).toMatchObject({ kind: 'closed' })
    expect(headLine(base({ done, view: 'notes', views: ['all', 'notes'] }))).toMatchObject({ kind: 'done' })
    expect(headLine(base({ view: 'notes', views: ['all', 'notes'], offline: { asOf: '2026-11-17T09:42:00.000Z' } }))).toMatchObject({ kind: 'view', view: 'notes' })
    expect(headLine(base({ offline: { asOf: '2026-11-17T09:42:00.000Z' } }))).toMatchObject({ kind: 'offline' })
    expect(headLine(base())).toBeNull()
    expect(head()).not.toContain('fw-rth-line')
    expect(textOf(head({ closed }))).toContain('Closed by Alex Demo')
  })

  it('the ⓘ is the ONE place for key hints (P8): J / K, R, N, Enter on a quote, /, Enter, Shift+Enter, Esc — in it and en', () => {
    expect(HEAD_KEYS.map((row) => row.key)).toEqual(['keys.jk', 'keys.r', 'keys.n', 'keys.quote', 'keys.slash', 'keys.enter', 'keys.shiftEnter', 'keys.esc'])
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['record-thread-head'])['record-thread-head'] ?? {})
      for (const row of HEAD_KEYS) {
        expect(t(row.key), `${locale} ${row.key}`).not.toBe(row.key)
        if (typeof row.glyph !== 'string') expect(t(row.glyph.key), locale).not.toBe(row.glyph.key)
      }
      expect(head({}, locale)).toContain(`aria-label="${t('keys.title')}"`)
    }
    // No hint rows under the menu's items (B9): a held row says why; nothing else has a second line.
    const source = readFileSync(new URL('./view/RecordThreadHead.tsx', import.meta.url), 'utf8')
    expect(source).not.toMatch(/Hint'\)|hint: /)
  })

  it('the ⋮ holds, in ONE order: Show · Done · the doors with their counts · Change owner · Width · Print · Close', () => {
    const rows = menuRows(base({ views: ['all', 'shared'], done: null, doneHeld: null, ownerHeld: null, print: true, canManage: true, counts: { approvals: { kind: 'approvals', count: 1, lines: [] } } }))
    const order = rows.map((row) => (row.kind === 'door' ? row.door : row.kind === 'width' ? 'width' : row.kind))
    expect([...new Set(order)]).toEqual(['view', 'done', 'follow', 'mute', 'remind', 'owner', 'approve', 'share', 'followers', 'task', 'width', 'print', 'close'])
    expect(rows.find((row) => row.kind === 'door' && row.door === 'approve')).toMatchObject({ count: { key: 'act.openApprovals', params: { count: 1 } } })
  })

  it('every head control fits a 433 px dock: the title shrinks ("…"), the tools never wrap or leave the row (P0-B1)', () => {
    const css = readFileSync(new URL('./head.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.fw-rth \{[^}]*display: flex;[^}]*min-width: 0;/)
    expect(css).toMatch(/\.fw-rth-titleblock \{[^}]*flex: 1 1 auto;[^}]*min-width: 0;/)
    expect(css).toMatch(/\.fw-rth-tools \{[^}]*flex: none;/)
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix/i)
  })
})

describe('tw- W2.1 — the pinned bar (W-080 / W-081, R12): newest pin first, "Sender: text", a click jumps and shows the next', () => {
  const pin = (n: number, over: Partial<PinInput['message']> = {}, pinnedAt = `2026-11-1${n}T09:00:00.000Z`): PinInput => ({ messageId: `m${n}`, pinnedAt, message: { authorName: 'Bea Esempio', excerpt: `Words ${n}`, audience: 'PARTNER', attachmentCount: 0, removed: false, authorKind: 'USER', ...over } })

  it('R12: the pinned bar names a hidden floor writer as "A person on the floor" (never a name, in it and en)', () => {
    const hidden = barPinsOf([pin(1, { authorName: null, authorKind: 'WORKER', audience: 'OFFICE' })])
    expect(hidden[0]).toMatchObject({ hidden: true, author: null, office: true })
    expect(barWords(hidden[0]!).who).toEqual({ key: 'author.floorPerson' })
    for (const [locale, words] of [['en', 'A person on the floor'], ['it', 'Una persona in reparto']] as const) {
      const html = drawAll(createElement(PinnedBar, { pins: hidden }), locale)
      expect(textOf(html), locale).toContain(`${words}: Words 1`)
      expect(html, locale).toContain('fw-rt-pinlock')
    }
    // An automatic message (SYSTEM, no name) is the system's name, never "a person on the floor".
    expect(barWords(barPinsOf([pin(2, { authorName: null, authorKind: 'SYSTEM' })])[0]!).who).toEqual({ key: 'author.SYSTEM' })
  })

  it('newest pin first; a removed message says so with no writer; files only says how many; a lock only on an office note', () => {
    const pins = barPinsOf([pin(1), pin(3, { removed: true, authorName: 'Bea Esempio', excerpt: 'gone words' }), pin(2, { excerpt: ' ', attachmentCount: 2 })])
    expect(pins.map((one) => one.messageId)).toEqual(['m3', 'm2', 'm1'])
    expect(barWords(pins[0]!)).toEqual({ who: null, what: { key: 'quote.removed' } })
    expect(pins[0]!.excerpt).toBe('')
    expect(barWords(pins[1]!)).toEqual({ who: { text: 'Bea Esempio' }, what: { key: 'quote.files', count: 2 } })
    expect(barWords(pins[2]!)).toEqual({ who: { text: 'Bea Esempio' }, what: { text: 'Words 1' } })
    const html = drawAll(createElement(PinnedBar, { pins }))
    expect(textOf(html)).toContain('Message removed')
    expect(html).not.toContain('gone words')
    expect(html).not.toContain('fw-rt-pinlock')
    expect(html).toContain('aria-label="Pinned message 1 of 3: go to it"')
  })

  it('the marks: one per pin up to 4, a window of 4 past it with the current one on; a click shows the next older (and wraps)', () => {
    const six = barPinsOf([1, 2, 3, 4, 5, 6].map((n) => pin(n)))
    expect(BAR_MARKS).toBe(4)
    expect(barState(six, 0)).toMatchObject({ index: 0, count: 6, marks: [true, false, false, false], next: 1 })
    expect(barState(six, 5)).toMatchObject({ index: 5, marks: [false, false, false, true], next: 0 })
    expect(barState(six, 4)!.marks).toEqual([false, false, false, true]) // the window ends at the pin shown (it never leaves it)
    expect(barState(six, 2)!.marks).toEqual([false, false, true, false])
    expect(barState(six.slice(0, 2), 1)).toMatchObject({ marks: [false, true], next: 0 })
    expect(barState([], 0)).toBeNull()
    // One pin: no marks at all; none: no bar.
    expect(drawAll(createElement(PinnedBar, { pins: six.slice(0, 1) }))).not.toContain('fw-rt-pinmarks')
    expect(drawAll(createElement(PinnedBar, { pins: [] }))).toBe('')
  })

  it('in RecordThread itself, under the head and above the feed (≤ 2 bands, S7); never on a forbidden thread', () => {
    const thread = readFileSync(new URL('../RecordThread.tsx', import.meta.url), 'utf8')
    expect(thread).toContain("{model.feed.state !== 'forbidden' && model.pinned && model.pinned.length > 0 ? <PinnedBar pins={model.pinned} onJump={actions.onJump} /> : null}")
    expect(thread.indexOf('<PinnedBar')).toBeGreaterThan(thread.indexOf('<TitleOnly pick={slots.top} />'))
    expect(thread.indexOf('<PinnedBar')).toBeLessThan(thread.indexOf('<Feed'))
    const host = readFileSync(new URL('../../../areas/_shared/record-thread/use-record-thread.ts', import.meta.url), 'utf8')
    expect(host).toContain('const pinned = useMemo(() => barPinsOf(pins ?? []), [pins])')
  })
})
// ---- end tw- W2.1

// ---- tw- W2.4 (tw-s part 5; R10): a search hit says who wrote it and when ----------------------------------------------------------
import { hitWho } from './model'

describe('tw- W2.4 — search hits with the writer and the time', () => {
  const head = (search: ThreadSearchModel, locale: 'it' | 'en' = 'en') => drawAll(createElement(RecordThreadHead, { model: base({ search }) }), locale)
  const open = (hits: ThreadSearchModel['hits']): ThreadSearchModel => ({ open: true, query: 'collar', state: 'ready', hits, total: hits.length, words: ['collar'] })

  it('R10: a hit on a floor note with the gate shut shows "A person on the floor" — never a name', () => {
    const hidden = { id: 'm-9', excerpt: 'Collar cut', direction: 'INTERNAL_NOTE', at: '2026-11-17T09:40:00.000Z', sender: { name: null, kind: 'WORKER' } }
    expect(hitWho(hidden)).toEqual({ key: 'author.floorPerson' })
    expect(textOf(head(open([hidden])))).toContain('A person on the floor')
    expect(textOf(head(open([hidden]), 'it'))).toContain('Una persona in reparto')
    expect(hitWho({ sender: { name: null, kind: 'SYSTEM' } })).toEqual({ key: 'author.SYSTEM' })
  })

  it('a named writer and the time beside the hit’s side; a hit the server says nothing of stays as before', () => {
    const named = { id: 'm-1', excerpt: 'Collar in yellow piping', direction: 'INBOUND', at: '2026-11-17T09:40:00.000Z', sender: { name: 'Lia Modello', kind: 'PARTY' } }
    const text = textOf(head(open([named])))
    expect(text).toMatch(/Lia Modello · \d{1,2} Nov \d\d:\d\d/)
    expect(hitWho({ sender: null })).toBeNull()
    expect(head(open([{ id: 'm-2', excerpt: 'Collar', direction: 'INBOUND' }]))).not.toContain('fw-rth-search-who')
    const api = readFileSync(new URL('../../../areas/_shared/record-thread/api.ts', import.meta.url), 'utf8')
    expect(api).toContain('message: z.object({ at: z.string(), authorName: z.string().nullable(), authorKind: z.string() }).optional(),')
  })
})
// ---- end tw- W2.4

// ---- tw- W2.4: the catalogue scan — both catalogues hold every key; no removed word is read anywhere ----------------------------
describe('tw- W2.4 — the thread’s catalogues: the same keys in it and en, and the words this rebuild removed are read nowhere', () => {
  const GONE: Readonly<Record<string, readonly string[]>> = {
    'record-thread-head': ['new.count_one', 'new.count_other', 'new.many'],
    'record-thread-card': ['menu.replyHint', 'menu.taskHint', 'menu.linkHint', 'menu.useOnHint', 'menu.correctHint', 'menu.pinHint', 'menu.unpinHint', 'mentioned.list', 'mentioned.more', 'details.email', 'undo.sending', 'erased.short', 'filesOnly.line_one'],
    'record-thread-composer': ['mark.note', 'mark.reply', 'mark.portal', 'placeholder.note', 'placeholder.reply', 'placeholder.portal', 'portal.line', 'floor.off'],
    'record-thread-feed': ['fold.count_one', 'fold.range', 'fold.show', 'fold.label_one', 'folded.label'],
    'record-thread-files': ['pins.chip_one', 'pins.go', 'pins.unpin', 'design.frame519'],
  }

  it('every thread namespace has the same keys in it and en', () => {
    for (const name of ['record-thread', 'record-thread-head', 'record-thread-card', 'record-thread-composer', 'record-thread-feed', 'record-thread-files', 'record-thread-popups', 'record-thread-helpers', 'record-thread-attach', 'record-thread-send']) {
      expect(Object.keys(CATALOGUE.it[name] ?? {}).sort(), name).toEqual(Object.keys(CATALOGUE.en[name] ?? {}).sort())
    }
  })

  it('a removed word is in neither catalogue', () => {
    for (const [name, keys] of Object.entries(GONE)) for (const key of keys) for (const locale of ['en', 'it'] as const) expect(CATALOGUE[locale][name]?.[key], `${locale} ${name} ${key}`).toBeUndefined()
  })
})
// ---- end tw- W2.4 catalogue

// ---- tw- fx2 (the walk: G-4, G-5, G-10, G-17, G-21, G-22) ---------------------------------------------------------------------------
import { drawnRows, snippetAround } from './model'

describe('tw- fx2 — the head after the walk', () => {
  it('G-4 / G-5: the ⋮ draws only the rows the reader may use — no greyed row, no hint sentence (the untrue "never shared" one too)', () => {
    const holds = doorHolds({ can: { ...ALL, approve: false, share: false }, hasParty: true, offline: false, rights: { approve: 'Ask partners to approve' } })
    const rows = drawnRows(menuRows(base({ holds, ownerHeld: { key: 'held.noRight', params: { right: 'Write in threads' } }, done: null, doneHeld: { key: 'held.offline' } })))
    expect(rows.some((row) => 'held' in row && row.held !== null && row.held !== undefined)).toBe(false)
    expect(rows.map((row) => (row.kind === 'door' ? row.door : row.kind))).not.toContain('approve')
    expect(rows.map((row) => (row.kind === 'door' ? row.door : row.kind))).not.toContain('owner')
    expect(rows.map((row) => (row.kind === 'door' ? row.door : row.kind))).not.toContain('mute') // held "follow first"
    const source = readFileSync(new URL('./view/RecordThreadHead.tsx', import.meta.url), 'utf8')
    expect(source).toContain('for (const row of drawnRows(menuRows(model))) {')
  })

  it('G-10: "Read only · 1 thread" / "… 2 threads", in both languages', () => {
    for (const [locale, one, two] of [['en', 'Read only · 1 thread', 'Read only · 2 threads'], ['it', 'Sola lettura · 1 thread', 'Sola lettura · 2 thread']] as const) {
      const t = createTranslator(locale, messagesFor(locale, ['record-thread-head'])['record-thread-head'] ?? {})
      expect(t('allOf.line', { count: 1 })).toBe(one)
      expect(t('allOf.line', { count: 2 })).toBe(two)
    }
  })

  it('G-17: the line drops WHOLE parts when it does not fit — the owner (and its dot) first — never a stub like "Own"', () => {
    const css = readFileSync(new URL('./head.css', import.meta.url), 'utf8')
    expect(css).toMatch(/@container fw-rth \(max-width: 520px\) \{\s*\.fw-rth-line:has\(\.fw-rth-linepart\.is-wait\) \.fw-rth-linepart\.is-owner,\s*\.fw-rth-linesep\.is-owner \{\s*display: none;/)
    expect(head({ answers: { on: 'us', since: '2026-11-17T06:40:00.000Z' }, owner: { id: 'u1', name: 'Bea Esempio', active: true, source: 'SET' }, ownerHeld: null })).toContain('class="fw-rth-linesep is-owner"')
  })

  it('G-21: the title is the thread’s record label; the pick keeps the long label in its menu and its name', () => {
    const source = readFileSync(new URL('./view/RecordThreadHead.tsx', import.meta.url), 'utf8')
    expect(source).toContain('<HeadTitleProvider title={model.pickTitle === undefined ? model.record : model.pickTitle}>{pick}</HeadTitleProvider>')
    const docked = readFileSync(new URL('../../../areas/_shared/record-thread/DockedOfficeThread.tsx', import.meta.url), 'utf8')
    expect(docked).toContain("...(key.type === 'Party' ? { pickTitle: null } : {}),")
    const pick = readFileSync(new URL('../../../areas/_shared/record-thread/ThreadPick.tsx', import.meta.url), 'utf8')
    expect(pick).toContain('const title = useHeadTitle() ?? shown.long')
    expect(pick).toContain('<span className="fw-thread-pick-long">{title}</span>')
  })

  it('G-22: a hit’s snippet is cut around the searched word, so the mark shows', () => {
    const long = `${'Hello! Here is our size list for the jackets, every size and colour as agreed last week. '.repeat(2)}The tannery confirms the leather.`
    const cut = snippetAround(long, ['tannery'])
    expect(cut.startsWith('…')).toBe(true)
    expect(cut).toContain('tannery')
    expect(markWords(cut, ['tannery']).some((part) => part.hit)).toBe(true)
    expect(snippetAround('Short words', ['tannery'])).toBe('Short words')
    expect(snippetAround(long, ['absent'])).toBe(`${long.slice(0, 90)}…`)
    expect(snippetAround(long, ['hello'])).toBe(`${long.slice(0, 90)}…`)
    const docked = readFileSync(new URL('../../../areas/_shared/record-thread/DockedOfficeThread.tsx', import.meta.url), 'utf8')
    expect(docked).toContain('const hitWords = (id: string, line: string | null) => latestCompose.current.messages.find((one) => one.id === id)?.body || line')
    expect(docked).toContain('excerpt: hitWords(hit.recordId, hit.subtitle)')
    expect(readFileSync(new URL('./view/ThreadSearch.tsx', import.meta.url), 'utf8')).toContain('markWords(snippetAround(words, model.words), model.words)')
  })
  const head = (over: Partial<HeadModel> = {}) => drawAll(createElement(RecordThreadHead, { model: base(over) }))
})
// ---- end tw- fx2

// ---- pt-w1 W1.4 (lane pt-, A11; ONE SHARED THREAD): the Width rows both doors' heads draw -------------------------------------------
import { DOCK_WIDTHS, widthRows } from './model'

describe('pt-w1 W1.4 — the Width rows of a "⋮"', () => {
  it('widthRows: the office’s four widths + Hide + Default; the portal’s three; the current one ticked', () => {
    const office = widthRows(DOCK_WIDTHS, 'forty')
    expect(office.map((row) => row.width)).toEqual(['third', 'forty', 'half', 'full', 'hide', 'reset'])
    expect(office.filter((row) => row.checked).map((row) => row.width)).toEqual(['forty'])
    expect(office.every((row) => row.kind === 'width')).toBe(true)
    const portal = widthRows(['third', 'forty', 'half'] as const, 'half')
    expect(portal.map((row) => row.width)).toEqual(['third', 'forty', 'half', 'hide', 'reset'])
    expect(portal.filter((row) => row.checked).map((row) => row.width)).toEqual(['half'])
    // No width chosen yet: nothing ticked, Hide and Default still there.
    expect(widthRows(['third', 'forty', 'half'] as const, null).some((row) => row.checked)).toBe(false)
    // The office's ⋮ draws exactly these rows, in its place.
    expect(menuRows(base()).filter((row) => row.kind === 'width')).toEqual(widthRows(DOCK_WIDTHS, base().width))
    expect(readFileSync(new URL('./model.ts', import.meta.url), 'utf8')).toContain('if (model.width !== null) rows.push(...widthRows(DOCK_WIDTHS, model.width))')
  })
})
// ---- end pt-w1 W1.4
