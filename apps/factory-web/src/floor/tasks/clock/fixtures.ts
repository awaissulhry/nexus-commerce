import { defineDesignScreen } from '../../../lib/design/design-screen'
import { deviceFrame, onFloor, signedInFrame } from '../../frame/fixtures'
import type { ClockView, OpenItem } from './model'
import { ClockScreen, type ClockViewModel } from './view/ClockView'

/**
 * SCR-170's cases with made-up people and times: your time today in each state, fixed and clocked breaks, a badge
 * scanned here, Clock out? with open work and what it paused, forgot badge, offline, the kiosk with nobody signed in, the
 * closed clock (the ATTENDANCE gate), refusals. No badge code and no PIN appears (the view never holds one); no money.
 */

/** The running clock counts from the moment of the read: here, the moment the page opens. */
const READ_AT = Date.now()
const PERSON = { workerId: '0190f0e2-3333-7000-8000-000000000010', employeeId: '0190f0e2-3333-7000-8000-000000000110', name: 'Ada Demo' }
const SHIFT = { label: 'Mattina', date: '2026-10-29', startsAt: '2026-10-29T05:00:00.000Z', endsAt: '2026-10-29T13:00:00.000Z', source: 'ROSTER' as const }
const event = (id: string, kind: ClockView['next'], occurredAt: string, flags: ClockView['events'][number]['flags'] = []) => ({ id, kind, source: flags.includes('FORGOT_BADGE') ? ('NAME_PIN' as const) : ('BADGE' as const), occurredAt, flags, flagged: flags.length > 0 })
const IN_EVENT = event('0190f0e2-3333-7000-8000-000000000201', 'IN', '2026-10-29T06:58:00.000Z')

const inClock: ClockView = {
  person: PERSON,
  state: 'IN',
  inSince: '2026-10-29T06:58:00.000Z',
  breakSince: null,
  forgottenSince: null,
  minutes: { worked: 252, present: 252, breaks: 0 },
  shift: SHIFT,
  breaks: { mode: 'FIXED', next: { label: null, startsAt: '2026-10-29T10:00:00.000Z', endsAt: '2026-10-29T10:30:00.000Z' }, due: null },
  autoClockOutAt: '2026-10-29T13:15:00.000Z',
  actions: ['OUT'],
  next: 'OUT',
  events: [IN_EVENT],
  serverTime: '2026-10-29T11:10:00.000Z',
}
const outClock: ClockView = { ...inClock, state: 'OUT', inSince: null, minutes: { worked: 0, present: 0, breaks: 0 }, breaks: { mode: 'FIXED', next: null, due: null }, autoClockOutAt: null, actions: ['IN'], next: 'IN', events: [] }
const clocked: ClockView = { ...inClock, breaks: { mode: 'CLOCKED', next: null, due: null }, actions: ['OUT', 'BREAK_OUT'], autoClockOutAt: null }
const onBreak: ClockView = { ...clocked, state: 'ON_BREAK', breakSince: '2026-10-29T10:58:00.000Z', actions: ['BREAK_IN', 'OUT'], next: 'BREAK_IN' }

const PAUSED: OpenItem = { bundleId: '0190f0e2-3333-7000-8000-000000000041', bundleCode: 'B-000123', operation: { id: '0190f0e2-3333-7000-8000-000000000042', seq: 30, name: 'Cucitura colletto' }, state: 'PAUSED', mine: true, pausedAtClockOut: true }
const ROSTER = ['Ada Demo', 'Bea Esempio', 'Carlo Prova', 'Luca Demo', 'Marta Esempio', 'Sara Prova'].map((name, index) => ({ id: `0190f0e2-3333-7000-8000-0000000003${String(index + 10)}`, name }))

const base = { online: true, forgot: true, roster: ROSTER, timeZone: 'Europe/Rome' }
const mine = (view: ClockView | null, extra: Partial<ClockViewModel> = {}, asOf: string | null = null): ClockViewModel => ({ ...base, frame: signedInFrame('tile.clock'), step: { kind: 'mine', view, readAt: READ_AT, asOf }, ...extra })
const kiosk = (extra: Partial<ClockViewModel> = {}): ClockViewModel => ({ ...base, frame: deviceFrame('tile.clock'), step: { kind: 'kiosk' }, kept: { waiting: 0, available: true, refused: [] }, ...extra })
const offlineFrame = signedInFrame('tile.clock', { online: false, pending: 1 })
const RECORDED_IN = { kind: 'recorded', action: 'IN', at: '2026-10-29T06:58:00.000Z', repeated: false, name: null, flags: [] } as const

export const designScreen = defineDesignScreen<ClockViewModel>({
  screen: 'SCR-170',
  title: 'Floor Clock in/out & breaks',
  view: onFloor(ClockScreen),
  cases: [
    { id: 'in', label: 'In since 07:58', model: mine(inClock), note: 'Your time today: the shift, the next fixed break, when the automatic clock-out closes it. Enter = Clock out. A badge scanned here clocks at once.' },
    { id: 'out', label: 'Not clocked in', model: mine(outClock), note: 'Enter = Clock in.' },
    { id: 'clocked-in', label: 'Just clocked in', model: mine(inClock, { receipt: RECORDED_IN }), note: 'The confirmation shows the time and the hours so far (MES-223).' },
    { id: 'breaks-clocked', label: 'Breaks are clocked', model: mine(clocked), note: 'Secondary action Break, main Clock out (MES-224).' },
    { id: 'on-break', label: 'On a break', model: mine(onBreak), note: 'Main action Back from break; the day does not count on.' },
    { id: 'break-due', label: 'A break is due', model: mine({ ...clocked, breaks: { ...clocked.breaks, due: 'You have worked 6 h 10 min without a break.' } }), note: 'D.Lgs. 66/2003 art. 8, a law reference in plain words.' },
    { id: 'forgotten', label: 'A clock-in never closed', model: mine({ ...outClock, forgottenSince: '2026-10-28T07:00:00.000Z' }), note: 'Older than 13 hours it counts as out; the team leader corrects that day.' },
    { id: 'flagged', label: 'Clocked by name and PIN', model: mine({ ...inClock, events: [event('0190f0e2-3333-7000-8000-000000000202', 'IN', '2026-10-29T06:58:00.000Z', ['FORGOT_BADGE'])] }), note: 'MES-239: flagged for the team leader, and the person sees that it is.' },
    { id: 'confirm', label: 'Clock out? with open work', model: mine(inClock, { confirm: ['B-000123'] }), note: 'SCR-170\'s pop-up. Enter = Clock out. A badge scanned does not ask.' },
    { id: 'confirm-many', label: 'Clock out? with two open bundles', model: mine(inClock, { confirm: ['B-000123', 'B-000124'] }) },
    { id: 'paused', label: 'Open work paused at clock-out', model: mine(outClock, { receipt: { kind: 'recorded', action: 'OUT', at: '2026-10-29T13:02:00.000Z', repeated: false, name: null, flags: [] }, paused: [PAUSED] }), note: 'MES-117: the next sign-in offers to continue.' },
    { id: 'pausing', label: 'Open work: the pause is on its way', model: mine(outClock, { receipt: { kind: 'recorded', action: 'OUT', at: '2026-10-29T13:02:00.000Z', repeated: false, name: null, flags: [] }, willPause: ['B-000123'] }) },
    { id: 'other-badge', label: 'Another person\'s badge scanned here', model: mine(inClock, { receipt: { kind: 'recorded', action: 'OUT', at: '2026-10-29T11:10:00.000Z', repeated: false, name: 'Luca Demo', flags: [] } }), note: 'Their answer leaves the screen after a few seconds: one person\'s own time, never a list.' },
    { id: 'repeated', label: 'The badge scanned twice', model: mine(inClock, { receipt: { ...RECORDED_IN, repeated: true } }), note: 'Within a minute a scan answers the one before: it never clocks back out.' },
    { id: 'refused', label: 'A wrong button (refused in words)', model: mine(inClock, { receipt: { kind: 'refused', code: 'ALREADY_IN', message: 'Already in.', fix: null } }) },
    { id: 'refused-month', label: 'A closed month', model: mine(inClock, { receipt: { kind: 'refused', code: 'MONTH_CLOSED', message: 'Closed.', fix: null } }) },
    { id: 'offline-saved', label: 'Offline: saved on this tablet', model: mine(inClock, { frame: offlineFrame, online: false, receipt: { kind: 'saved', action: 'IN', at: '2026-10-29T06:58:00.000Z', clockWrong: false }, ticks: 'saved' }, '2026-10-29T06:40:00.000Z'), note: 'MES-199: the tablet\'s time, one tick; the office answers when the network is back. Forgot your badge is held with the reason.' },
    { id: 'offline-wrong-clock', label: 'Offline: the clock looks wrong', model: mine(inClock, { frame: offlineFrame, online: false, receipt: { kind: 'saved', action: 'IN', at: '2026-10-29T06:58:00.000Z', clockWrong: true }, ticks: 'saved' }, '2026-10-29T06:40:00.000Z') },
    { id: 'offline-unknown', label: 'Offline: nothing read on this tablet', model: mine(null, { frame: signedInFrame('tile.clock', { online: false }), online: false }), note: 'The person says in or out; the office keeps it as the tablet recorded it.' },
    { id: 'forgot-names', label: 'Forgot your badge: pick your name', model: { ...mine(inClock), step: { kind: 'names' } }, note: 'Name tiles, a letter strip, no keyboard.' },
    { id: 'forgot-names-empty', label: 'Forgot your badge: nobody set up', model: { ...mine(inClock), step: { kind: 'names' }, roster: [] } },
    { id: 'forgot-pin', label: 'Forgot your badge: your PIN', model: { ...mine(inClock), step: { kind: 'pin', name: 'Luca Demo' } }, note: 'The sixth digit sends. Flagged for the team leader.' },
    { id: 'forgot-pin-wrong', label: 'Forgot your badge: wrong PIN', model: { ...mine(inClock), step: { kind: 'pin', name: 'Luca Demo' }, pinProblem: 'wrong' }, note: 'One answer: the API names no reason.' },
    { id: 'kiosk', label: 'Kiosk: nobody signed in', model: kiosk(), note: 'One scan clocks in or out; 0 taps after the scan. The screen stays on the scan for the next person.' },
    { id: 'kiosk-recorded', label: 'Kiosk: clocked in', model: kiosk({ receipt: { kind: 'recorded', action: 'IN', at: '2026-10-29T06:58:00.000Z', repeated: false, name: 'Luca Demo', flags: [] } }), note: 'The person\'s name and time for a few seconds, then gone.' },
    { id: 'kiosk-wrong', label: 'Kiosk: this badge does not open it', model: kiosk({ receipt: { kind: 'wrong' } }), note: 'One uniform answer.' },
    { id: 'kiosk-not-badge', label: 'Kiosk: another label scanned', model: kiosk({ receipt: { kind: 'notBadge' } }) },
    { id: 'kiosk-offline', label: 'Kiosk: offline, clockings waiting', model: kiosk({ frame: deviceFrame('tile.clock', { online: false }), online: false, kept: { waiting: 2, available: true, refused: [] } }), note: 'A badge scanned offline waits sealed on the tablet, and is gone once sent. Forgot your badge is held: a PIN is never kept.' },
    { id: 'kiosk-refused', label: 'Kiosk: a kept clocking was refused', model: kiosk({ kept: { waiting: 0, available: true, refused: [{ clientEventId: 'clk-demo-1', action: 'IN', occurredAt: '2026-10-29T06:58:00.000Z', code: 'MONTH_CLOSED' }] } }), note: 'No badge and no name stays: only what to tell the team leader.' },
    { id: 'choose', label: 'Offline: in or out?', model: { ...kiosk({ online: false }), step: { kind: 'choose' } }, note: 'The tablet cannot know the person\'s state.' },
    { id: 'choose-not-kept', label: 'Offline: this tablet cannot keep a badge', model: { ...kiosk({ online: false, kept: { waiting: 0, available: false, refused: [] } }), step: { kind: 'choose' } }, note: 'Held, the reason on screen: no sealed storage, so no badge code is kept.' },
    { id: 'closed', label: 'The clock is closed (signed in)', model: { ...mine(null), step: { kind: 'closed' } }, note: 'The ATTENDANCE gate is off at this site: nothing is read, nothing is offered, the reason in words (Statuto dei Lavoratori art. 4).' },
    { id: 'closed-kiosk', label: 'The clock is closed (kiosk)', model: { ...kiosk(), step: { kind: 'closed' } }, note: 'Known before anyone scans a badge.' },
    { id: 'no-role', label: 'No floor role here', model: { ...mine(null), step: { kind: 'noRole' } }, note: 'The tile is not shown without floor.work; an address typed by hand says this.' },
    { id: 'loading', label: 'Reading', model: { ...mine(null), step: { kind: 'loading' } } },
    { id: 'unavailable', label: 'Server not answering', model: { ...mine(null), step: { kind: 'unavailable' } } },
  ],
})
