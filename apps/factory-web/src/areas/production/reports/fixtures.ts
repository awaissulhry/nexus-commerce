import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { CLOSED_DAY, canAs, DAILY, EMPTY_DAY, FOR_COLLEAGUE, inShell, ME, MINE, NOW, PEOPLE, PREFIX, SITE, TODAY, TWO_SITES, type Role } from './demo/fixtures'
import { draftOf } from './model'
import { ReportsView, type ReportsModel } from './view/ReportsView'
import type { SubscribeModel } from './view/SubscribeDialog'
// B-W2b-130: Cutting and yield (prr-yield), made-up reports.
import { CUT_YIELD, CUT_YIELD_EMPTY, CUT_YIELD_LEATHER_ONLY } from './yield/fixtures'
import type { YieldCan } from './yield/model'
import type { YieldPanelModel } from './yield/view/YieldPanel'

/**
 * SCR-240 — Production › Reports (design production.reports; MES-301), with made-up data only: Daily production for one
 * day (tiles, bars per lane, per lane its table by style and size), the e-mail dialog (Email me this report) in its
 * states, and the page's states (loading, error, offline, empty day, a closed day, no permission, several sites). Roles:
 * Production manager, Owner, Floor supervisor, Quality inspector (reads, gets it only himself), Sales (no permission).
 * B-W2b-130: Cutting and yield (MES-302) — cut vs ordered, a leather cut order waiting for its reconciliation, fabric used per
 * material, yield per hide lot (bars, worst first) and per supplier, the cut orders — with its period, states and roles (the
 * links to Cutting, a cut order and a lot only for whoever may open them).
 */

interface ReportsCase {
  role: Role
  model: ReportsModel
}

// B-W2b-130: who follows the section's links (production.cutting.view, inventory.stock.view), as the roles hold them.
const YIELD_CAN: Readonly<Record<Role, YieldCan>> = {
  owner: { cutting: true, lots: true },
  manager: { cutting: true, lots: true },
  supervisor: { cutting: false, lots: false },
  inspector: { cutting: false, lots: true },
  sales: { cutting: false, lots: false },
}
const cutYield = (role: Role, over: Partial<YieldPanelModel> = {}): YieldPanelModel => ({ prefix: PREFIX, can: YIELD_CAN[role], days: 30, read: { value: CUT_YIELD, problem: null }, ...over })

const page = (role: Role, over: Partial<ReportsModel> = {}): ReportsCase => ({
  role,
  model: { prefix: PREFIX, can: canAs(role), address: { site: SITE.id, date: DAILY.day }, daily: { value: DAILY, problem: null }, mine: role === 'manager' ? MINE : null, live: 'live', now: NOW, dialog: null, cutYield: cutYield(role), ...over },
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
    // B-W2b-130: Cutting and yield (prr-yield, MES-302).
    { id: 'w2b-yield', label: 'W2b · Cutting and yield: cut vs ordered, fabric used, yield per hide lot (bars, worst first) and per supplier, the cut orders', model: page('manager'), note: 'Below Daily production. A lot opens its record, a cut order its record; → Cutting and → Lots open their pages. Never by cutter.' },
    { id: 'w2b-yield-7', label: 'W2b · Cutting and yield over 7 days', model: page('manager', { cutYield: cutYield('manager', { days: 7, read: { value: { ...CUT_YIELD, from: '2026-10-23' }, problem: null } }) }) },
    { id: 'w2b-yield-leather', label: 'W2b · Cutting and yield: leather only, no cut order cut yet (cutting by the work order)', model: page('manager', { cutYield: cutYield('manager', { read: { value: CUT_YIELD_LEATHER_ONLY, problem: null } }) }) },
    { id: 'w2b-yield-empty', label: 'W2b · Cutting and yield: nothing cut in the period', model: page('manager', { cutYield: cutYield('manager', { read: { value: CUT_YIELD_EMPTY, problem: null } }) }) },
    { id: 'w2b-yield-loading', label: 'W2b · Cutting and yield: still being read', model: page('manager', { cutYield: cutYield('manager', { read: { value: null, problem: null } }) }) },
    { id: 'w2b-yield-error', label: 'W2b · Cutting and yield: the read failed, with Try again', model: page('manager', { cutYield: cutYield('manager', { read: { value: null, problem: 'error.offline' } }) }) },
    { id: 'w2b-yield-inspector', label: 'W2b · Quality inspector: reads it; lots open, cut orders and Cutting do not (no production.cutting.view)', model: page('inspector') },
  ],
})
