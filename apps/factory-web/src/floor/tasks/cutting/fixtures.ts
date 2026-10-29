import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import type { CutWorkOrderRow, RemnantPlace } from './api'
import { areaUsed, sizeStates, type CutCell } from './model'
import { CutView, type CutViewModel, type HideCardModel } from './view/CutView'

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
  ],
})
