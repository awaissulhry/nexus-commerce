import { defineDesignScreen } from '../../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import type { MyDay, Mine, MyStatement } from './api'
import { rowsOf, type MyDayData, type MyRow } from './model'
import { MyDayScreen, type MyDayStep, type MyDayViewModel } from './view/MyDayScreen'

/**
 * SCR-171's cases (B-W2b-68; design floor.myday, MES-111, -112, -205, -206, -261; Owner answers F1, F2): the PIN every time,
 * Today with each gate off and on, the records, a dispute, the answers, the statement printed or as a PDF, every held and
 * failed state. Only the worker on the tablet appears; every figure is made up. No line output, no average, no other person.
 */

const TODAY = '2026-10-29'
const AT = '2026-10-29T09:12:00.000Z'

const PACE = { line: { code: 'L1', name: 'Linea giacche' }, done: 96, target: 240, targetSoFar: 100, hourTarget: 30, percent: 96, pace: 'ON_PACE' as const }
const PERFORMANCE = { earnedMinutes: '144.000', timedMinutes: '160.000', offStandardMinutes: '12.000', efficiency: '90.0', traineeDay: false, sharedReports: 0, pace: PACE }

const STATEMENT: MyStatement = {
  id: 'statement-1',
  status: 'APPROVED',
  revision: 1,
  currency: 'EUR',
  lines: [
    { operationCode: 'SEW', operationName: 'Cucitura maniche', pieces: 1840, minutes: '2760.000', sharePct: null, rate: '0.300000', amount: 55200 },
    { operationCode: 'ASM', operationName: 'Assemblaggio collo', pieces: 310, minutes: '620.000', sharePct: '50', rate: '0.450000', amount: 13950 },
  ],
  time: [{ code: 'WAIT_HELP', minutes: '45.000', rate: '0.150000', amount: 675 }],
  bonus: null,
  earningsAmount: 69825,
  makeUpAmount: 8200,
}
/** B-W2b-84: under a standard-minute bonus scheme the pieces pay nothing by the piece; the guaranteed pay and the bonus do. */
const STATEMENT_BONUS: MyStatement = {
  ...STATEMENT,
  lines: [{ operationCode: 'SEW', operationName: 'Cucitura maniche', pieces: 1840, minutes: '2760.000', sharePct: null, rate: '0.300000', amount: 0 }],
  time: [],
  bonus: { minutesPresent: 2880, standardMinutes: '2760.000', thresholdMinutes: '2160.000', efficiencyPct: '95.83', bonusMinutes: '600.000', amount: 12000 },
  earningsAmount: 12000,
  makeUpAmount: 43200,
}

const PAY = { month: '2026-10', status: 'OPEN', currency: 'EUR', todayEarnings: 2880, periodPieces: 2150, periodEarnings: 69825, held: 0, statement: null }
const PAY_STATEMENT = { ...PAY, status: 'LOCKED', month: '2026-09', statement: STATEMENT }

const DAY: MyDay = { subject: 'WORKER', linked: true, today: TODAY, month: '2026-10', asOf: AT, work: { pieces: 96, scrap: 2, rework: 1, reports: 4 }, performance: PERFORMANCE, paysToday: true, pay: PAY, printer: true }
const NO_PAY: MyDay = { ...DAY, paysToday: false, pay: null }
const GATE_OFF: MyDay = { ...NO_PAY, performance: null }

const report = (n: number, at: string, workDate: string, good: number, extra: Partial<Mine['records'][number]> = {}): Mine['records'][number] => ({ scanId: `scan-${n}`, at, workDate, workOrder: { number: 'WO-0041' }, bundle: { code: `B-00012${n}` }, operation: { seq: 20, code: 'SEW', name: 'Cucitura maniche' }, counts: { good, scrap: 0, rework: 0 }, state: 'STANDING', minutes: null, enteredByLead: false, disputable: true, dispute: null, ...extra })
const OPEN_DISPUTE = { id: 'dispute-1', version: 1, recordType: 'OperationScan' as const, recordId: 'scan-2', workDate: TODAY, reason: 'WRONG_QUANTITY', words: null, status: 'OPEN' as const, answer: null, answeredAt: null, raisedAt: AT }
const ANSWERED = { ...OPEN_DISPUTE, id: 'dispute-2', version: 2, recordId: 'scan-3', workDate: '2026-10-21', reason: 'NOT_ME', status: 'UPHELD' as const, answer: 'Corretto: il fascio era di un altro turno.', answeredAt: AT }

const MINE: Mine = {
  subject: 'WORKER',
  from: '2026-10-01',
  to: TODAY,
  minutesShown: true,
  records: [
    report(1, '2026-10-29T08:40:00.000Z', TODAY, 30, { minutes: '45.000', counts: { good: 30, scrap: 2, rework: 1 } }),
    report(2, '2026-10-29T07:50:00.000Z', TODAY, 28, { minutes: '42.000', dispute: { id: 'dispute-1', status: 'OPEN' } }),
    report(3, '2026-10-21T10:10:00.000Z', '2026-10-21', 24, { state: 'CORRECTED', minutes: '36.000', enteredByLead: true, dispute: { id: 'dispute-2', status: 'UPHELD' } }),
    report(4, '2026-10-20T10:10:00.000Z', '2026-10-20', 12, { state: 'UNDONE', disputable: false, counts: { good: 0, scrap: 0, rework: 0 } }),
  ],
  blocks: [
    { id: 'block-1', code: { code: 'WAIT_MATERIAL', labelIt: 'Attesa materiale', labelEn: 'Waiting for material', labelI18n: {} }, workDate: TODAY, startedAt: '2026-10-29T08:10:00.000Z', minutes: 12, status: 'APPROVED', disputable: true, dispute: null },
    { id: 'block-2', code: { code: 'CLEANING', labelIt: 'Pulizia', labelEn: 'Cleaning', labelI18n: {} }, workDate: TODAY, startedAt: '2026-10-29T09:05:00.000Z', minutes: 7, status: 'OPEN', disputable: false, dispute: null },
  ],
  disputes: [OPEN_DISPUTE, ANSWERED],
  edits: [{ id: 'edit-1', at: AT, changes: [{ field: 'endedAt', from: '10:30', to: '10:15' }], reason: 'Blocco chiuso in ritardo' }],
  reasons: { OperationScan: ['WRONG_QUANTITY', 'NOT_ME', 'WRONG_OPERATION', 'OTHER'], OffStandardEntry: ['WRONG_TIME', 'WRONG_CODE', 'NOT_ME', 'OTHER'] },
}
const EMPTY_MINE: Mine = { ...MINE, records: [], blocks: [], disputes: [], edits: [] }
const DATA: MyDayData = { day: DAY, mine: MINE, statement: DAY }

const frame = (extra: Partial<MyDayViewModel['frame']> = {}) => signedInFrame('tile.myday', { station: { name: 'SEW-01 · Cucitura 1', site: 'Stabilimento Demo Nord' }, ...extra })

const model = (step: MyDayStep, data: MyDayData | null = DATA, extra: Partial<MyDayViewModel> = {}): MyDayViewModel => ({ frame: frame(extra.online === false ? { online: false, pending: 1 } : {}), step, data, online: true, phone: false, unread: 0, closing: null, ...extra })

const pay = (day: Partial<MyDay>): MyDayData => ({ day: { ...DAY, ...day }, mine: MINE, statement: { ...DAY, ...day } })
const row = (key: string): MyRow => rowsOf(MINE, 'period', TODAY).find((entry) => entry.key === key)!
const SCAN_ROW = row('r:scan-1')
const BLOCK_ROW = row('b:block-1')

const REFUSED_NOT_APPROVED = { kind: 'refused' as const, code: 'NOT_APPROVED', message: 'This statement is not approved yet.', fix: null }

export const designScreen = defineDesignScreen<MyDayViewModel>({
  screen: 'SCR-171',
  title: 'Floor › My day',
  view: onFloor(MyDayScreen),
  cases: [
    { id: 'pin', label: 'Only you: the PIN, every time, even after a badge', model: model({ kind: 'pin' }, null), note: 'Owner answer F1. No figure is read before the PIN.' },
    { id: 'pin-wrong', label: 'A wrong PIN', model: model({ kind: 'pin', problem: 'wrong' }, null) },
    { id: 'pin-locked', label: 'Too many wrong PINs', model: model({ kind: 'pin', problem: 'locked' }, null) },
    { id: 'pin-again', label: 'The two minutes are over: the PIN again, the same act goes on', model: model({ kind: 'pin', again: true }) },
    { id: 'loading', label: 'Loading', model: model({ kind: 'loading' }, null) },
    { id: 'offline', label: 'Offline: held, own figures are not stored on the tablet', model: model({ kind: 'offline' }, null, { online: false }) },
    { id: 'problem', label: 'The server does not answer', model: model({ kind: 'problem', problem: { kind: 'unavailable' } }, null) },
    { id: 'no-permission', label: 'No permission', model: model({ kind: 'problem', problem: { kind: 'forbidden', path: null, message: null } }, null) },
    { id: 'station', label: 'A site that records stations: no personal list', model: model({ kind: 'station' }, null) },

    { id: 'today', label: 'Today: pieces, minutes, efficiency, money, pace; gate and piece pay on', model: model({ kind: 'today' }), note: 'The ring is the worker\'s pieces against the LINE\'s target; no line output, no other person.' },
    { id: 'gate-on-no-pay', label: 'Piece pay off: no money anywhere', model: model({ kind: 'today' }, pay(NO_PAY)) },
    { id: 'gate-off', label: 'The PERFORMANCE gate off (the default): pieces only, the reason in words', model: model({ kind: 'today' }, pay(GATE_OFF)), note: 'Statuto dei Lavoratori art. 4: what ships until the Owner records the basis.' },
    { id: 'gate-off-pay', label: 'Gate off in the month, with money from an earlier window', model: model({ kind: 'today' }, pay({ ...GATE_OFF, paysToday: false, pay: PAY_STATEMENT })) },
    { id: 'behind', label: 'Under the line\'s target so far: words, a neutral ring', model: model({ kind: 'today' }, pay({ performance: { ...PERFORMANCE, pace: { ...PACE, done: 60, percent: 60, pace: 'BEHIND' } } })) },
    { id: 'over', label: 'Over the target: the ring is full, the number says it', model: model({ kind: 'today' }, pay({ performance: { ...PERFORMANCE, pace: { ...PACE, done: 130, percent: 130 } } })) },
    { id: 'no-target', label: 'No target today', model: model({ kind: 'today' }, pay({ performance: { ...PERFORMANCE, efficiency: null, pace: { ...PACE, line: null, target: null, targetSoFar: null, hourTarget: null, percent: null, pace: 'NO_TARGET' } } })) },
    { id: 'shared', label: 'Team work left out of the pace', model: model({ kind: 'today' }, pay({ performance: { ...PERFORMANCE, sharedReports: 2 } })) },
    { id: 'trainee', label: 'A trainee day', model: model({ kind: 'today' }, pay({ performance: { ...PERFORMANCE, traineeDay: true } })) },
    { id: 'not-linked', label: 'A sign-in not linked to an employee', model: model({ kind: 'today' }, pay({ ...GATE_OFF, linked: false })) },
    { id: 'held', label: 'Scans held until the clock shows them', model: model({ kind: 'today' }, pay({ pay: { ...PAY, held: 2 } })) },
    { id: 'answer-waits', label: 'An answer waits', model: model({ kind: 'today' }, DATA, { unread: 1 }) },
    { id: 'closing', label: 'The last seconds: the figures leave the screen', model: model({ kind: 'today' }, DATA, { closing: { secondsLeft: 8 } }) },

    { id: 'records', label: 'Your records today', model: model({ kind: 'records', span: 'today' }) },
    { id: 'records-period', label: 'This period: corrected, undone, entered by the lead, disputed', model: model({ kind: 'records', span: 'period' }) },
    { id: 'records-none', label: 'Nothing recorded', model: model({ kind: 'records', span: 'today' }, { ...DATA, mine: EMPTY_MINE }) },
    { id: 'records-sent', label: 'A dispute sent', model: model({ kind: 'records', span: 'today', done: 'sent' }) },
    { id: 'records-existing', label: 'Already disputed: nothing twice', model: model({ kind: 'records', span: 'today', done: 'existing' }) },

    { id: 'dispute', label: 'Dispute a report: reason tiles', model: model({ kind: 'dispute', row: SCAN_ROW, draft: { reason: null, words: '' } }) },
    { id: 'dispute-picked', label: 'A reason picked: Send', model: model({ kind: 'dispute', row: SCAN_ROW, draft: { reason: 'WRONG_QUANTITY', words: '' } }) },
    { id: 'dispute-other', label: 'Other asks for words', model: model({ kind: 'dispute', row: SCAN_ROW, draft: { reason: 'OTHER', words: '' } }) },
    { id: 'dispute-block', label: 'Dispute a time block', model: model({ kind: 'dispute', row: BLOCK_ROW, draft: { reason: 'WRONG_TIME', words: '' } }) },
    { id: 'dispute-refused', label: 'Refused, in words', model: model({ kind: 'dispute', row: SCAN_ROW, draft: { reason: 'NOT_ME', words: '' }, problem: { kind: 'refused', code: 'NOT_DISPUTABLE', message: 'x', fix: null } }) },

    { id: 'disputes', label: 'Your disputes, the answers, the changes', model: model({ kind: 'disputes' }) },
    { id: 'disputes-none', label: 'No disputes', model: model({ kind: 'disputes' }, { ...DATA, mine: EMPTY_MINE }) },
    { id: 'answer-open', label: 'An open dispute: Withdraw', model: model({ kind: 'answer', dispute: OPEN_DISPUTE }) },
    { id: 'answer-upheld', label: 'An answer', model: model({ kind: 'answer', dispute: ANSWERED }) },
    { id: 'answer-withdrawn', label: 'Withdrawn', model: model({ kind: 'disputes', done: 'withdrawn' }) },

    { id: 'statement', label: 'Statement: pieces, minutes, rates, earnings, make-up; Print', model: model({ kind: 'statement' }, pay({ month: '2026-09', pay: PAY_STATEMENT })) },
    { id: 'statement-bonus', label: 'A standard-minute bonus: pieces at no amount, the bonus in the earnings', model: model({ kind: 'statement' }, pay({ month: '2026-09', pay: { ...PAY_STATEMENT, statement: STATEMENT_BONUS } })) },
    { id: 'statement-sent', label: 'Sent to the office printer in your name', model: model({ kind: 'statement', sent: { code: 'A4-UFF', name: 'Ufficio' } }, pay({ month: '2026-09', pay: PAY_STATEMENT })) },
    { id: 'statement-draft', label: 'Not approved yet: Print held', model: model({ kind: 'statement' }, pay({ month: '2026-09', pay: { ...PAY_STATEMENT, statement: { ...STATEMENT, status: 'DRAFT' } } })) },
    { id: 'statement-no-printer', label: 'No office printer known: held, the reason on screen', model: model({ kind: 'statement' }, pay({ month: '2026-09', printer: false, pay: PAY_STATEMENT })) },
    { id: 'statement-none', label: 'No statement yet for this month', model: model({ kind: 'statement' }) },
    { id: 'statement-no-pay', label: 'A month with no piece pay', model: model({ kind: 'statement' }, pay({ month: '2026-03', pay: null, paysToday: true })) },
    { id: 'statement-refused', label: 'Refused, in words', model: model({ kind: 'statement', problem: REFUSED_NOT_APPROVED }, pay({ month: '2026-09', pay: PAY_STATEMENT })) },
    { id: 'statement-phone', label: 'On one\'s own phone: Open as PDF', model: model({ kind: 'statement' }, pay({ month: '2026-09', pay: PAY_STATEMENT }), { phone: true }) },
    { id: 'statement-phone-ready', label: 'The PIN again, then Open as PDF', model: model({ kind: 'statement', pdfReady: true }, pay({ month: '2026-09', pay: PAY_STATEMENT }), { phone: true }) },
  ],
})
