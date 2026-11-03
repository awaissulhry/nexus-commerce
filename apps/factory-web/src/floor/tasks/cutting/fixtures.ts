import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import type { CutWorkOrderRow, RemnantPlace } from './api'
import { areaUsed, cardCheck, remnantMinimum, sizeStates, type CheckWarning, type CutCell, type HideChecks } from './model'
import type { AnywayModel } from './view/AnywayDialog'
import { CutView, type CutViewModel, type HideCardModel, type HideCheckModel } from './view/CutView'

/**
 * SCR-094's cases (design floor.hidecut): the cutting table's work order, the hide's check, the sets drafted per size,
 * Hide done with or without a remnant, the two ticks, and every refusal as a full-screen state. Made-up plant, people,
 * leather, codes and orders only (a made-up tenant tag); no money anywhere (the floor shows none).
 */

const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
const HIDE = formatScanId({ type: 'HIDE', tenantTag: TAG, ref: 4211 })
const HIDE_2 = formatScanId({ type: 'HIDE', tenantTag: TAG, ref: 4212 })
const AT = '2026-10-29T08:12:00.000Z'

const frame = signedInFrame('tile.cut')
const offlineFrame = signedInFrame('tile.cut', { online: false, pending: 1, lastSentAt: '2026-10-29T08:40:00.000Z' })

const ROWS: CutWorkOrderRow[] = [
  { id: 'wo-1', number: 'WO-DEMO-0042', batchNumber: 'B-26-042', status: 'IN_PROGRESS', dueDate: '2026-11-06', style: { id: 's1', code: 'GIA-01', name: 'Giacca Aria Demo' }, colourways: ['NERO'], pieces: 40, toCut: 22, sizesLeft: ['NERO 50', 'NERO 52', 'NERO 54'] },
  { id: 'wo-2', number: 'WO-DEMO-0043', batchNumber: null, status: 'RELEASED', dueDate: '2026-11-12', style: { id: 's2', code: 'PAN-02', name: 'Pantalone Demo' }, colourways: ['MARRONE'], pieces: 24, toCut: 24, sizesLeft: ['MARRONE 48', 'MARRONE 50'] },
  { id: 'wo-3', number: 'WO-DEMO-0039', batchNumber: 'B-26-039', status: 'IN_PROGRESS', dueDate: null, style: { id: 's3', code: 'GIL-03', name: 'Gilet Demo' }, colourways: ['NERO', 'GRIGIO'], pieces: 12, toCut: 0, sizesLeft: [] },
]

const CELLS: CutCell[] = [
  { id: 'c50', colourwayCode: 'NERO', size: '50', quantity: 10, toCut: 4 },
  { id: 'c52', colourwayCode: 'NERO', size: '52', quantity: 12, toCut: 6 },
  { id: 'c54', colourwayCode: 'NERO', size: '54', quantity: 8, toCut: 0 },
  { id: 'c56', colourwayCode: 'NERO', size: '56', quantity: 10, toCut: 10 },
]

const chip = { id: 'wo-1', number: 'WO-DEMO-0042', style: 'Giacca Aria Demo', colours: ['NERO'] }

const hide: HideCardModel = {
  code: HIDE,
  item: 'Pelle bovina pieno fiore 1,2 mm (demo)',
  colour: 'NERO',
  area: '52.40',
  areaUom: 'FT2',
  grade: 'A',
  thicknessMm: '1.20',
  shade: 'S2',
  dyeBatch: '7731',
  lotCode: 'LOT-DEMO-0007',
  state: 'FULL',
  defects: null,
  left: '52.4000',
  baseUom: 'FT2',
  issuedByCut: false,
  match: { kind: 'same', batch: '7731' },
  lastCut: null,
}

const PLACES: RemnantPlace[] = [
  { id: 'p1', code: 'R2', name: 'Rastrelliera avanzi (demo)' },
  { id: 'p2', code: 'A1-STORE-01', name: 'Magazzino pelli (demo)' },
]

const check = (extra: Partial<CutViewModel> = {}, draft: readonly string[] = []): CutViewModel => ({
  frame,
  stage: 'check',
  workOrder: chip,
  hide,
  sizes: sizeStates(CELLS, draft),
  picked: 'c52',
  draft: [],
  ...extra,
})

const drafted: CutViewModel = check({ draft: [{ label: '50', sets: 1 }, { label: '52', sets: 2 }] }, ['c52', 'c52', 'c50'])

const remnant = (value: number | null, extra: Partial<NonNullable<CutViewModel['remnant']>> = {}): CutViewModel => ({
  ...drafted,
  stage: 'remnant',
  remnant: { value, uom: 'FT2', max: 52.4, left: '52.4000', used: areaUsed('52.4000', value), problem: value === null ? 'empty' : value >= 52.4 ? 'tooLarge' : null, places: PLACES, placeId: 'p1', ...extra },
})

const scan = (extra: Partial<CutViewModel> = {}): CutViewModel => ({ frame, stage: 'scan', workOrder: chip, ...extra })

// ---- B-W2b-110: the hide check in depth, "Cut anyway", the thickness at the table, the photo (made-up lots, people) -------

const LOT = { lotCode: 'LOT-DEMO-0007', shadeLabel: '2' }
const OTHER_LOT = { lotCode: 'LOT-DEMO-0011', shadeLabel: '3' }

const CLEAN: HideChecks = {
  warnings: [],
  standing: [],
  passed: [],
  shade: { rule: 'ORDER', cutFrom: [LOT], hide: { ...LOT, outOfShade: false }, same: true },
  thickness: { verdict: 'OK', valueMm: '1.20', source: 'HIDE', minMm: '1.10', maxMm: '1.30' },
  grade: { hide: 'A', byText: false, pieces: [{ name: 'Davanti', minGrade: 'B', verdict: 'OK' }, { name: 'Manica', minGrade: null, verdict: 'OK' }] },
  reserved: { forIt: true, hides: [HIDE], lots: ['LOT-DEMO-0007'] },
  photo: { required: false },
}

const SHADE: CheckWarning = { kind: 'SHADE', code: 'SHADE_LOT', shade: { rule: 'ORDER', cutFrom: [LOT], hide: { ...OTHER_LOT, outOfShade: false }, cell: null } }
const WRONG: CheckWarning = { kind: 'WRONG_HIDE', code: 'NOT_RESERVED', wrongHide: { reservedHides: [{ code: HIDE_2, lotCode: 'LOT-DEMO-0007', grade: 'A' }], reservedLots: ['LOT-DEMO-0007'], differs: ['LOT', 'GRADE'], hide: { lotCode: 'LOT-DEMO-0011', grade: 'B' } } }
const THIN: CheckWarning = { kind: 'THICKNESS', code: 'THIN', thickness: { valueMm: '0.95', source: 'HIDE', minMm: '1.10', maxMm: '1.30' } }
const BELOW: CheckWarning = { kind: 'GRADE', code: 'BELOW', grade: { hideGrade: 'C', pieces: [{ name: 'Davanti', minGrade: 'B' }] } }

const shadeChecks: HideChecks = { ...CLEAN, warnings: [SHADE], standing: ['SHADE'], shade: { ...CLEAN.shade, hide: { ...OTHER_LOT, outOfShade: false }, same: false }, reserved: { forIt: false, hides: [], lots: [] } }
const wrongChecks: HideChecks = { ...CLEAN, warnings: [WRONG], standing: ['WRONG_HIDE'], reserved: { forIt: false, hides: [HIDE_2], lots: ['LOT-DEMO-0007'] } }
const thinChecks: HideChecks = { ...CLEAN, warnings: [THIN], standing: ['THICKNESS'], thickness: { verdict: 'THIN', valueMm: '0.95', source: 'HIDE', minMm: '1.10', maxMm: '1.30' } }
const belowChecks: HideChecks = { ...CLEAN, warnings: [BELOW], standing: ['GRADE'], grade: { hide: 'C', byText: false, pieces: [{ name: 'Davanti', minGrade: 'B', verdict: 'BELOW' }, { name: 'Manica', minGrade: null, verdict: 'OK' }] } }
const severalChecks: HideChecks = { ...belowChecks, warnings: [SHADE, BELOW], standing: ['SHADE', 'GRADE'], shade: shadeChecks.shade, reserved: { forIt: false, hides: [], lots: [] } }
const passedChecks: HideChecks = { ...shadeChecks, standing: [], passed: ['SHADE'] }

const checkModel = (checks: HideChecks, measuredMm: string | null = null): HideCheckModel => {
  const card = cardCheck(checks, measuredMm)
  return { workOrderNumber: 'WO-DEMO-0042', warnings: card.warnings, standing: card.standing, passed: checks.passed, shade: checks.shade, thickness: card.thickness, grade: checks.grade, reserved: checks.reserved, measuredMm, measurable: true }
}

const inDepth = (checks: HideChecks, extra: Partial<HideCardModel> = {}, measuredMm: string | null = null): HideCardModel => ({
  ...hide,
  lotCode: checks.shade.hide.lotCode,
  grade: checks.grade.hide,
  thicknessMm: checks.thickness.valueMm,
  checks: checkModel(checks, measuredMm),
  photo: { taken: false, required: checks.photo.required, held: null },
  ...extra,
})

/** A card that stops: the size buttons pick the first set, the main action is Cut anyway (held with its reason, or not). */
const stopped = (checks: HideChecks, held: NonNullable<CutViewModel['stopped']>['held'] = null, extra: Partial<CutViewModel> = {}): CutViewModel => check({ hide: inDepth(checks), stopped: { held, waiting: held === 'waiting' ? 2 : 0 }, ...extra })

const PEOPLE = [
  { id: 'w-1', name: 'Marta Demo' },
  { id: 'w-2', name: 'Luca Demo' },
  { id: 'w-3', name: 'Sara Demo' },
]

const anyway = (extra: Partial<AnywayModel> = {}, warnings: readonly CheckWarning[] = [SHADE]): AnywayModel => ({
  hideCode: HIDE,
  workOrderNumber: 'WO-DEMO-0042',
  size: '52',
  warnings,
  measuredMm: null,
  reasonCode: null,
  words: '',
  lead: null,
  people: PEOPLE,
  picking: false,
  busy: false,
  problem: null,
  ...extra,
})
const signing = (extra: Partial<AnywayModel> = {}, warnings?: readonly CheckWarning[]): CutViewModel => stopped(shadeChecks, null, { anyway: anyway({ reasonCode: 'CHECKED_BY_EYE', lead: { kind: 'name', workerId: 'w-1', name: 'Marta Demo' }, ...extra }, warnings) })

const W2B_CASES = [
  { id: 'check-in-depth', label: 'W2b hide check passed (shade lot, reserved, thickness, grade)', model: check({ hide: inDepth(CLEAN) }), note: 'B-W2b-110: every check passes, so the size buttons are there at once (no tap). Same shade lot, reserved for this work order, thickness against the leather\'s range, the pieces\' minimum grade. Photo of the hide and Measure here on the card.' },
  { id: 'stop-shade', label: 'Stops: another shade lot (Cut anyway)', model: stopped(shadeChecks), note: 'MES-053: W2b blocks it. The warning stops on the card, never as a tap on a size; the size buttons pick the first set the lead\'s signature records.' },
  { id: 'stop-wrong-hide', label: 'Stops: not the reserved hide', model: stopped(wrongChecks), note: 'MES-063: the work order has a hide reserved by name; this one differs by lot and grade.' },
  { id: 'stop-thin-measure-first', label: 'Stops: too thin as recorded (measure first)', model: stopped(thinChecks, 'measure'), note: 'MES-064: a thickness read off the hide\'s record: Cut anyway waits for a measure at the table (the office refuses it otherwise).' },
  { id: 'stop-grade', label: 'Stops: grade too low for a piece', model: stopped(belowChecks), note: 'MES-055: the hide is grade C; Davanti asks B or better.' },
  { id: 'stop-several', label: 'Stops: two warnings at once', model: stopped(severalChecks) },
  { id: 'stop-offline', label: 'Stops, offline: Cut anyway needs the network', model: stopped(shadeChecks, 'offline', { frame: offlineFrame, asOf: '2026-10-29T08:35:00.000Z' }), note: 'The card as the tablet read it this visit; the lead\'s PIN is checked by the office, so Cut anyway is held with the reason. The queue never carries a signature.' },
  { id: 'stop-waiting', label: 'Stops: cuts of this work order wait to be sent', model: stopped(shadeChecks, 'waiting'), note: 'Order: what this tablet saved for the work order goes first.' },
  { id: 'anyway-reason', label: 'Cut anyway? — what differs, a reason tile', model: stopped(shadeChecks, null, { anyway: anyway() }), note: 'Design hidecut.override: what differs, a reason tile, the lead\'s PIN. Esc cancels.' },
  { id: 'anyway-other-words', label: 'Cut anyway? — Other asks a few words', model: stopped(shadeChecks, null, { anyway: anyway({ reasonCode: 'OTHER', words: 'Pi' }) }) },
  { id: 'anyway-lead', label: 'Cut anyway? — the lead scans a badge or is picked by name', model: stopped(shadeChecks, null, { anyway: anyway({ reasonCode: 'CHECKED_BY_EYE' }) }) },
  { id: 'anyway-pick-name', label: 'Cut anyway? — pick the lead by name', model: stopped(shadeChecks, null, { anyway: anyway({ reasonCode: 'NO_OTHER_HIDE', picking: true }) }), note: 'The site\'s people, never the cutter: they cannot sign their own cut.' },
  { id: 'anyway-pin', label: 'Cut anyway? — the lead\'s PIN', model: signing(), note: 'The sixth digit signs. The PIN goes in that one request and is never drawn or kept.' },
  { id: 'anyway-pin-several', label: 'Cut anyway? — two warnings, thickness measured', model: stopped(severalChecks, null, { anyway: anyway({ reasonCode: 'HIDDEN_PARTS', lead: { kind: 'badge', code: 'BADGE' }, measuredMm: '0.98' }, [SHADE, BELOW]) }) },
  { id: 'anyway-wrong-pin', label: 'Cut anyway? — badge or PIN wrong', model: signing({ problem: 'wrong' }) },
  { id: 'anyway-cutter', label: 'Cut anyway? — the cutter cannot sign', model: signing({ problem: 'self' }) },
  { id: 'anyway-not-lead', label: 'Cut anyway? — not a lead', model: signing({ problem: 'notLead' }) },
  { id: 'anyway-locked', label: 'Cut anyway? — too many tries', model: signing({ problem: 'locked' }) },
  { id: 'anyway-no-answer', label: 'Cut anyway? — no answer (sign again)', model: signing({ problem: 'unavailable' }), note: 'The same cut, the same client id: signed again, it is recorded once.' },
  { id: 'anyway-busy', label: 'Cut anyway? — signing', model: signing({ busy: true }) },
  {
    id: 'anyway-signed',
    label: 'Signed: the first set recorded, cut the rest',
    model: check({ hide: inDepth(passedChecks), notice: { tone: 'success', text: 'Cut anyway signed (shade): the first set is recorded. Cut the rest as usual.' } }),
    note: 'The pass is per hide and work order: the next sets of this hide queue as usual. The signed set is on the scan step\'s strip, recorded, with Undo (online): the pass goes with it.',
  },
  { id: 'anyway-changed', label: 'The check changed since the card', model: stopped(severalChecks, null, { notice: { tone: 'warning', text: 'The hide\'s check changed since the card (grade): read it again, then a lead signs.' } }) },
  { id: 'measure-pad', label: 'Thickness at the table', model: { ...check({ hide: inDepth(thinChecks) }), stage: 'measure', measure: { value: 0.98, problem: null } }, note: 'MES-064: mm on the pad; it goes with every cut of this hide while it is on the table.' },
  { id: 'measure-empty', label: 'Thickness at the table — nothing typed', model: { ...check({ hide: inDepth(thinChecks) }), stage: 'measure', measure: { value: null, problem: 'empty' } } },
  { id: 'measured-in-range', label: 'Measured here inside the range: the warning goes', model: check({ hide: inDepth(thinChecks, {}, '1.15') }), note: 'The record said 0.95 mm; 1.15 mm measured at the table is inside 1.10–1.30: no warning, the sizes open. The cut carries the measure.' },
  { id: 'measured-still-thin', label: 'Measured here, still too thin', model: stopped(thinChecks, null, { hide: inDepth(thinChecks, {}, '0.98') }), note: 'Measured: Cut anyway may open; the entry records what the lead saw.' },
  { id: 'photo-step', label: 'Photo of the hide', model: { ...check({ hide: inDepth(CLEAN) }), stage: 'photo', photoStep: { sending: false, failed: false, held: null } }, note: 'MES-060: camera step with an outline guide, faces kept out; the camera starts only when asked.' },
  { id: 'photo-sending', label: 'Photo of the hide — sending', model: { ...check({ hide: inDepth(CLEAN) }), stage: 'photo', photoStep: { sending: true, failed: false, held: null } } },
  { id: 'photo-failed', label: 'Photo of the hide — did not reach the office', model: { ...check({ hide: inDepth(CLEAN) }), stage: 'photo', photoStep: { sending: false, failed: true, held: null } } },
  { id: 'photo-offline', label: 'Photo of the hide — needs the network', model: { ...check({ frame: offlineFrame, hide: inDepth(CLEAN, { photo: { taken: false, required: false, held: 'offline' } }) }), stage: 'photo', photoStep: { sending: false, failed: false, held: 'offline' } } },
  { id: 'photo-taken', label: 'Photo taken: it goes with the next cut', model: check({ hide: inDepth(CLEAN, { photo: { taken: true, required: false, held: null } }) }) },
  { id: 'photo-required', label: 'A site that asks the photo first', model: check({ hide: inDepth({ ...CLEAN, photo: { required: true } }), photoFirst: true }), note: 'No site setting yet (B-W2b-103): optional everywhere today. When a site asks it, + 1 set waits for the photo.' },
  { id: 'remnant-tag-scanned', label: 'A remnant scanned by its RM tag', model: check({ hide: inDepth(CLEAN, { state: 'REMNANT', remnantTag: 'RM-5P-00003P-K', left: '14.2000' }) }), note: 'B-W2b-100: the RM tag is looked up to its hide (online).' },
  { id: 'remnant-no-right', label: 'An RM tag the role cannot look up', model: scan({ notice: { tone: 'danger', text: 'This is a remnant\'s tag, and your role cannot look it up: scan the hide\'s own tag on it.' } }) },
  { id: 'remnant-too-small', label: 'Remnant smaller than the minimum kept', model: remnant(0.6, { problem: 'tooSmall', minimum: remnantMinimum('FT2') }), note: 'B-W2b-100: a piece under 10 dm² is waste; the office refuses it, so the save waits.' },
  { id: 'refused-cut-warning', label: 'The office refused a queued cut: warnings now', model: scan({ last: { text: `${HIDE_2} · 52 × 2 · not done`, ticks: 'refused', refused: 'This hide has warnings no lead signed for. Take another hide, or scan it again online: a lead signs Cut anyway with their PIN and a reason.', undo: null } }), note: 'A card read clean (or offline) whose warning appeared before the queue sent it: refused, final, in words.' },
] satisfies { id: string; label: string; model: CutViewModel; note?: string }[]

export const designScreen = defineDesignScreen<CutViewModel>({
  screen: 'SCR-094',
  title: 'Hide check & cut log',
  view: onFloor(CutView),
  cases: [
    { id: 'pick-work-order', label: 'Cutting for which work order?', model: { frame, stage: 'workOrder', workOrders: ROWS }, note: 'Scan the traveller, or pick from today\'s released work orders at this site (number, style, colour, sizes left). A hide\'s tag scanned here opens the one work order that cuts it.' },
    { id: 'loading-work-orders', label: 'Reading the work orders', model: { frame, stage: 'workOrder', workOrders: null } },
    { id: 'empty', label: 'Nothing to cut', model: { frame, stage: 'workOrder', workOrders: [] }, note: '"No released work order to cut. Ask the office."' },
    { id: 'scan-hide', label: 'Scan the hide\'s tag', model: scan(), note: 'The work order stays as a chip line with Change for the visit.' },
    { id: 'looking', label: 'Checking a hide', model: scan({ loading: HIDE }) },
    { id: 'wrong-type', label: 'Not a hide tag', model: scan({ wrongType: true }), note: 'A bundle ticket or another label at the hide step: "Scan the hide\'s tag."' },
    { id: 'check-passed', label: 'Hide check passed: size buttons', model: check(), note: 'Area in sq ft and dm² both, grade as a big letter, thickness, shade and dye batch, lot, state, defects. The checks pass, so the size buttons are there at once: + 1 set (Enter) logs every part of one garment of the picked size.' },
    { id: 'different-batch', label: 'Different dye batch (information)', model: check({ hide: { ...hide, dyeBatch: '7745', match: { kind: 'different', batch: '7745', others: ['7731'] } } }), note: 'W1: information in amber, nothing is blocked (W2b blocks it, MES-053).' },
    { id: 'not-yet-issued', label: 'Hide not yet issued (the cut issues it)', model: check({ hide: { ...hide, issuedByCut: true, match: { kind: 'first' } } }), note: 'SCM-215: the first cut issues the hide to the work order (only released lots; never twice, SCM-194).' },
    { id: 'sets-drafted', label: 'Sets drafted on this hide', model: drafted, note: '"From this hide: 50 × 1 · 52 × 2", Undo last set. The draft stays on this tablet until Hide done.' },
    { id: 'size-all-cut', label: 'A size all cut (held)', model: check({ picked: 'c54' }), note: 'Size 54 has nothing left: held on its button, and + 1 set says why.' },
    { id: 'cut-on-another-table', label: 'Cut on another table before', model: check({ hide: { ...hide, state: 'PARTLY_CUT', left: '18.6000', lastCut: { at: AT, workOrderNumber: 'WO-DEMO-0042', station: 'Tavolo taglio 1' } } }), note: 'The hide\'s last cut: when, for which work order, at which table, and the area left. Never who.' },
    { id: 'hide-done', label: 'Hide done: two big choices', model: { ...drafted, stage: 'done' }, note: 'No remnant · done, or type the remnant\'s area.' },
    { id: 'remnant-pad', label: 'The remnant\'s area (with the other unit)', model: remnant(12.5), note: 'The pad in the hide\'s unit with decimals, the other unit beside, where it goes, and the area used = left − remnant, shown, not typed.' },
    { id: 'remnant-too-large', label: 'Remnant above what is left', model: remnant(52.4), note: 'With pieces logged the remnant is less than what is left: the save is held with the limit.' },
    { id: 'remnant-no-places', label: 'Remnant: places need the network', model: remnant(8, { places: null, placeId: null, placesHeld: 'unavailable' }) },
    { id: 'recorded', label: 'Recorded by the office (two ticks)', model: scan({ last: { text: `${HIDE} · 50 × 1 · 52 × 2 · remnant 12.5 ft²`, ticks: 'recorded', place: 'R2', undo: { held: null } } }), note: 'The cut log entry is recorded: two ticks, where the remnant goes, Undo while it is the last cut on this tablet.' },
    { id: 'saved-offline', label: 'Saved on this tablet (offline)', model: scan({ frame: offlineFrame, last: { text: `${HIDE_2} · 56 × 3 · no remnant`, ticks: 'saved', undo: { held: 'offline' } } }), note: 'One tick: saved here, sent when the network is back. Undo needs the network.' },
    { id: 'refused', label: 'The office refused the last cut', model: scan({ last: { text: `${HIDE_2} · 52 × 1 · not done`, ticks: 'refused', refused: 'Nothing is left of this hide for this work order.', undo: null } }) },
    { id: 'from-tablet', label: 'From this tablet (as of)', model: check({ frame: offlineFrame, asOf: '2026-10-29T08:35:00.000Z' }), note: 'Offline: the hide and the work order the tablet read this visit, with their time. The cut queues.' },
    { id: 'lot-on-hold', label: 'Lot on hold (Cr VI pending)', model: { frame, stage: 'scan', workOrder: chip, refusal: { kind: 'lot', code: HIDE, reason: 'CR_VI_PENDING', lotCode: 'LOT-DEMO-0008', words: null, place: 'Q1' } }, note: '"This hide\'s lot is on quality hold (Cr VI test pending). Do not cut. Put it back on Q1."' },
    { id: 'used-up', label: 'Hide used up', model: { frame, stage: 'scan', workOrder: chip, refusal: { kind: 'usedUp', code: HIDE, state: 'CONSUMED', lastCut: { at: '2026-10-12T14:20:00.000Z' } } } },
    { id: 'not-for-work-order', label: 'Not this work order\'s leather', model: { frame, stage: 'scan', workOrder: chip, refusal: { kind: 'noWorkOrder', code: HIDE, number: 'WO-DEMO-0042' } } },
    { id: 'work-order-closed', label: 'Work order not open', model: { frame, stage: 'workOrder', refusal: { kind: 'workOrder', code: 'WO-DEMO-0040', number: 'WO-DEMO-0040', refusal: { code: 'WORK_ORDER_NOT_OPEN', message: 'Work order WO-DEMO-0040 is ON_HOLD.' } } } },
    { id: 'change-confirm', label: 'Change the work order with sets not saved', model: { ...drafted, confirm: { sets: 3 } }, note: 'Design hidecut.change-wo: "3 sets on this hide are not saved. Save them as cut first?" Save and change / Back.' },
    { id: 'not-on-tablet', label: 'Offline: a hide not on this tablet', model: { frame: offlineFrame, stage: 'scan', workOrder: chip, refusal: { kind: 'notOnTablet', code: HIDE_2 } } },
    { id: 'error', label: 'The office does not answer', model: { frame, stage: 'scan', workOrder: chip, refusal: { kind: 'problem', problem: { kind: 'unavailable' }, code: HIDE } } },
    { id: 'not-found', label: 'Not a hide of this site', model: { frame, stage: 'scan', workOrder: chip, refusal: { kind: 'problem', problem: { kind: 'notFound' }, code: 'HD-XX-1' } } },
    { id: 'no-permission', label: 'No permission to cut', model: { frame, stage: 'workOrder', noPermission: true }, note: 'Fail closed: without production.cut nothing is asked.' },
    ...W2B_CASES,
  ],
})
