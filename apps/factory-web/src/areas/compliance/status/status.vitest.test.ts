import { describe, expect, it } from 'vitest'
import { LINE_STATES as DOMAIN_LINE_STATES } from '@nexus/factory-domain/compliance/gates/gate'
import { OVERRIDE_REASON_MAX as DOMAIN_REASON_MAX, OVERRIDE_REASON_MIN as DOMAIN_REASON_MIN, latestUntil as domainLatestUntil } from '@nexus/factory-domain/compliance/gates/override'
import { GAP_TYPES as DOMAIN_GAP_TYPES } from '@nexus/factory-domain/compliance/reports/rules'
import { COMPLIANCE_GATES, FIX_PLACES as DOMAIN_FIX_PLACES, OVERRIDE_DAYS_MAX as DOMAIN_DAYS_MAX, WHO as DOMAIN_WHO } from '@nexus/factory-domain/compliance/requirements/rules'
import { CELL_STATES as DOMAIN_CELL_STATES } from '@nexus/factory-domain/compliance/status/board'
import { daysBetween, leftWords, spanParts, validityOf } from '../_shared/validity/validity'
import { CELL_STATES, FIX_PLACES, GAP_TYPES, GATES, LINE_STATES, WHO, type GateEvent } from './api'
import { BOARD, FEED } from './fixtures'
import {
  boardCsvRows,
  boardQueryOf,
  cellWalk,
  defaultOverrideDay,
  EMPTY_ADDRESS,
  endOfRomeDay,
  feedCsvRows,
  feedShown,
  firstCellOf,
  fixHeld,
  fixHref,
  latestUntil,
  OVERRIDE_DAYS_MAX,
  OVERRIDE_REASON_MAX,
  OVERRIDE_REASON_MIN,
  overrideHeld,
  overridesInForce,
  overrideProblems,
  overrideRefusalKey,
  overrideSendHeld,
  printAddress,
  romeDay,
  rowsShown,
  statusAddressOf,
  statusAddressText,
  statusCan,
  styleHref,
  subjectHref,
  tileAct,
  tileActive,
  tileToggle,
  untilOf,
} from './model'

const params = (text: string) => new URLSearchParams(text)
const ALL = statusCan(['compliance.certificates.view', 'compliance.gates.override', 'quality.lots.view', 'workorders.view', 'shipping.view', 'product.styles.view'])
const VIEWER = statusCan(['compliance.certificates.view'])
const BUILT = new Set(['/compliance/certificates', '/compliance/labels', '/compliance/tests', '/products/styles/[id]', '/production/work-orders/[id]', '/warehouse/shipments/[id]'])
const BRAND = '0190f0e2-7302-7000-8000-000000000001'

describe('the lists are the API\'s (factory-domain)', () => {
  it('gates, cell and line states, who, fix places and gap types', () => {
    expect([...GATES]).toEqual([...COMPLIANCE_GATES])
    expect([...CELL_STATES]).toEqual([...DOMAIN_CELL_STATES])
    expect([...LINE_STATES]).toEqual([...DOMAIN_LINE_STATES])
    expect([...WHO]).toEqual([...DOMAIN_WHO])
    expect([...FIX_PLACES]).toEqual([...DOMAIN_FIX_PLACES])
    expect([...GAP_TYPES]).toEqual([...DOMAIN_GAP_TYPES])
  })
  it('the override limits', () => {
    expect([OVERRIDE_REASON_MIN, OVERRIDE_REASON_MAX, OVERRIDE_DAYS_MAX]).toEqual([DOMAIN_REASON_MIN, DOMAIN_REASON_MAX, DOMAIN_DAYS_MAX])
    const now = new Date('2026-11-10T09:42:00.000Z')
    for (const days of [0, 1, 3, 7, 30]) expect(latestUntil(now, days).toISOString()).toBe(domainLatestUntil(now, days).toISOString())
  })
})

describe('rights and the address', () => {
  it('the page needs the certificate view; the override its own permission', () => {
    expect(statusCan([])).toMatchObject({ view: false, override: false })
    expect(VIEWER).toMatchObject({ view: true, override: false, lots: false })
    expect(ALL).toMatchObject({ view: true, override: true, lots: true, workOrders: true, shipments: true, styles: true })
  })
  it('reads and writes every term, dropping what it does not know', () => {
    const address = statusAddressOf(params(`markets=it,DE,xx1,DE&brand=${BRAND}&gap=docLanguage&status=blocked&q=JKT&gate=SHIPMENT&feed=blocked&days=30`))
    expect(address).toEqual({ markets: ['IT', 'DE'], brandId: BRAND, gap: 'docLanguage', status: 'blocked', q: 'JKT', gate: 'SHIPMENT', feed: 'blocked', days: 30 })
    expect(statusAddressOf(params(statusAddressText(address).slice(1)))).toEqual(address)
    expect(statusAddressOf(params('brand=nope&gap=wrong&status=x&gate=Y&feed=z&days=12'))).toEqual(EMPTY_ADDRESS)
    expect(statusAddressText(EMPTY_ADDRESS)).toBe('')
  })
  it('asks the board for a gap except Cr VI (lots, not cells)', () => {
    expect(boardQueryOf({ ...EMPTY_ADDRESS, gap: 'label', q: '  ' })).toEqual({ markets: [], brandId: null, gap: 'label', q: null })
    expect(boardQueryOf({ ...EMPTY_ADDRESS, gap: 'crVi' }).gap).toBeNull()
  })
  it('the print window keeps the board\'s filters, not the refusals\'', () => {
    expect(printAddress('/w/DEMO', { ...EMPTY_ADDRESS, markets: ['DE'], status: 'ready', gate: 'SHIPMENT', feed: 'blocked', days: 30 })).toBe('/w/DEMO/compliance/status/print?markets=DE&status=ready')
  })
})

describe('the matrix', () => {
  it('a status filter keeps the rows that say so', () => {
    expect(rowsShown(BOARD.rows, null)).toHaveLength(5)
    expect(rowsShown(BOARD.rows, 'ready').map((row) => row.style.code)).toEqual(['DEMO-TRS-02'])
    expect(rowsShown(BOARD.rows, 'blocked').map((row) => row.style.code)).toEqual(['DEMO-JKT-01', 'DEMO-SUT-04', 'DEMO-VST-05'])
    expect(rowsShown(BOARD.rows, 'expiring').map((row) => row.style.code)).toEqual(['DEMO-GLV-03'])
    expect(rowsShown(BOARD.rows, 'missing').map((row) => row.style.code)).toEqual(['DEMO-JKT-01', 'DEMO-SUT-04'])
  })
  it('J / K walk the row, ⇧J / ⇧K the rows; Enter opens the worst cell', () => {
    const codes = BOARD.markets.map((market) => market.code)
    const [jacket, trousers] = BOARD.rows
    expect(cellWalk(BOARD.rows, codes, { styleId: jacket!.style.id, market: 'IT' })).toEqual({ next: { styleId: jacket!.style.id, market: 'DE' }, prev: null, down: { styleId: trousers!.style.id, market: 'IT' }, up: null })
    expect(cellWalk(BOARD.rows, codes, { styleId: 'gone', market: 'IT' })).toEqual({ next: null, prev: null, down: null, up: null })
    expect(firstCellOf(jacket!)).toEqual({ styleId: jacket!.style.id, market: 'DE' })
    expect(firstCellOf(trousers!)).toEqual({ styleId: trousers!.style.id, market: 'IT' })
  })
  it('the file says each market in words with the first requirement', () => {
    const rows = boardCsvRows([BOARD.rows[0]!], ['IT', 'DE'], (state, missing) => (state === 'MISSING' ? `Missing ${missing}` : state))
    expect(rows).toEqual([['DEMO-JKT-01', 'Giacca Demo Touring', null, 'READY', 'BLOCKED (USER-INFO-LANGUAGE)']])
  })
})

describe('where things lead', () => {
  it('a tile filters or opens its list; pressing it again clears it', () => {
    expect(tileAct('stylesBlocked', '/w/DEMO', ALL, BUILT)).toEqual({ kind: 'filter', change: { status: 'blocked', gap: null } })
    expect(tileAct('missingLanguages', '/w/DEMO', ALL, BUILT)).toEqual({ kind: 'filter', change: { gap: 'docLanguage', status: null } })
    expect(tileAct('certificatesExpiring90', '/w/DEMO', ALL, BUILT)).toEqual({ kind: 'link', href: '/w/DEMO/compliance/certificates?view=expiring90' })
    expect(tileAct('lotsWithoutCrVi', '/w/DEMO', VIEWER, BUILT)).toEqual({ kind: 'none', held: 'tile.held.role' })
    const held = tileAct('shipmentsHeld', '/w/DEMO', ALL, BUILT)
    const on = { ...EMPTY_ADDRESS, gate: 'SHIPMENT' as const, feed: 'blocked' as const, days: 30 as const }
    expect(tileActive('shipmentsHeld', on)).toBe(true)
    expect(tileToggle('shipmentsHeld', on, held)).toEqual({ gate: null, feed: 'all', days: 7 })
    expect(tileToggle('stylesReady', EMPTY_ADDRESS, tileAct('stylesReady', '', ALL, BUILT))).toEqual({ status: 'ready', gap: null })
  })
  it('Fix opens its page once built and in the role, else says why', () => {
    expect(fixHref('certificates', '/w/DEMO', ALL, BUILT)).toBe('/w/DEMO/compliance/certificates')
    expect(fixHref('declarations', '/w/DEMO', ALL, BUILT)).toBeNull()
    expect(fixHeld('declarations', ALL, BUILT)).toBe('fix.held.declarations')
    expect(fixHeld('operators', ALL, BUILT)).toBe('fix.held.settings')
    expect(fixHref('tests', '/w/DEMO', VIEWER, BUILT)).toBeNull()
    expect(fixHeld('tests', VIEWER, BUILT)).toBe('fix.held.role')
  })
  it('a refusal opens its work order or shipment when the role may; a style its record', () => {
    const [refusal, shipment] = FEED.events
    expect(subjectHref(refusal!, '/w/DEMO', ALL, BUILT)).toBe(`/w/DEMO/production/work-orders/${refusal!.subject.id}`)
    expect(subjectHref(shipment!, '/w/DEMO', VIEWER, BUILT)).toBeNull()
    expect(styleHref('s1', '/w/DEMO', ALL, BUILT)).toBe('/w/DEMO/products/styles/s1')
    expect(styleHref('s1', '/w/DEMO', VIEWER, BUILT)).toBeNull()
  })
})

describe('gate refusals and the override', () => {
  const [blocked, notMine, locked, overridden, cleared] = FEED.events as [GateEvent, GateEvent, GateEvent, GateEvent, GateEvent]
  it('the feed filter keeps one state', () => {
    expect(feedShown(FEED.events, 'all')).toHaveLength(5)
    expect(feedShown(FEED.events, 'blocked').map((event) => event.subject.number)).toEqual(['DEMO-WO-0142', 'DEMO-SHP-0091', 'DEMO-WO-0138'])
    expect(feedShown(FEED.events, 'overridden').map((event) => event.subject.number)).toEqual(['DEMO-WO-0131'])
  })
  it('Override… says why it is held', () => {
    expect(overrideHeld(blocked, ALL, false)).toBeNull()
    expect(overrideHeld(blocked, ALL, true)).toBe('override.held.offline')
    expect(overrideHeld(blocked, VIEWER, false)).toBe('override.held.role')
    expect(overrideHeld(notMine, ALL, false)).toBe('override.held.role')
    expect(overrideHeld(locked, ALL, false)).toBe('override.held.locked')
    expect(overrideHeld(overridden, ALL, false)).toBe('override.held.state.OVERRIDDEN')
    expect(overrideHeld(cleared, ALL, false)).toBe('override.held.state.CLEARED')
    expect(overrideHeld({ ...blocked, requirement: { ...blocked.requirement, overrideRoleKeys: [] } }, ALL, false)).toBe('override.held.noRole')
    // Another refusal of the same work order, gate and requirement with an override in force: the API would answer IN_FORCE.
    const twin = { ...blocked, id: 'twin', overrides: [{ id: 'o1', at: blocked.at, until: '2026-11-12T22:59:59.000Z', reason: 'Made up.', by: null, inForce: true }] }
    const keys = overridesInForce([blocked, twin], new Date('2026-11-10T09:42:00.000Z'))
    expect(overrideHeld(blocked, ALL, false, keys)).toBe('override.held.state.OVERRIDDEN')
    expect(overridesInForce(FEED.events, new Date('2026-11-10T09:42:00.000Z')).size).toBe(1)
  })
  it('the last day: the end of that day in Rome, never later than the requirement allows', () => {
    const now = new Date('2026-11-10T09:42:00.000Z')
    expect(romeDay(now)).toBe('2026-11-10')
    expect(endOfRomeDay('2026-11-11').toISOString()).toBe('2026-11-11T22:59:59.000Z')
    expect(endOfRomeDay('2026-07-01').toISOString()).toBe('2026-07-01T21:59:59.000Z')
    expect(untilOf('2026-11-11', now, 3).toISOString()).toBe('2026-11-11T22:59:59.000Z')
    expect(untilOf('2026-11-13', now, 3).toISOString()).toBe('2026-11-13T09:42:00.000Z')
    expect(defaultOverrideDay(now, 3)).toBe('2026-11-11')
    expect(defaultOverrideDay(new Date('2026-11-10T22:30:00.000Z'), 0)).toBe('2026-11-10')
  })
  it('the draft as the API would refuse it', () => {
    const now = new Date('2026-11-10T09:42:00.000Z')
    expect(overrideProblems({ reason: 'Too short', day: '2026-11-11' }, now, 3)).toEqual({ reason: 'override.problem.reasonShort' })
    expect(overrideProblems({ reason: 'x'.repeat(2001), day: '2026-11-11' }, now, 3)).toEqual({ reason: 'override.problem.reasonLong' })
    expect(overrideProblems({ reason: 'A written reason (made up).', day: '2026-11-09' }, now, 3)).toEqual({ day: 'override.problem.past' })
    expect(overrideProblems({ reason: 'A written reason (made up).', day: '2026-11-14' }, now, 3)).toEqual({ day: 'override.problem.tooLong' })
    expect(overrideProblems({ reason: 'A written reason (made up).', day: '' }, now, 3)).toEqual({ day: 'override.problem.day' })
    expect(overrideSendHeld({ reason: 'A written reason (made up).', day: '2026-11-13' }, now, 3, false)).toBeNull()
    expect(overrideSendHeld({ reason: 'A written reason (made up).', day: '2026-11-13' }, now, 3, true)).toBe('override.held.busy')
    expect(overrideRefusalKey('forbidden')).toBe('override.refused.role')
    expect(overrideRefusalKey('conflict')).toBe('override.refused.conflict')
    expect(overrideRefusalKey('internal')).toBe('override.refused.unavailable')
  })
  it('the refusals\' file names no person', () => {
    const rows = feedCsvRows([overridden], { gate: (gate) => gate, state: (state) => state })
    expect(rows[0]).toEqual([overridden.at, 'WORK_ORDER_RELEASE', 'DEMO-WO-0131', 'DEMO-JKT-01', 'NERO', '54', 'DE', 'USER-INFO-LANGUAGE', 'OVERRIDDEN', overridden.reason])
    expect(JSON.stringify(rows)).not.toContain('Demo Responsabile')
  })
})

describe('the ValidityBar', () => {
  it('counts days and calendar parts as a person does', () => {
    expect(daysBetween('2026-11-10', '2026-12-08')).toBe(28)
    expect(spanParts('2026-11-10', '2030-03-11')).toEqual({ years: 3, months: 4, days: 1 })
    expect(spanParts('2026-01-31', '2026-03-01')).toEqual({ years: 0, months: 1, days: 1 })
  })
  it('the stage, today on the track and the alert ticks', () => {
    const five = validityOf({ from: '2024-03-12', to: '2029-03-11', today: '2026-11-10' })
    expect(five.stage).toBe('ok')
    expect(five.alerts.map((alert) => alert.days)).toEqual([180, 90, 30])
    expect(five.todayAt).toBeGreaterThan(50)
    expect(five.todayAt).toBeLessThan(60)
    expect(validityOf({ from: '2021-12-09', to: '2026-12-08', today: '2026-11-10' }).stage).toBe('d30')
    expect(validityOf({ from: null, to: '2027-01-31', today: '2026-11-10' })).toMatchObject({ stage: 'd90', todayAt: null, alerts: [] })
    expect(validityOf({ from: null, to: '2027-04-30', today: '2026-11-10' }).stage).toBe('d180')
    expect(validityOf({ from: null, to: '2026-11-01', today: '2026-11-10' }).stage).toBe('ended')
    expect(validityOf({ from: '2026-12-01', to: '2031-11-30', today: '2026-11-10' }).stage).toBe('notYet')
  })
  it('the words: two units, days alone under a month, ends today, ended', () => {
    expect(leftWords(validityOf({ from: null, to: '2030-03-11', today: '2026-11-10' }))).toEqual([
      { key: 'validity.years', params: { count: 3 } },
      { key: 'validity.months', params: { count: 4 } },
    ])
    expect(leftWords(validityOf({ from: null, to: '2026-12-08', today: '2026-11-10' }))).toEqual([{ key: 'validity.daysLeft', params: { count: 28 } }])
    expect(leftWords(validityOf({ from: null, to: '2026-11-10', today: '2026-11-10' }))).toEqual([{ key: 'validity.endsToday', params: {} }])
    expect(leftWords(validityOf({ from: null, to: '2026-11-07', today: '2026-11-10' }))).toEqual([{ key: 'validity.ended', params: { count: 3 } }])
  })
})
