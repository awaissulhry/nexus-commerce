import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { ReportAbout, ReportResults, ReportSchedule } from '../api'
import {
  CUT_RESULT,
  DAILY,
  DAILY_ABOUT,
  DAILY_SCHEDULE,
  EMPTY_RESULT,
  MARGIN_NO_ACCESS,
  NO_SCHEDULE,
  OPEN_ORDERS,
  OPEN_ORDERS_ABOUT,
  OPEN_ORDERS_FILTERED,
  OPEN_ORDERS_GROUPED,
  OPEN_ORDERS_PLANNER,
  OPEN_ORDERS_PLANNER_ABOUT,
  PREFIX,
  STOCK_VALUE_HELD,
  inShell,
  type Role,
} from '../demo/fixtures'
import { reportsCanOf, type ReportTab } from '../model'
import { ReportView, type ReportModel } from '../view/ReportView'

/**
 * SCR-104-report — a report of the pack (design home.reports rec:Report: Results, Schedule, About; ANA-034), with made-up
 * data only: Open orders for the owner (rows, totals, a row opens its order), grouped by status, filtered, for a planner
 * (the net value left out and said), rows selected (Export N as CSV), nothing found, cut at the limit, reading, a failed
 * read; Daily production with a line of fewer than 5 people (its efficiency hidden, said); its Schedule (who gets it by
 * e-mail) and a report not scheduled; About; a report needing cost rights and one reading a list outside the role (held,
 * About readable); loading, not found and no permission.
 */

interface Case {
  readonly role: Role
  readonly model: ReportModel
}

const hrefs = (results: ReportResults | null) => Object.fromEntries((results?.rows ?? []).filter((row) => row.record).map((row) => [row.id, `${PREFIX}/sales/orders/${row.record!.id}`]))

function report(role: Role, about: ReportAbout | null, results: ReportResults | null, change: Omit<Partial<ReportModel>, 'schedule'> & { tab?: ReportTab; scheduled?: ReportSchedule | null } = {}): Case {
  const { tab = 'results', scheduled = null, ...rest } = change
  return {
    role,
    model: {
      can: reportsCanOf(role === 'none' ? ['home.view'] : ['home.reports.view']),
      prefix: PREFIX,
      key: about?.key ?? 'sales.open-orders',
      address: { tab, filters: {}, group: null },
      about: { value: about, problem: null },
      results: { value: results, problem: null, reading: false },
      schedule: { value: scheduled, problem: null },
      rowHrefs: hrefs(results),
      ...rest,
    },
  }
}

function ReportDesign({ model }: { model: Case }) {
  return inShell(`/home/reports/${model.model.key}`, createElement(ReportView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-104-report',
  title: 'Reports: a report — Results, Schedule, About (Home › Insights)',
  view: ReportDesign,
  cases: [
    { id: 'results', label: 'Open orders — results (owner)', model: report('owner', OPEN_ORDERS_ABOUT, OPEN_ORDERS), note: 'Filters (status, promised) and Group by; what the server applied; the rows in the shared list frame (a row opens its order); totals; Print in a new tab; Export ▾ CSV or PDF.' },
    { id: 'grouped', label: 'Grouped by status', model: report('owner', OPEN_ORDERS_ABOUT, OPEN_ORDERS_GROUPED, { address: { tab: 'results', filters: {}, group: 'status' } }), note: 'One row per group with its rows and sums; "Show the rows" goes back.' },
    {
      id: 'filtered',
      label: 'Filtered: confirmed, promised in the next 30 days',
      model: report('owner', OPEN_ORDERS_ABOUT, OPEN_ORDERS_FILTERED, { address: { tab: 'results', filters: { status: 'CONFIRMED', promise: 'NEXT_30_DAYS' }, group: null } }),
      note: 'The address keeps the filters; "Applied" says the server’s own words and the days.',
    },
    { id: 'planner', label: 'A planner: the net value left out', model: report('planner', OPEN_ORDERS_PLANNER_ABOUT, OPEN_ORDERS_PLANNER), note: '"What you see: left out because of your rights: price." The column is not in the answer at all.' },
    { id: 'selected', label: 'Rows selected: Export 2 rows', model: report('owner', OPEN_ORDERS_ABOUT, OPEN_ORDERS, { selected: [OPEN_ORDERS.rows[0]!.id, OPEN_ORDERS.rows[2]!.id] }), note: 'Select-all, shift range and x select rows; the toolbar swaps to the bulk action.' },
    { id: 'small-groups', label: 'Daily production: a line of fewer than 5 people', model: report('owner', DAILY_ABOUT, DAILY), note: 'L2 has 3 people: its efficiency is hidden ("—") and the banner says so (Statuto dei Lavoratori art. 4). Per line, never per person.' },
    { id: 'empty', label: 'No rows for these filters', model: report('owner', OPEN_ORDERS_ABOUT, EMPTY_RESULT) },
    { id: 'cut', label: 'Cut at the row limit', model: report('owner', OPEN_ORDERS_ABOUT, CUT_RESULT), note: 'The report stopped at its limit and says so.' },
    { id: 'reading', label: 'Reading the result', model: report('owner', OPEN_ORDERS_ABOUT, null, { results: { value: null, problem: null, reading: true } }) },
    { id: 'error', label: 'The result could not be read', model: report('owner', OPEN_ORDERS_ABOUT, null, { results: { value: null, problem: 'error.offline', reading: false } }), note: 'Only the result fails, with Try again; the band and the tabs keep working.' },
    { id: 'schedule', label: 'Schedule: who gets the daily production report', model: report('owner', DAILY_ABOUT, null, { tab: 'schedule', scheduled: DAILY_SCHEDULE, address: { tab: 'schedule', filters: {}, group: null } }), note: 'Me and a colleague, site, time and days, language, on/off, last sent; changed on Production reports.' },
    { id: 'schedule-none', label: 'Schedule: not scheduled', model: report('owner', OPEN_ORDERS_ABOUT, null, { tab: 'schedule', scheduled: NO_SCHEDULE, address: { tab: 'schedule', filters: {}, group: null } }), note: 'Scheduling any report comes later: said, with Print and CSV meanwhile.' },
    { id: 'about', label: 'About: what it counts', model: report('planner', OPEN_ORDERS_PLANNER_ABOUT, null, { address: { tab: 'about', filters: {}, group: null } }), note: 'Question, how it is made, sources, refresh, owner, formats, its numbers on Today, what the person’s rights leave out.' },
    { id: 'held-grain', label: 'Stock value for a planner: needs cost rights', model: report('planner', STOCK_VALUE_HELD, null), note: 'Held with the reason; About stays readable.' },
    { id: 'held-access', label: 'Margin by order for a planner: a list outside the role', model: report('planner', MARGIN_NO_ACCESS, null) },
    { id: 'loading', label: 'Loading the report', model: report('owner', null, null) },
    { id: 'not-found', label: 'No such report', model: report('owner', null, null, { about: { value: null, problem: 'error.notFound' } }) },
    { id: 'no-permission', label: 'No permission', model: report('none', OPEN_ORDERS_ABOUT, null) },
  ],
})
