import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WAITING_KINDS } from '@nexus/factory-domain/insights/waiting'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as followingScreen } from '../following/fixtures'
import { followingKey, rowOf as followingRow } from '../following/model'
import { designScreen as waitingScreen } from '../waiting-on/fixtures'
import { nudgeOf, sinceWords, whoWords } from '../waiting-on/model'
import { designScreen as viewsScreen } from './fixtures'
import { chipsOf, pageOfList } from './model'

/** Today's My work (B-W2b-388; COL-035): Waiting on others, Changed since you looked, My saved views — rules, words, cases. */

const KEY_ON_SCREEN = /\b(waiting|following|views|held)\.[a-zA-Z]/
const BUILT = new Set(['/production/work-orders', '/sales/orders'])

describe('Waiting on others', () => {
  it('names whom I wait for and since when; Nudge only on an approval I asked for, held with its reason', () => {
    expect(whoWords({ kind: 'APPROVAL_REQUEST', waitingFor: 'An approver of quotes' })).toEqual({ key: 'waiting.who.approver', name: '' })
    expect(whoWords({ kind: 'PO_CONFIRMATION', waitingFor: 'Conceria Demo' })).toEqual({ key: 'waiting.who.party', name: 'Conceria Demo' })
    expect(sinceWords({ ageDays: 0 })).toEqual({ key: 'waiting.since.today', count: 0 })
    expect(sinceWords({ ageDays: 3 })).toEqual({ key: 'waiting.since.days', count: 3 })
    expect(nudgeOf({ kind: 'MESSAGE_REPLY', nudge: { allowed: false, refusal: 'OUTSIDE' } }, null)).toEqual({ offered: false, held: null })
    expect(nudgeOf({ kind: 'APPROVAL_REQUEST', nudge: { allowed: true, refusal: null } }, null)).toEqual({ offered: true, held: null })
    expect(nudgeOf({ kind: 'APPROVAL_REQUEST', nudge: { allowed: false, refusal: 'TODAY_ALREADY' } }, null)).toEqual({ offered: true, held: 'waiting.nudge.refusal.TODAY_ALREADY' })
    expect(nudgeOf({ kind: 'APPROVAL_REQUEST', nudge: { allowed: true, refusal: null } }, 'held.offline')).toEqual({ offered: true, held: 'held.offline' })
  })

  it('has words for every kind in it and en', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['home-mywork'])['home-mywork'] ?? {})
      for (const kind of WAITING_KINDS) {
        expect(t(`waiting.kind.${kind}`, { record: 'X' })).not.toMatch(/^waiting\./)
        expect(t(`waiting.tag.${kind}`)).not.toMatch(/^waiting\./)
      }
    }
  })
})

describe('Changed since you looked', () => {
  it('a line opens its record; a followed view opens its list with the view, or says its page is not built', () => {
    const base = { key: 'k', companyId: null, anchor: null, messageKey: 'notifications.following.changed', params: {}, sentence: '', actor: null, people: {}, at: '2026-11-13T08:00:00.000Z', count: 1, ids: ['n1'] }
    expect(followingRow({ ...base, record: { type: 'SalesOrder', id: 'o1', label: 'SO-1' }, view: false, listKey: null }, '/w/DEMO', BUILT).href).toMatch(/^\/w\/DEMO\//)
    expect(followingRow({ ...base, record: { type: 'SavedView', id: 'v1', label: 'Late' }, view: true, listKey: 'production.work-orders' }, '/w/DEMO', BUILT).href).toBe('/w/DEMO/production/work-orders?savedView=v1')
    expect(followingRow({ ...base, record: { type: 'SavedView', id: 'v2', label: 'Holds' }, view: true, listKey: 'quality.holds' }, '/w/DEMO', BUILT).href).toBeNull()
    expect(followingKey('e', { alt: false, ctrl: false, meta: false })).toBe('seen')
    expect(followingKey('e', { alt: false, ctrl: true, meta: false })).toBeNull()
  })
})

describe('My saved views', () => {
  it('a chip says its count (1000+ when capped, none until counted) and opens its list with the view', () => {
    expect(pageOfList('production.work-orders')).toBe('/production/work-orders')
    const chips = chipsOf(
      {
        max: 50,
        views: [
          { followId: 'f1', viewId: 'v1', name: 'Late', listKey: 'production.work-orders', companyId: null, count: 6, capped: false, countedAt: '2026-11-13T08:00:00.000Z', since: '2026-11-01T08:00:00.000Z' },
          { followId: 'f2', viewId: 'v2', name: 'All', listKey: 'sales.orders', companyId: null, count: 1000, capped: true, countedAt: null, since: '2026-11-01T08:00:00.000Z' },
          { followId: 'f3', viewId: 'v3', name: 'New', listKey: 'quality.holds', companyId: null, count: null, capped: false, countedAt: null, since: '2026-11-01T08:00:00.000Z' },
        ],
      },
      '/w/DEMO',
      BUILT,
    )
    expect(chips.map((chip) => chip.count)).toEqual([{ key: 'views.count', count: 6 }, { key: 'views.capped', count: 1000 }, null])
    expect(chips.map((chip) => chip.href)).toEqual(['/w/DEMO/production/work-orders?savedView=v1', '/w/DEMO/sales/orders?savedView=v2', null])
  })
})

describe('My work’s design cases', () => {
  it('draws every case of SCR-540, SCR-541 and SCR-542 with no key on screen', () => {
    for (const screen of [waitingScreen, followingScreen, viewsScreen] as DesignScreen<unknown>[]) {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(screen.view as ComponentType<{ model: unknown }>, { model: item.model })))
          expect(html, `${screen.screen} ${item.id} ${locale}`).not.toMatch(KEY_ON_SCREEN)
        }
      }
    }
  })
})
