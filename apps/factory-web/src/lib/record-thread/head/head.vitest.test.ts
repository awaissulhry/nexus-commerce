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
import { readWidth, writeWidth } from './use-thread-width'
import { PortalHeadLine } from './view/PortalHeadLine'

/**
 * B-TH-209 — the thread's Head (T1, rule R-ACT): who answers next from the last SHARED message, the five Activity doors
 * always in the "⋯" (also at count 0) and held with the reason, Close only with threads.manage, the portal line with no
 * office count (W08, W34), the width remembered per person and record type, every case drawn in it and en.
 */

const KEY_ON_SCREEN = /\b(answers|wait|closed|view|count|width|more|act|held|portal|design)\.[a-zA-Z]/
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
