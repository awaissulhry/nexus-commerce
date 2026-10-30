import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { dailyReport, lastOperationOf, missingRoots, rootOf, standingScans, type DailyFacts, type DailyScan } from './daily'
import { bottleneckOf, lineStateOf, outputPct, plannedOnLine, plannedShare } from './lines'
import { PRODUCTION_REPORTS_PERMISSIONS } from './permissions'
import { dailyReportMail, reportLocaleOf, subscriptionProblems } from './subscriptions'

// Every figure below is worked out by hand (the comments show the sums). 29 Oct 2026 is a Thursday in CET (UTC+1).
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour - 1, minute))
const scan = (id: string, extra: Partial<DailyScan>): DailyScan => ({
  id,
  kind: 'REPORT',
  correctsId: null,
  bundleId: 'B1',
  workOrderId: 'WO1',
  operationId: 'op20',
  good: 0,
  scrap: 0,
  rework: 0,
  stationId: 'S1',
  at: at(29, 8),
  ...extra,
})

function facts(): DailyFacts {
  return {
    day: '2026-10-29',
    timeZone: 'Europe/Rome',
    scans: [
      scan('s0', { bundleId: 'B2', good: 6, at: at(28, 15) }), // yesterday, corrected today
      scan('s1', { good: 10, at: at(29, 8) }), // L1 op20 (not the line's last): earns 10 × 12.5
      scan('s2', { operationId: 'op30', good: 8, scrap: 1, rework: 1, stationId: 'S2', at: at(29, 10) }), // L1 last op
      scan('s3', { bundleId: 'B2', operationId: 'op30', good: 5, stationId: 'S2', at: at(29, 11) }), // undone
      scan('s4', { bundleId: 'B2', operationId: 'op30', kind: 'UNDO', correctsId: 's3', stationId: 'S2', at: at(29, 11, 1) }),
      scan('s5', { bundleId: 'B2', operationId: 'op30', good: 6, stationId: 'S2', at: at(29, 11, 5) }),
      scan('s6', { bundleId: 'BP', operationId: 'op30', good: 4, stationId: 'S2', at: at(29, 12) }), // a part bundle: not garments
      scan('s7', { operationId: 'op40', good: 7, scrap: 1, stationId: 'Q1', at: at(29, 14) }), // the inspection bench
      scan('s8', { bundleId: 'B2', kind: 'CORRECTION', correctsId: 's0', good: 5, at: at(29, 9) }), // counts on the 28th
      scan('s9', { bundleId: 'B2', good: 3, at: at(30, 0, 30) }), // tomorrow
      scan('s10', { good: 2, stationId: null, at: at(29, 15) }), // no station: no lane
    ],
    bundles: new Map([
      ['B1', { part: null, status: 'ACTIVE', workOrderSizeId: 'cellA' }],
      ['B2', { part: null, status: 'ACTIVE', workOrderSizeId: 'cellB' }],
      ['BP', { part: 'SLEEVES', status: 'ACTIVE', workOrderSizeId: 'cellA' }],
    ]),
    operations: new Map([
      ['op10', { workOrderId: 'WO1', seq: 10, scanRequired: true, workCentreId: 'C-CUT', standardMinutes: '5' }],
      ['op20', { workOrderId: 'WO1', seq: 20, scanRequired: true, workCentreId: 'C-SEW', standardMinutes: '12.5' }],
      ['op30', { workOrderId: 'WO1', seq: 30, scanRequired: true, workCentreId: 'C-SEW', standardMinutes: '7.5' }],
      ['op35', { workOrderId: 'WO1', seq: 35, scanRequired: false, workCentreId: 'C-SEW', standardMinutes: '1' }],
      ['op40', { workOrderId: 'WO1', seq: 40, scanRequired: true, workCentreId: 'C-QC', standardMinutes: '2' }],
    ]),
    workOrders: new Map([['WO1', { styleId: 'ST1' }]]),
    sizes: new Map([
      ['cellA', '48'],
      ['cellB', '50'],
    ]),
    stationLanes: new Map([
      ['S1', { kind: 'LINE' as const, id: 'L1' }],
      ['S2', { kind: 'LINE' as const, id: 'L1' }],
      ['Q1', { kind: 'WORK_CENTRE' as const, id: 'C-QC' }],
    ]),
    laneCentres: new Map([
      ['LINE:L1', new Set(['C-SEW'])],
      ['LINE:L2', new Set(['C-SEW'])],
      ['WORK_CENTRE:C-QC', new Set(['C-QC'])],
    ]),
    // A rework finished today on L1's work order: 2 garments of size 50 scrapped.
    extras: [{ lane: { kind: 'LINE', id: 'L1' }, workOrderId: 'WO1', workOrderSizeId: 'cellB', scrap: 2, rework: 0 }],
    available: new Map([
      ['L1', { people: 2, workingMinutes: 480 }],
      ['L2', { people: 1, workingMinutes: 480 }],
    ]),
  }
}

describe('the daily production report (MES-301)', () => {
  it('counts good through the lane’s last operation, scrap and rework anywhere on it, per style and size', () => {
    const report = dailyReport(facts(), ['LINE:L1', 'LINE:L2'])
    expect(report.lanes.map((lane) => `${lane.lane.kind}:${lane.lane.id}`)).toEqual(['LINE:L1', 'LINE:L2', 'WORK_CENTRE:C-QC'])
    const [l1, l2, qc] = report.lanes
    // good: s2 8 + s5 6 (op30 is L1's last); s1 (op20), s3 (undone), s6 (part), s8 (the 28th), s9 (the 30th) do not count.
    expect(l1).toMatchObject({ good: 14, scrap: 3, rework: 1 })
    // earned: s1 10 × 12.5 + s2 8 × 7.5 + s5 6 × 7.5 = 125 + 60 + 45 = 230; available 2 × 480 = 960; 230 / 960 = 23.958 %.
    expect(l1).toMatchObject({ earnedMinutes: '230.0', availableMinutes: '960.0', efficiencyPct: '24.0' })
    expect(l1!.rows).toEqual([
      { styleId: 'ST1', size: '48', good: 8, scrap: 1, rework: 1 },
      { styleId: 'ST1', size: '50', good: 6, scrap: 2, rework: 0 },
    ])
    // A line with nothing reported, whose people were planned to work: 0 %, said, not hidden.
    expect(l2).toMatchObject({ good: 0, scrap: 0, rework: 0, earnedMinutes: '0.0', availableMinutes: '480.0', efficiencyPct: '0.0', rows: [] })
    // The inspection bench is a lane of its own; no efficiency for a work centre.
    expect(qc).toMatchObject({ good: 7, scrap: 1, rework: 0, earnedMinutes: null, availableMinutes: null, efficiencyPct: null })
    expect(report.totals).toEqual({ good: 21, scrap: 4, rework: 1 })
  })

  it('counts a correction on the day of the report it corrects', () => {
    const report = dailyReport({ ...facts(), day: '2026-10-28', extras: [], available: new Map() })
    // s8 (CORRECTION of s0, approved on the 29th) stands for s0's 28th: op20 is not L1's last, so only earned minutes.
    expect(report.lanes).toEqual([{ lane: { kind: 'LINE', id: 'L1' }, good: 0, scrap: 0, rework: 0, earnedMinutes: '62.5', availableMinutes: null, efficiencyPct: null, rows: [] }])
  })

  it('says nothing per person: a worker on a scan never reaches the report', () => {
    const withWorkers = { ...facts(), scans: facts().scans.map((row) => ({ ...row, workerId: 'W-ANNA', workerName: 'Anna' })) }
    const text = JSON.stringify(dailyReport(withWorkers))
    expect(text).not.toMatch(/worker|Anna|W-ANNA|station|S1|S2/i)
  })

  it('a closed day has no efficiency: nothing was available', () => {
    const report = dailyReport({ ...facts(), available: new Map([['L1', { people: 2, workingMinutes: 0 }]]) })
    expect(report.lanes[0]).toMatchObject({ lane: { id: 'L1' }, availableMinutes: '0.0', efficiencyPct: null })
  })

  it('reads standing scans, roots and the lane’s last operation', () => {
    const rows = facts().scans
    expect(standingScans(rows).map((row) => row.id)).toEqual(['s1', 's2', 's5', 's6', 's7', 's8', 's9', 's10'])
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(rootOf(byId.get('s8')!, byId).id).toBe('s0')
    expect(missingRoots(rows.filter((row) => row.id !== 's0'))).toEqual(['s0'])
    const ops = [...facts().operations].map(([id, op]) => ({ ...op, id }))
    expect(lastOperationOf(ops, new Set(['C-SEW']))).toBe('op30') // op35 is not scanned
    expect(lastOperationOf(ops, new Set(['C-PACK']))).toBeNull()
    expect(lastOperationOf(ops, undefined)).toBeNull()
  })
})

describe('the floor overview by line (MES-160, Owner F2)', () => {
  const now = at(29, 10, 30)
  it('says Running, Waiting or No work', () => {
    expect(lineStateOf({ openWorkOrders: 1, plannedToday: 20, lastScanAt: at(29, 10, 5), now })).toBe('RUNNING')
    expect(lineStateOf({ openWorkOrders: 0, plannedToday: null, lastScanAt: at(29, 10, 0), now })).toBe('RUNNING') // 30 min exactly
    expect(lineStateOf({ openWorkOrders: 1, plannedToday: null, lastScanAt: at(29, 9, 59), now })).toBe('WAITING')
    expect(lineStateOf({ openWorkOrders: 0, plannedToday: 12, lastScanAt: null, now })).toBe('WAITING')
    expect(lineStateOf({ openWorkOrders: 0, plannedToday: 0, lastScanAt: null, now })).toBe('NO_WORK')
  })

  it('plans a slot’s garments by its working minutes today', () => {
    expect(plannedShare(100, { today: 480, slot: 960 }, { today: 0, slot: 0 })).toBe(50)
    expect(plannedShare(7, { today: 480, slot: 480 }, { today: 0, slot: 0 })).toBe(7)
    expect(plannedShare(10, { today: 160, slot: 480 }, { today: 0, slot: 0 })).toBe(3) // 3.33 → 3
    expect(plannedShare(10, { today: 0, slot: 0 }, { today: 120, slot: 240 })).toBe(5) // over closed time: by the clock
    expect(plannedShare(10, { today: 0, slot: 480 }, { today: 0, slot: 480 })).toBe(0)
    // per work order: its whole-order slots, else the bars of its highest operation on the line, never their sum
    expect(
      plannedOnLine([
        { workOrderId: 'WO1', operationSeq: 20, plannedToday: 30 },
        { workOrderId: 'WO1', operationSeq: 30, plannedToday: 25 },
        { workOrderId: 'WO2', operationSeq: 20, plannedToday: 9 },
        { workOrderId: 'WO2', operationSeq: null, plannedToday: 12 },
      ]),
    ).toBe(25 + 12)
  })

  it('finds the operation where most pieces wait, and output against the plan', () => {
    const op = (n: string, waiting: number) => ({ workOrderId: n, workOrderNumber: n, operationId: `${n}-30`, seq: 30, code: 'SEW', name: 'Sew', waiting })
    expect(bottleneckOf([op('WO1', 4), op('WO2', 9), op('WO3', 9)])?.workOrderId).toBe('WO2')
    expect(bottleneckOf([op('WO1', 0)])).toBeNull()
    expect(outputPct(14, 20)).toBe(70)
    expect(outputPct(3, null)).toBeNull()
    expect(outputPct(3, 0)).toBeNull()
  })
})

describe('the daily report by e-mail', () => {
  it('checks the time and the weekdays', () => {
    expect(subscriptionProblems({ sendTime: '07:00', weekdays: [1, 2, 3, 4, 5] })).toEqual([])
    expect(subscriptionProblems({ sendTime: '7:00', weekdays: [] }).map((issue) => issue.path)).toEqual(['body/sendTime', 'body/weekdays'])
    expect(subscriptionProblems({ sendTime: '24:00', weekdays: [2, 1] }).map((issue) => issue.path)).toEqual(['body/sendTime', 'body/weekdays'])
  })

  it('picks the language asked, else the person’s, else Italian', () => {
    expect(reportLocaleOf('en', 'it')).toBe('en')
    expect(reportLocaleOf(null, 'en-GB')).toBe('en')
    expect(reportLocaleOf(undefined, 'de')).toBe('it')
  })

  it('writes the mail per line, never per person', () => {
    const report = {
      site: { code: 'A1', name: 'Plant A1' },
      day: '2026-10-29',
      lanes: [
        { label: 'L1 Line 1', kind: 'LINE' as const, good: 14, scrap: 3, rework: 1, efficiencyPct: '24.0' },
        { label: 'QC Inspection', kind: 'WORK_CENTRE' as const, good: 7, scrap: 1, rework: 0, efficiencyPct: null },
      ],
      totals: { good: 21, scrap: 4, rework: 1 },
      link: 'https://factory.example/w/A/production/reports?site=s&date=2026-10-29',
    }
    const en = dailyReportMail(report, 'en')
    expect(en.subject).toBe('Production on Thursday 29 October 2026 · A1')
    expect(en.lines).toContain('In all: 21 good · 4 scrap · 1 rework.')
    expect(en.lines).toContain('• L1 Line 1: 14 good · 3 scrap · 1 rework · efficiency 24.0 %')
    expect(en.lines).toContain('• QC Inspection: 7 good · 1 scrap · 0 rework')
    const it = dailyReportMail(report, 'it')
    expect(it.subject).toBe('Produzione del giovedì 29 ottobre 2026 · A1')
    expect(it.lines).toContain('• L1 Line 1: 14 buoni · 3 scarti · 1 rilavorazioni · efficienza 24,0 %')
    expect(dailyReportMail({ ...report, lanes: [], totals: { good: 0, scrap: 0, rework: 0 } }, 'en').lines).toContain('The floor recorded no work on this day.')
  })
})

describe('catalogues', () => {
  it('declares the permissions and gives them to the office templates that read the floor', () => {
    for (const name of PRODUCTION_REPORTS_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    const holders = (name: string) => ROLE_TEMPLATES.filter((role) => role.permissions.includes(name as never)).map((role) => role.key).sort()
    expect(holders('production.reports.view')).toEqual(['floor_supervisor', 'owner', 'planner', 'production_manager', 'quality_inspector', 'read_only'])
    expect(holders('production.reports.subscribe')).toEqual(['floor_supervisor', 'owner', 'planner', 'production_manager'])
    expect(EVENT_CATALOGUE.find('production.report_subscription_changed', 1)).toBeDefined()
    expect(EVENT_CATALOGUE.find('production.daily_report_sent', 1)).toBeDefined()
  })
})
