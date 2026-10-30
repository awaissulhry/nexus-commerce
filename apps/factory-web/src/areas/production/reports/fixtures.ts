import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { CLOSED_DAY, canAs, DAILY, EMPTY_DAY, FOR_COLLEAGUE, inShell, ME, MINE, NOW, PEOPLE, PREFIX, SITE, TODAY, TWO_SITES, type Role } from './demo/fixtures'
import { draftOf } from './model'
import { ReportsView, type ReportsModel } from './view/ReportsView'
import type { SubscribeModel } from './view/SubscribeDialog'

/**
 * SCR-240 — Production › Reports (design production.reports; MES-301), with made-up data only: Daily production for one
 * day (tiles, bars per lane, per lane its table by style and size), the e-mail dialog (Email me this report) in its
 * states, and the page's states (loading, error, offline, empty day, a closed day, no permission, several sites). Roles:
 * Production manager, Owner, Floor supervisor, Quality inspector (reads, gets it only himself), Sales (no permission).
 */

interface ReportsCase {
  role: Role
  model: ReportsModel
}

const page = (role: Role, over: Partial<ReportsModel> = {}): ReportsCase => ({
  role,
  model: { prefix: PREFIX, can: canAs(role), address: { site: SITE.id, date: DAILY.day }, daily: { value: DAILY, problem: null }, mine: role === 'manager' ? MINE : null, live: 'live', now: NOW, dialog: null, ...over },
})

const dialog = (role: Role, over: Partial<SubscribeModel> = {}): SubscribeModel => {
  const can = canAs(role)
  const mine = role === 'manager' ? MINE : null
  return {
    site: SITE,
    me: ME,
    can,
    draft: draftOf(mine, ME.id),
    mine,
    others: role === 'manager' ? [FOR_COLLEAGUE] : [],
    people: can.subscribe ? { value: PEOPLE, problem: null } : { value: null, problem: null },
    busy: false,
    problem: null,
    ...over,
  }
}

function ReportsDesign({ model }: { model: ReportsCase }) {
  return inShell('/production/reports', createElement(ReportsView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<ReportsCase>({
  screen: 'SCR-240',
  title: 'Production reports: daily production (Production)',
  view: ReportsDesign,
  cases: [
    { id: 'day', label: 'Production manager: yesterday per line, style and size; the e-mail on', model: page('manager'), note: 'A line opens Floor now on it; a style opens its work orders. ⋯ holds Email me and Print (a new tab).' },
    { id: 'owner', label: 'Owner', model: page('owner') },
    { id: 'today', label: 'Floor supervisor: today so far (no next day)', model: page('supervisor', { daily: { value: TODAY, problem: null }, address: { site: SITE.id, date: null } }) },
    { id: 'inspector', label: 'Quality inspector (reads it; no Floor now links)', model: page('inspector') },
    { id: 'sites', label: 'Several sites: the site picker', model: page('manager', { daily: { value: TWO_SITES, problem: null } }) },
    { id: 'empty', label: 'Nothing recorded on the day (lines with their 0 %)', model: page('manager', { daily: { value: EMPTY_DAY, problem: null } }) },
    { id: 'closed', label: 'A closed day of the site’s calendar', model: page('manager', { daily: { value: CLOSED_DAY, problem: null } }) },
    { id: 'subscribe', label: 'Email me this report: me and colleagues who may read it', model: page('manager', { dialog: dialog('manager') }), note: 'Who gets it already is said; Turn off keeps the settings; Esc closes.' },
    { id: 'subscribe-first', label: 'Email me: the first time (07:00, Monday to Friday, each person’s language)', model: page('supervisor', { dialog: dialog('supervisor', { mine: null, others: [], people: { value: PEOPLE.map((person) => ({ ...person, subscribed: false })), problem: null } }) }) },
    { id: 'subscribe-only-me', label: 'Email me: the inspector gets it himself only', model: page('inspector', { dialog: dialog('inspector') }) },
    { id: 'subscribe-held', label: 'Email me: held — no day chosen', model: page('supervisor', { dialog: dialog('supervisor', { draft: { ...draftOf(null, ME.id), weekdays: [] } }) }) },
    { id: 'subscribe-refused', label: 'Email me: a colleague who may not read it, refused in words', model: page('manager', { dialog: dialog('manager', { problem: { key: 'subscribe.problem.recipient', params: { name: 'Bea Esempio' } } }) }) },
    { id: 'subscribe-loading', label: 'Email me: the people still being read', model: page('manager', { dialog: dialog('manager', { people: { value: null, problem: null } }) }) },
    { id: 'offline', label: 'Offline: the last figures, said', model: page('manager', { live: 'offline' }) },
    { id: 'loading', label: 'Loading', model: page('manager', { daily: { value: null, problem: null }, live: 'connecting', mine: null }) },
    { id: 'error', label: 'The read failed: in words, with Try again', model: page('manager', { daily: { value: null, problem: 'error.offline' }, live: 'offline' }) },
    { id: 'no-permission', label: 'Sales: no production.reports.view', model: page('sales', { daily: { value: null, problem: 'error.forbidden' } }) },
  ],
})
