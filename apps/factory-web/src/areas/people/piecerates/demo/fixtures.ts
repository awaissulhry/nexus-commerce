import { PEOPLE, SITE_N, SITE_S, TODAY } from '../../_shared/fixtures'
import type { EarningsCounts, EmployeePublications, EmployeeStatements, EntryRecord, EntryRow, HeldRecord, HeldRow, Overview, PeriodDetail, PeriodRow, Publication, PublishPreview, RateRow, RatesPage, SchemeDetail, SchemesPage, Statement, StatementRow, SwitchView, TableRow, VersionDetail, VersionSummary } from '../api'

/**
 * Made-up data for People › Piece rates' design cases: an invented company and sites (the People fixtures'), invented tables,
 * operations, rates, schemes, periods and figures. Nothing here is a real rate, CCNL, consultant, person or number.
 */

const uid = (block: string, n: number) => `0190f0e3-${block.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = uid('1000', 1)
export const STYLE = { id: uid('1001', 1), code: 'GIA-01', name: 'Giacca esempio' }
export const LINE = { id: uid('1002', 1), code: 'L-A', name: 'Linea giacche' }
const SEW = { id: uid('1003', 1), code: 'CUC-01', name: 'Cucitura maniche (esempio)' }
const PACK = { id: uid('1003', 2), code: 'IMB-01', name: 'Imballo (esempio)' }
const TABLE = { id: uid('1004', 1), code: 'T-GIA', name: 'Tariffe giacca esempio', currency: 'EUR' }

const summary = (over: Partial<VersionSummary> = {}): VersionSummary => ({
  id: uid('1005', 1),
  tableId: TABLE.id,
  versionNo: 2,
  status: 'PUBLISHED',
  state: 'CONFIRMED',
  changeReason: 'METHOD_CHANGED',
  changeNote: null,
  effectiveFrom: '2026-10-01',
  effectiveTo: null,
  provisional: false,
  trialEndsOn: null,
  inForceToday: true,
  rateCount: 2,
  publishedOn: '2026-09-25',
  readBy: { read: 3, of: 4 },
  version: 3,
  ...over,
})
export const CONFIRMED = summary()
export const PROVISIONAL = summary({ id: uid('1005', 2), versionNo: 3, status: 'PROVISIONAL', state: 'PROVISIONAL', provisional: true, trialEndsOn: '2026-11-10', effectiveFrom: '2026-10-20', changeReason: 'EQUIPMENT_CHANGED' })
export const ENDED_TRIAL = summary({ id: uid('1005', 3), versionNo: 4, status: 'PROVISIONAL', state: 'PROVISIONAL', provisional: true, trialEndsOn: '2026-10-30', effectiveFrom: '2026-09-01' })
export const DRAFT = summary({ id: uid('1005', 4), versionNo: 5, status: 'DRAFT', state: 'DRAFT', inForceToday: false, publishedOn: null, readBy: { read: 0, of: 0 }, effectiveFrom: '2026-12-01', changeReason: 'NEW' })

const rate = (id: number, operation: typeof SEW, basis: 'SMV_RATE' | 'FIXED', minutes: string | null, perMinute: string | null, perPiece: string, shown: boolean) => ({ id: uid('1006', id), operation, sizeBand: 'ALL', basis, standardMinutes: minutes, ...(shown ? { ratePerMinute: perMinute, ratePerPiece: perPiece } : {}), note: null })
const row = (id: number, version: VersionSummary, operation: typeof SEW, basis: 'SMV_RATE' | 'FIXED', shown: boolean): RateRow => ({ table: TABLE, style: STYLE, line: null, rate: rate(id, operation, basis, basis === 'FIXED' ? null : '12.5', basis === 'FIXED' ? null : '0.12', basis === 'FIXED' ? '0.30' : '1.5', shown), version })
export const rateRows = (shown = true): RateRow[] => [row(1, CONFIRMED, SEW, 'SMV_RATE', shown), row(2, CONFIRMED, PACK, 'FIXED', shown), row(3, PROVISIONAL, SEW, 'SMV_RATE', shown), row(4, ENDED_TRIAL, PACK, 'FIXED', shown), row(5, DRAFT, SEW, 'SMV_RATE', shown)]
export const RATES: RatesPage = { today: TODAY, payShown: true, rows: rateRows(), complete: true }
export const RATES_NO_PAY: RatesPage = { today: TODAY, payShown: false, rows: rateRows(false), complete: true }
export const RATES_EMPTY: RatesPage = { today: TODAY, payShown: true, rows: [], complete: true }

const tableView = { ...TABLE, companyId: COMPANY, siteId: SITE_N.id, style: STYLE, line: null, status: 'ACTIVE' as const, note: null, fixed: true, version: 2 }
export const TABLES: TableRow[] = [{ table: tableView, current: CONFIRMED, next: DRAFT, drafts: 1 }]

const site = { id: SITE_N.id, companyId: COMPANY, code: SITE_N.code, name: SITE_N.name }
export const OVERVIEW: Overview = {
  today: TODAY,
  payShown: true,
  sites: [
    { site, switch: { state: 'ON', onFrom: '2026-10-01', offFrom: null, missing: 0 }, tiles: { trialEndingSoon: 1, trialEnded: 1, unread: 2, drafts: 1 } },
    { site: { id: SITE_S.id, companyId: COMPANY, code: SITE_S.code, name: SITE_S.name }, switch: { state: 'OFF', onFrom: null, offFrom: null, missing: 6 }, tiles: { trialEndingSoon: 0, trialEnded: 0, unread: 0, drafts: 0 } },
  ],
}
export const OVERVIEW_OFF: Overview = { ...OVERVIEW, sites: [{ ...OVERVIEW.sites[0]!, switch: { state: 'OFF', onFrom: null, offFrom: null, missing: 4 } }, OVERVIEW.sites[1]!] }

const precondition = (code: SwitchView['preconditions'][number]['code'], met: boolean, words: string, page: string | null = null): SwitchView['preconditions'][number] => ({ code, met, law: 'law', page, words })
const RECORDED: SwitchView['recorded'] = { ccnlName: 'CCNL esempio', ccnlArticle: 'art. 00', workerNotice: { id: uid('1007', 1), label: '2026-10', status: 'PUBLISHED' }, dpia: { id: uid('1007', 2), versionNo: 1, status: 'STORED' }, consultantName: 'Studio Esempio', consultantAgreedOn: '2026-09-10', scheme: { id: uid('1008', 1), name: 'Schema esempio', kind: 'PIECE_RATE', status: 'ACTIVE', validFrom: '2026-09-01', validTo: null, lineId: null }, preconditionsNote: null }
const MET = [
  precondition('SITE_BASIS', true, "The site's scans name workers on a recorded basis (Accordo esempio)."),
  precondition('PERFORMANCE_GATE', true, "One person's work figures are switched on at this site."),
  precondition('WORKER_NOTICE', true, 'The worker notice 2026-10 covers piece pay.'),
  precondition('DPIA', true, 'Impact assessment version 1 covers piece pay.'),
  precondition('CCNL', true, 'CCNL esempio, art. 00.'),
  precondition('CONSULTANT', true, 'Studio Esempio agreed on 2026-09-10.'),
  precondition('SCHEME', true, 'The scheme "Schema esempio" is in force from 2026-09-01.'),
  precondition('RATES_PUBLISHED', true, 'The rates in force on 2026-11-02 were published to all 4 active workers.'),
  precondition('EARNING_CODES', true, 'Every earning code (3) is mapped for the payroll export.'),
]
const base: SwitchView = { site, today: TODAY, state: 'ON', onFrom: '2026-10-01', switchedOnAt: '2026-09-30T08:00:00.000Z', switchedOnByName: 'Anna Esempio', offFrom: null, switchedOffAt: null, switchedOffByName: null, offReason: null, earlierWindows: [], recorded: RECORDED, preconditions: MET, canStart: false, noticeReadBy: { read: 4, of: 4 }, candidates: { notices: [RECORDED.workerNotice!], dpias: [RECORDED.dpia!], schemes: [RECORDED.scheme!] }, version: 4, canManage: true, canSwitch: true }
export const GATE_ON = base
export const GATE_READY: SwitchView = { ...base, state: 'OFF', onFrom: null, switchedOnAt: null, switchedOnByName: null, canStart: true }
export const GATE_MISSING: SwitchView = {
  ...GATE_READY,
  canStart: false,
  recorded: { ...RECORDED, ccnlName: null, ccnlArticle: null, consultantName: null, consultantAgreedOn: null, scheme: null },
  preconditions: [
    precondition('SITE_BASIS', true, "The site's scans name workers on a recorded basis (Accordo esempio)."),
    precondition('PERFORMANCE_GATE', false, "One person's work figures are switched off at this site: switch them on first (People › Settings)."),
    precondition('WORKER_NOTICE', true, 'The worker notice 2026-10 covers piece pay.'),
    precondition('DPIA', true, 'Impact assessment version 1 covers piece pay.'),
    precondition('CCNL', false, 'Record the CCNL and the article of it that allows piece work.'),
    precondition('CONSULTANT', false, 'Record the labour consultant who agreed the scheme, the make-up and the statement, and the day.'),
    precondition('SCHEME', false, "Name the incentive scheme piece pay starts with (its guaranteed pay is the labour consultant's)."),
    precondition('RATES_PUBLISHED', false, '2 of 4 active workers have not been given the rates in force on 2026-11-02: publish them to them before work starts.'),
    precondition('EARNING_CODES', false, "Earning codes not mapped to the payroll provider's codes yet: PIECES, MAKEUP."),
  ],
}
export const GATE_STOPPED: SwitchView = { ...GATE_READY, offFrom: '2026-10-28', onFrom: '2026-10-01', offReason: 'Motivo esempio' }

export const SCHEME: SchemeDetail = {
  scheme: { id: uid('1008', 1), companyId: COMPANY, siteId: null, line: null, name: 'Schema esempio', kind: 'PIECE_RATE', status: 'ACTIVE', state: 'IN_FORCE', validFrom: '2026-09-01', validTo: null, guaranteedBasis: 'CCNL_MINIMUM', guaranteedHourlyRate: '9', teamSplit: null, currency: 'EUR', version: 2, efficiencyThresholdPct: null, traineeHourlyRate: '7.5', reworkOwnFault: 'UNPAID', scrapOwnFault: 'REDUCED_RATE', ownFaultRatePct: '50', othersFaultPay: 'AVERAGE', waitingPay: 'AVERAGE', payOnlyWhileClockedIn: true, note: null },
  periods: [{ id: uid('1009', 1), month: '2026-10', status: 'LOCKED', effect: 'LOCKED' }, { id: uid('1009', 2), month: '2026-11', status: 'OPEN', effect: 'ACCRUES' }],
  follows: null,
  followedBy: null,
  switches: [{ site: SITE_N, state: 'ON' }],
  actions: { edit: { allowed: false, refusal: { code: 'NOT_DRAFT' } }, activate: { allowed: false, refusal: { code: 'NOT_DRAFT' } }, end: { allowed: false, refusal: { code: 'IN_USE' } }, delete: { allowed: false, refusal: { code: 'NOT_DRAFT' } } },
  payShown: true,
  canManage: true,
}
export const SCHEME_DRAFT: SchemeDetail = { ...SCHEME, scheme: { ...SCHEME.scheme, id: uid('1008', 2), name: 'Bozza di squadra', kind: 'TEAM_INCENTIVE', status: 'DRAFT', state: 'DRAFT', teamSplit: 'HOURS_PRESENT', guaranteedBasis: 'UNDECIDED', guaranteedHourlyRate: null, line: { id: LINE.id, code: LINE.code, name: LINE.name }, validFrom: '2027-01-01' }, switches: [], actions: { edit: { allowed: true, refusal: null }, activate: { allowed: false, refusal: { code: 'NO_GUARANTEE' } }, end: { allowed: false, refusal: { code: 'NOT_ACTIVE' } }, delete: { allowed: true, refusal: null } } }
export const SCHEMES: SchemesPage = { today: TODAY, payShown: true, schemes: [SCHEME.scheme, SCHEME_DRAFT.scheme], applies: [{ line: null, scheme: { id: SCHEME.scheme.id, name: SCHEME.scheme.name }, inherited: false }] }

const period = (id: number, month: string, status: PeriodRow['status'], over: Partial<PeriodRow> = {}): PeriodRow => ({ id: uid('1009', id), companyId: COMPANY, month, periodStart: `${month}-01`, periodEnd: `${month}-28`, status, people: 12, earnings: 1845000, makeUp: 12300, currency: 'EUR', tooFew: false, heldOpen: 0, disputesOpen: 0, statements: { draft: 0, approved: 12 }, version: 3, ...over })
export const PERIODS: PeriodRow[] = [period(3, '2026-11', 'OPEN', { people: 0, earnings: 0, makeUp: 0, statements: { draft: 0, approved: 0 } }), period(2, '2026-10', 'REVIEW', { heldOpen: 2, disputesOpen: 1, statements: { draft: 3, approved: 9 } }), period(1, '2026-09', 'LOCKED')]
export const PERIODS_HIDDEN: PeriodRow[] = PERIODS.map(({ earnings: _earnings, makeUp: _makeUp, ...row }) => row)
export const PERIODS_FEW: PeriodRow[] = PERIODS.map((row) => ({ ...row, people: 2, tooFew: true, earnings: null, makeUp: null }))

const ALL_ALLOWED = { allowed: true, refusal: null }
const NO = (code: string) => ({ allowed: false, refusal: { code } })
export const PERIOD_REVIEW: PeriodDetail = { period: { ...PERIODS[1]!, previewedAt: '2026-11-01T09:00:00.000Z', reviewStartedAt: '2026-11-01T10:00:00.000Z', lockedAt: null, lockNote: null }, checks: [{ code: 'DISPUTES_OPEN', blocking: false, count: 1 }, { code: 'NO_RATE', blocking: false, count: 2 }], lines: [{ line: LINE, people: 8, pieces: '4200', earnings: 1320000, makeUp: 8000, makeUpSharePct: '0.6', tooFew: false }, { line: { id: uid('1002', 2), code: 'L-B', name: 'Linea pantaloni' }, people: 2, pieces: null, earnings: null, makeUp: null, makeUpSharePct: null, tooFew: true }], actions: { run: NO('WRONG_STATE'), reopen: NO('WRONG_STATE'), startReview: NO('WRONG_STATE'), back: ALL_ALLOWED, lock: NO('STATEMENTS_OPEN') }, lockPhrase: 'LOCK 2026-10', canManage: true, payShown: true }
export const PERIOD_PREVIEW: PeriodDetail = { ...PERIOD_REVIEW, period: { ...PERIOD_REVIEW.period, status: 'PREVIEW' }, checks: [{ code: 'HELD_OPEN', blocking: true, count: 2 }, { code: 'DAYS_OPEN', blocking: true, count: 1 }, { code: 'NO_RATE', blocking: false, count: 2 }], actions: { run: ALL_ALLOWED, reopen: ALL_ALLOWED, startReview: NO('CHECKS_OPEN'), back: NO('WRONG_STATE'), lock: NO('WRONG_STATE') } }
export const PERIOD_READY_TO_LOCK: PeriodDetail = { ...PERIOD_REVIEW, checks: [], actions: { ...PERIOD_REVIEW.actions, lock: ALL_ALLOWED } }
export const PERIOD_LOCKED: PeriodDetail = { ...PERIOD_REVIEW, period: { ...PERIOD_REVIEW.period, status: 'LOCKED' }, checks: [], actions: { run: NO('WRONG_STATE'), reopen: NO('WRONG_STATE'), startReview: NO('WRONG_STATE'), back: NO('WRONG_STATE'), lock: NO('WRONG_STATE') } }
export const STATEMENTS: StatementRow[] = [1, 2, 3].map((n) => ({ id: uid('1010', n), siteId: SITE_N.id, status: n === 1 ? 'APPROVED' : 'DRAFT', revision: 1, leadReviewed: n === 2, stale: n === 3, version: 2 }))

export const STATEMENT: Statement = {
  id: uid('1010', 2),
  periodId: PERIODS[1]!.id,
  month: '2026-10',
  periodStatus: 'REVIEW',
  person: { employeeId: PEOPLE.giulia.id, name: 'Giulia Esempio', code: 'D-0001' },
  revision: 1,
  status: 'DRAFT',
  openedAs: 'HR',
  currency: 'EUR',
  lines: [{ operationCode: SEW.code, operationName: SEW.name, pieces: 420, minutes: '5250.000', sharePct: null, rate: '1.5', amount: 63000 }, { operationCode: PACK.code, operationName: PACK.name, pieces: 300, minutes: '0.000', sharePct: '33.3333', rate: '0.3', amount: 9000 }],
  time: [{ code: 'WAIT', minutes: '120.000', rate: '0.16', amount: 1920 }],
  corrections: [{ kind: 'ADJUSTMENT', month: '2026-09', words: 'Scansione tardiva (esempio)', amount: 1500 }],
  attendance: { ordinaryMinutes: 9600, approvedOvertimeMinutes: 120 },
  makeUp: { minutes: 9720, rate: '0.15', guaranteed: 145800, earned: 75420, amount: 70380 },
  held: { open: 0, counted: 1, notPaid: 0 },
  defects: { scrap: 2, rework: 1, othersScrap: 2, othersRework: 0 },
  bonus: null,
  disputes: [{ id: uid('1011', 1), status: 'OPEN', workDate: '2026-10-14', recordType: 'EarningsEntry' }],
  earningsAmount: 75420,
  makeUpAmount: 70380,
  stale: false,
  leadReview: null,
  fileId: null,
  approvedAt: null,
  canApprove: true,
  version: 2,
}
export const { earningsAmount: _e, makeUpAmount: _m, ...STATEMENT_WITHOUT_TOTALS } = STATEMENT
/** B-W2b-84: a standard-minute bonus scheme's statement: the pieces at their rate with no amount, the guaranteed pay, the bonus. */
export const STATEMENT_BONUS: Statement = {
  ...STATEMENT,
  lines: [{ operationCode: SEW.code, operationName: SEW.name, pieces: 420, minutes: '5250.000', sharePct: null, rate: '1.5', amount: 0 }],
  time: [],
  corrections: [],
  makeUp: { minutes: 9720, rate: '0.15', guaranteed: 145800, earned: 0, amount: 145800 },
  bonus: { minutesPresent: 9720, standardMinutes: '5250.000', thresholdMinutes: '4860.000', efficiencyPct: '54.01', bonusMinutes: '390.000', amount: 4680 },
  defects: { scrap: 2, rework: 1, othersScrap: 0, othersRework: 0 },
  earningsAmount: 4680,
  makeUpAmount: 145800,
}

const entry = (n: number, over: Partial<EntryRow> = {}): EntryRow => ({ id: uid('1012', n), workDate: '2026-10-14', siteId: SITE_N.id, periodId: PERIODS[1]!.id, kind: 'SCAN', bundle: 'B-00142', operation: SEW, pieces: 12, minutes: null, sharePct: null, rate: '1.5', amount: 1800, currency: 'EUR', reversesId: null, correctsMonth: null, reason: null, createdAt: '2026-10-14T09:12:00.000Z', ...over })
export const ENTRIES: EntryRow[] = [entry(1), entry(2, { kind: 'SCAN', amount: -1800, reversesId: uid('1012', 1), reason: 'Scansione annullata (esempio)' }), entry(3, { kind: 'TEAM_SPLIT', pieces: 4, sharePct: '33.3333', amount: 600 }), entry(4, { kind: 'MAKE_UP', bundle: null, operation: null, pieces: null, minutes: '9720', rate: '0.15', amount: 70380 }), entry(5, { kind: 'ADJUSTMENT', bundle: null, operation: null, pieces: null, rate: null, amount: 1500, correctsMonth: '2026-09', reason: 'Lavoro di settembre (esempio)' })]
export const ENTRY: EntryRecord = { ...ENTRIES[0]!, person: { employeeId: PEOPLE.giulia.id, name: 'Giulia Esempio', code: 'D-0001' }, reversedById: null, canCorrect: true }

const held = (n: number, over: Partial<HeldRow> = {}): HeldRow => ({ id: uid('1013', n), siteId: SITE_N.id, periodId: PERIODS[1]!.id, at: '2026-10-15T14:42:00.000Z', bundle: 'B-00151', operation: { code: SEW.code, name: SEW.name }, lineId: LINE.id, pieces: 8, reason: 'NOT_CLOCKED_IN', status: 'OPEN', version: 1, ...over })
export const HELD: HeldRow[] = [held(1), held(2, { reason: 'ON_BREAK', bundle: 'B-00152' }), held(3, { status: 'COUNTED' })]
export const HELD_RECORD: HeldRecord = { ...HELD[0]!, day: '2026-10-15', people: [{ employeeId: PEOPLE.giulia.id, name: 'Giulia Esempio', clockedIn: false }], peopleShown: true, attendanceDayId: uid('1014', 1), voided: false, canCount: false, resolution: null }
export const HELD_CAN_COUNT: HeldRecord = { ...HELD_RECORD, canCount: true, people: [{ employeeId: PEOPLE.giulia.id, name: 'Giulia Esempio', clockedIn: true }] }
export const HELD_NO_NAMES: HeldRecord = { ...HELD_RECORD, people: [], peopleShown: false }

export const COUNTS: EarningsCounts = { heldOpen: 2, disputesOpen: 1, asOf: '2026-11-02T09:42:00.000Z' }

const workers = [{ workerId: uid('1015', 1), name: 'Giulia Esempio', employeeId: PEOPLE.giulia.id, read: { at: '2026-09-26T07:02:00.000Z', channel: 'DEVICE' as const } }, { workerId: uid('1015', 2), name: 'Paolo Prova', employeeId: PEOPLE.paolo.id, read: { at: '2026-09-26T07:30:00.000Z', channel: 'PAPER' as const } }, { workerId: uid('1015', 3), name: 'Ion Campione', employeeId: null, read: null }]
export const PUBLICATION: Publication = { id: uid('1016', 1), status: 'PUBLISHED', line: null, onFloor: true, printed: true, publishedAt: '2026-09-25T15:00:00.000Z', publishedByName: 'Anna Esempio', withdrawnAt: null, withdrawReason: null, workers, readBy: { read: 2, of: 3 }, version: 1 }
export const VERSION: VersionDetail = {
  table: tableView,
  site,
  version: { ...CONFIRMED, confirmedAt: null, confirmedByName: null, supersededAt: null, cancelledAt: null, cancelReason: null, createdAt: '2026-09-20T09:00:00.000Z', createdByName: 'Anna Esempio' },
  rates: rateRows().slice(0, 2).map((row2) => row2.rate),
  publications: [PUBLICATION],
  actions: { edit: { allowed: false, refusal: { code: 'NOT_DRAFT' } }, publish: { allowed: true, refusal: null }, putInForce: { allowed: false, refusal: { code: 'NOT_DRAFT' } }, confirm: { allowed: false, refusal: { code: 'NOT_PROVISIONAL' } }, cancel: { allowed: false, refusal: { code: 'NOT_DRAFT' } } },
  payShown: true,
  canManage: true,
}
export const VERSION_DRAFT: VersionDetail = { ...VERSION, version: { ...VERSION.version, ...DRAFT }, publications: [], actions: { edit: { allowed: true, refusal: null }, publish: { allowed: true, refusal: null }, putInForce: { allowed: false, refusal: { code: 'NOT_PUBLISHED' } }, confirm: { allowed: false, refusal: { code: 'NOT_PROVISIONAL' } }, cancel: { allowed: true, refusal: null } } }
export const VERSION_TRIAL: VersionDetail = { ...VERSION, version: { ...VERSION.version, ...PROVISIONAL }, actions: { ...VERSION.actions, confirm: { allowed: false, refusal: { code: 'TRIAL_RUNNING' } } } }
export const VERSION_NO_PAY: VersionDetail = { ...VERSION, rates: rateRows(false).slice(0, 2).map((row2) => row2.rate), payShown: false, canManage: false }

export const PREVIEW: PublishPreview = { version: { id: DRAFT.id, versionNo: 5, status: 'DRAFT' }, line: null, workers: workers.map((worker) => ({ workerId: worker.workerId, name: worker.name, employeeId: worker.employeeId, alreadyTold: worker.workerId === uid('1015', 1) })), count: 3, newCount: 2, withoutEmployee: 1, refusal: null }

export const EMPLOYEE_STATEMENTS: EmployeeStatements = { employeeId: PEOPLE.giulia.id, payShown: true, statements: [{ id: STATEMENT.id, month: '2026-10', periodStatus: 'REVIEW', status: 'DRAFT', revision: 1, currency: 'EUR', earningsAmount: 75420, makeUpAmount: 70380, approvedOn: null }, { id: uid('1010', 9), month: '2026-09', periodStatus: 'LOCKED', status: 'APPROVED', revision: 1, currency: 'EUR', earningsAmount: 142300, makeUpAmount: 3500, approvedOn: '2026-10-03' }] }
export const EMPLOYEE_PUBLICATIONS: EmployeePublications = { employeeId: PEOPLE.giulia.id, publications: [{ id: PUBLICATION.id, versionId: CONFIRMED.id, versionNo: 2, table: { code: TABLE.code, name: TABLE.name }, state: 'CONFIRMED', effectiveFrom: '2026-10-01', publishedAt: '2026-09-25T15:00:00.000Z', onFloor: true, printed: true, read: { at: '2026-09-26T07:02:00.000Z', channel: 'DEVICE', device: 'Tablet taglio' } }, { id: uid('1016', 2), versionId: PROVISIONAL.id, versionNo: 3, table: { code: TABLE.code, name: TABLE.name }, state: 'PROVISIONAL', effectiveFrom: '2026-10-20', publishedAt: '2026-10-18T15:00:00.000Z', onFloor: true, printed: false, read: null }] }
