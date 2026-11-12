import type { DesignCase } from '../../../../lib/design/design-screen'
import type { StartDraft } from '../model'
import type { ReturnsListViewModel } from '../view/ReturnsListView'
import type { ReturnsCaseBuilder } from '../view/ReturnsCase'
import type { StartDialogModel } from '../view/StartDialog'
import type { RepairItem, RepairsRead } from './api'
import { OTHER_GARMENT } from './model'

/**
 * SCR-187's cases of B-W2b-342 (made-up data only): "Start a return or claim" with the third card, Repair or alteration
 * (the garment from what we delivered or by its serial, a repair or an alteration, what is wrong, the work wanted, check and
 * send, sent), and the page's "Your repairs" section (rows, a failed read, loading). B-W2b-197's fixtures spread them in.
 */

const id = (n: number) => `0190f0e2-1970-7000-8000-${String(n).padStart(12, '0')}`
const AT = '2026-11-10T09:30:00.000Z'

const row = (n: number, over: Partial<RepairItem>): RepairItem => ({
  id: id(3400 + n),
  number: `REP-2026-00${40 + n}`,
  kind: 'REPAIR',
  stage: 'AWAITING_GOODS',
  channel: 'PORTAL',
  opened: AT,
  open: true,
  next: { code: 'SEND_GARMENT', forYou: true },
  garment: { style: { code: 'JKT-DEMO-01', name: 'Giacca Demo Touring' }, colourway: { code: 'NER', name: 'Nero' }, size: '52', serial: 'SN-DEMO-000123' },
  estimate: null,
  ...over,
})

export function repairsRead(items?: RepairItem[]): RepairsRead {
  return {
    items: items ?? [
      row(1, {}),
      row(2, { stage: 'ESTIMATED', next: { code: 'ANSWER_ESTIMATE', forYou: true }, estimate: { revision: 1, status: 'SENT' }, channel: 'LINK' }),
      row(3, { kind: 'ALTERATION', stage: 'IN_REPAIR', next: { code: 'WE_REPAIR', forYou: false }, estimate: { revision: 1, status: 'ACCEPTED' }, garment: { style: { code: 'PNT-DEMO-02', name: 'Pantalone Demo Touring' }, colourway: null, size: '50', serial: null } }),
      row(4, { stage: 'SHIPPED', open: false, next: { code: 'DONE', forYou: false } }),
    ],
    mayRequest: true,
    seesPrices: true,
    asOf: AT,
  }
}

export interface RepairCaseMakers {
  listCase: (build?: (locale: 'it' | 'en') => Partial<ReturnsListViewModel>) => ReturnsCaseBuilder
  startCase: (draft: Partial<StartDraft>, over?: Partial<StartDialogModel>) => ReturnsCaseBuilder
  prefix: string
}

const repairDraft: Partial<StartDraft> = {
  step: 'details',
  type: 'REPAIR',
  repairKind: 'REPAIR',
  repairItem: 'line-1|52',
  repairSerial: 'SN-DEMO-000123',
  problem: 'Dopo una scivolata la cucitura della spalla sinistra si è aperta e la protezione si sposta.',
  workWanted: 'Ricucire la spalla e controllare la protezione.',
}
const alterationDraft: Partial<StartDraft> = { step: 'details', type: 'REPAIR', repairKind: 'ALTERATION', repairItem: OTHER_GARMENT, repairSerial: 'SN-DEMO-000456', problem: '', workWanted: 'Allungare le maniche di 2 cm.' }

export function repairListCases(make: RepairCaseMakers): DesignCase<ReturnsCaseBuilder>[] {
  return [
    { id: 'w2b-342-repairs', label: 'B-W2b-342 · Your repairs (under the cases)', model: make.listCase(() => ({ repairs: { state: 'ready', read: repairsRead() } })), note: 'The customer’s repair and alteration requests, newest first: number, where it stands, the next step (“Your move:” when it is theirs), the garment, the day it was asked; a row opens the repair (SCR-358).' },
    { id: 'w2b-342-repairs-loading', label: 'B-W2b-342 · Your repairs · loading', model: make.listCase(() => ({ repairs: { state: 'loading', read: null } })) },
    { id: 'w2b-342-repairs-failed', label: 'B-W2b-342 · Your repairs · not read', model: make.listCase(() => ({ repairs: { state: 'error', read: null } })), note: 'A failed read says so with Try again (never drawn as none).' },
    { id: 'w2b-342-start-type', label: 'B-W2b-342 · Start › the third card: Repair or alteration', model: make.startCase({ type: 'REPAIR' }), note: 'Return items · Report a quality problem · Repair or alteration (RR1:02).' },
    { id: 'w2b-342-start-repair', label: 'B-W2b-342 · Start › a repair’s details', model: make.startCase(repairDraft), note: 'The garment from what we delivered (or another one by its serial), a repair or an alteration, what is wrong (needed for a repair), the work wanted; no payment data: an estimate comes first.' },
    { id: 'w2b-342-start-alteration', label: 'B-W2b-342 · Start › an alteration of another garment', model: make.startCase(alterationDraft), note: 'Another garment needs its serial; an alteration needs the work wanted.' },
    { id: 'w2b-342-start-problems', label: 'B-W2b-342 · Start › a repair with problems', model: make.startCase({ step: 'details', type: 'REPAIR', repairKind: 'REPAIR', repairItem: OTHER_GARMENT, tried: true }), note: 'Next with problems: each at its field (the serial of another garment, what is wrong).' },
    { id: 'w2b-342-start-review', label: 'B-W2b-342 · Start › check and send (a repair)', model: make.startCase({ ...repairDraft, step: 'review' }), note: 'One screen; at least two photos of the damage are added on the repair’s page once it is sent.' },
    { id: 'w2b-342-start-refused', label: 'B-W2b-342 · Start › refused (the garment is with us already)', model: make.startCase({ ...repairDraft, step: 'review' }, { problem: 'returns-repair:refusal.open' }) },
    { id: 'w2b-342-start-sent', label: 'B-W2b-342 · Start › sent (a repair)', model: make.startCase({ ...repairDraft, step: 'review' }, { sent: { type: 'REPAIR', number: 'REP-2026-0045', answerBy: '2026-11-14', href: `${make.prefix}/returns/repairs/x?tab=request` } }), note: 'The number (copy), when we answer, add photos of the damage, send the garment with a DDT, Open the repair.' },
  ]
}
