import { cadencesOf, EVENT_KINDS, PREFERENCE_CHANNELS, type Cadence, type EventKind, type PreferenceChannel } from '@nexus/factory-domain/notifications/preferences/preferences'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Matrix, MatrixCell, PreferencesModel, RoleDefaults } from './model'
import { PreferencesCase } from './view/PreferencesCase'

/**
 * SCR-546 — Home › Notifications › Notification preferences (B-W2b-388; design home.notifications popup preferences; PLT-141).
 * Made-up data only.
 */

const id = (n: number) => `0190f0e2-cccc-7000-8000-${String(n).padStart(12, '0')}`
const PLANNER = { id: id(1), name: 'Planner' }

const QUIET: Readonly<Record<PreferenceChannel, (event: EventKind) => Cadence>> = {
  IN_APP: () => 'INSTANT',
  EMAIL: (event) => (event === 'APPROVAL_WAITING' || event === 'MENTIONED' ? 'DAILY_DIGEST' : 'OFF'),
  PUSH: (event) => (event === 'MENTIONED' || event === 'APPROVAL_WAITING' || event === 'AREA_ALERT' ? 'INSTANT' : 'OFF'),
}

function cell(event: EventKind, channel: PreferenceChannel): MatrixCell {
  const quiet = QUIET[channel](event)
  const base = { event, channel, quiet, choices: [...cadencesOf(channel)], role: null }
  if (event === 'MENTIONED' && channel === 'EMAIL') return { ...base, cadence: 'INSTANT', source: 'PERSON' }
  if (event === 'FOLLOWING_CHANGED' && channel === 'IN_APP') return { ...base, cadence: 'OFF', source: 'PERSON' }
  if (event === 'AREA_ALERT' && channel === 'PUSH') return { ...base, cadence: 'INSTANT', source: 'ROLE', role: PLANNER }
  if (event === 'APPROVAL_DECIDED' && channel === 'EMAIL') return { ...base, cadence: 'DAILY_DIGEST', source: 'ROLE', role: PLANNER }
  return { ...base, cadence: quiet, source: 'QUIET' }
}

const MATRIX: Matrix = {
  asOf: '2026-11-13T08:30:00.000Z',
  events: [...EVENT_KINDS],
  channels: [...PREFERENCE_CHANNELS],
  cells: EVENT_KINDS.flatMap((event) => PREFERENCE_CHANNELS.map((channel) => cell(event, channel))),
  roles: [PLANNER],
  digestOn: true,
  pushDevices: 1,
  mayManageDefaults: false,
}

const DEFAULTS: RoleDefaults = {
  roles: [
    { id: PLANNER.id, name: PLANNER.name, key: 'planner', system: true },
    { id: id(2), name: 'Sales', key: 'sales', system: true },
  ],
  roleId: PLANNER.id,
  cells: EVENT_KINDS.flatMap((event) =>
    PREFERENCE_CHANNELS.map((channel) => ({ event, channel, cadence: event === 'AREA_ALERT' && channel === 'PUSH' ? ('INSTANT' as const) : event === 'APPROVAL_DECIDED' && channel === 'EMAIL' ? ('DAILY_DIGEST' as const) : null, quiet: QUIET[channel](event), choices: [...cadencesOf(channel)], changedAt: null })),
  ),
}

const base: PreferencesModel = { matrix: { status: 'ready', data: MATRIX }, saving: {}, defaults: null, defaultsSaving: {}, held: null, notice: null }

export const designScreen = defineDesignScreen<PreferencesModel & { tab?: 'roles' }>({
  screen: 'SCR-546',
  title: 'Notification preferences (B-W2b-388)',
  view: PreferencesCase,
  part: true,
  cases: [
    { id: 'mine', label: 'My matrix', model: base, note: 'Seven kinds × In app · E-mail · Push; each cell a cadence that saves at once, where it comes from (my choice, "Default for Planner", the quiet default). ← / → (and Alt + ↑ / ↓) move between cells.' },
    { id: 'saving', label: 'A cell saving, one refused', model: { ...base, saving: { 'MENTIONED:PUSH': { state: 'saving' }, 'ASSIGNED:EMAIL': { state: 'failed', problem: 'prefs.problem.failed' } } }, note: 'The DS CellSaveMark while it saves; a refusal on the cell in words.' },
    {
      id: 'waits',
      label: 'Digest off, no push device',
      model: { ...base, matrix: { status: 'ready', data: { ...MATRIX, digestOn: false, pushDevices: 0 } } },
      note: 'A daily digest chosen while the digest is off, push chosen with no device: each says so with a way there.',
    },
    { id: 'reset', label: 'After Reset', model: { ...base, matrix: { status: 'ready', data: { ...MATRIX, cells: MATRIX.cells.map((entry) => (entry.source === 'PERSON' ? { ...entry, source: 'QUIET' as const, cadence: entry.quiet } : entry)) } }, notice: { key: 'prefs.notice.reset', tone: 'success' } } },
    { id: 'admin-roles', label: 'Admin: role defaults', model: { ...base, matrix: { status: 'ready', data: { ...MATRIX, mayManageDefaults: true } }, defaults: { status: 'ready', data: DEFAULTS }, tab: 'roles' }, note: 'An admin picks an office role and sets its defaults ("No default" = the quiet default).' },
    { id: 'offline', label: 'Offline', model: { ...base, held: 'held.offline' }, note: 'A change says why it waits; nothing is lost.' },
    // B-TH-239 (threads plan TH-3; O-HOME-NOTIF.prefs-F01, picture 17): new requests in the matrix, quiet by default.
    {
      id: 'th3-239-requests',
      label: 'TH-3 · New requests in the matrix (quiet defaults)',
      model: { ...base, matrix: { status: 'ready', data: { ...MATRIX, cells: MATRIX.cells.map((entry) => ({ ...entry, source: 'QUIET' as const, role: null, cadence: entry.quiet })) } } },
      note: 'B-TH-239: a new request reaches the people who answer that company’s (and customer’s) requests as an "Assigned" notice — the row says so ("…and each new request of a customer whose requests you answer"); by the quiet defaults it is in the app as it happens, by e-mail only in the daily digest once it is on, never on a phone. Turn "Assigned" off in the app to stop it. A row of its own for new requests needs a schema change (the matrix’s kinds are a database list).',
    },
    { id: 'loading', label: 'Loading', model: { ...base, matrix: { status: 'loading' } } },
    { id: 'error', label: 'Could not load', model: { ...base, matrix: { status: 'error', problem: 'prefs.problem.failed' } } },
  ],
})
