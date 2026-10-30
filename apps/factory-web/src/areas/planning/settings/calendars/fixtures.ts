import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { OwnerRef } from '../api'
import type { SaveStatus } from '../model'
import { PlanningSettingsView } from '../view/PlanningSettingsView'
import { CALENDARS, canOf, COMPANY, COMPANY_NAME, detailOf, inShell, LANES, LINE_1, LINE_2, LINE_2_CAL, PATTERNS, PLANT_1, PLANT_2, PREFIX, SITE_CAL, TWO_SHIFTS, workingTimeOf, type Role } from './demo/fixtures'
import { NEW_PATTERN, patternDraftOf } from './model'
import { CalendarsView, type CalendarsModel } from './view/CalendarsView'

/**
 * SCR-124 — Planning settings › Calendars & shifts (design planning.settings sec:calendars, pop:day, pop:closure), with
 * made-up data only (calendars/demo.ts: an invented company, two plants, two lines, two workshops). Each case is one
 * state of the design, in the office shell, as a role sees it: the planner keeps calendars; the buyer and the
 * production manager only look (held with the missing right in words). In the browser the calendar works for real (kept
 * in the view): click a day, drag across days, open a pattern.
 */

interface Case {
  role: Role
  status: SaveStatus | null
  model: CalendarsModel
}

const SITE: OwnerRef = { scope: 'SITE', id: PLANT_1.id }
const L1: OwnerRef = { scope: 'LINE', id: LINE_1.id }
const L2: OwnerRef = { scope: 'LINE', id: LINE_2.id }
const CO: OwnerRef = { scope: 'COMPANY', id: COMPANY }

const own = (owner: OwnerRef) => (owner.scope === 'SITE' ? detailOf(SITE_CAL) : owner.scope === 'LINE' && owner.id === LINE_2.id ? detailOf(LINE_2_CAL) : owner.scope === 'COMPANY' ? detailOf(CALENDARS[0]!) : null)

function base(owner: OwnerRef, patch: Partial<CalendarsModel> = {}, role: Role = 'planner'): CalendarsModel {
  return {
    prefix: PREFIX,
    site: PLANT_1,
    companyName: COMPANY_NAME,
    otherSites: [PLANT_2],
    can: canOf(role),
    today: '2026-10-20',
    load: { status: 'ready' },
    calendars: CALENDARS,
    lanes: LANES,
    patterns: PATTERNS,
    owner,
    view: 'month',
    month: '2026-08',
    year: { status: 'ready', time: workingTimeOf(owner), own: own(owner) },
    busy: false,
    notice: null,
    changedElsewhere: false,
    ...patch,
  }
}

const make = (model: CalendarsModel, role: Role = 'planner', status: SaveStatus | null = null): Case => ({ role, status, model: { ...model, can: canOf(role) } })

function CalendarsDesign({ model }: { model: Case }) {
  const frame = createElement(
    PlanningSettingsView,
    { model: { prefix: PREFIX, can: model.model.can, tab: 'calendars', sites: { status: 'ready', items: [PLANT_1, PLANT_2] }, siteId: PLANT_1.id, status: model.status } },
    createElement(CalendarsView, { model: model.model }),
  )
  return inShell(frame, model.role)
}

const IMPACT = {
  status: 'ready' as const,
  lanes: [
    { kind: 'LINE' as const, id: LINE_1.id, code: 'L1', name: 'Line 1', bookedMinutes: 1240, workOrders: 3 },
    { kind: 'LINE' as const, id: LINE_2.id, code: 'L2', name: 'Line 2', bookedMinutes: 0, workOrders: 0 },
    { kind: 'WORK_CENTRE' as const, id: LANES.workCentres[0]!.id, code: 'CUT', name: 'Cutting', bookedMinutes: 310, workOrders: 1 },
    { kind: 'WORK_CENTRE' as const, id: LANES.workCentres[1]!.id, code: 'FIN', name: 'Finishing', bookedMinutes: 0, workOrders: 0 },
  ],
  otherSites: [],
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-124',
  title: 'Calendars & shifts (Planning settings)',
  view: CalendarsDesign,
  cases: [
    {
      id: 'site-month',
      label: 'Plant 1 in August (planner)',
      model: make(base(SITE)),
      note: 'The site calendar: two shifts Monday to Friday, weekends hatched, the summer closure with its reason, Ferragosto from the company calendar. Click a day for its exception; drag across days for a closure.',
    },
    { id: 'site-year', label: 'The year', model: make(base(SITE, { view: 'year' })), note: 'Twelve months: every public holiday, the August and Christmas closures; the key counts each kind over the year.' },
    {
      id: 'line-own',
      label: 'Line 2: its own days',
      model: make(base(L2, { month: '2026-09' })),
      note: 'Line 2 has its own calendar: an overhaul on 15 Sep (closed), an extra Saturday morning on the 26th; its shifts come from Plant 1 (two shifts), said under each day.',
    },
    {
      id: 'line-follows',
      label: 'Line 1 follows the site',
      model: make(base(L1, { month: '2026-12' })),
      note: 'Line 1 has no calendar of its own: the banner says whose days it follows; "Give Line 1 its own calendar" starts one with the week above.',
    },
    { id: 'company', label: 'The company calendar (every site)', model: make(base(CO, { month: '2026-12' })), note: 'The company calendar: the Italian public holidays and the patron saint, for every site; sites may open a day on their own.' },
    {
      id: 'day',
      label: 'Pop:day — Tuesday 3 Nov — Line 2',
      model: make(base(L2, { month: '2026-11', dialog: { kind: 'day', date: '2026-11-03' } })),
      note: 'The day popover anchored on the day: its state and hours, as the week · extra shift · short day · working with the week’s shifts · closed · holiday, the shifts of the day, its name and a note, and the lanes whose capacity it recalculates. Esc closes it and returns to the day.',
    },
    {
      id: 'day-extra',
      label: 'Pop:day — an extra Saturday',
      model: make(base(L2, { month: '2026-11', dialog: { kind: 'day', date: '2026-11-07' } })),
      note: 'Saturday 7 Nov is an extra shift of Line 2 (Saturday morning, 06:00–12:00): the pattern is offered only among those with more working time than the week has on that weekday.',
    },
    {
      id: 'closure',
      label: 'Pop:closure — Christmas with the lanes affected',
      model: make(base(SITE, { month: '2026-12', dialog: { kind: 'closure', draft: { from: '2026-12-21', to: '2026-12-23', reason: 'Inventario di fine anno', targets: [`SITE:${PLANT_1.id}`], taken: [], takenChoice: null } }, impact: IMPACT })),
      note: 'Add a closure: from, to, sites and lines, the reason; the lanes it reaches with the work orders booked on those days (Line 1: 3, Cutting: 1) and a link to move them on the planning board. Capacity is recalculated at once.',
    },
    {
      id: 'closure-taken',
      label: 'Pop:closure — days already set',
      model: make(base(SITE, { month: '2026-12', dialog: { kind: 'closure', draft: { from: '2026-12-07', to: '2026-12-11', reason: 'Fermo impianto', targets: [`LINE:${LINE_2.id}`], taken: ['2026-12-08'], takenChoice: null } }, closureTaken: ['2026-12-08'], impact: { ...IMPACT, lanes: [IMPACT.lanes[1]!] } })),
      note: 'Line 2 already has 8 Dec set (open for a rush order): the calendar refused the closure for that day; keep it and close the other days, or replace it. Add is held until one is chosen.',
    },
    {
      id: 'pattern',
      label: 'Shift pattern editor (two shifts)',
      model: make(base(SITE, { dialog: { kind: 'pattern', draft: patternDraftOf(TWO_SHIFTS) } })),
      note: 'One row per shift or break with its weekdays: Morning and Afternoon Monday to Friday with a 15-minute break each; the week in hours below. Saving recalculates the capacity of the calendars that use it.',
    },
    {
      id: 'pattern-problem',
      label: 'A new pattern with overlapping shifts',
      model: make(
        base(SITE, {
          dialog: {
            kind: 'pattern',
            draft: { ...NEW_PATTERN, code: 'NIGHT', name: 'Night shift', rows: [{ days: [1, 2, 3, 4], kind: 'SHIFT', label: 'Night', start: '22:00', end: '06:00' }, { days: [2], kind: 'SHIFT', label: 'Early', start: '05:00', end: '13:00' }] },
          },
        }),
      ),
      note: 'A night shift 22:00–06:00 (ends the next morning) runs into an early shift on Tuesday: said at the row before anything is sent; Create is held with the count of problems.',
    },
    {
      id: 'patterns-selected',
      label: 'Patterns selected (Archive N)',
      model: make(base(SITE, { selected: [PATTERNS[0]!.id, PATTERNS[2]!.id] })),
      note: 'Two unused patterns selected: Archive 2 patterns. A pattern in use cannot be ticked (its box says which calendars use it).',
    },
    {
      id: 'saved',
      label: 'Closure added (saved)',
      model: make(base(SITE, { month: '2026-12', notice: { tone: 'success', key: 'cal.notice.closureAdded', params: { where: 'P1 · Plant 1', lanes: 'Line 1 · Line 2 · Cutting · Finishing' } } }), 'planner', { kind: 'saved', at: '2026-10-20T09:42:00.000Z' }),
      note: 'The band says "All changes saved · 10:42"; the notice names the lanes whose capacity was recalculated at once.',
    },
    {
      id: 'no-calendar',
      label: 'No calendar yet (the default)',
      model: make(base(SITE, { calendars: [], year: { status: 'ready', time: workingTimeOf(SITE, 2026, []), own: null }, month: '2026-11' })),
      note: 'Nothing set for the company, the site or its lines: the site default (Monday to Friday, one shift) is drawn and said, never hidden; "Give Plant 1 its own calendar" starts one.',
    },
    { id: 'loading', label: 'Loading', model: make(base(SITE, { load: { status: 'loading' } })), note: 'Skeletons in the section’s shape; "Still loading…" after about a second.' },
    { id: 'year-loading', label: 'Loading the days', model: make(base(SITE, { year: { status: 'loading' } })), note: 'The calendar draws its skeleton month while the days are read.' },
    { id: 'error', label: 'Read failed', model: make(base(SITE, { load: { status: 'error', problem: 'ps.problem.offline' } })), note: 'A failed read is never drawn as an empty calendar: the reason in words and Try again.' },
    { id: 'changed', label: 'Changed by someone else', model: make(base(SITE, { changedElsewhere: true })), note: 'Live calendar.changed from another screen: Reload; nothing of ours is lost.' },
    {
      id: 'read-only',
      label: 'Production manager (read-only)',
      model: make(base(L2, { month: '2026-09' }), 'production'),
      note: 'Without calendars.manage: the calendar is drawn the same and days still open; Add closure, the week, New pattern and selecting days are held with the missing right in words.',
    },
    { id: 'buyer', label: 'Buyer (read-only here)', model: make(base(SITE), 'buyer'), note: 'The buyer keeps suppliers’ calendars (Purchasing), not the plant’s: everything here is held, with the reason.' },
  ],
})
