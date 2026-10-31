import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import type { JobState, TicketContent } from './model'
import { BundlesView, type BundlesStep, type BundlesViewModel, type CardModel, type ProposalCellModel, type TicketModel } from './view/BundlesView'

/**
 * SCR-095's cases: a cutting table's bundles and tickets, online, offline with the queue, held, refused, failed, empty
 * and without the permission. Made-up work orders, styles, printers and codes of a made-up tenant (its tag from a fixed
 * made-up id); no money and no person anywhere (the floor shows neither).
 */

const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
const bn = (ref: number) => formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref })
const AT = '2026-10-29T08:41:00.000Z'

const frame = (extra: Parameters<typeof signedInFrame>[1] = {}) => signedInFrame('tile.bundles', extra)

const OPERATIONS = [
  { seq: 10, code: 'CUC-SPALLE', name: 'Cucitura spalle' },
  { seq: 20, code: 'MANICHE', name: 'Attacco maniche' },
  { seq: 30, code: 'ZIP', name: 'Cerniera frontale' },
  { seq: 40, code: 'FINIT', name: 'Finitura e controllo' },
]

const ORDER = { id: 'wo-1', number: 'WO-DEMO-0042', batchNumber: 'B-26-042', style: 'GIA-01 · Giacca moto Demo', open: true }

const cells = (extra: Partial<ProposalCellModel>[] = []): ProposalCellModel[] => [
  { id: 'c-50', label: 'NERO 50', cut: 16, bundled: 0, toBundle: 16, pending: 0, quantities: [10, 6], ...extra[0] },
  { id: 'c-52', label: 'NERO 52', cut: 12, bundled: 4, toBundle: 8, pending: 0, quantities: [8], ...extra[1] },
]

const content = (code: string | null, size: string, quantity: number): TicketContent => ({
  code,
  workOrder: { number: ORDER.number, batchNumber: ORDER.batchNumber },
  style: { code: 'GIA-01', name: 'Giacca moto Demo' },
  colourway: 'NERO',
  size,
  quantity,
  part: null,
  operations: OPERATIONS,
})

const job = (status: JobState['status'], extra: Partial<JobState> = {}): JobState => ({ id: `job-${status}`, status, version: 2, scanId: null, lastError: null, createdAt: AT, ...extra })

const ticket = (key: string, code: string | null, size: string, quantity: number, extra: Partial<TicketModel> = {}): TicketModel => ({
  key,
  content: content(code, size, quantity),
  ticks: 'recorded',
  print: { kind: 'job', job: job('PRINTED', { scanId: code }) },
  ...extra,
})

const proposal = (extra: Partial<Extract<BundlesStep, { kind: 'proposal' }>> = {}): BundlesStep => ({
  kind: 'proposal',
  order: ORDER,
  cells: cells(),
  bundleSize: 10,
  standardBundleSize: 10,
  singlePiece: false,
  printer: { kind: 'station', name: 'Etichette taglio 2 (demo)' },
  seesJobs: true,
  editing: null,
  tickets: [],
  ...extra,
})

const madeOnline: TicketModel[] = [
  ticket('t4', bn(131), '52', 8, { ticks: 'sending', print: { kind: 'waiting' } }),
  ticket('t3', bn(130), '50', 6, { print: { kind: 'job', job: job('QUEUED', { scanId: bn(130) }) } }),
  ticket('t2', bn(129), '50', 10),
]

const madeOffline: TicketModel[] = [
  ticket('o3', bn(9003), '52', 8, { ticks: 'saved', print: { kind: 'waiting' } }),
  ticket('o2', bn(9002), '50', 6, { ticks: 'saved', print: { kind: 'waiting' } }),
  ticket('o1', bn(9001), '50', 10, { ticks: 'saved', print: { kind: 'waiting' } }),
]

const doneCells = cells([
  { bundled: 0, toBundle: 0, pending: 16, quantities: [] },
  { bundled: 4, toBundle: 0, pending: 8, quantities: [] },
])

const card = (extra: Partial<CardModel> = {}): CardModel => ({
  id: 'b-1',
  code: bn(123),
  scanned: bn(123),
  status: 'ACTIVE',
  refusal: null,
  workOrder: { number: ORDER.number, batchNumber: ORDER.batchNumber, style: ORDER.style },
  colourway: 'NERO Nero',
  size: '50',
  part: null,
  quantity: 10,
  scans: 0,
  operations: OPERATIONS.map((operation, index) => ({ ...operation, done: index < 1 })),
  replacedCodes: [],
  ticket: content(bn(123), '50', 10),
  ...extra,
})

const bundle = (extra: Partial<Extract<BundlesStep, { kind: 'bundle' }>> = {}): BundlesStep => ({ kind: 'bundle', card: card(), stage: 'card', ...extra })

const model = (step: BundlesStep, extra: Partial<BundlesViewModel> = {}): BundlesViewModel => ({ frame: frame(), online: true, step, ...extra })
const offline = (step: BundlesStep, pending: number, extra: Partial<BundlesViewModel> = {}): BundlesViewModel => ({
  frame: frame({ online: false, pending, lastSentAt: '2026-10-29T08:12:00.000Z' }),
  online: false,
  step,
  ...extra,
})

export const designScreen = defineDesignScreen<BundlesViewModel>({
  screen: 'SCR-095',
  title: 'Bundles & tickets',
  view: onFloor(BundlesView),
  cases: [
    {
      id: 'pick',
      label: 'What was cut, not in bundles',
      model: model({
        kind: 'pick',
        rows: [
          { id: 'wo-1', number: 'WO-DEMO-0042', batchNumber: 'B-26-042', style: 'Giacca moto Demo', toBundle: 24, cells: [{ label: 'NERO 50', cut: 16, bundled: 0, toBundle: 16 }, { label: 'NERO 52', cut: 12, bundled: 4, toBundle: 8 }] },
          { id: 'wo-2', number: 'WO-DEMO-0043', batchNumber: null, style: 'Pantalone Demo', toBundle: 6, cells: [{ label: 'BLU 48', cut: 6, bundled: 0, toBundle: 6 }] },
          { id: 'wo-3', number: 'WO-DEMO-0045', batchNumber: 'B-26-045', style: 'Gilet Demo', toBundle: 12, cells: [{ label: 'GRIGIO M', cut: 20, bundled: 8, toBundle: 12 }] },
        ],
      }),
      note: 'Scan the traveller, or a row. Rows: work order · style · per size "N cut · M in bundles" · garments to bundle. Keys only in the footer\'s information icon.',
    },
    { id: 'empty', label: 'Nothing waits for bundles', model: model({ kind: 'pick', rows: [] }), note: 'Scanning a traveller still opens that work order.' },
    { id: 'loading', label: 'Looking a code up', model: model({ kind: 'loading', code: 'WO-DEMO-0042' }) },
    { id: 'proposal', label: 'Proposed bundles, two sizes', model: model(proposal()), note: 'Same split as the API: full bundles of the size, the last takes the rest (16 by 10 → 10 + 6). One tap makes 3 bundles and prints 3 tickets on this station\'s printer.' },
    {
      id: 'quantity',
      label: 'A bundle\'s quantity being changed',
      model: model(proposal({ cells: cells([{ quantities: [8, 8] }]), editing: { cellId: 'c-50', index: 0, value: 8, max: 16 } })),
      note: 'Tap a bundle: the pad opens with its quantity; Set keeps the bundles before it and splits the rest again, so every cut garment still has a bundle.',
    },
    {
      id: 'single-piece',
      label: 'Made to measure: single piece',
      model: model(
        proposal({
          order: { ...ORDER, number: 'WO-DEMO-0050', batchNumber: null, style: 'GIA-MTM · Giacca su misura Demo' },
          cells: [{ id: 'c-u', label: 'NERO MTM', cut: 3, bundled: 0, toBundle: 3, pending: 0, quantities: [1, 1, 1] }],
          bundleSize: 1,
          singlePiece: true,
        }),
      ),
      note: 'MES-068: one garment per bundle, each with its own ticket; the size cannot change.',
    },
    {
      id: 'made-online',
      label: 'Tickets just made (online)',
      model: model(proposal({ cells: cells([{ bundled: 16, toBundle: 0, quantities: [] }, { bundled: 4, toBundle: 0, pending: 8, quantities: [] }]), tickets: madeOnline })),
      note: 'Each ticket: its code, the two ticks (Saved on this tablet → Recorded by the office), then its print job: in the queue, sent, printed.',
    },
    {
      id: 'print-failed',
      label: 'A ticket did not print',
      model: model(proposal({ cells: doneCells, tickets: [ticket('f1', bn(140), '50', 10, { print: { kind: 'job', job: job('FAILED', { scanId: bn(140), lastError: 'Etichette taglio 2: rotolo finito (demo)' }) } }), madeOnline[2]!] })),
      note: 'The job failed with the printer\'s reason; Print again queues the same job again.',
    },
    {
      id: 'made-offline',
      label: 'Made offline: saved on this tablet',
      model: offline(proposal({ cells: doneCells, tickets: madeOffline, asOf: '2026-10-29T08:10:00.000Z' }), 3),
      note: 'The codes come from this tablet\'s own block; one tick each; the tickets print on the station\'s printer when the office records them. The work order is the tablet\'s copy, with its time.',
    },
    {
      id: 'numbers-low',
      label: 'Ticket numbers running low (offline)',
      model: offline(proposal({ tickets: madeOffline.slice(0, 1), asOf: '2026-10-29T08:10:00.000Z' }), 1, { lowNumbers: 3 }),
      note: 'Only 3 numbers left on the tablet: a ticket made with none left is numbered by the office when it arrives.',
    },
    {
      id: 'numbered-by-office',
      label: 'No number left: the office numbers it',
      model: offline(proposal({ cells: doneCells, tickets: [ticket('n1', null, '50', 10, { ticks: 'saved', print: { kind: 'waiting' } })], asOf: '2026-10-29T08:10:00.000Z' }), 1, { lowNumbers: 0 }),
    },
    {
      id: 'no-printer',
      label: 'No label printer at the site',
      model: model(proposal({ printer: { kind: 'none' }, cells: doneCells, tickets: [ticket('p1', bn(150), '50', 10, { print: { kind: 'none' } })] })),
      note: 'Said plainly: the tickets are not printed here. No made-up print state.',
    },
    {
      id: 'choose-printer',
      label: 'Two printers, none at the station',
      model: model(proposal({ printer: { kind: 'choose', printers: [{ id: 'p1', name: 'Etichette taglio 1 (demo)' }, { id: 'p2', name: 'Etichette taglio 2 (demo)' }], picked: null } })),
      note: 'Make is held until a printer is picked.',
    },
    {
      id: 'closed',
      label: 'Work order not open',
      model: model(proposal({ order: { ...ORDER, open: false } })),
    },
    {
      id: 'ticket-refused',
      label: 'A ticket refused by the office',
      model: model(
        proposal({
          cells: doneCells,
          tickets: [ticket('r1', bn(9010), '50', 10, { ticks: 'refused', print: { kind: 'waiting' }, refusal: { message: 'Bundles wait at this site until its floor is ready.', fix: 'Ask your team leader: the office finishes setting up the floor rules.' } })],
        }),
        { frame: frame({ refused: 1 }) },
      ),
      note: 'The banner counts it in red; Waiting to send has the fix.',
    },
    { id: 'bundle-card', label: 'A bundle scanned', model: model(bundle()), note: 'Facts, its operations with ticks, the ticket as it printed. Reprint (main) and Split (W2a) in the bar; Void in the card (rare, final, before any scan).' },
    { id: 'reprint', label: 'Reprint: why a new ticket?', model: model(bundle({ stage: 'reprint' })), note: 'One tap on a reason prints the new ticket.' },
    {
      id: 'reprinted',
      label: 'Reprinted with a new code',
      model: model(
        bundle({
          card: card({ code: bn(160), scanned: bn(160), replacedCodes: [bn(123)], ticket: content(bn(160), '50', 10) }),
          done: { kind: 'reprinted', replacedCode: bn(123), ticket: ticket('b-1', bn(160), '50', 10, { print: { kind: 'job', job: job('SENT', { scanId: bn(160) }) } }) },
        }),
      ),
      note: 'MES-073: the old code says "replaced" when scanned.',
    },
    { id: 'void-confirm', label: 'Void this bundle?', model: model(bundle({ stage: 'void', reason: 'mistake' })), note: 'A confirm with a reason tile; Enter is Cancel.' },
    { id: 'voided', label: 'Voided', model: model(bundle({ card: card({ status: 'VOID' }), done: { kind: 'voided', code: bn(123), quantity: 10 } })) },
    { id: 'voided-scanned', label: 'A voided ticket scanned', model: model(bundle({ card: card({ status: 'VOID', refusal: { code: 'VOIDED', message: 'Bundle voided.' } }) })) },
    {
      id: 'replaced-scanned',
      label: 'An old (replaced) ticket scanned',
      model: model(bundle({ card: card({ code: bn(160), scanned: bn(123), replacedCodes: [bn(123)], refusal: { code: 'REPLACED', message: 'Replaced.' }, ticket: content(bn(160), '50', 10) }) })),
    },
    { id: 'held-offline', label: 'Offline: reprint, void and split wait', model: offline(bundle({ asOf: '2026-10-29T08:20:00.000Z' }), 2), note: 'The tablet\'s copy of the bundle with its time; reprint, void and split need the network (held with the reason).' },
    // ---- B-W2a-75: split a bundle (design floor.bundles "Split a bundle", MES-071) ----
    {
      id: 'split',
      label: 'Split: how many come off, and why',
      model: model(bundle({ card: card({ scans: 2, operations: OPERATIONS.map((operation, index) => ({ ...operation, done: index < 2 })) }), stage: 'split', split: { quantity: 3, reason: 'REWORK', live: 10 } })),
      note: 'The pad (1 to the garments in it − 1: at least one stays) and the DS reason grid (rework, recut, hold). One tap splits them off into a new bundle and prints its ticket; the genealogy stays.',
    },
    { id: 'split-empty', label: 'Split: nothing typed yet', model: model(bundle({ stage: 'split', split: { quantity: null, reason: null, live: 10 } })), note: 'The main action says what it waits for.' },
    { id: 'split-reading', label: 'Split: reading the bundle', model: model(bundle({ stage: 'split', split: { quantity: null, reason: null, live: null, reading: true } })), note: 'The garments still in it (as cut, less earlier splits) are read from the work order first.' },
    { id: 'split-one', label: 'Split: one garment left in it', model: model(bundle({ card: card({ quantity: 4, live: 1 }), stage: 'split', split: { quantity: null, reason: null, live: 1 } })), note: 'Three were split off before: nothing more can come off.' },
    {
      id: 'split-done',
      label: 'Split off: the new ticket',
      model: model(
        bundle({
          card: card({ scans: 2, live: 7, operations: OPERATIONS.map((operation, index) => ({ ...operation, done: index < 2 })) }),
          done: { kind: 'split', parentCode: bn(123), quantity: 3, reason: 'REWORK', live: 7, ticket: ticket('b-170', bn(170), '50', 3, { print: { kind: 'job', job: job('SENT', { scanId: bn(170) }) } }) },
        }),
      ),
      note: 'The child bundle\'s ticket with its print state (Retry when it fails); the card says how many stay in the parent.',
    },
    {
      id: 'split-refused',
      label: 'Split refused: work order on hold',
      model: model(bundle({ stage: 'split', split: { quantity: 3, reason: 'HOLD', live: 10 }, problem: { kind: 'refused', code: 'WORK_ORDER_ON_HOLD', message: 'Work order WO-DEMO-0042 is on hold.', fix: null } })),
      note: 'The API\'s refusal in the screen\'s words; the pad stays as typed.',
    },
    {
      id: 'refused',
      label: 'Refused: bundle scanned already',
      model: model(bundle({ card: card({ scans: 2, operations: OPERATIONS.map((operation, index) => ({ ...operation, done: index < 2 })) }), problem: { kind: 'refused', code: 'SCANNED', message: 'Bundle was scanned already.', fix: null } })),
      note: 'A void after a scan: the words say why and what to do.',
    },
    { id: 'not-found', label: 'Not at this site', model: model({ kind: 'problem', problem: { kind: 'notFound' }, code: bn(999) }) },
    { id: 'error', label: 'Server not answering', model: model({ kind: 'problem', problem: { kind: 'unavailable' }, code: null }) },
    { id: 'offline-unknown', label: 'Offline, not on this tablet', model: offline({ kind: 'problem', problem: { kind: 'offline' }, code: 'WO-DEMO-0099' }, 0) },
    { id: 'no-permission', label: 'Not for this role', model: model({ kind: 'noPermission' }) },
  ],
})
