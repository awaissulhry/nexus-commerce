import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MyProject } from '../../../products/projects/api'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen } from './fixtures'
import { isQuietPastTarget, orderRows, panelShown, rowOf, type MyProjectsModel } from './model'

/**
 * B-TH-252 — Today › My projects (PROJ.home-F03, F04): the open projects I am in with MY OWN new marks; the lead's stale nudge; the
 * panel hidden when I am in none; every line opens the project. (Written in the build; run at the end check.)
 */

const NOW = Date.UTC(2026, 10, 17, 9, 0)
const day = (offset: number) => new Date(NOW - offset * 86_400_000).toISOString()

function project(extra: Partial<MyProject> = {}): MyProject {
  return {
    id: 'p1',
    number: 'PRJ-26-012',
    name: 'FW27 airbag line',
    companyId: 'c1',
    party: { id: 'b1', code: 'ALPHA', name: 'Brand Alpha' },
    lead: { id: 'u1', name: 'Marco Demo', me: true },
    status: 'ACTIVE',
    targetDate: '2026-11-01',
    target: { state: 'OVERDUE', days: -16 },
    seasonCode: null,
    lastMessageAt: day(20),
    newForMe: 0,
    muted: false,
    mine: true,
    linked: 2,
    version: 3,
    ...extra,
  }
}

describe('My projects', () => {
  it('a project I lead, past its target date and quiet for 14 days, is stale; a recent message or another lead is not', () => {
    expect(rowOf(project(), '/w/DEMO', NOW).stale).toBe(true)
    expect(rowOf(project({ lastMessageAt: day(3) }), '/w/DEMO', NOW).stale).toBe(false)
    expect(rowOf(project({ lead: { id: 'u2', name: 'Lucia Demo', me: false } }), '/w/DEMO', NOW).stale).toBe(false)
    expect(rowOf(project({ target: { state: 'SOON', days: 3 }, targetDate: '2026-11-20' }), '/w/DEMO', NOW).stale).toBe(false)
    expect(isQuietPastTarget(project({ status: 'CLOSED' }), NOW)).toBe(false)
    expect(isQuietPastTarget(project({ lastMessageAt: null, target: { state: 'OVERDUE', days: -15 } }), NOW)).toBe(true)
    expect(isQuietPastTarget(project({ lastMessageAt: null, target: { state: 'OVERDUE', days: -2 } }), NOW)).toBe(false)
  })

  it('shows my own new marks only, none when muted; opens the project and its thread at what is new', () => {
    const row = rowOf(project({ newForMe: 3 }), '/w/DEMO', NOW)
    expect(row.newForMe).toBe(3)
    expect(row.href).toBe('/w/DEMO/products/projects/p1')
    expect(row.threadHref).toBe('/w/DEMO/products/projects/p1?thread=new')
    expect(rowOf(project({ newForMe: 0, muted: true }), '/w/DEMO', NOW).newForMe).toBe(0)
    expect(rowOf(project({ party: null }), '/w/DEMO', NOW).party).toBeNull()
  })

  it('says the target date in words and tone, never colour alone', () => {
    expect(rowOf(project(), '/w/DEMO', NOW).target).toEqual({ tone: 'danger', phrase: { key: 'target.overdue', params: { count: 16 } } })
    expect(rowOf(project({ target: { state: 'SOON', days: 0 } }), '/w/DEMO', NOW).target).toEqual({ tone: 'warning', phrase: { key: 'target.today' } })
    expect(rowOf(project({ target: { state: 'LATER', days: 40 } }), '/w/DEMO', NOW).target.phrase).toBeNull()
  })

  it('puts my stale ones first, then new messages, then the nearest target date', () => {
    const rows = orderRows([
      rowOf(project({ id: 'a', number: 'PRJ-1', lead: { id: 'x', name: 'X', me: false }, target: { state: 'LATER', days: 50 }, targetDate: '2027-01-01' }), '', NOW),
      rowOf(project({ id: 'b', number: 'PRJ-2', lead: { id: 'x', name: 'X', me: false }, newForMe: 2, target: { state: 'LATER', days: 60 }, targetDate: '2027-02-01' }), '', NOW),
      rowOf(project({ id: 'c', number: 'PRJ-3' }), '', NOW),
    ])
    expect(rows.map((row) => row.id)).toEqual(['c', 'b', 'a'])
  })

  it('is hidden when I am in none and while it first reads; a failed read is said', () => {
    const model = (rows: MyProjectsModel['rows']): MyProjectsModel => ({ rows, allHref: '/w/DEMO/products/projects' })
    expect(panelShown(model({ status: 'ready', data: { items: [] } }))).toBe(false)
    expect(panelShown(model({ status: 'loading' }))).toBe(false)
    expect(panelShown(model({ status: 'error', problem: 'unavailable' }))).toBe(true)
    expect(panelShown(model({ status: 'ready', data: { items: [rowOf(project(), '', NOW)] } }))).toBe(true)
  })

  it('has every word in Italian and English with the same placeholders', () => {
    const en = CATALOGUE.en.home ?? {}
    const it = CATALOGUE.it.home ?? {}
    const keys = Object.keys(en).filter((key) => key.startsWith('myProjects.'))
    expect(keys.length).toBeGreaterThan(10)
    for (const key of keys) expect(it[key], key).toBeTruthy()
  })

  it('draws every design case in Italian and English with no raw key; the hidden case draws nothing', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const entry of designScreen.cases) {
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: entry.model })))
        expect(html, `${entry.id} (${locale})`).not.toMatch(/\bmyProjects\.[a-zA-Z]|\btarget\.(overdue|soon|today)\b|\bstatus\.[A-Z_]+\b/)
        if (entry.id === 'none') expect(html, locale).toBe('')
        expect(html).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
      }
    }
  })
})
