import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { inShell, PREFIX, SCOPE_ALL, SCOPE_ONE, SIGHT_OFF, TODAY, type PeopleRole } from '../_shared/fixtures'
import {
  COUNTS,
  ENTRIES,
  ENTRY,
  GATE_MISSING,
  GATE_ON,
  GATE_READY,
  GATE_STOPPED,
  HELD,
  HELD_CAN_COUNT,
  HELD_NO_NAMES,
  HELD_RECORD,
  LINE,
  OVERVIEW,
  OVERVIEW_OFF,
  PERIOD_LOCKED,
  PERIOD_PREVIEW,
  PERIOD_READY_TO_LOCK,
  PERIOD_REVIEW,
  PERIODS,
  PERIODS_FEW,
  PERIODS_HIDDEN,
  PREVIEW,
  PUBLICATION,
  RATES,
  RATES_EMPTY,
  RATES_NO_PAY,
  rateRows,
  SCHEME,
  SCHEME_DRAFT,
  SCHEMES,
  STATEMENT,
  STATEMENT_BONUS,
  STATEMENT_WITHOUT_TOTALS,
  STATEMENTS,
  STYLE,
  TABLES,
  VERSION,
  VERSION_DRAFT,
  VERSION_NO_PAY,
  VERSION_TRIAL,
  DRAFT,
} from './demo/fixtures'
import { blankRate, blankScheme, draftOfScheme, pieceAddressOf, pieceCan, type RateDraft, type VersionDraft } from './model'
import type { PieceDialog, PieceModel, Read } from './view-model'
import { PieceRatesView } from './view/PieceRatesView'

/**
 * SCR-158 — Piece rates & pay periods with made-up data only: the switch off (missing, ready), on and stopped; every section's
 * loading, failed, empty and held state; the pop-ups (Record the preconditions, Start, Stop, New rate version, Publish,
 * Confirm n, a version's record, the scheme's edit, a pay period at each stage, Lock, Worker statement, Resolve held scan, an
 * entry, Correct); roles: HR (the right), the Owner's view is HR's, the production manager (operations and SMVs only),
 * read-only, no access. Names appear inside one record only.
 */

const HR = ['people.piecerates.view', 'people.piecerates.manage', 'people.piecerates.switch', 'people.earnings.view', 'people.earnings.records', 'people.earnings.manage', 'people.efficiency.view', 'money.pay', 'product.routing.view', 'product.styles.view', 'sites.view']
const PRODUCTION = ['people.piecerates.view', 'people.earnings.view', 'people.earnings.review']
const READ_ONLY = ['people.piecerates.view', 'people.earnings.view']

const ready = <T,>(value: T): Read<T> => ({ status: 'ready', value })
const LOADING = { status: 'loading' } as const
const failed = { status: 'failed', problem: { key: 'problem.unavailable' } } as const
const ADDRESS = pieceAddressOf(null)

interface PieceCase {
  role: PeopleRole
  model: PieceModel
}

function page(permissions: readonly string[] = HR, over: Partial<PieceModel> = {}, role: PeopleRole = 'hr'): PieceCase {
  return {
    role,
    model: {
      prefix: PREFIX,
      can: pieceCan(permissions),
      address: ADDRESS,
      today: TODAY,
      scope: SCOPE_ONE,
      sight: SIGHT_OFF,
      siteId: SCOPE_ONE.siteId,
      overview: ready(OVERVIEW),
      gate: ready(GATE_ON),
      ever: true,
      counts: COUNTS,
      reviewCount: 3,
      rates: ready(RATES),
      selectedRates: [],
      tables: TABLES,
      schemes: ready(SCHEMES),
      schemeId: SCHEME.scheme.id,
      scheme: ready(SCHEME),
      schemeEdit: null,
      periods: ready(PERIODS),
      ledger: { entries: ENTRIES, problem: null, more: true, loadingMore: false },
      lines: [LINE],
      held: ready(HELD),
      selectedHeld: [],
      version: null,
      period: null,
      statement: null,
      heldRecord: null,
      entry: null,
      dialog: null,
      stepUp: { open: false, busy: false, sentence: null, problem: null },
      notice: null,
      built: { efficiency: null, attendance: `${PREFIX}/people/attendance` },
      asOf: '2026-11-02T09:42:00.000Z',
      live: 'live',
      help: false,
      busyRun: false,
      ...over,
    },
  }
}

const off = (permissions: readonly string[] = HR, over: Partial<PieceModel> = {}, role: PeopleRole = 'hr') => page(permissions, { gate: ready(GATE_MISSING), overview: ready(OVERVIEW_OFF), ever: false, periods: null, ledger: null, held: null, counts: null, ...over }, role)
const withDialog = (dialog: PieceDialog, over: Partial<PieceModel> = {}) => page(HR, { dialog, ...over })
const period = (detail: PieceModel['period']) => page(HR, { period: detail })
const opened = (detail: Parameters<typeof ready>[0], over: Partial<NonNullable<PieceModel['period']>> = {}) => ({ detail: ready(detail) as NonNullable<PieceModel['period']>['detail'], statements: STATEMENTS, busy: false, problem: null, ...over })

const rateOne: RateDraft = { ...blankRate('r1'), operationId: 'op1', operationLabel: 'CUC-01 · Cucitura maniche (esempio)', standardMinutes: '12.5', ratePerMinute: '0.12' }
const rateFixed: RateDraft = { ...blankRate('r2'), operationId: 'op2', operationLabel: 'IMB-01 · Imballo (esempio)', basis: 'FIXED', ratePerPiece: '0.30' }
const draftVersion = (over: Partial<VersionDraft> = {}): VersionDraft => ({ tableId: TABLES[0]!.table.id, changeReason: 'METHOD_CHANGED', changeNote: '', effectiveFrom: '2026-12-01', provisional: false, trialEndsOn: '', rates: [rateOne, rateFixed], ...over })
const versionDialog = (over: Partial<Extract<PieceDialog, { kind: 'version' }>> = {}): PieceDialog => ({ kind: 'version', draft: draftVersion(), table: null, editing: null, operations: [{ id: 'op1', code: 'CUC-01', name: 'Cucitura maniche (esempio)', standardMinutes: '12.5' }], styles: [STYLE], lines: [LINE], rateForAll: '', busy: false, problem: null, ...over })
const publish = (over: Partial<Extract<PieceDialog, { kind: 'publish' }>> = {}): PieceDialog => ({ kind: 'publish', versionId: DRAFT.id, version: null, lineId: '', lines: [LINE], preview: ready(PREVIEW), onFloor: true, printed: true, busy: false, problem: null, ...over })
const confirmRows = [{ id: DRAFT.id, label: 'T-GIA · 4', from: 'PROVISIONAL', trial: '2026-10-30', refused: null, version: 2 }, { id: 'x', label: 'T-GIA · 3', from: 'PROVISIONAL', trial: '2026-11-10', refused: { key: 'refusal.TRIAL_RUNNING' }, version: 3 }]
const statementOpen = (read: NonNullable<PieceModel['statement']>['read'], over: Partial<NonNullable<PieceModel['statement']>> = {}) => page(HR, { period: opened(PERIOD_REVIEW), statement: { read, busy: false, problem: null, ...over } })
const held = (read: NonNullable<PieceModel['heldRecord']>['read'], over: Partial<NonNullable<PieceModel['heldRecord']>> = {}, permissions: readonly string[] = HR) => page(permissions, { heldRecord: { read, note: '', busy: false, problem: null, ...over } })

function PieceDesign({ model: { role, model } }: { model: PieceCase }) {
  return inShell('/people/piecerates', createElement(PieceRatesView, { model }), role)
}

export const designScreen = defineDesignScreen<PieceCase>({
  screen: 'SCR-158',
  title: 'Piece rates & pay periods (behind the legal switch)',
  view: PieceDesign,
  cases: [
    { id: 'off-missing', label: 'Switch off: what is missing, in words', model: off(), note: 'The gate first, nothing of a person. Rates and the scheme stay: two of the preconditions.' },
    { id: 'off-ready', label: 'Switch off: every precondition met', model: off(HR, { gate: ready(GATE_READY) }) },
    { id: 'on', label: 'On: the gate folds to one line; every section', model: page() },
    { id: 'stopped', label: 'Stopped: periods stay computable', model: page(HR, { gate: ready(GATE_STOPPED) }) },
    { id: 'all-sites', label: 'All sites: each site’s switch', model: page(HR, { scope: SCOPE_ALL, sight: { status: 'allSites' }, siteId: null, gate: null, rates: null }) },
    { id: 'production', label: 'Production manager: operations and SMVs only', model: page(PRODUCTION, { rates: ready(RATES_NO_PAY), periods: ready(PERIODS_HIDDEN), ledger: null, schemes: ready({ ...SCHEMES, payShown: false }), reviewCount: null }, 'production') },
    { id: 'read-only', label: 'Read-only: reads, changes nothing', model: page(READ_ONLY, { rates: ready(RATES_NO_PAY), periods: ready(PERIODS_HIDDEN), ledger: null, gate: ready({ ...GATE_ON, canManage: false, canSwitch: false }), reviewCount: null }, 'readOnly') },
    { id: 'no-permission', label: 'No access', model: page([], {}, 'sales') },
    { id: 'loading', label: 'Loading', model: page(HR, { gate: LOADING, overview: LOADING, rates: LOADING, schemes: LOADING, scheme: null, periods: LOADING, held: LOADING, ledger: { entries: null, problem: null, more: false, loadingMore: false }, counts: null, sight: { status: 'loading' }, asOf: null, live: 'connecting' }) },
    { id: 'error', label: 'Every read failed: never drawn as empty', model: page(HR, { gate: failed, overview: failed, rates: failed, schemes: failed, scheme: null, periods: failed, held: failed, ledger: { entries: null, problem: { key: 'problem.unavailable' }, more: false, loadingMore: false } }) },
    { id: 'preconditions', label: 'Record what piece pay rests on', model: off(HR, { dialog: { kind: 'preconditions', busy: false, problem: null, draft: { ccnlName: 'CCNL esempio', ccnlArticle: '', workerNoticeId: '', dpiaId: '', consultantName: '', consultantAgreedOn: '', schemeId: '', note: '' } } }) },
    { id: 'start', label: 'Start piece pay: the preconditions as met', model: off(HR, { gate: ready(GATE_READY), dialog: { kind: 'start', onFrom: TODAY, reason: 'Accordo firmato (esempio)', busy: false, problem: null, missing: [] } }) },
    { id: 'start-refused', label: 'Start refused in words, no code asked', model: off(HR, { gate: ready(GATE_MISSING), dialog: { kind: 'start', onFrom: TODAY, reason: 'Accordo firmato (esempio)', busy: false, problem: { key: 'problem.preconditions' }, missing: ['CCNL', 'SCHEME'] } }) },
    { id: 'start-code', label: 'Start: the fresh code comes last', model: off(HR, { gate: ready(GATE_READY), dialog: { kind: 'start', onFrom: TODAY, reason: 'Accordo firmato (esempio)', busy: true, problem: null, missing: [] }, stepUp: { open: true, busy: false, sentence: 'stepUp.start', problem: null } }) },
    { id: 'stop', label: 'Stop piece pay', model: withDialog({ kind: 'stop', reason: '', busy: false, problem: null }) },
    { id: 'rates-empty', label: 'No rates yet', model: off(HR, { rates: ready(RATES_EMPTY), tables: [] }) },
    { id: 'rates-filter', label: 'A tile is a filter', model: page(HR, { address: { ...ADDRESS, tile: 'TRIAL' } }) },
    { id: 'rates-selected', label: 'Rates selected: Confirm n', model: page(HR, { selectedRates: [rateRows()[3]!.rate.id] }) },
    { id: 'confirm', label: 'Confirm n provisional rates: the review', model: withDialog({ kind: 'confirm', ids: [DRAFT.id], rates: 2, rows: confirmRows, review: { phase: 'ready' } }) },
    { id: 'version-new', label: 'New rate version', model: withDialog(versionDialog()) },
    { id: 'version-table', label: 'New rate version: a new table', model: withDialog(versionDialog({ table: { name: 'Tariffe giacca', code: 'TARIFFE-GIACCA', styleId: '', lineId: '' }, draft: draftVersion({ tableId: '' }) })) },
    { id: 'version-provisional', label: 'Provisional with a trial', model: withDialog(versionDialog({ draft: draftVersion({ provisional: true, trialEndsOn: '2027-01-31' }) })) },
    { id: 'version-held', label: 'Held with why', model: withDialog(versionDialog({ draft: draftVersion({ changeReason: '', rates: [] }) })) },
    { id: 'version-refused', label: 'Refused by the API, in words', model: withDialog(versionDialog({ problem: { key: 'refusal.OVERLAPS' } })) },
    { id: 'publish', label: 'Publish rates', model: withDialog(publish()) },
    { id: 'publish-reading', label: 'Publish: reading who receives it', model: withDialog(publish({ preview: LOADING })) },
    { id: 'publish-nobody', label: 'Publish: nobody left to tell', model: withDialog(publish({ preview: ready({ ...PREVIEW, count: 0, newCount: 0, workers: [], withoutEmployee: 0 }) })) },
    { id: 'version', label: 'A version: rates and who read them', model: page(HR, { version: ready(VERSION) }) },
    { id: 'version-draft', label: 'A draft: held Put in force', model: page(HR, { version: ready(VERSION_DRAFT) }) },
    { id: 'version-trial', label: 'Provisional: Confirm held while the trial runs', model: page(HR, { version: ready(VERSION_TRIAL) }) },
    { id: 'version-no-pay', label: 'A version without the pay grain', model: page(READ_ONLY, { version: ready(VERSION_NO_PAY), rates: ready(RATES_NO_PAY), ledger: null, periods: ready(PERIODS_HIDDEN) }, 'readOnly') },
    { id: 'paper', label: 'Record signed paper copies', model: page(HR, { version: ready(VERSION), dialog: { kind: 'paper', publication: PUBLICATION, picked: [], busy: false, problem: null } }) },
    { id: 'withdraw', label: 'Withdraw a publication of a draft', model: page(HR, { version: ready(VERSION_DRAFT), dialog: { kind: 'withdraw', publication: PUBLICATION, reason: '', busy: false, problem: null } }) },
    { id: 'scheme-draft', label: 'A draft scheme: Start held with why', model: page(HR, { schemeId: SCHEME_DRAFT.scheme.id, scheme: ready(SCHEME_DRAFT) }) },
    { id: 'scheme-edit', label: 'Editing a draft (EditModeBar)', model: page(HR, { schemeEdit: { id: SCHEME_DRAFT.scheme.id, version: 2, draft: draftOfScheme(SCHEME_DRAFT, TODAY, false), busy: false, problem: null } }) },
    { id: 'scheme-new', label: 'A new scheme', model: page(HR, { schemeEdit: { id: null, version: null, draft: blankScheme(TODAY), busy: false, problem: null } }) },
    { id: 'scheme-delete', label: 'Delete a draft scheme', model: page(HR, { schemeId: SCHEME_DRAFT.scheme.id, scheme: ready(SCHEME_DRAFT), dialog: { kind: 'deleteScheme', busy: false, problem: null } }) },
    { id: 'scheme-end', label: 'End a scheme', model: withDialog({ kind: 'endScheme', lastDay: TODAY, reason: '', busy: false, problem: null }) },
    { id: 'periods-few', label: 'Too few people: no total', model: page(HR, { periods: ready(PERIODS_FEW) }) },
    { id: 'periods-empty', label: 'No period yet', model: page(HR, { periods: ready([]) }) },
    { id: 'period-preview', label: 'A period in preview: what stands in the way', model: period(opened(PERIOD_PREVIEW)) },
    { id: 'period-review', label: 'A period in review: Lock held with why', model: period(opened(PERIOD_REVIEW)) },
    { id: 'period-ready', label: 'Ready to lock', model: period(opened(PERIOD_READY_TO_LOCK)) },
    { id: 'period-locked', label: 'A locked period', model: period(opened(PERIOD_LOCKED)) },
    { id: 'period-failed', label: 'A period refused in words', model: period(opened(PERIOD_PREVIEW, { problem: { key: 'refusal.NOT_OVER' } })) },
    { id: 'lock', label: 'Lock: typed confirm', model: page(HR, { period: opened(PERIOD_READY_TO_LOCK), dialog: { kind: 'lock', busy: false, problem: null } }) },
    { id: 'back', label: 'Back to preview', model: page(HR, { period: opened(PERIOD_REVIEW), dialog: { kind: 'backToPreview', reason: '', busy: false, problem: null } }) },
    { id: 'statement', label: 'Worker statement: J / K, A', model: statementOpen(ready(STATEMENT)) },
    { id: 'statement-bonus', label: 'A standard-minute bonus: the pieces measure it, the guaranteed pay and the bonus', model: statementOpen(ready(STATEMENT_BONUS)) },
    { id: 'statement-opening', label: 'Opening: recorded by the same command', model: statementOpen(LOADING) },
    { id: 'statement-stale', label: 'No longer matches the ledger', model: statementOpen(ready({ ...STATEMENT, stale: true, canApprove: false })) },
    { id: 'statement-lead', label: 'A lead: pieces and minutes, no money', model: statementOpen(ready({ ...STATEMENT_WITHOUT_TOTALS, openedAs: 'LEAD', canApprove: false, lines: STATEMENT.lines.map(({ operationCode, operationName, pieces, minutes, sharePct }) => ({ operationCode, operationName, pieces, minutes, sharePct })), time: [], corrections: [], makeUp: null })) },
    { id: 'statement-lead-open', label: 'A lead says why before opening', model: page(PRODUCTION, { period: opened(PERIOD_REVIEW), dialog: { kind: 'leadOpen', statementId: STATEMENTS[1]!.id, reason: '', busy: false, problem: null }, rates: ready(RATES_NO_PAY), ledger: null, periods: ready(PERIODS_HIDDEN) }, 'production') },
    { id: 'statement-held', label: 'Period for someone with neither right: Open held', model: page(READ_ONLY, { period: opened(PERIOD_REVIEW), rates: ready(RATES_NO_PAY), ledger: null, periods: ready(PERIODS_HIDDEN) }, 'readOnly') },
    { id: 'statement-refused', label: 'Approve refused in words', model: statementOpen(ready(STATEMENT), { problem: { key: 'refusal.STATEMENT_STALE' } }) },
    { id: 'ledger-empty', label: 'No entries', model: page(HR, { ledger: { entries: [], problem: null, more: false, loadingMore: false } }) },
    { id: 'ledger-no-right', label: 'Without the right: said in words', model: page(PRODUCTION, { ledger: null, rates: ready(RATES_NO_PAY), periods: ready(PERIODS_HIDDEN), reviewCount: null }, 'production') },
    { id: 'entry', label: 'One entry names its person', model: page(HR, { entry: ready(ENTRY) }) },
    { id: 'entry-reversed', label: 'Correct held with why', model: page(HR, { entry: ready({ ...ENTRY, canCorrect: false }) }) },
    { id: 'correct', label: 'Correct: a reversal and a new entry', model: page(HR, { entry: ready(ENTRY), dialog: { kind: 'correct', amount: '', reason: '', busy: false, problem: null } }) },
    { id: 'held-all', label: 'Held scans: every state', model: page(HR, { address: { ...ADDRESS, heldAll: true } }) },
    { id: 'held-selected', label: 'Held scans selected', model: page(HR, { selectedHeld: [HELD[0]!.id, HELD[1]!.id] }) },
    { id: 'held-empty', label: 'Nothing held', model: page(HR, { held: ready([]) }) },
    { id: 'resolve', label: 'Resolve: needs the attendance fix', model: held(ready(HELD_RECORD)) },
    { id: 'resolve-count', label: 'Resolve: the attendance shows it', model: held(ready(HELD_CAN_COUNT)) },
    { id: 'resolve-no-names', label: 'Resolve without the right: no name', model: held(ready(HELD_NO_NAMES), {}, READ_ONLY) },
    { id: 'resolve-refused', label: 'Count refused in words', model: held(ready(HELD_RECORD), { problem: { key: 'refusal.NOT_CLOCKED_IN_YET' } }) },
    { id: 'not-paid', label: 'Do not pay, with a reason', model: withDialog({ kind: 'notPaid', ids: [HELD[0]!.id, HELD[1]!.id], reason: '', busy: false, problem: null }) },
    { id: 'notice', label: 'A notice after a write', model: page(HR, { notice: { tone: 'success', words: { key: 'publish.done', params: { count: 3 } } } }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: page(HR, { help: true }) },
  ],
})
