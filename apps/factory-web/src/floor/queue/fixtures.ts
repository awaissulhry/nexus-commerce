import { defineDesignScreen } from '../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../frame/fixtures'
import { SyncView, type RefusedRowModel, type SyncRow, type SyncViewModel } from './view/SyncView'

/**
 * SCR-023's cases (design floor.sync): this tablet's queue for the person signed in — online and all recorded, offline
 * with actions waiting, sending, refused with the reason and one fix, the refused action as a step screen and its discard
 * confirm, discard held without the network, label numbers running low, the clock off, storage low, other people's
 * actions counted. Made-up people, codes and times only (a "Demo" plant, the tenant tag 7K).
 */

const at = (minutes: number) => new Date(Date.parse('2026-10-29T08:00:00.000Z') + minutes * 60_000).toISOString()

const row = (key: string, kind: string, summary: SyncRow['summary'], minutes: number): SyncRow => ({ key, kind, summary, at: at(minutes) })

const WAITING = [
  { ...row('w1', 'production.scan.report', { code: 'BN-7K-000123-M', good: 18, scrap: 2 }, 41), sending: false, again: false },
  { ...row('w2', 'production.scan.report', { code: 'BN-7K-000124-P', good: 20 }, 44), sending: false, again: false },
  { ...row('w3', 'production.bundles.make', { code: 'BN-7K-000211-X', quantity: 10 }, 47), sending: false, again: false },
  { ...row('w4', 'production.cut.log', { code: 'HD-7K-000031-4', sets: 3 }, 52), sending: false, again: false },
]

const REFUSED: RefusedRowModel[] = [
  { ...row('r1', 'production.scan.report', { code: 'BN-7K-000098-2', good: 20 }, 22), code: 'REPLACED', message: 'Bundle BN-7K-000098-2 was replaced by BN-7K-000124-P.', fix: 'Discard it and scan the new ticket.', final: true },
  {
    ...row('r2', 'production.scan.report', { code: 'BN-7K-000101-6', good: 12 }, 30),
    code: 'PREVIOUS_NOT_REPORTED',
    message: 'Op 20 of this bundle is not reported yet.',
    fix: 'It is sent again by itself; if it stays here, ask your team leader.',
    final: false,
  },
]

const RECORDED = [
  { ...row('d1', 'production.scan.report', { code: 'BN-7K-000120-E', good: 20 }, 5), recordedAt: at(6) },
  { ...row('d2', 'production.scan.undo', { target: 'x' }, 8), recordedAt: at(9) },
  { ...row('d3', 'production.bundles.make', { code: 'BN-7K-000210-T', quantity: 10 }, 12), recordedAt: at(13) },
]

const base = (extra: Partial<SyncViewModel> = {}): SyncViewModel => ({
  frame: signedInFrame('sync.title', { queueButton: false, showSynced: true, lastSentAt: at(58) }),
  online: true,
  sending: false,
  lastSentAt: at(58),
  counts: { waiting: 0, refused: 0, recordedToday: 12, othersWaiting: 0, othersRefused: 0 },
  clock: null,
  storage: 'kept',
  freeMb: 2_400,
  numbers: [{ kind: 'BUNDLE', left: 184, low: false }],
  refused: [],
  waiting: [],
  recorded: RECORDED,
  showRecorded: false,
  open: null,
  confirm: false,
  problem: null,
  ...extra,
})

const offlineFrame = (pending: number, refused = 0) => signedInFrame('sync.title', { queueButton: false, showSynced: true, online: false, pending, refused, lastSentAt: at(38) })

export const designScreen = defineDesignScreen<SyncViewModel>({
  screen: 'SCR-023',
  title: 'Waiting to send',
  view: onFloor(SyncView),
  cases: [
    { id: 'synced', label: 'Online, everything recorded', model: base(), note: 'Nothing waits, nothing refused; the banner says so quietly on this screen only (elsewhere it leaves). Recorded today is collapsed.' },
    {
      id: 'offline-pending',
      label: 'Offline, 4 actions waiting',
      model: base({ frame: offlineFrame(4), online: false, lastSentAt: at(38), counts: { waiting: 4, refused: 0, recordedToday: 12, othersWaiting: 0, othersRefused: 0 }, waiting: WAITING }),
      note: 'Each action was saved on this tablet at once (one tick). Send now is held: no network. They send by themselves when the network is back.',
    },
    {
      id: 'sending',
      label: 'Back online: sending',
      model: base({
        frame: signedInFrame('sync.title', { queueButton: false, showSynced: true, pending: 4, lastSentAt: at(38) }),
        sending: true,
        lastSentAt: at(38),
        counts: { waiting: 4, refused: 0, recordedToday: 12, othersWaiting: 0, othersRefused: 0 },
        waiting: WAITING.map((item, index) => ({ ...item, sending: index === 0 })),
      }),
      note: 'One send at a time, in the queue\'s order: the first row says Sending.',
    },
    {
      id: 'refused',
      label: 'Refused, with the reason and one fix',
      model: base({ frame: signedInFrame('sync.title', { queueButton: false, showSynced: true, refused: 2, lastSentAt: at(58) }), counts: { waiting: 0, refused: 2, recordedToday: 12, othersWaiting: 0, othersRefused: 1 }, refused: REFUSED }),
      note: 'A final refusal (red) waits for Discard; one that may pass later (amber) is sent again by itself. Another person\'s refused action is counted, never shown.',
    },
    {
      id: 'refused-detail',
      label: 'A refused action, opened',
      model: base({ frame: signedInFrame('sync.title', { queueButton: false, refused: 2 }), counts: { waiting: 0, refused: 2, recordedToday: 12, othersWaiting: 0, othersRefused: 0 }, refused: REFUSED, open: 'r1' }),
      note: 'A step screen (no pop-up over the job): what, why in words, the one fix, when. Back · Discard (main, bottom right).',
    },
    {
      id: 'discard-confirm',
      label: 'Discard this action?',
      model: base({ frame: signedInFrame('sync.title', { queueButton: false, refused: 2 }), counts: { waiting: 0, refused: 2, recordedToday: 12, othersWaiting: 0, othersRefused: 0 }, refused: REFUSED, open: 'r1', confirm: true }),
      note: 'Design sync.discard: it will not be recorded; the team leader sees it was discarded. Enter = Cancel.',
    },
    {
      id: 'refused-later',
      label: 'A refusal that may pass later, opened',
      model: base({ frame: signedInFrame('sync.title', { queueButton: false, refused: 2 }), counts: { waiting: 0, refused: 2, recordedToday: 12, othersWaiting: 0, othersRefused: 0 }, refused: REFUSED, open: 'r2' }),
      note: 'It stays in the queue and is sent again by itself; Send again sends it now.',
    },
    {
      id: 'discard-offline',
      label: 'Discard needs the network',
      model: base({ frame: offlineFrame(0, 2), online: false, counts: { waiting: 0, refused: 2, recordedToday: 12, othersWaiting: 0, othersRefused: 0 }, refused: REFUSED, open: 'r1' }),
      note: 'Offline the office cannot be told: Discard is held with its reason.',
    },
    {
      id: 'numbers-low',
      label: 'Bundle ticket numbers running low (offline)',
      model: base({ frame: offlineFrame(3), online: false, counts: { waiting: 3, refused: 0, recordedToday: 12, othersWaiting: 0, othersRefused: 0 }, waiting: WAITING.slice(0, 3), numbers: [{ kind: 'BUNDLE', left: 12, low: true }] }),
      note: 'Tickets printed offline take numbers from this tablet\'s own block; it tops up by itself when the network is back.',
    },
    {
      id: 'clock-off',
      label: "The tablet's clock is off",
      model: base({ clock: { minutes: 7, ahead: false, flagged: false } }),
      note: 'PLT-240: every action keeps the tablet\'s time and the office\'s; the gap is shown when it is over five minutes.',
    },
    {
      id: 'storage-low',
      label: 'Space low on the tablet',
      model: base({ storage: 'low', freeMb: 120 }),
      note: 'PLT-242: the browser said little room is left. "May be cleared" when the browser did not promise to keep the data.',
    },
    { id: 'recorded-open', label: 'Recorded today, shown', model: base({ showRecorded: true }), note: 'Own actions recorded today, with the tablet\'s time and the office\'s (two ticks).' },
    {
      id: 'others',
      label: "Other people's actions on this tablet",
      model: base({ counts: { waiting: 0, refused: 0, recordedToday: 12, othersWaiting: 2, othersRefused: 1 } }),
      note: 'Statuto dei Lavoratori art. 4: counted, never shown. Theirs are sent when they sign in on this tablet.',
    },
    {
      id: 'problem',
      label: 'The last send did not reach the office',
      model: base({ frame: signedInFrame('sync.title', { queueButton: false, pending: 4, lastSentAt: at(38) }), lastSentAt: at(38), problem: 'unavailable', counts: { waiting: 4, refused: 0, recordedToday: 12, othersWaiting: 0, othersRefused: 0 }, waiting: WAITING }),
      note: 'The network is up but the server did not answer: the actions stay on the tablet and the queue tries again.',
    },
  ],
})
