import { createElement } from 'react'
import { fingerprintLine, type Fingerprint } from '@nexus/factory-domain/ops/drills'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { rolePermissions } from '../../../shell/design-data'
import { STEP_UP_CLOSED, type StepUpModel } from '../shared/model'
import { inShell, PREFIX } from '../shared/fixtures'
import type { Drill, DrillStatus, FingerprintAnswer, SecurityFacts, TwoFactorList, TwoFactorPreview, TwoFactorRole } from './api'
import { emptyDrillForm, LOADING, NO_DIALOG, type Dialog, type Read, type SecurityViewModel } from './model'
import { SecurityView } from './view/SecurityView'

/**
 * SCR-166 Security & health with made-up data: invented people ("Anna Esempio" …), invented roles' holders, checksums
 * made of repeated hex, a group called "Demo". Nothing here is a real company, person, backup or checksum. Design-only.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour = 9, minute = 0, month = 10) => new Date(Date.UTC(2026, month - 1, day, hour, minute)).toISOString()
const NOW = at(30, 9, 42)
const NOW_DATE = new Date(NOW)

const sum = (seed: string): string => seed.repeat(16).slice(0, 16)
const PRINT: Fingerprint = { orders: sum('3f2a'), invoices: sum('9b1c'), stockMoves: sum('c4d5'), parties: sum('7e80'), files: sum('a1b2') }
const LINE = fingerprintLine(PRINT)
const OTHER: Fingerprint = { ...PRINT, invoices: sum('ffe0') }

const drill = (n: number, extra: Partial<Drill> & Pick<Drill, 'drilledOn' | 'result'>): Drill => ({
  id: uid('5151', n),
  environment: 'una copia locale',
  backupAt: `${extra.drilledOn}T02:00:00.000Z`,
  durationMinutes: 18,
  notes: null,
  checks: (['orders', 'invoices', 'stockMoves', 'parties', 'files'] as const).map((key) => ({ key, source: PRINT[key], restored: PRINT[key], match: true })),
  evidenceFileId: uid('7777', n),
  performedBy: { id: uid('3333', 1), name: 'Anna Esempio' },
  createdAt: `${extra.drilledOn}T16:00:00.000Z`,
  ...extra,
})

const PASSED_AUG = drill(1, { drilledOn: '2026-08-09', result: 'PASSED' })
const PASSED_MAY = drill(2, { drilledOn: '2026-05-11', result: 'PASSED', environment: 'staging', durationMinutes: 25 })
const FAILED_OCT = drill(3, {
  drilledOn: '2026-10-20',
  result: 'FAILED',
  environment: 'staging',
  evidenceFileId: null,
  checks: (['orders', 'invoices', 'stockMoves', 'parties', 'files'] as const).map((key) => ({ key, source: PRINT[key], restored: OTHER[key], match: PRINT[key] === OTHER[key] })),
  notes: 'ESEMPIO — le fatture differiscono: il backup era di prima della chiusura.',
})

const status = (drill: DrillStatus, over: Partial<Record<SecurityFacts['status'][number]['part'], Partial<SecurityFacts['status'][number]>>> = {}): SecurityFacts['status'] =>
  (['api', 'database', 'jobs', 'scheduled', 'files', 'backups', 'drill'] as const).map((part) => ({
    part,
    state: part === 'scheduled' || part === 'backups' ? 'unknown' : part === 'drill' ? (drill.state === 'ok' ? 'ok' : drill.state === 'due_soon' ? 'warning' : drill.state === 'none' ? 'needs' : 'failing') : 'ok',
    count: part === 'jobs' ? 2 : part === 'files' ? 0 : null,
    minutes: part === 'jobs' ? 0 : null,
    at: part === 'api' || part === 'database' ? NOW : part === 'drill' ? drill.lastOn : null,
    days: part === 'drill' ? drill.daysLeft : null,
    mode: part === 'files' ? 'LIVE' : null,
    ...over[part],
  }))

const DUE_SOON: DrillStatus = { state: 'due_soon', lastOn: '2026-08-09', lastResult: 'PASSED', daysAgo: 82, dueOn: '2026-11-07', daysLeft: 8 }
const OK: DrillStatus = { state: 'ok', lastOn: '2026-10-27', lastResult: 'PASSED', daysAgo: 3, dueOn: '2027-01-25', daysLeft: 87 }
const OVERDUE: DrillStatus = { state: 'overdue', lastOn: '2026-05-11', lastResult: 'PASSED', daysAgo: 172, dueOn: '2026-08-09', daysLeft: -82 }
const FAILED: DrillStatus = { state: 'failed', lastOn: '2026-10-20', lastResult: 'FAILED', daysAgo: 10, dueOn: '2026-11-07', daysLeft: 8 }
const NONE: DrillStatus = { state: 'none', lastOn: null, lastResult: null, daysAgo: null, dueOn: null, daysLeft: null }

function facts(drillStatus: DrillStatus, drills: Drill[], over: Partial<SecurityFacts> = {}): SecurityFacts {
  return {
    asOf: NOW,
    status: status(drillStatus),
    signIn: {
      password: { minLength: 12, maxLength: 256 },
      lockout: { afterFailures: 5, firstLockMinutes: 1, maxLockMinutes: 60 },
      sessions: { idleHours: 8, absoluteDays: 7, stepUpMinutes: 5 },
      twoFactor: { officeRoles: 12, asking: 5, holdersWithout: 2 },
    },
    backups: { drill: drillStatus, drills, canRecord: true },
    protection: [
      { fact: 'inTransit', state: 'on', count: null },
      { fact: 'atRest', state: 'provider', count: null },
      { fact: 'secrets', state: 'on', count: 6 },
      { fact: 'bank', state: 'partly', count: null },
      { fact: 'headers', state: 'on', count: null },
      { fact: 'virusScan', state: 'off', count: 2 },
    ],
    ...over,
  }
}

const people = {
  anna: { userId: uid('3333', 1), name: 'Anna Esempio', twoFactor: true },
  marco: { userId: uid('3333', 2), name: 'Marco Prova', twoFactor: false },
  lucia: { userId: uid('3333', 3), name: 'Lucia Demo', twoFactor: true },
  paolo: { userId: uid('3333', 4), name: 'Paolo Fittizio', twoFactor: false },
}
const role = (n: number, key: string, name: string, extra: Partial<TwoFactorRole> = {}): TwoFactorRole => ({
  id: uid('4444', n),
  key,
  name,
  system: !key.startsWith('custom.'),
  requireMfa: false,
  requireMfaSince: null,
  lock: null,
  templateAsks: false,
  version: 1,
  holders: [],
  heldByMe: false,
  ...extra,
})
const ROLES: TwoFactorRole[] = [
  role(1, 'owner', 'Owner', { requireMfa: true, requireMfaSince: '2026-09-01T07:30:00.000Z', lock: 'money', templateAsks: true, holders: [people.anna], heldByMe: true }),
  role(2, 'admin', 'Administrator', { requireMfa: true, requireMfaSince: '2026-09-01T07:30:00.000Z', lock: 'template', templateAsks: true, holders: [people.lucia] }),
  role(3, 'finance', 'Finance', { requireMfa: true, requireMfaSince: '2026-09-01T07:30:00.000Z', lock: 'money', templateAsks: true, holders: [people.lucia] }),
  // B-W2b-24: a role that asked before Nexus recorded since when (since unknown).
  role(4, 'sales', 'Sales', { requireMfa: true, lock: 'money', templateAsks: true, holders: [people.marco] }),
  role(5, 'planner', 'Planner', { holders: [people.paolo, people.marco] }),
  role(6, 'buyer', 'Buyer', { holders: [people.paolo] }),
  role(7, 'warehouse', 'Warehouse'),
  role(8, 'read_only', 'Read-only', { holders: [people.lucia] }),
  role(9, 'custom.office_manager', 'Responsabile ufficio (esempio)', { requireMfa: true, requireMfaSince: '2026-10-28T13:05:00.000Z', holders: [people.paolo] }),
]
const TWO_FACTOR: TwoFactorList = { roles: ROLES, canChange: true }

const ok = <T>(value: T): Read<T> => ({ state: 'ok', value })
const model = (over: Partial<SecurityViewModel> = {}): SecurityViewModel => ({
  prefix: PREFIX,
  facts: ok(facts(DUE_SOON, [PASSED_AUG, PASSED_MAY])),
  twoFactor: ok(TWO_FACTOR),
  fingerprint: null,
  dialog: NO_DIALOG,
  notice: null,
  ...over,
})

const ASK_PREVIEW: TwoFactorPreview = { affected: [people.marco, people.paolo], openSessions: 1, refusals: [] }
const twoFactorDialog = (requireMfa: boolean, preview: Read<TwoFactorPreview>, roleIds: string[]): Dialog => ({
  kind: 'twoFactor',
  requireMfa,
  changes: roleIds.map((roleId) => ({ roleId, version: 1, requireMfa })),
  preview,
  busy: false,
  problem: null,
  reason: '',
})
const SOURCE: FingerprintAnswer = { asOf: at(29, 2), fingerprint: PRINT, line: LINE }
const drillDialog = (form: Partial<ReturnType<typeof emptyDrillForm>> = {}, extra: Partial<Extract<Dialog, { kind: 'drill' }>> = {}): Dialog => ({
  kind: 'drill',
  form: { ...emptyDrillForm(NOW_DATE), drilledOn: '2026-10-29', ...form },
  source: ok(SOURCE),
  busy: false,
  problem: null,
  tried: false,
  ...extra,
})
const filled = { environment: 'una copia locale', backupAt: at(29, 2), durationMinutes: '18', restored: LINE, evidence: { name: 'registro-ripristino.pdf', size: 48_000 } }

type Case = { model: SecurityViewModel; permissions?: readonly string[]; stepUp?: StepUpModel }

const OWNER = rolePermissions('owner')
const READER = rolePermissions('read_only')

function SecurityDesign({ model: c }: { model: Case }) {
  return inShell('/admin/security', createElement(SecurityView, { model: c.model, stepUp: c.stepUp ?? STEP_UP_CLOSED }), c.permissions ?? OWNER)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-166',
  title: 'Security & health',
  view: SecurityDesign,
  cases: [
    { id: 'normal', label: 'Every part read; restore drill due in 8 days', model: { model: model() }, note: 'Scheduled jobs and backups say "Not watched yet": never shown as working. Two-factor per role in the list frame.' },
    { id: 'drill-ok', label: 'Drill done 3 days ago', model: { model: model({ facts: ok({ ...facts(OK, [drill(4, { drilledOn: '2026-10-27', result: 'PASSED' }), PASSED_AUG]) }) }) } },
    { id: 'drill-failed', label: 'The last drill failed', model: { model: model({ facts: ok(facts(FAILED, [FAILED_OCT, PASSED_AUG, PASSED_MAY])) }) }, note: 'Invoices differed; the due date stays the last pass’s.' },
    { id: 'drill-overdue', label: 'Drill overdue', model: { model: model({ facts: ok(facts(OVERDUE, [PASSED_MAY])) }) } },
    { id: 'drill-none', label: 'No drill recorded yet', model: { model: model({ facts: ok(facts(NONE, [])) }) } },
    {
      id: 'jobs-failing',
      label: 'Background events failed for good',
      model: { model: model({ facts: ok({ ...facts(DUE_SOON, [PASSED_AUG]), status: status(DUE_SOON, { jobs: { state: 'failing', count: 3 }, files: { state: 'warning', count: 2 } }) }) }) },
    },
    { id: 'loading', label: 'Loading', model: { model: model({ facts: LOADING, twoFactor: LOADING }) } },
    { id: 'error', label: 'Status not available', model: { model: model({ facts: { state: 'failed', problem: 'problem.unavailable' }, twoFactor: { state: 'failed', problem: 'problem.unavailable' } }) }, note: 'Never shown as all working.' },
    { id: 'no-permission', label: 'No right to see the page', model: { model: model({ facts: { state: 'no-right' }, twoFactor: { state: 'no-right' } }), permissions: ['home.view'] } },
    {
      id: 'read-only',
      label: 'Read-only: sees, records nothing, changes nothing',
      model: { model: model({ facts: ok(facts(DUE_SOON, [PASSED_AUG], { backups: { drill: DUE_SOON, drills: [PASSED_AUG], canRecord: false } })), twoFactor: ok({ ...TWO_FACTOR, canChange: false }) }), permissions: READER },
      note: 'No Record a restore drill; every role box held with its reason.',
    },
    { id: 'tf-selected', label: 'Two roles ticked: Ask two-factor of 2 roles', model: { model: model({ selected: [ROLES[4]!.id, ROLES[5]!.id] }) }, note: 'Owner is held: you hold it.' },
    { id: 'tf-ask', label: 'Ask two-factor: who it affects first', model: { model: model({ dialog: twoFactorDialog(true, ok(ASK_PREVIEW), [ROLES[4]!.id, ROLES[5]!.id]) }) } },
    {
      id: 'tf-lockout',
      label: 'Refused: it would lock every administrator out',
      model: { model: model({ dialog: twoFactorDialog(true, ok({ affected: [people.paolo], openSessions: 0, refusals: [{ path: 'changes', code: 'lockOut', message: 'x' }] }), [ROLES[8]!.id]) }) },
    },
    { id: 'tf-stop', label: 'Stop asking a custom role', model: { model: model({ dialog: twoFactorDialog(false, ok({ affected: [people.paolo], openSessions: 0, refusals: [] }), [ROLES[8]!.id]) }) } },
    { id: 'tf-step-up', label: 'Saving asks for a fresh code', model: { model: model({ dialog: { ...(twoFactorDialog(true, ok(ASK_PREVIEW), [ROLES[4]!.id]) as Extract<Dialog, { kind: 'twoFactor' }>), busy: true } }), stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.twoFactorAsk', problem: null } } },
    { id: 'drill-dialog', label: 'Record a restore drill (empty)', model: { model: model({ dialog: drillDialog() }) } },
    { id: 'drill-dialog-pass', label: 'Record a drill: would pass', model: { model: model({ dialog: drillDialog(filled) }) } },
    { id: 'drill-dialog-fail', label: 'Record a drill: a key differs', model: { model: model({ dialog: drillDialog({ ...filled, restored: fingerprintLine(OTHER) }) }) } },
    { id: 'drill-dialog-refused', label: 'Record a drill: over production refused', model: { model: model({ dialog: drillDialog({ ...filled, environment: 'server di produzione', restored: 'orders=1' }, { tried: true }) }) } },
    { id: 'fingerprint', label: "This database's fingerprint, to copy", model: { model: model({ fingerprint: ok({ ...SOURCE, asOf: NOW }) }) } },
    { id: 'notice', label: 'After a drill that passed', model: { model: model({ facts: ok(facts(OK, [drill(4, { drilledOn: '2026-10-30', result: 'PASSED' }), PASSED_AUG])), notice: { key: 'sec.notice.drillPassed', tone: 'success' } }) } },
  ],
})
