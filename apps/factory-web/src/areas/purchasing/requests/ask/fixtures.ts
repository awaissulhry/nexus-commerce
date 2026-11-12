import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { at, COLOURS, inShell, MATERIALS, PREFIX, ROLES, SITE, SITE_SOUTH, TIME_ZONE, uid, type Role } from '../../../_shared/buying/fixtures'
import { phrase } from '../../../_shared/buying/model'
import type { AskedRequest, AskOptions } from './api'
import { askCan, newDraft, withMaterial, type AskModel, type MineModel } from './model'
import { AskDialog } from './view/AskDialog'
import { MyRequests } from './view/MyRequests'

/**
 * SCR-356 — Ask to buy (B-W2b-332; design purchasing.requests pop:ask "Material, quantity, date, reason, work order — Send
 * request"; page.h#1 the band's secondary "Ask to buy"), made-up data only (the invented company of
 * areas/_shared/buying/fixtures): the dialog empty, filled, each held reason, loading, failed, sending, refused, sent (it
 * waits for the buyers) and sent waiting for a yes, offline, no right; and for a person who asks but does not buy (no
 * purchasing.view) the page of their own requests: every state of a request, selection with "Take back n", the take-back
 * dialog, empty, failed, loading, no access. Roles: Buyer, Production manager, HR (asks, sees only their own), Read-only.
 */

const TODAY = '2026-11-12'
const ME = { id: uid('9191', 1), name: 'Giulia Esempio' }

/** The real templates' permissions for the roles this screen shows (the shared buying roles plus who asks). */
const ASKERS: Record<string, readonly string[]> = {
  buyer: [...ROLES.buyer, 'purchasing.requests.ask'],
  productionManager: ['home.view', 'planning.view', 'workorders.view', 'product.materials.view', 'purchasing.requests.ask'],
  hr: ['home.view', 'people.view', 'purchasing.requests.ask'],
  readOnly: [...ROLES.readOnly],
}
type Asker = keyof typeof ASKERS
const shellRole = (asker: Asker): Role => (asker === 'buyer' ? 'buyer' : asker === 'readOnly' ? 'readOnly' : 'planner')

const material = (key: keyof typeof MATERIALS, colours: { id: string; code: string; name: string }[] = [], units?: AskOptions['materials'][number]['units']) => ({
  ...MATERIALS[key],
  units: units ?? [MATERIALS[key].baseUom],
  colours,
})

export const OPTIONS: AskOptions = {
  sites: [
    { id: SITE.id, companyId: SITE.companyId, code: SITE.code, name: SITE.name },
    { id: SITE_SOUTH.id, companyId: SITE_SOUTH.companyId, code: SITE_SOUTH.code, name: SITE_SOUTH.name },
  ],
  siteId: SITE.id,
  today: TODAY,
  materials: [material('leather', [COLOURS.black, COLOURS.red], ['FT2', 'M2', 'HIDE']), material('lining', [COLOURS.grey], ['M']), material('protector'), material('zip', [COLOURS.black])],
  workOrders: [
    { id: uid('5151', 1), number: 'WO-2026-0042', style: 'GIACCA-PISTA', dueDate: '2026-11-27' },
    { id: uid('5151', 2), number: 'WO-2026-0041', style: 'TUTA-INTERA', dueDate: '2026-12-04' },
  ],
  more: false,
}
const ONE_SITE: AskOptions = { ...OPTIONS, sites: OPTIONS.sites.slice(0, 1) }

type Case = { kind: 'dialog'; role: Asker; model: AskModel } | { kind: 'mine'; role: Asker; model: MineModel }

const leatherDraft = () => ({ ...withMaterial(newDraft(TODAY, SITE.id), OPTIONS.materials[0]!), itemColourId: COLOURS.black.id, quantity: '40', needDate: '2026-11-20', reason: 'Campionatura per la nuova giacca: serve prima del fitting.', workOrderId: OPTIONS.workOrders[0]!.id })

function dialog(role: Asker, over: Partial<AskModel> = {}): Case {
  return {
    kind: 'dialog',
    role,
    model: { prefix: PREFIX, can: askCan(ASKERS[role]!), draft: newDraft(TODAY, SITE.id), shortage: null, options: { status: 'ready', value: OPTIONS }, busy: false, offline: false, problem: null, done: null, timeZone: TIME_ZONE, ...over },
  }
}

export function asked(n: number, over: Partial<AskedRequest> = {}): AskedRequest {
  return {
    id: uid('9292', n),
    companyId: SITE.companyId,
    siteId: SITE.id,
    site: { code: SITE.code, name: SITE.name },
    source: 'OFFICE',
    status: 'OPEN',
    version: 1,
    requestedBy: ME,
    requestedAt: at(11, 9, 15, 11),
    mine: true,
    item: { id: MATERIALS.leather.id, code: MATERIALS.leather.code, name: MATERIALS.leather.name, kind: 'LEATHER' },
    colour: COLOURS.black,
    description: null,
    quantity: '40.0000',
    uom: 'FT2',
    needDate: '2026-11-20',
    reason: 'Campionatura per la nuova giacca.',
    workOrder: null,
    shortage: null,
    approvalTaskId: null,
    rejected: null,
    converted: null,
    cancelled: null,
    cancel: { allowed: true, why: null },
    ...over,
  }
}

const decided = { cancel: { allowed: false, why: 'decided' } }
const MINE: AskedRequest[] = [
  asked(1),
  asked(2, { status: 'PENDING_APPROVAL', approvalTaskId: uid('9393', 1), item: { id: MATERIALS.protector.id, code: MATERIALS.protector.code, name: MATERIALS.protector.name, kind: 'PROTECTOR' }, colour: null, quantity: '24.0000', uom: 'PCS', reason: 'Scorta per le riparazioni in garanzia.' }),
  asked(3, { status: 'CONVERTED', converted: { at: at(10, 15, 0, 11), by: 'Marco Buyer', purchaseOrder: { id: uid('9494', 1), number: 'PO-2026-0031', status: 'DRAFT' } }, item: { id: MATERIALS.lining.id, code: MATERIALS.lining.code, name: MATERIALS.lining.name, kind: 'LINING' }, colour: COLOURS.grey, quantity: '12.0000', uom: 'M', ...decided }),
  asked(4, { status: 'REJECTED', rejected: { at: at(9, 11, 0, 11), by: 'Marco Buyer', reason: 'Già in magazzino: 3 rotoli nel reparto taglio.' }, item: { id: MATERIALS.zip.id, code: MATERIALS.zip.code, name: MATERIALS.zip.name, kind: 'TRIM' }, colour: COLOURS.black, quantity: '50.0000', uom: 'PCS', ...decided }),
  asked(5, { status: 'CANCELLED', cancelled: { at: at(8, 10, 0, 11), reason: 'Il cliente ha annullato la prova.' }, ...decided }),
  asked(6, { source: 'SHORTAGE', workOrder: { id: OPTIONS.workOrders[0]!.id, number: 'WO-2026-0042' }, shortage: { word: 'NOT_ENOUGH', short: '18.0000', uom: 'FT2', needDate: '2026-11-18', runId: null, workOrderNumber: 'WO-2026-0042' }, quantity: '18.0000', reason: 'Mancanza per WO-2026-0042.' }),
]

function mine(role: Asker, over: Partial<MineModel> = {}): Case {
  return { kind: 'mine', role, model: { prefix: PREFIX, can: askCan(ASKERS[role]!), rows: { items: MINE, more: false, problem: null }, offline: false, takeBack: null, timeZone: TIME_ZONE, ...over } }
}

function AskDesign({ model }: { model: Case }) {
  const page = model.kind === 'dialog' ? createElement(AskDialog, { model: model.model }) : createElement(MyRequests, { model: model.model })
  return inShell('/purchasing/requests', page, shellRole(model.role))
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-356',
  title: 'Ask to buy (the pop-up, and one’s own requests for a person who asks but does not buy)',
  view: AskDesign,
  cases: [
    // ---- the pop-up ----
    { id: 'empty', label: 'Ask to buy: empty (buyer, two sites)', model: dialog('buyer'), note: 'Send request is held with the first thing missing; Esc closes and returns the focus to the band’s button.' },
    { id: 'filled', label: 'Filled: ready to send', model: dialog('buyer', { draft: leatherDraft() }), note: 'Material, colour, 40 ft², by 20 Nov, why, for WO-2026-0042. No money anywhere.' },
    { id: 'one-site', label: 'One site: no site field (production manager)', model: dialog('productionManager', { options: { status: 'ready', value: ONE_SITE }, draft: { ...leatherDraft(), workOrderId: null } }) },
    { id: 'held-colour', label: 'Held: the colour is still to pick', model: dialog('buyer', { draft: { ...leatherDraft(), itemColourId: null } }) },
    { id: 'held-quantity', label: 'Held: how much is not a number above 0', model: dialog('buyer', { draft: { ...leatherDraft(), quantity: '0' } }) },
    { id: 'held-reason', label: 'Held: say why', model: dialog('buyer', { draft: { ...leatherDraft(), reason: '' } }) },
    { id: 'words', label: 'With words of one’s own and a note for the approver', model: dialog('hr', { options: { status: 'ready', value: ONE_SITE }, draft: { ...withMaterial(newDraft(TODAY, SITE.id), OPTIONS.materials[2]!), quantity: '6', needDate: '2026-11-19', description: 'Taglia L, per il nuovo addetto al taglio', reason: 'Dotazione per il nuovo assunto del 17 novembre.', note: 'Urgente: inizia lunedì.' } }) },
    { id: 'loading', label: 'Reading the materials', model: dialog('buyer', { options: { status: 'loading' } }) },
    { id: 'error', label: 'Couldn’t read the materials', model: dialog('buyer', { options: { status: 'error', problem: 'problem.offline' } }) },
    { id: 'sending', label: 'Sending', model: dialog('buyer', { draft: leatherDraft(), busy: true }) },
    { id: 'refused', label: 'Refused: the work order closed meanwhile', model: dialog('buyer', { draft: leatherDraft(), problem: phrase('refused.workOrderId') }) },
    { id: 'refused-approver', label: 'Refused: every rule names you as the approver', model: dialog('buyer', { draft: leatherDraft(), problem: phrase('refused.approverSelf') }) },
    { id: 'sent', label: 'Sent: it waits for the buyers', model: dialog('buyer', { draft: leatherDraft(), done: { kind: 'sent', request: asked(1, { workOrder: { id: OPTIONS.workOrders[0]!.id, number: 'WO-2026-0042' } }) } }) },
    { id: 'sent-waiting', label: 'Sent: it waits for a yes first', model: dialog('hr', { draft: leatherDraft(), done: { kind: 'waiting', request: asked(2, { status: 'PENDING_APPROVAL' }) } }), note: 'An approval rule (Admin › Automation) asked a yes; nobody approves their own request.' },
    { id: 'offline', label: 'Offline: held', model: dialog('buyer', { draft: leatherDraft(), offline: true }) },
    { id: 'no-right', label: 'Read-only: held, no right to ask', model: dialog('readOnly') },
    // ---- one's own requests (asks, does not buy) ----
    { id: 'mine', label: 'My requests (HR: asks, does not buy)', model: mine('hr'), note: 'Every state: waits for the buyers, for a yes, in PO-…, refused with the reason, taken back, from a shortage.' },
    { id: 'mine-selected', label: 'Two selected: Take back 2', model: mine('hr', { selected: [MINE[0]!.id, MINE[1]!.id] }), note: 'A decided request says why its box is off.' },
    { id: 'mine-take-back', label: 'Take back: say why', model: mine('hr', { takeBack: { ids: [MINE[0]!.id, MINE[1]!.id], reason: '', busy: false, problem: null } }) },
    { id: 'mine-take-back-ready', label: 'Take back: ready', model: mine('hr', { takeBack: { ids: [MINE[1]!.id], reason: 'Trovate in magazzino.', busy: false, problem: null } }) },
    { id: 'mine-empty', label: 'Nothing asked yet', model: mine('hr', { rows: { items: [], more: false, problem: null } }) },
    { id: 'mine-loading', label: 'Loading', model: mine('hr', { rows: { items: null, more: false, problem: null } }) },
    { id: 'mine-error', label: 'Couldn’t load', model: mine('hr', { rows: { items: null, more: false, problem: 'problem.offline' } }) },
    { id: 'mine-offline', label: 'Offline: Ask to buy held', model: mine('productionManager', { offline: true }) },
    { id: 'mine-no-access', label: 'No right to ask', model: mine('readOnly', { rows: { items: [], more: false, problem: null } }) },
  ],
})
