import { at, COLOURS, ITEMS, LOTS, SITE, uid, WORK_ORDERS } from '../../../../_shared/stock/fixtures'
import type { AskAnswer, BomLineChoice, SubstituteChoice, SubstituteOptions, Substitution } from '../api'
import { blankAsk, subCan } from '../model'
import type { SubstituteDialogModel } from '../use-substitute'
import type { SubstitutesModel } from '../view/SubstitutesSection'

/**
 * B-W2b-320 — made-up substitutes (design-only): WO-D-0031's protector line short, with an alternate protector that needs
 * the production manager's yes and is covered by its certificate, a lining alternate allowed only while short (refused:
 * not short), another lot of the own protector (one lot without its chromium VI test, one in quarantine); one substitute
 * waiting, one approved; the substitutes of the site. Nothing here is real business data.
 */

export const SUB_CAN = subCan(['inventory.issue', 'inventory.stock.view'])
export const SUB_CAN_NONE = subCan(['inventory.stock.view'])

const protector = { ...ITEMS.protector, kind: 'PROTECTOR', isPpeComponent: true }
const altProtector = { id: uid('7171', 13), code: 'DEMO-PRT-13', name: 'Protezione spalla livello 2 (alternativa)', baseUom: 'PCS', tracking: 'LOT', kind: 'PROTECTOR', isPpeComponent: true }
const altLining = { id: uid('7171', 12), code: 'DEMO-FOD-12', name: 'Fodera rete alternativa', baseUom: 'M', tracking: 'LOT', kind: 'LINING', isPpeComponent: false }

export function substitution(n: number, over: Partial<Substitution> = {}): Substitution {
  return {
    id: uid('7676', n),
    siteId: SITE.id,
    workOrder: { id: WORK_ORDERS.a.id, number: WORK_ORDERS.a.number, status: 'IN_PROGRESS' },
    line: { id: uid('7777', 30), seq: 30, placement: 'Spalle', material: { id: protector.id, code: protector.code, name: protector.name, baseUom: 'PCS' } },
    kind: 'ALTERNATE',
    substitute: { item: altProtector, colour: null, lot: { id: uid('8181', 31), code: 'LOT-D-000131', qualityStatus: 'RELEASED' }, alternate: { id: uid('7878', 1), priority: 1, allowedWhen: 'WITH_APPROVAL' } },
    quantity: '4.0000',
    uom: 'PCS',
    replaces: { quantity: '4.0000', uom: 'PCS' },
    reasonCode: null,
    status: 'WAITING',
    approval: { taskId: uid('7979', 1), status: 'PENDING', dueAt: at(31, 12) },
    asked: 'OFFICE',
    decidedAt: null,
    issuedAt: null,
    withdrawnAt: null,
    version: 1,
    createdAt: at(30, 8, 40),
    ...over,
  }
}

export const SUBSTITUTIONS: Substitution[] = [
  substitution(1),
  substitution(2, { workOrder: { id: WORK_ORDERS.b.id, number: WORK_ORDERS.b.number, status: 'RELEASED' }, line: { id: uid('7777', 20), seq: 20, placement: 'Fodera corpo', material: { id: ITEMS.lining.id, code: ITEMS.lining.code, name: ITEMS.lining.name, baseUom: 'M' } }, substitute: { item: altLining, colour: COLOURS.black, lot: null, alternate: { id: uid('7878', 2), priority: 1, allowedWhen: 'WHEN_SHORT' } }, quantity: '6.5000', uom: 'M', replaces: { quantity: '6.5000', uom: 'M' }, status: 'APPROVED', approval: null, asked: 'FLOOR', decidedAt: at(29, 15) }),
]

const usableLot = (n: number, code: string, onHand: string, places: string[]) => ({ lot: { id: uid('8181', n), code, qualityStatus: 'RELEASED', crViStatus: 'NOT_REQUIRED', requiresCrViTest: false }, colour: null, onHand, hides: 0, places, usable: true })

const ALTERNATE: SubstituteChoice = {
  kind: 'ALTERNATE',
  alternate: { id: uid('7878', 1), priority: 1, allowedWhen: 'WITH_APPROVAL', certificateCheck: true, qty: null, note: null, colourId: null },
  item: altProtector,
  answer: { may: false, held: ['NEEDS_APPROVAL'] },
  needsPerson: true,
  refusal: null,
  certificateRequired: true,
  certificate: { id: uid('8080', 2), number: 'CERT-D-0002', standard: 'EN 1621-1', validTo: '2027-06-30' },
  max: '10.0000',
  stock: { onHand: '24.0000', lots: [usableLot(31, 'LOT-D-000131', '24.0000', ['N-MAG-A-01'])] },
  approval: { asks: true, active: 1, rule: { id: uid('8181', 90), name: 'Sostituti DPI → responsabile produzione', signatureMeaning: null, requireStepUp: false, dueHours: 24 }, approver: { kind: 'ROLE', id: uid('8282', 90), name: 'Responsabile produzione' }, namedSelf: false },
  mayAsk: true,
  held: null,
}

const OUTSIDE: SubstituteChoice = {
  ...ALTERNATE,
  alternate: { id: uid('7878', 3), priority: 2, allowedWhen: 'ALWAYS', certificateCheck: true, qty: null, note: null, colourId: null },
  item: { ...altProtector, id: uid('7171', 14), code: 'DEMO-PRT-14', name: 'Protezione spalla livello 1' },
  answer: { may: false, held: ['NEEDS_CERTIFICATE_CHECK'] },
  needsPerson: false,
  refusal: { code: 'OUTSIDE_CERTIFICATE' },
  certificate: null,
  approval: { asks: false, active: 1, rule: null, approver: null, namedSelf: false },
  mayAsk: false,
  held: 'refused',
}

const OWN: SubstituteChoice = {
  kind: 'OWN_MATERIAL',
  alternate: null,
  item: protector,
  answer: { may: false, held: ['NEEDS_APPROVAL'] },
  needsPerson: true,
  refusal: null,
  certificateRequired: false,
  certificate: null,
  max: '10.0000',
  stock: {
    onHand: '6.0000',
    lots: [
      usableLot(5, LOTS.protector.code, '6.0000', ['N-MAG-A-02']),
      { lot: { id: uid('8181', 35), code: 'LOT-D-000135', qualityStatus: 'QUARANTINE', crViStatus: 'NOT_REQUIRED', requiresCrViTest: false }, colour: null, onHand: '12.0000', hides: 0, places: ['N-QUA'], usable: false },
    ],
  },
  approval: ALTERNATE.approval,
  mayAsk: true,
  held: null,
}

export const OPTIONS: SubstituteOptions = {
  asOf: at(30, 9, 42),
  workOrder: { id: WORK_ORDERS.a.id, number: WORK_ORDERS.a.number, status: 'IN_PROGRESS', siteId: SITE.id, companyId: SITE.companyId },
  line: { id: uid('7777', 30), seq: 30, placement: 'Spalle', material: protector, qty: '2.0000', uom: 'PCS', planned: '24.0000', issued: '10.0000', toIssue: '14.0000', short: '8.0000', ownShort: true, standing: '4.0000', open: '10.0000' },
  substitutions: [SUBSTITUTIONS[0]!],
  choices: [ALTERNATE, OUTSIDE, OWN],
}

/** Nobody could decide it: the rule names the person asking. */
export const NAMED_SELF: SubstituteOptions = { ...OPTIONS, choices: [{ ...ALTERNATE, approval: { asks: false, active: 1, rule: null, approver: null, namedSelf: true }, mayAsk: false, held: 'refused' }, OWN] }

export const BOM_LINES: BomLineChoice[] = [
  { bomLineId: uid('7777', 30), seq: 30, placement: 'Spalle', itemId: protector.id, itemCode: protector.code, itemName: protector.name, itemColourId: null, colourCode: null, baseUom: 'PCS', planned: 24, toIssue: 14 },
  { bomLineId: uid('7777', 31), seq: 31, placement: 'Gomiti', itemId: protector.id, itemCode: protector.code, itemName: protector.name, itemColourId: null, colourCode: null, baseUom: 'PCS', planned: 24, toIssue: 6 },
]

export const ASKED: AskAnswer = { substitution: substitution(3), approval: { asked: true, taskId: uid('7979', 3), approverRoleId: uid('8282', 90), approverUserId: null, dueAt: at(31, 12) }, approvedAtOnce: false }

export function dialogModel(over: Partial<SubstituteDialogModel> = {}): SubstituteDialogModel {
  return { target: { workOrderId: WORK_ORDERS.a.id, number: WORK_ORDERS.a.number }, lines: null, bomLineId: OPTIONS.line.id, options: { value: OPTIONS, problem: null }, draft: blankAsk(OPTIONS), busy: false, problem: null, done: null, withdraw: null, ...over }
}

export function substitutesModel(over: Partial<SubstitutesModel> = {}): SubstitutesModel {
  return { status: 'OPEN', rows: SUBSTITUTIONS, problem: null, more: false, withdraw: null, ...over }
}
