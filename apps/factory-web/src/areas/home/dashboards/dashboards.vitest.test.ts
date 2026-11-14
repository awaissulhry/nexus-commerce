import { describe, expect, it } from 'vitest'
import { ATTENTION_KINDS, KIND_RULES } from '@nexus/factory-domain/insights/attention'
import { BOARDS, DASHBOARD_KEYS as DOMAIN_KEYS, REPORT_PANELS } from '@nexus/factory-domain/insights/dashboards/boards'
import { MEASURE_SOURCES } from '@nexus/factory-domain/insights/kpis/measures'
import { WIP_AGE_BUCKETS } from '@nexus/factory-domain/insights/kpis/wip'
import enWords from '../../../../messages/en/home-dashboards.json'
import itWords from '../../../../messages/it/home-dashboards.json'
import enHome from '../../../../messages/en/home.json'
import enReports from '../../../../messages/en/home-reports.json'
import { OFFICE_PAGES, WINDOW_PAGES } from '../../../shell/nav/office-nav'
import { DASHBOARD_KEYS as KPI_USE_KEYS, useOf } from '../kpis/model'
import { BOARD_PANELS, DASHBOARD_PERIODS } from './api'
import { NEEDS, numbersFor } from './demo/fixtures'
import { designScreen as ownerScreen } from './fixtures'
import { designScreen as pinScreen } from './pin/fixtures'
import { designScreen as presentScreen } from './present/fixtures'
import { designScreen as rolesScreen } from './roles/fixtures'
import {
  boardShown,
  companyHref,
  dashboardAddressOf,
  dashboardsCanOf,
  dashboardsHref,
  layoutFrom,
  needsHrefOf,
  pinnableOf,
  pinnedOf,
  presentHref,
  recordsHrefOf,
  sectionSpecs,
  sectionValue,
  SEE_ALL_HREF,
  visiblePanels,
  withPinned,
} from './model'

const flat = (tree: Record<string, unknown>, prefix = ''): Record<string, string> =>
  Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value]] : Object.entries(flat(value as Record<string, unknown>, `${prefix}${key}.`)))))
const EN = flat(enWords)
const IT = flat(itWords)
const has = (key: string) => {
  expect(EN[key] ?? EN[`${key}_other`], `en ${key}`).toBeTruthy()
  expect(IT[key] ?? IT[`${key}_other`], `it ${key}`).toBeTruthy()
}
const A = '0190f0e2-1111-7000-8000-000000000001'
const S = '0190f0e2-2222-7000-8000-000000000001'

describe('the address (design: "The choice is part of the address (?board=planner)")', () => {
  it('reads the dashboard, the period and the scope, and writes them back', () => {
    const address = dashboardAddressOf(new URLSearchParams(`board=planner&period=WEEK&company=${A}&site=${S}`))
    expect(address).toEqual({ board: 'planner', period: 'WEEK', company: A, site: S })
    expect(dashboardsHref('/w/DEMO', address)).toBe(`/w/DEMO/home/dashboards?board=planner&period=WEEK&company=${A}&site=${S}`)
    expect(presentHref('/w/DEMO', { ...address, period: 'MONTH', company: null, site: null })).toBe('/w/DEMO/home/dashboards/present?board=planner')
    expect(dashboardAddressOf(new URLSearchParams('board=nobody&period=YEAR&company=x'))).toEqual({ board: null, period: 'MONTH', company: null, site: null })
  })

  it('shows the address’s dashboard when the person may see it, else their first', () => {
    const boards = [
      { key: 'planner' as const, mine: true, panels: [] },
      { key: 'owner-group' as const, mine: false, panels: [] },
    ]
    expect(boardShown(boards, { board: 'owner-group', period: 'MONTH', company: null, site: null })?.key).toBe('owner-group')
    expect(boardShown(boards, { board: null, period: 'MONTH', company: null, site: null })?.key).toBe('planner')
    expect(dashboardsCanOf(['home.kpis.view']).view).toBe(true)
    expect(dashboardsCanOf(['home.view']).view).toBe(false)
  })

  it('is where the KPI library’s "Where used" opens a dashboard', () => {
    expect([...KPI_USE_KEYS]).toEqual(['today', ...DOMAIN_KEYS])
    expect(useOf({ usedIn: 'DASHBOARD', useKey: 'planner' }, OFFICE_PAGES, []).href).toBe('/home/dashboards?board=planner')
  })
})

describe('every number opens its records; every exception its list (ANA-003)', () => {
  it('opens a report, the KPI’s records over the period shown, or an area list', () => {
    const numbers = numbersFor('owner', 'owner-group').numbers
    const href = (key: string) => recordsHrefOf(numbers.find((number) => number.kpiKey === key)!, OFFICE_PAGES)
    expect(href('sales.orders_in')).toBe('/home/reports/sales.orders-in')
    expect(href('delivery.otif')).toMatch(/^\/home\/kpis\/delivery\.otif\/records\?from=2026-11-01&to=2026-11-30/)
    expect(companyHref('ESEMPIO', '/home/reports/sales.orders-in')).toBe('/w/ESEMPIO/home/reports/sales.orders-in')
  })

  it('opens an exception kind on Today, a rule alert on Home › Alerts', () => {
    expect(needsHrefOf({ kind: 'LOT_HOLD' }, OFFICE_PAGES)).toBe('/home/today?kind=LOT_HOLD')
    expect(needsHrefOf({ kind: 'RULE_ALERT' }, OFFICE_PAGES)).toBe('/home/alerts')
    expect(needsHrefOf({ kind: 'RULE_ALERT' }, new Set())).toBe('/home/today?kind=RULE_ALERT')
    expect(SEE_ALL_HREF).toBe('/home/today?tile=ALERT')
    for (const row of NEEDS.rows) expect(KIND_RULES[row.kind].category, row.kind).toBe('ALERT')
  })
})

describe('arrange, saved on the server (pop:arrange) and pinned reports (DB1:01)', () => {
  const layout = [
    { id: 'numbers', hidden: false, width: 'FULL' as const },
    { id: 'needs-action', hidden: false, width: 'HALF' as const },
    { id: 'trends', hidden: false, width: 'HALF' as const },
    { id: 'wip', hidden: true, width: 'FULL' as const },
    { id: 'report:sales.intake', hidden: false, width: 'HALF' as const },
  ]

  it('turns the server’s arrangement into the DS layout and back, keeping hidden and unseen panels', () => {
    expect(sectionValue(layout)).toEqual({ order: ['numbers', 'needs-action', 'trends', 'report:sales.intake'], widths: { numbers: 'full', 'needs-action': 'half', trends: 'half', wip: 'full', 'report:sales.intake': 'half' } })
    const specs = sectionSpecs(layout, (id) => id)
    expect(specs[0]).toMatchObject({ id: 'numbers', locked: true })
    // The person may not see the work in progress: it is not drawn, and saving keeps it where it was.
    expect(visiblePanels(layout, ['numbers', 'needs-action', 'trends']).map((panel) => panel.id)).toEqual(['numbers', 'needs-action', 'trends', 'report:sales.intake'])
    const next = layoutFrom({ order: ['numbers', 'report:sales.intake', 'trends'], widths: { numbers: 'full', 'report:sales.intake': 'full', trends: 'two-thirds' } }, layout)
    expect(next).toEqual([
      { id: 'numbers', hidden: false, width: 'FULL' },
      { id: 'report:sales.intake', hidden: false, width: 'FULL' },
      { id: 'trends', hidden: false, width: 'TWO_THIRDS' },
      { id: 'needs-action', hidden: true, width: 'HALF' },
      { id: 'wip', hidden: true, width: 'FULL' },
    ])
  })

  it('pins a report page’s panels once, shown, at the end', () => {
    expect(pinnableOf('sales')).toEqual(['report:sales.strip', 'report:sales.intake', 'report:sales.backlog', 'report:sales.returns'])
    expect(withPinned(layout, ['report:sales.intake', 'report:sales.returns']).map((panel) => `${panel.id}${panel.hidden ? '-' : ''}`)).toEqual(['numbers', 'needs-action', 'trends', 'wip-', 'report:sales.intake', 'report:sales.returns'])
    expect(pinnedOf('report:sales.intake')).toMatchObject({ kind: 'panel', area: 'sales', page: '/sales/reports' })
    expect(pinnedOf('report:sales.late-orders')).toEqual({ kind: 'report', id: 'report:sales.late-orders', key: 'sales.late-orders' })
    expect(pinnedOf('numbers')).toBeNull()
  })
})

describe('words, pages and design routes', () => {
  it('says every code in Italian and English with the same placeholders', () => {
    expect(Object.keys(EN).sort()).toEqual(Object.keys(IT).sort())
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const key of Object.keys(EN)) expect(holes(IT[key]!), key).toEqual(holes(EN[key]!))
    for (const board of DOMAIN_KEYS) has(`board.${board}`)
    for (const panel of BOARD_PANELS) has(`panel.${panel}`)
    for (const period of DASHBOARD_PERIODS) (has(`period.${period}`), has(`periodWord.${period}`))
    for (const source of MEASURE_SOURCES) has(`source.${source}`)
    for (const bucket of WIP_AGE_BUCKETS) (has(`wip.band.${bucket}`), has(`wip.bandName.${bucket}`))
    for (const panel of REPORT_PANELS) (has(`pinned.${panel.area}.${panel.panel}`), has(`pinned.area.${panel.area}`))
    for (const key of ['error.read', 'error.forbidden', 'error.notFound', 'error.offline', 'error.save', 'error.stale', 'error.gone', 'error.invalid']) has(key)
    // Today's kinds and severities and the report pack's titles are said by their own catalogues.
    const today = (enHome as { today: { kind: Record<string, string>; severity: Record<string, string> } }).today
    for (const kind of ATTENTION_KINDS.filter((entry) => KIND_RULES[entry].category === 'ALERT')) expect(today.kind[kind], kind).toBeTruthy()
    expect(Object.keys(today.severity).sort()).toEqual(['HIGH', 'LOW', 'MEDIUM'])
    expect(flat(enReports as Record<string, unknown>)['report.sales.late-orders.title']).toBeTruthy()
  })

  it('is a built page in the navigation, Present a window page, the W2b-5 report pages built', () => {
    for (const page of ['/home/dashboards', '/home/dashboards/present']) expect(OFFICE_PAGES.has(page), page).toBe(true)
    expect(WINDOW_PAGES.has('/home/dashboards/present')).toBe(true)
    for (const panel of REPORT_PANELS) expect(OFFICE_PAGES.has(panel.page), panel.page).toBe(true)
    expect(BOARDS.length).toBe(DOMAIN_KEYS.length)
  })

  it('has its design routes with every state', () => {
    const screens = [ownerScreen, rolesScreen, presentScreen, pinScreen]
    const cases = (screen: string) => screens.find((entry) => entry.screen === screen)?.cases.map((item) => item.id) ?? []
    expect(cases('SCR-103')).toEqual(expect.arrayContaining(['owner', 'company', 'explain', 'arrange', 'arrange-refused', 'stale', 'nothing', 'few-weeks', 'panel-error', 'loading', 'error', 'no-permission']))
    expect(cases('SCR-031')).toEqual(expect.arrayContaining(['planner', 'planner-owner-view', 'sales', 'pinned', 'no-numbers']))
    expect(cases('SCR-490')).toEqual(['owner', 'plant-manager', 'loading'])
    expect(cases('SCR-491')).toEqual(expect.arrayContaining(['open', 'none-ticked', 'done', 'refused', 'boards-failed']))
  })
})
