import { defineDesignScreen } from '../../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import { failItem, passGroup, suggestedPlan, type Answer, type Check } from './model'
import { fromListReason, type PickerList, type PickerReason } from '../reasons/model'
import { FinalView, type CellModel, type FinalViewModel, type HoldDialogModel, type InspectionModel, type OrderModel } from './view/FinalView'

/**
 * SCR-097's cases: the inspection bench at tablet width, from the work orders to inspect to the release and its labels,
 * with every state the design names (online, offline with the last read kept, held, refused with the reason, error,
 * empty, no permission). Made-up work orders, styles, batches and numbers of a made-up "Demo" plant; no money anywhere,
 * and never another person's name (the maker check says only "you" or "not you").
 */

const BENCH = 'QC-01 · Banco collaudo'
const frame = (extra: Partial<FinalViewModel['frame']> = {}) => signedInFrame('tile.final', { station: { name: BENCH, site: 'Stabilimento Demo Nord' }, ...extra })
const CAN = { record: true, release: true, labels: false }

const ok = (code: Check['code'], message: string): Check => ({ code, state: 'OK', message, fix: null })
const open = (code: Check['code'], message: string, fix: string): Check => ({ code, state: 'OPEN', message, fix })
const notNeeded = (code: Check['code'], message: string): Check => ({ code, state: 'NOT_NEEDED', message, fix: null })

const greenChecks = (cell: string, room: number): Check[] => [
  ok('WORK_ORDER', 'Work order WO-DEMO-0042 is in progress.'),
  ok('INSPECTION', 'INS-D-2026-0007 PASSED.'),
  ok('QUANTITY', `${room} garment(s) of ${cell} can be released from this inspection.`),
  notNeeded('SERIALS', 'The style traces its garments by batch: no serial is named.'),
  ok('LABELS', `${room} garment label(s) printed for ${cell}; 0 released.`),
  ok('CERTIFICATE', `Covered: certificate CERT-DEMO-11 (EN 17092-4, AA) covers ${cell} today; valid until 2027-03-31.`),
  ok('DOCUMENTS', 'The Declaration of Conformity and the user information are on file (or not needed).'),
  ok('LOTS', 'No material lot the work order took is on hold.'),
  ok('MAKER', 'Made by (from the floor\'s records): 4 people. You are not among them.'),
  notNeeded('SECOND_PERSON', 'An inspector who made none of the garments releases alone (Owner answer Q1 (a)).'),
]

const cell = (label: string, extra: Partial<CellModel> = {}): CellModel => ({
  id: `cell-${label.replace(' ', '-').toLowerCase()}`,
  label,
  pieces: 24,
  released: 0,
  releasable: 24,
  labelsPrinted: 24,
  checks: greenChecks(label, 24),
  secondPerson: [],
  held: null,
  printLabels: false,
  ...extra,
})

const order = (extra: Partial<OrderModel> = {}): OrderModel => ({
  id: 'wo-demo-0042',
  number: 'WO-DEMO-0042',
  batchNumber: 'B-DEMO-26-041',
  style: 'GIA-01 · Giacca moto Demo',
  status: 'IN_PROGRESS',
  finished: 48,
  released: 0,
  made: false,
  rule: 'WHEN_REQUIRED',
  customerListed: false,
  documents: [],
  cells: [cell('NERO 50'), cell('NERO 52')],
  inspections: [{ label: 'INS-D-2026-0007', status: 'PASSED' }],
  open: null,
  main: 'release',
  holds: [],
  holdHeld: null,
  ...extra,
})

const PLAN = suggestedPlan(48)
const allPass = (): Answer[] => (['LABELS', 'GARMENT', 'ARMOUR', 'PACKAGING'] as const).reduce<Answer[]>((list, group) => passGroup(list, group), [])
const twoGroups = passGroup(passGroup([], 'LABELS'), 'GARMENT')

const inspection = (extra: Partial<InspectionModel> = {}): InspectionModel => ({
  id: 'ins-demo-0008',
  label: 'INS-D-2026-0008',
  plan: PLAN,
  checklist: twoGroups,
  defects: [],
  result: 'PASS',
  statementNeeded: false,
  ...extra,
})

const openOrder = order({ inspections: [{ label: 'INS-D-2026-0008', status: 'OPEN' }], open: { label: 'INS-D-2026-0008', yours: true }, main: 'continue', cells: [cell('NERO 50', { releasable: 0, held: 'checks', checks: [open('INSPECTION', 'INS-D-2026-0008 is OPEN: only a PASSED inspection releases garments (QHS-058).', 'Sign the inspection first.'), ...greenChecks('NERO 50', 24).slice(2)] })] })

const base = (step: FinalViewModel['step'], extra: Partial<FinalViewModel> = {}): FinalViewModel => ({ frame: frame(), online: true, can: CAN, step, ...extra })

const ROWS = [
  { id: 'wo-demo-0042', number: 'WO-DEMO-0042', batchNumber: 'B-DEMO-26-041', style: 'GIA-01 · Giacca moto Demo', dueDate: '2026-11-06', pieces: 48, finished: 48, released: 0, open: false },
  { id: 'wo-demo-0043', number: 'WO-DEMO-0043', batchNumber: 'B-DEMO-26-042', style: 'PAN-02 · Pantalone Demo', dueDate: '2026-11-10', pieces: 30, finished: 18, released: 6, open: true },
  { id: 'wo-demo-0039', number: 'WO-DEMO-0039', batchNumber: null, style: 'GIL-01 · Gilet Demo', dueDate: null, pieces: 12, finished: 12, released: 4, open: false },
]

const failedList = failItem(twoGroups, 'ZIPS', 'La cerniera non funziona (ZIP-FAULT)')

// ---- B-W2a-75: Hold lot (B-W2a-F6: the tenant's HOLD list in the floor's one reason picker) ----
const holdReason = (code: string, labelIt: string, labelEn: string, icon: string | null, colour: string | null, sortOrder: number, needsDetail = false): PickerReason =>
  fromListReason({ id: `hold-${code.toLowerCase()}`, list: 'HOLD', code, labelIt, labelEn, labelI18n: {}, icon, colour, needsDetail, sortOrder })
const HOLD_REASONS: PickerReason[] = [
  holdReason('QUALITY_CHECK', 'Verifica qualità', 'Quality check', 'shield', '#8b5cf6', 10),
  holdReason('MISSING_CERTIFICATE', 'Certificato mancante', 'Missing certificate', 'award', '#b87503', 20),
  holdReason('CUSTOMER_REQUEST', 'Richiesta del cliente', 'Customer request', 'flag', '#1f6fde', 30),
  holdReason('SUPPLIER_CHECK', 'Verifica fornitore', 'Supplier check', 'truck', '#6366f1', 40),
  holdReason('OTHER', 'Altro', 'Other', null, null, 90, true),
]
const holdList = (extra: Partial<PickerList> = {}): PickerList => ({ state: 'ready', reasons: HOLD_REASONS, asOf: null, ...extra })
const holdDialog = (extra: Partial<HoldDialogModel> = {}): HoldDialogModel => ({ subject: 'WO-DEMO-0042 · B-DEMO-26-041', reasons: holdList(), picked: null, quantity: 48, ...extra })
const heldOrder = order({
  status: 'ON_HOLD',
  holds: [{ id: 'hold-1', reason: 'Verifica qualità', since: '2026-10-31T08:12:00.000Z', ncr: 'NCR-D-2026-0004' }],
  holdHeld: 'already',
  cells: [cell('NERO 50', { held: 'checks' }), cell('NERO 52', { held: 'checks' })],
})

export const designScreen = defineDesignScreen<FinalViewModel>({
  screen: 'SCR-097',
  title: 'Final inspection & release',
  view: onFloor(FinalView),
  cases: [
    { id: 'pick', label: 'Work orders to inspect', model: base({ kind: 'pick', rows: ROWS }), note: 'Scan the traveller (Home hands its scan over), or pick a row: what the site has finished and not released, highest priority first. The keys are in the list footer\'s icon.' },
    { id: 'empty', label: 'Nothing to inspect', model: base({ kind: 'pick', rows: [] }) },
    { id: 'not-found', label: 'A traveller of no work order here', model: base({ kind: 'pick', rows: ROWS, scanned: { code: 'WO-DEMO-9999', why: 'notFound' } }) },
    { id: 'not-ready', label: 'A work order not released yet', model: base({ kind: 'pick', rows: ROWS, scanned: { code: 'WO-DEMO-0050', why: 'notReady', status: 'DRAFT' } }) },
    { id: 'loading', label: 'Reading', model: base({ kind: 'loading', code: 'WO-DEMO-0042' }) },
    {
      id: 'gate-green',
      label: 'Inspected and passed: every check green',
      model: base({ kind: 'gate', order: order() }),
      note: 'The inspection passed, the labels are printed, the certificate covers both sizes today: Release to ship (the PIN signs it).',
    },
    {
      id: 'gate-red',
      label: 'The certificate gate is red',
      model: base({
        kind: 'gate',
        order: order({
          cells: [
            cell('NERO 50', { held: 'checks', checks: greenChecks('NERO 50', 24).map((check) => (check.code === 'CERTIFICATE' ? open('CERTIFICATE', 'Certificate CERT-DEMO-11 is SUSPENDED: no valid certificate covers NERO 50 today.', 'Ask the compliance lead: the certificate must cover this colourway and size today.') : check)) }),
            cell('NERO 52'),
          ],
        }),
      }),
      note: 'Red blocks the release with the plain reason and the one fix; the other size may still go.',
    },
    { id: 'start', label: 'Finished, not inspected yet', model: base({ kind: 'gate', order: order({ inspections: [], main: 'start', cells: [cell('NERO 50', { releasable: 0, held: 'checks', checks: [open('INSPECTION', 'No final inspection is named.', 'Inspect the garments first, then release from that inspection.'), ...greenChecks('NERO 50', 24).slice(2)] })] }) }) },
    { id: 'plan', label: 'The sampling plan before opening', model: base({ kind: 'plan', order: order({ main: 'start' }), plan: PLAN, field: null, maxLot: 48 }), note: 'The lot is the finished garments not yet released; every one is checked, no defect accepted, unless the inspector changes the acceptance numbers (no ISO 2859-1 table is claimed in W1).' },
    { id: 'plan-edit', label: 'Changing the lot', model: base({ kind: 'plan', order: order({ main: 'start' }), plan: PLAN, field: 'lotSize', maxLot: 48 }), note: 'Every garment of the lot is checked on the floor (the AQL sample is W2b): the lot and the acceptance numbers can change.' },
    {
      id: 'checklist',
      label: 'Checklist, 2 of 4 groups',
      model: base({ kind: 'checklist', order: openOrder, inspection: inspection(), group: 'ARMOUR', failing: null }),
      note: 'Each check Pass or Fail; "Group passes" answers the rest of the group in one tap after looking.',
    },
    { id: 'fail-reason', label: 'A check fails: what is wrong', model: base({ kind: 'checklist', order: openOrder, inspection: inspection(), group: 'GARMENT', failing: 'ZIPS' }) },
    {
      id: 'failed-check',
      label: 'A failed check with its defect',
      model: base({ kind: 'checklist', order: openOrder, inspection: inspection({ checklist: failedList, defects: [{ code: 'ZIP-FAULT', quantity: 1 }], result: 'FAIL' }), group: 'GARMENT', failing: null }),
    },
    // ---- B-W2a-75: Hold lot (design floor.final "Hold lot (secondary): a reason, and an NCR"; pop final.hold) ----
    {
      id: 'hold',
      label: 'Hold the lot: a reason tile',
      model: base({ kind: 'checklist', order: openOrder, inspection: inspection({ checklist: allPass() }), group: 'PACKAGING', failing: null }, { hold: holdDialog({ picked: 'QUALITY_CHECK' }) }),
      note: 'The tenant\'s HOLD reasons in the floor\'s one reason picker (SCR-091, pick mode): what it is about, the choice, the tiles. Other asks a written note: held on the floor with why (quality places that hold). Hold places the quality hold on the work order and opens the NCR that decides it. Enter = Cancel.',
    },
    { id: 'hold-gate', label: 'Hold lot from the work order', model: base({ kind: 'gate', order: order() }, { hold: holdDialog() }), note: 'Hold lot is the secondary action of the work order, the checklist and the release; Hold waits for a reason ("Choose a reason first").' },
    { id: 'hold-loading', label: 'Hold: reading the reasons', model: base({ kind: 'gate', order: order() }, { hold: holdDialog({ reasons: holdList({ state: 'loading', reasons: [] }) }) }) },
    { id: 'hold-failed', label: 'Hold: the reasons could not be read', model: base({ kind: 'gate', order: order() }, { hold: holdDialog({ reasons: holdList({ state: 'error', reasons: [] }) }) }), note: 'The picker\'s failed state with Try again (reads the HOLD list again); Hold waits.' },
    { id: 'hold-kept', label: 'Hold: the reasons this tablet kept', model: base({ kind: 'gate', order: order() }, { hold: holdDialog({ reasons: holdList({ asOf: '2026-10-31T07:40:00.000Z' }), picked: 'MISSING_CERTIFICATE' }) }), note: 'The office did not answer: the reasons read earlier in this visit, with their time.' },
    {
      id: 'hold-refused',
      label: 'Hold refused: the office closed the work order',
      model: base({ kind: 'gate', order: order() }, { hold: holdDialog({ picked: 'QUALITY_CHECK', problem: { kind: 'conflict', message: 'Work order WO-DEMO-0042 is CLOSED: hold its garments (serials, shipments) instead.' } }) }),
      note: 'Refused in words inside the dialog, never a 500; nothing is held.',
    },
    {
      id: 'held',
      label: 'Held: quality decides',
      model: base({ kind: 'gate', order: heldOrder }, { held: { reason: 'Verifica qualità', ncr: 'NCR-D-2026-0004' } }),
      note: 'The hold and its NCR on the work order\'s screen; Release and Hold lot are held with the reason; quality releases it in the office (never the worker who held it).',
    },
    { id: 'held-release', label: 'Release waits for quality', model: base({ kind: 'release', order: heldOrder, cell: cell('NERO 50', { held: 'checks' }), quantity: 24, signing: false, refused: [open('WORK_ORDER', 'Work order WO-DEMO-0042 is on hold (Quality check, since 31 Oct 2026).', 'Quality releases the hold in the office (Quality › Holds); then release the garments.')] }) },
    { id: 'sign', label: 'Sign the result with the PIN', model: base({ kind: 'sign', order: openOrder, inspection: inspection({ checklist: allPass() }), result: 'PASS', statement: false }) },
    { id: 'pin-wrong', label: 'Wrong PIN', model: base({ kind: 'sign', order: openOrder, inspection: inspection({ checklist: allPass() }), result: 'PASS', statement: false }, { pin: 'wrong' }) },
    { id: 'pin-locked', label: 'PIN locked', model: base({ kind: 'sign', order: openOrder, inspection: inspection({ checklist: allPass() }), result: 'PASS', statement: false }, { pin: 'locked' }) },
    {
      id: 'statement',
      label: 'A site that records stations: the statement',
      model: base({ kind: 'sign', order: openOrder, inspection: inspection({ checklist: allPass(), statementNeeded: true }), result: 'PASS', statement: false }),
      note: 'Where the floor records the station, not the worker, the tick "I did not make these goods" replaces the maker check (Q16 b).',
    },
    { id: 'release', label: 'Release one size', model: base({ kind: 'release', order: order(), cell: cell('NERO 50'), quantity: 24, signing: false, refused: [] }) },
    { id: 'release-pin', label: 'Release: the PIN again', model: base({ kind: 'release', order: order(), cell: cell('NERO 50'), quantity: 24, signing: true, refused: [] }), note: 'The PIN window (2 minutes) has passed: the PIN signs the release.' },
    {
      id: 'release-refused',
      label: 'Release refused: labels and more',
      model: base({
        kind: 'release',
        order: order(),
        cell: cell('NERO 52', { labelsPrinted: 10, releasable: 24 }),
        quantity: 24,
        signing: false,
        refused: [
          open('LABELS', 'NERO 52 has 10 garment label(s) printed and 0 garment(s) released: 24 can be released until 14 more label(s) are printed (QHS-051: labels before packing).', 'Print the garment labels at the final operation first.'),
          open('DOCUMENTS', 'The signed DoC of revision 3 is not on file.', "Put the signed DoC and leaflet of the style's revision on file (Compliance)."),
        ],
      }),
      note: 'Every open check at once, in words, each with its fix (409 checks/<CODE>).',
    },
    {
      id: 'maker',
      label: 'You worked on this order',
      model: base({ kind: 'gate', order: order({ made: true, main: 'maker', cells: [cell('NERO 50', { held: 'maker' }), cell('NERO 52', { held: 'maker' })] }) }),
      note: 'The person who made the goods never releases them: the check is in the button; nobody else is named.',
    },
    {
      id: 'second-person',
      label: 'A listed customer: a second person',
      model: base({ kind: 'release', order: order({ customerListed: true }), cell: cell('NERO 50', { secondPerson: ['CUSTOMER'] }), quantity: 24, signing: false, refused: [] }),
      note: 'Q1 (a): a second person only for overrides and listed customers; never the inspector who signed the result.',
    },
    {
      id: 'labels',
      label: 'Garment labels printing',
      model: base(
        {
          kind: 'labels',
          order: order(),
          cell: cell('NERO 52', { labelsPrinted: 10, printLabels: true }),
          jobs: [
            { id: 'job-1', status: 'PRINTED', copies: 8, detail: null },
            { id: 'job-2', status: 'SENT', copies: 4, detail: null },
            { id: 'job-3', status: 'FAILED', copies: 2, detail: 'Printer LBL-QC-01 did not answer.' },
          ],
          refused: null,
        },
        { can: { ...CAN, labels: true } },
      ),
      note: 'For a person who holds the labels permission: the station\'s printer, each job queued → sent → printed or failed, Retry on a failed one.',
    },
    { id: 'released', label: 'Released', model: base({ kind: 'done', order: order(), cell: 'NERO 50', quantity: 24, releaseNumber: 'REL-D-2026-0019', secondPerson: false }) },
    {
      id: 'offline',
      label: 'Offline: writes wait',
      model: base({ kind: 'gate', order: order({ cells: [cell('NERO 50', { held: 'offline' }), cell('NERO 52', { held: 'offline' })] }) }, { online: false, asOf: '2026-10-29T09:41:00.000Z', frame: frame({ online: false }) }),
      note: 'Inspections and releases take their number from the office at once: never queued. The last read stays, with its time.',
    },
    { id: 'offline-checklist', label: 'Offline in the checklist', model: base({ kind: 'checklist', order: openOrder, inspection: inspection(), group: 'ARMOUR', failing: null }, { online: false, frame: frame({ online: false }) }) },
    { id: 'error', label: 'The office does not answer', model: base({ kind: 'problem', problem: { kind: 'unavailable' }, code: 'WO-DEMO-0042' }) },
    { id: 'no-permission', label: 'A role without final inspection', model: base({ kind: 'noPermission' }) },
    {
      id: 'view-only',
      label: 'A role that only views',
      model: base({ kind: 'gate', order: order({ main: null, cells: [cell('NERO 50', { held: 'noRight' })] }) }, { can: { record: false, release: false, labels: false } }),
      note: 'A team leader sees the gate; recording and releasing are held with the reason.',
    },
  ],
})
