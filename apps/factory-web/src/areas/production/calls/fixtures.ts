import { createElement } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { permissionCheck } from '../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../shell/design-data'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import type { Call, CallCounts, CallRecord, CallRecordAnswer, CallsByHour, CallType, CallTypes, StationMachine } from './api'
import { callsCanOf, type CallsAddress } from './model'
import { CallsView, type CallsModel } from './view/CallsView'

/**
 * Design cases of SCR-142 — Production › Floor control › Help calls (B-W2b-58; design production.calls). Made-up data
 * only: an invented site "STAB-N", lines L1 and L2, stations SEW-01 … QC-01, teams with invented names, an invented office
 * user ("Giulia Esempio") who acknowledged a call and an invented operator named inside one call only (a WORKER site with
 * its notice acknowledged). Roles from factory-domain's templates: the production manager (answers, keeps the routing,
 * opens maintenance jobs), the floor supervisor (answers), read-only (looks), sales (no permission). Response times are a
 * call's, a kind's and a line's: never a person's (Owner F2).
 */

const PREFIX = '/w/DEMO'
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const NOW = Date.UTC(2026, 9, 30, 9, 40)
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
const SITE = { id: uid('3131', 1), name: 'Stabilimento Demo Nord' }
const L1 = { id: uid('3232', 1), code: 'L1', name: 'Linea 1 · Giacche' }
const L2 = { id: uid('3232', 2), code: 'L2', name: 'Linea 2 · Pantaloni' }
const station = (n: number, code: string, name: string) => ({ id: uid('3333', n), code, name })
const SEW1 = station(1, 'SEW-01', 'Cucitura 1')
const SEW4 = station(4, 'SEW-04', 'Cucitura 4')
const SEW7 = station(7, 'SEW-07', 'Cucitura 7')
const QC1 = station(9, 'QC-01', 'Controllo finale')
const PRESS = station(10, 'PRS-02', 'Pressa 2')
const TEAM_L1 = { id: uid('3434', 1), code: 'L1-A', name: 'Squadra L1-A' }
const TEAM_MNT = { id: uid('3434', 2), code: 'MNT', name: 'Manutenzione' }
const TEAM_WH = { id: uid('3434', 3), code: 'MAG', name: 'Magazzino' }
const TEAM_QA = { id: uid('3434', 4), code: 'QUA', name: 'Qualità' }
const OFFICE_USER = { kind: 'USER' as const, name: 'Giulia Esempio' }
const FLOOR = { kind: 'WORKER' as const, name: null }

const TYPE = {
  machine: { id: uid('3535', 1), code: 'MACHINE_STOP', kind: 'MACHINE' as const, labelIt: 'Macchina ferma', labelEn: 'Machine stopped', labelI18n: {}, icon: 'alert', colour: '#e5484d' },
  material: { id: uid('3535', 2), code: 'MATERIAL_SHORT', kind: 'MATERIAL' as const, labelIt: 'Manca materiale', labelEn: 'Material short', labelI18n: {}, icon: 'package', colour: '#b87503' },
  quality: { id: uid('3535', 3), code: 'QUALITY_DOUBT', kind: 'QUALITY' as const, labelIt: 'Dubbio qualità', labelEn: 'Quality doubt', labelI18n: {}, icon: 'shield', colour: '#7400bc' },
  leader: { id: uid('3535', 4), code: 'TEAM_LEADER', kind: 'SUPERVISOR' as const, labelIt: 'Caposquadra', labelEn: 'Team leader', labelI18n: {}, icon: null, colour: null },
}

const times = (response: number | null, onTheWay: number | null, resolve: number | null) => ({ responseSeconds: response, onTheWaySeconds: onTheWay, resolveSeconds: resolve })

function call(n: number, over: Partial<Call> & Pick<Call, 'type' | 'station' | 'sentAt'>): Call {
  return {
    id: uid('3636', n),
    version: 1,
    siteId: SITE.id,
    status: 'SENT',
    open: true,
    line: L1,
    workOrder: null,
    bundle: null,
    responderTeam: TEAM_L1,
    note: null,
    seenAt: null,
    onTheWayAt: null,
    solvedAt: null,
    cancelledAt: null,
    openSeconds: Math.floor((NOW - Date.parse(over.sentAt)) / 1000),
    times: times(null, null, null),
    seenBy: null,
    resolutionCode: null,
    outcome: null,
    waitingBooked: false,
    ...over,
  }
}

const WO = { id: uid('3737', 1), number: 'WO-2026-0142' }
const OPEN: Call[] = [
  call(1, { type: TYPE.machine, station: SEW4, line: L2, sentAt: ago(12), responderTeam: TEAM_MNT, workOrder: WO, bundle: { id: uid('3838', 1), code: 'BN-004211' } }),
  call(2, { type: TYPE.material, station: SEW1, sentAt: ago(9), status: 'SEEN', seenAt: ago(7), seenBy: OFFICE_USER, times: times(120, null, null), responderTeam: TEAM_WH, workOrder: WO, waitingBooked: true }),
  call(3, { type: TYPE.quality, station: QC1, sentAt: ago(6), status: 'ON_THE_WAY', seenAt: ago(5), onTheWayAt: ago(5), seenBy: FLOOR, times: times(60, 60, null), responderTeam: TEAM_QA }),
  call(4, { type: TYPE.leader, station: SEW7, line: L2, sentAt: ago(3), responderTeam: null }),
  call(5, { type: TYPE.material, station: PRESS, sentAt: ago(1), responderTeam: TEAM_WH, note: 'Fodera nera finita' }),
]
const CLOSED: Call[] = [
  call(6, { type: TYPE.machine, station: SEW1, sentAt: ago(95), status: 'SOLVED', open: false, openSeconds: null, seenAt: ago(93), onTheWayAt: ago(92), solvedAt: ago(70), seenBy: OFFICE_USER, times: times(120, 180, 1500), responderTeam: TEAM_MNT, resolutionCode: 'FIXED', outcome: { recordType: 'MaintenanceJob', recordId: uid('3939', 1) }, waitingBooked: true }),
  call(7, { type: TYPE.material, station: SEW4, line: L2, sentAt: ago(140), status: 'SOLVED', open: false, openSeconds: null, seenAt: ago(139), solvedAt: ago(128), seenBy: FLOOR, times: times(60, null, 720), responderTeam: TEAM_WH, resolutionCode: 'BROUGHT' }),
  call(8, { type: TYPE.leader, station: QC1, sentAt: ago(180), status: 'CANCELLED', open: false, openSeconds: null, cancelledAt: ago(176), responderTeam: null }),
]

const COUNTS: CallCounts = { tiles: { OPEN: 5, WAITING: 2, ANSWERED_TODAY: 9 }, medianResponseSeconds: 95, waitingMinutes: 5 }

const zero = () => ({ MACHINE: 0, MATERIAL: 0, QUALITY: 0, SUPERVISOR: 0, MAINTENANCE: 0, OTHER: 0 })
const hour = (h: number, kinds: Partial<Record<'MACHINE' | 'MATERIAL' | 'QUALITY' | 'SUPERVISOR', number>>, lines: [number, number]) => {
  const byKind = { ...zero(), ...kinds }
  const calls = Object.values(byKind).reduce((sum, value) => sum + value, 0)
  return { hour: h, calls, byKind, byLine: [{ lineId: L1.id, count: lines[0] }, { lineId: L2.id, count: lines[1] }].filter((entry) => entry.count > 0) }
}
const DAY: CallsByHour = {
  date: '2026-10-30',
  timeZone: 'Europe/Rome',
  hours: Array.from({ length: 24 }, (_, h) => {
    const busy: Record<number, ReturnType<typeof hour>> = {
      6: hour(6, { MATERIAL: 1 }, [1, 0]),
      7: hour(7, { MACHINE: 1, MATERIAL: 2 }, [2, 1]),
      8: hour(8, { MATERIAL: 1, QUALITY: 1, SUPERVISOR: 1 }, [2, 1]),
      9: hour(9, { MACHINE: 1, MATERIAL: 2, QUALITY: 1, SUPERVISOR: 1 }, [3, 2]),
      10: hour(10, { MACHINE: 1, MATERIAL: 1 }, [1, 1]),
    }
    return busy[h] ?? { hour: h, calls: 0, byKind: zero(), byLine: [] }
  }),
  byKind: [
    { kind: 'MACHINE', calls: 3, answered: 2, medianResponseSeconds: 120 },
    { kind: 'MATERIAL', calls: 7, answered: 6, medianResponseSeconds: 75 },
    { kind: 'QUALITY', calls: 2, answered: 2, medianResponseSeconds: 60 },
    { kind: 'SUPERVISOR', calls: 2, answered: 1, medianResponseSeconds: 360 },
  ],
  lines: [L1, L2],
}
const QUIET_DAY: CallsByHour = { ...DAY, hours: Array.from({ length: 24 }, (_, h) => ({ hour: h, calls: 0, byKind: zero(), byLine: [] })), byKind: [], lines: [] }

const routing = (n: number, type: (typeof TYPE)[keyof typeof TYPE], team: { id: string; code: string; name: string } | null, members: number, escalate: number | null, over: Partial<CallType> = {}): CallType => ({
  ...type,
  id: type.id,
  companyId: DEMO_COMPANIES[0].id,
  siteId: SITE.id,
  codeListed: true,
  responder: team ? { kind: 'TEAM', team: { ...team, active: true }, members } : { kind: 'TEAM_LEADERS', team: null, members },
  escalateAfterMinutes: escalate,
  waitingCode: null,
  sortOrder: n * 10,
  active: true,
  version: 1,
  usedCount: 12 - n,
  openCount: 0,
  ...over,
})
const TYPES: CallTypes = {
  site: { id: SITE.id, code: 'STAB-N', name: SITE.name },
  types: [routing(1, TYPE.machine, TEAM_MNT, 3, 5), routing(2, TYPE.material, TEAM_WH, 4, 10), routing(3, TYPE.quality, TEAM_QA, 2, null), routing(4, TYPE.leader, null, 3, 5)],
  canManage: true,
}

function record(base: Call, over: Partial<CallRecord> = {}): CallRecordAnswer {
  const timeline: CallRecord['timeline'] = [{ step: 'SENT', at: base.sentAt, by: null }]
  if (base.seenAt) timeline.push({ step: 'SEEN', at: base.seenAt, by: base.seenBy })
  if (base.onTheWayAt) timeline.push({ step: 'ON_THE_WAY', at: base.onTheWayAt, by: base.seenBy })
  if (base.solvedAt) timeline.push({ step: 'SOLVED', at: base.solvedAt, by: base.seenBy })
  if (base.cancelledAt) timeline.push({ step: 'CANCELLED', at: base.cancelledAt, by: OFFICE_USER })
  return {
    call: {
      ...base,
      caller: null,
      timeline,
      coming: base.open && base.seenAt ? { step: base.onTheWayAt ? 'ON_THE_WAY' : 'SEEN', by: base.seenBy, team: base.responderTeam } : null,
      resolutionNote: null,
      waiting: null,
      bookWaiting: base.waitingBooked,
      ...over,
    },
    canAnswer: true,
    canNameOutcome: base.outcome === null,
  }
}

const MACHINES: StationMachine[] = [{ id: uid('4040', 1), assetNumber: 'MC-0412', status: 'DOWN', class: { labelIt: 'Macchina da cucire', labelEn: 'Sewing machine' }, make: 'Esempio', modelName: 'S-100', openJobs: 0 }]

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']
const ROLES = {
  production: template('production_manager'),
  supervisor: template('floor_supervisor'),
  owner: [...OWNER_PERMISSIONS, ...template('production_manager')],
  readOnly: [...(templateOf('read_only')?.permissions ?? []), 'home.view'],
  sales: template('sales'),
} as const
type Role = keyof typeof ROLES

interface CallsCase {
  role: Role
  model: CallsModel
}

const ADDRESS: CallsAddress = { view: 'open', tile: null, kind: null, q: '', open: null }

function base(role: Role, over: Partial<CallsModel> = {}, address: Partial<CallsAddress> = {}): CallsCase {
  return {
    role,
    model: {
      prefix: PREFIX,
      can: callsCanOf(ROLES[role]),
      address: { ...ADDRESS, ...address },
      timeZone: 'Europe/Rome',
      rows: { items: OPEN, problem: null },
      hasMore: false,
      loadingMore: false,
      counts: COUNTS,
      site: SITE,
      day: { status: 'ready', value: DAY },
      types: { status: 'ready', value: TYPES },
      asOf: new Date(NOW).toISOString(),
      live: 'live',
      announcement: null,
      chartOpen: true,
      chartBy: 'kind',
      busy: false,
      notice: null,
      detail: null,
      dialog: null,
      now: NOW,
      ...over,
    },
  }
}

const detailOf = (answer: CallRecordAnswer): CallsModel['detail'] => ({ id: answer.call.id, loaded: { status: 'ready', value: answer } })
const MACHINE_OPEN = record(OPEN[0]!)
const MATERIAL_SEEN = record(OPEN[1]!, { caller: { kind: 'WORKER', name: 'Marta Esempio' }, waiting: { blockId: uid('4141', 1), code: 'WAIT_HELP', status: 'OPEN', startedAt: OPEN[1]!.sentAt, endedAt: null } })
const SOLVED = record(CLOSED[0]!, { resolutionNote: 'Cinghia sostituita, macchina provata.', waiting: { blockId: uid('4141', 2), code: 'WAIT_HELP', status: 'APPROVED', startedAt: CLOSED[0]!.sentAt, endedAt: CLOSED[0]!.solvedAt } })

function shellFor(role: Role, page: ReturnType<typeof createElement>) {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...ROLES[role]])),
    path: '/production/calls',
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path: '/production/calls' },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

function CallsDesign({ model }: { model: CallsCase }) {
  return shellFor(model.role, createElement(CallsView, { model: model.model }))
}

export const designScreen = defineDesignScreen<CallsCase>({
  screen: 'SCR-142',
  title: 'Help calls (Production › Floor control)',
  view: CallsDesign,
  cases: [
    { id: 'inbox', label: 'Production manager: the open calls, oldest first; tiles, calls by hour, who is called', model: base('production'), note: 'SEW-04 waits 12 minutes (red); the material call books its waiting to off-standard time.' },
    { id: 'tile-waiting', label: 'The tile “Waiting over 5 minutes” pressed (a saved filter of the API)', model: base('production', { rows: { items: OPEN.slice(0, 2), problem: null } }, { tile: 'WAITING' }) },
    { id: 'all-calls', label: 'Every call: closed ones with response and resolve times', model: base('production', { rows: { items: [...OPEN, ...CLOSED], problem: null }, hasMore: true }, { view: 'all' }) },
    { id: 'selected', label: 'Rows selected: Acknowledge 2 · Mark 3 solved (closed calls cannot be selected)', model: base('production', { selected: [OPEN[0]!.id, OPEN[1]!.id, OPEN[3]!.id] }) },
    { id: 'by-line', label: 'Calls by hour stacked by line', model: base('production', { chartBy: 'line' }) },
    { id: 'chart-closed', label: 'Calls by hour folded away: Who is called takes the row', model: base('production', { chartOpen: false }) },
    { id: 'detail-machine', label: 'A machine call (DetailModal): A acknowledge, D done, J / K, Open a maintenance job', model: base('production', { detail: detailOf(MACHINE_OPEN) }, { open: OPEN[0]!.id }) },
    { id: 'detail-named', label: 'A material call at a WORKER site: the caller named inside the call only; waiting not counted', model: base('production', { detail: detailOf(MATERIAL_SEEN) }, { open: OPEN[1]!.id }) },
    { id: 'detail-solved', label: 'A solved call: how it was solved, the maintenance job it led to, the waiting approved', model: base('production', { rows: { items: [...OPEN, ...CLOSED], problem: null }, detail: detailOf(SOLVED) }, { view: 'all', open: CLOSED[0]!.id }) },
    { id: 'detail-loading', label: 'The call is being read', model: base('production', { detail: { id: OPEN[0]!.id, loaded: { status: 'loading' } } }, { open: OPEN[0]!.id }) },
    { id: 'detail-gone', label: 'A call that does not exist (or another site’s)', model: base('production', { detail: { id: uid('3636', 99), loaded: { status: 'notFound' } } }, { open: uid('3636', 99) }) },
    { id: 'solve', label: 'Done: mark the call solved with how (resolution code) and words', model: base('production', { detail: detailOf(MACHINE_OPEN), dialog: { kind: 'solve', ids: [OPEN[0]!.id], draft: { code: 'FIXED', note: 'Ago sostituito.' }, problem: null } }, { open: OPEN[0]!.id }) },
    { id: 'solve-many', label: 'Mark 3 solved: one code and words for each', model: base('production', { selected: [OPEN[0]!.id, OPEN[1]!.id, OPEN[3]!.id], dialog: { kind: 'solve', ids: [OPEN[0]!.id, OPEN[1]!.id, OPEN[3]!.id], draft: { code: '', note: '' }, problem: null } }) },
    { id: 'solve-refused', label: 'Refused: someone else solved it meanwhile (in words)', model: base('production', { detail: detailOf(MACHINE_OPEN), dialog: { kind: 'solve', ids: [OPEN[0]!.id], draft: { code: 'FIXED', note: '' }, problem: { key: 'refusal.SOLVED' } } }, { open: OPEN[0]!.id }) },
    { id: 'cancel', label: 'Cancel this call? The reason is required (kept in the audit log)', model: base('production', { detail: detailOf(MACHINE_OPEN), dialog: { kind: 'cancel', id: OPEN[0]!.id, reason: '', problem: null } }, { open: OPEN[0]!.id }) },
    { id: 'job', label: 'Open a maintenance job: the station’s machine, priority, the problem in words', model: base('production', { detail: detailOf(MACHINE_OPEN), dialog: { kind: 'job', id: OPEN[0]!.id, machines: { status: 'ready', value: MACHINES }, draft: { machineId: MACHINES[0]!.id, priority: 'P1', problem: 'Chiamata di aiuto dalla postazione SEW-04 (L2): Macchina ferma.' }, problem: null } }, { open: OPEN[0]!.id }) },
    { id: 'job-no-machine', label: 'No machine recorded at the station: held, with the way to Plant › Maintenance jobs', model: base('production', { detail: detailOf(MACHINE_OPEN), dialog: { kind: 'job', id: OPEN[0]!.id, machines: { status: 'ready', value: [] }, draft: { machineId: '', priority: 'P2', problem: 'Chiamata di aiuto dalla postazione SEW-04 (L2): Macchina ferma.' }, problem: null } }, { open: OPEN[0]!.id }) },
    { id: 'job-done', label: 'The job is open and linked to the call', model: base('production', { notice: { tone: 'success', words: { key: 'notice.job', params: { number: 'MJ-0042' } }, link: { href: `${PREFIX}/plant/jobs/${uid('3939', 2)}`, words: { key: 'notice.openJob', params: { number: 'MJ-0042' } } } } }) },
    { id: 'partly', label: 'Acknowledge 3: 2 done, 1 not (someone else saw it first)', model: base('production', { notice: { tone: 'info', words: { key: 'notice.partly', params: { done: 2, refused: 1 } } } }) },
    { id: 'raised', label: 'A call just raised: it joins the end of the list and is announced politely', model: base('production', { announcement: 'Nuova chiamata di aiuto: Materiale' }) },
    { id: 'empty', label: 'No open calls ✓; no calls today', model: base('production', { rows: { items: [], problem: null }, counts: { ...COUNTS, tiles: { OPEN: 0, WAITING: 0, ANSWERED_TODAY: 0 }, medianResponseSeconds: null }, day: { status: 'ready', value: QUIET_DAY } }) },
    { id: 'supervisor', label: 'Floor supervisor: answers calls; the routing link held (no Floor rules & codes)', model: base('supervisor') },
    { id: 'read-only', label: 'Read-only: sees the calls and times, answers nothing (no selection, held with why)', model: base('readOnly', { detail: detailOf(MACHINE_OPEN) }, { open: OPEN[0]!.id }) },
    { id: 'no-site', label: 'All sites in the top bar with no site to show: the chart and who is called ask for one', model: base('production', { site: null, day: null, types: null }) },
    { id: 'offline', label: 'The live stream is offline: the page says it is not updating', model: base('production', { live: 'offline' }) },
    { id: 'keys', label: 'The keys (the footer’s information icon, “?”)', model: base('production', { dialog: { kind: 'keys' } }) },
    { id: 'loading', label: 'Loading', model: base('production', { rows: { items: null, problem: null }, counts: null, day: { status: 'loading' }, types: { status: 'loading' }, asOf: null }) },
    { id: 'error', label: 'The read failed: in words, Try again', model: base('production', { rows: { items: null, problem: 'problem.offline' }, day: { status: 'error', problem: 'problem.offline' }, types: { status: 'error', problem: 'problem.offline' } }) },
    { id: 'no-permission', label: 'Sales: no permission (production.calls.view)', model: base('sales') },
  ],
})
