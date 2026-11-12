import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { onFloor } from '../../../frame/fixtures'
import { AS_OF, frame, LIST, PICKED, WALK } from '../picklist/fixtures'
import type { Walk } from '../picklist/model'
import { PickView, type PickViewModel } from '../view/PickView'
import { kitOf, type KitLast } from './model'
import type { KitStepModel } from './view/KitStep'

/**
 * SCR-385 — Kit staging on Pick & issue (B-W2b-310, follow-up FT2:01; design floor.pick sec:kit "Kit location per work order and a
 * 'kit complete' check (SCM-213)": "Location, the list with ticks, 'Kit complete' (main)"; new review id for SCR-093's W2b part): a
 * warehouse tablet of a made-up "Demo" plant. The kit card (where it waits, lines picked, when it was checked — never who), the scan
 * of a place's label that stages it, the lines with their ticks, "Kit complete" held while lines are short, allowed once every line
 * is picked, checked; refusals in words; offline (held, as of); a kit with no place yet. Made-up places; no money, no person.
 */

const kit = (walk: Walk = WALK, list = LIST, extra: Partial<KitStepModel> = {}): KitStepModel => ({ kit: kitOf(walk, list), busy: false, last: null, asOf: null, ...extra })
const base = (model: KitStepModel, extra: Partial<PickViewModel> = {}): PickViewModel => ({ frame: frame(), online: true, stage: 'kit', list: LIST, walk: { walk: WALK, taken: new Set() }, kit: model, ...extra })
const checked: Walk = { ...WALK, kit: { ...WALK.kit, checkedAt: '2026-11-12T09:40:00.000Z', version: 3 } }
const unplaced: Walk = { ...WALK, kit: { location: null, checkedAt: null, version: 0 } }
const staged: KitLast = { kind: 'staged', place: 'A1-CUT' }

export const designScreen = defineDesignScreen<PickViewModel>({
  screen: 'SCR-385',
  title: 'Floor Kit staging',
  view: onFloor(PickView),
  cases: [
    { id: 'kit-short', label: 'Kit: lines still short', model: base(kit()), note: '"Kit complete" is held and says why (3 lines short); the scan of a place\'s label moves the kit there.' },
    { id: 'kit-unplaced', label: 'Kit with no place yet', model: base(kit(unplaced)), note: 'The first scan of a place\'s label stages it (the office\'s Picking & kits shows the same place).' },
    { id: 'kit-staged', label: 'The kit staged at a place', model: base(kit(WALK, LIST, { last: staged })) },
    { id: 'kit-ready', label: 'Every line picked: Kit complete', model: base(kit(WALK, PICKED), { list: PICKED }), note: 'One tap: the check is recorded with when (the record keeps who; the screen never names them).' },
    { id: 'kit-checked', label: 'Checked complete', model: base(kit(checked, PICKED, { last: { kind: 'checked' } }), { list: PICKED }), note: 'Held "checked complete already": the office opens it again if something is missing.' },
    { id: 'kit-busy', label: 'Sending', model: base(kit(WALK, PICKED, { busy: true }), { list: PICKED }) },
    { id: 'kit-refused-place', label: 'Refused: a kit does not wait there', model: base(kit(), { problem: { problem: { kind: 'refused', code: 'NOT_A_KIT_PLACE', message: '', fix: null }, code: 'BIN-TERZ-DEMO' } }) },
    { id: 'kit-refused-label', label: 'Refused: no place carries the label', model: base(kit(), { problem: { problem: { kind: 'refused', code: 'NOT_A_PLACE', message: '', fix: null }, code: 'BIN-XYZ' } }) },
    { id: 'kit-refused-short', label: 'Refused by the office: lines short', model: base(kit(), { problem: { problem: { kind: 'refused', code: 'LINES_SHORT', message: '', fix: null }, code: 'WO-DEMO-0042' } }), note: 'Another tablet gave a line back meanwhile: the office\'s check keeps the last word.' },
    { id: 'kit-offline', label: 'Offline: the kit waits for the network', model: base(kit(WALK, PICKED, { asOf: AS_OF }), { frame: frame({ online: false }), online: false, list: PICKED }) },
    { id: 'kit-notice', label: 'Scans held by the worker notice', model: base(kit(), { held: true }) },
    { id: 'list-kit-button', label: 'The pick list with its Kit button', model: { frame: frame(), online: true, stage: 'list', list: LIST, walk: { walk: WALK, taken: new Set() } }, note: 'Kit sits between Return unused and Done on the pick list.' },
  ],
})
