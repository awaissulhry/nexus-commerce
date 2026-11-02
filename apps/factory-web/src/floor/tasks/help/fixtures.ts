import { defineDesignScreen } from '../../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import type { CallType, HelpCall, HelpStation } from './api'
import { HelpView, type HelpStep, type HelpViewModel } from './view/HelpView'

/**
 * SCR-172's cases (B-W2b-70; design floor.help): Who do you need? (tiles, one open, one on the tablet, offline, no station,
 * no types), Your call (nobody yet, seen, on the way by a floor person, by the office, the machine and safety follow-ups, words
 * on it), Cancel this call? (someone on the way, nobody yet), Add details, the saved call's ticks, closed, refused. Made-up
 * stations, types and people of a made-up "Demo" plant: no money.
 */

const AT = '2026-10-31T08:41:00.000Z'
const place = (code: string, name: string) => ({ id: `place-${code.toLowerCase()}`, code, name })
const STATION = place('SEW-02', 'Cucitura 2')
const LINE = place('L1', 'Linea 1')
const TEAM = place('L1-A', 'Squadra linea 1')
const frame = (extra: Partial<HelpViewModel['frame']> = {}) => signedInFrame('tile.help', { station: { name: 'SEW-02 · Cucitura 2', site: 'Stabilimento Demo Nord' }, ...extra })

const type = (code: string, labelIt: string, labelEn: string, kind: CallType['kind'], colour: string): CallType => ({ id: `type-${code.toLowerCase()}`, kind, code, labelIt, labelEn, labelI18n: {}, icon: null, colour })
const MATERIAL = type('MATERIAL', 'Materiale', 'Material', 'MATERIAL', '#b87503')
const QUALITY = type('QUALITY', 'Qualità', 'Quality', 'QUALITY', '#8b5cf6')
const MACHINE = type('MACHINE', 'Macchina', 'Machine', 'MACHINE', '#e5484d')
const LEAD = type('TEAM_LEADER', 'Capo squadra', 'Team leader', 'SUPERVISOR', '#1f6fde')
const SERVICE = type('MAINTENANCE', 'Manutenzione', 'Maintenance', 'MAINTENANCE', '#e5484d')
const SAFETY = type('SAFETY', 'Sicurezza', 'Safety', 'OTHER', '#e5484d')
const TYPES = [MATERIAL, QUALITY, MACHINE, LEAD, SERVICE, SAFETY]

const call = (callType: CallType, extra: Partial<HelpCall> = {}): HelpCall => ({
  id: `call-${callType.code.toLowerCase()}`,
  version: 1,
  status: 'SENT',
  open: true,
  type: callType,
  station: STATION,
  line: LINE,
  responderTeam: TEAM,
  note: null,
  sentAt: AT,
  timeline: [{ step: 'SENT', at: AT, by: null }],
  coming: null,
  ...extra,
})

const SEEN = call(MATERIAL, { status: 'SEEN', timeline: [{ step: 'SENT', at: AT, by: null }, { step: 'SEEN', at: '2026-10-31T08:43:00.000Z', by: { kind: 'WORKER', name: 'Paolo Demo' } }], coming: { step: 'SEEN', by: { kind: 'WORKER', name: 'Paolo Demo' }, team: TEAM } })
const COMING = call(MATERIAL, { status: 'ON_THE_WAY', timeline: [...SEEN.timeline, { step: 'ON_THE_WAY', at: '2026-10-31T08:45:00.000Z', by: { kind: 'WORKER', name: 'Paolo Demo' } }], coming: { step: 'ON_THE_WAY', by: { kind: 'WORKER', name: 'Paolo Demo' }, team: TEAM } })
const OFFICE = call(MATERIAL, { status: 'ON_THE_WAY', timeline: [{ step: 'SENT', at: AT, by: null }, { step: 'ON_THE_WAY', at: '2026-10-31T08:45:00.000Z', by: { kind: 'USER', name: null } }], coming: { step: 'ON_THE_WAY', by: { kind: 'USER', name: null }, team: TEAM } })

const station = (open: readonly HelpCall[] = [], extra: Partial<HelpStation> = {}): HelpStation => ({
  station: { ...STATION, line: LINE },
  tiles: TYPES.map((entry) => ({ type: entry, open: open.find((row) => row.type.id === entry.id) ?? null })),
  open: [...open],
  ...extra,
})

const model = (step: HelpStep, here: HelpStation | null = station(), extra: Partial<HelpViewModel> = {}): HelpViewModel => ({ frame: frame(extra.online === false ? { online: false, pending: 1 } : {}), online: true, step, station: here, asOf: null, queued: [], ...extra })
const openCall = (entry: HelpCall, extra: Partial<Extract<HelpStep, { kind: 'call' }>> = {}) => model({ kind: 'call', callId: entry.id, ...extra }, station([entry]))

export const designScreen = defineDesignScreen<HelpViewModel>({
  screen: 'SCR-172',
  title: 'Floor › Call for help',
  view: onFloor(HelpView),
  cases: [
    { id: 'tiles', label: 'Who do you need? One tap sends', model: model({ kind: 'tiles' }) },
    { id: 'tiles-open', label: 'A tile with an open call: a second tap shows it, never a duplicate', model: model({ kind: 'tiles' }, station([SEEN])) },
    { id: 'tiles-saved', label: 'A call still on this tablet', model: model({ kind: 'tiles' }, station(), { queued: [{ clientEventId: 'queued-1', typeId: QUALITY.id, at: AT }] }) },
    { id: 'tiles-offline', label: 'Offline: honest, the call waits on this tablet', model: model({ kind: 'tiles' }, station(), { online: false, asOf: AT }), note: 'Design: "No network: the call waits on this tablet. Call out loud or use the line lamp."' },
    { id: 'tiles-no-station', label: 'A tablet with no station: tiles held with the reason', model: model({ kind: 'tiles' }, station([], { station: null })) },
    { id: 'tiles-none', label: 'The site has no call types', model: model({ kind: 'tiles' }, station([], { tiles: [] })) },
    { id: 'loading', label: 'Loading', model: model({ kind: 'loading' }, null) },
    { id: 'call-sent', label: 'Your call: nobody yet', model: openCall(call(MATERIAL)) },
    { id: 'call-seen', label: 'Your call: seen', model: openCall(SEEN) },
    { id: 'call-coming', label: 'On the way: "Paolo · team · on the way"', model: openCall(COMING), note: 'A floor responder is named inside this one call.' },
    { id: 'call-office', label: 'On the way from the office: no name on the floor', model: openCall(OFFICE) },
    { id: 'call-machine', label: 'Machine: says what is wrong next', model: openCall(call(MACHINE)) },
    { id: 'call-safety', label: 'Safety: Report an incident held with its wave', model: openCall(call(SAFETY)) },
    { id: 'call-words', label: 'With words added', model: openCall(call(MATERIAL, { note: 'Mancano le fodere per il fascio 12.' }), { done: 'details' }) },
    { id: 'call-offline', label: 'Your call offline: as of', model: model({ kind: 'call', callId: SEEN.id }, station([SEEN]), { online: false, asOf: AT }) },
    { id: 'cancel-coming', label: 'Cancel this call? Someone is on the way', model: openCall(COMING, { cancelling: true }) },
    { id: 'cancel-nobody', label: 'Cancel this call? Nobody yet', model: openCall(call(MATERIAL), { cancelling: true }) },
    { id: 'details', label: 'Add details', model: model({ kind: 'details', callId: SEEN.id, words: 'Mancano le fodere.' }, station([SEEN])) },
    { id: 'details-empty', label: 'Add details: held until there are words', model: model({ kind: 'details', callId: SEEN.id, words: '' }, station([SEEN])) },
    { id: 'details-offline', label: 'Add details offline: held with the reason', model: model({ kind: 'details', callId: SEEN.id, words: 'Mancano le fodere.' }, station([SEEN]), { online: false }) },
    { id: 'details-failed', label: 'Add details refused', model: model({ kind: 'details', callId: SEEN.id, words: 'Mancano le fodere.', problem: { kind: 'refused', code: 'SOLVED', message: 'This call is solved.', fix: null } }, station([SEEN])) },
    { id: 'saved', label: 'Sent: being sent', model: model({ kind: 'queued', clientEventId: 'queued-1', typeId: MATERIAL.id, ticks: 'sending', refusal: null }) },
    { id: 'saved-offline', label: 'Sent offline: one tick, says to call out loud', model: model({ kind: 'queued', clientEventId: 'queued-1', typeId: MATERIAL.id, ticks: 'saved', refusal: null }, station(), { online: false }) },
    { id: 'refused', label: 'Refused by the office', model: model({ kind: 'queued', clientEventId: 'queued-1', typeId: MATERIAL.id, ticks: 'refused', refusal: { code: 'TYPE_INACTIVE', message: 'This call type is switched off.' } }) },
    { id: 'solved', label: 'It\'s solved: recorded', model: model({ kind: 'closed', clientEventId: 'queued-2', what: 'SOLVED', type: 'Materiale', ticks: 'recorded', refusal: null }) },
    { id: 'cancelled', label: 'Cancelled: saved on the tablet', model: model({ kind: 'closed', clientEventId: 'queued-2', what: 'CANCELLED', type: 'Materiale', ticks: 'saved', refusal: null }, station(), { online: false }) },
    { id: 'closed-elsewhere', label: 'The call closed meanwhile', model: model({ kind: 'call', callId: 'gone' }) },
    { id: 'problem', label: 'The server does not answer', model: model({ kind: 'problem', problem: { kind: 'unavailable' } }, null) },
    { id: 'no-permission', label: 'No permission', model: model({ kind: 'problem', problem: { kind: 'forbidden', path: null, message: null } }, null) },
  ],
})
