import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { COLOURS, inShell, MATERIALS, PREFIX, ROLES, SITE, TIME_ZONE, uid, type Role } from '../../../../_shared/buying/fixtures'
import { phrase } from '../../../../_shared/buying/model'
import { asked, OPTIONS } from '../fixtures'
import { askCan, shortageDraft, type AskModel, type ShortageLine } from '../model'
import { AskDialog } from '../view/AskDialog'

/**
 * SCR-357 — Buy from a shortage (B-W2b-332; SCM-037; planning.mrp "Short on open work orders": the line becomes a request to
 * the buyers, or a buyer drafts its purchase order line in one step), made-up data only. The dialog in its shortage mode:
 * the work order, the material, what is short and by when are the list's (the server reads them again); a buyer picks
 * "Draft the purchase order now" or "Send to the buyers"; a planner or a production manager sends it to the buyers. Every
 * state: ready (both choices), delayed rather than short, held (say why; drafting without the right), sending, refused
 * (no longer short, asked already), drafted into a new draft or an open one, sent, sent waiting for a yes, offline,
 * reading.
 */

const TODAY = '2026-11-12'
const LINE: ShortageLine = {
  siteId: SITE.id,
  workOrder: { id: uid('5151', 1), number: 'WO-2026-0042' },
  material: { itemId: MATERIALS.leather.id, itemColourId: COLOURS.black.id, label: `${MATERIALS.leather.code} · ${COLOURS.black.name}`, uom: 'FT2' },
  word: 'NOT_ENOUGH',
  short: '18.0000',
  neededBy: '2026-11-18',
}
const REASON = 'Mancanza per WO-2026-0042: DEMO-LEA-01 · Nero'

const PEOPLE: Record<string, { role: Role; permissions: readonly string[] }> = {
  buyer: { role: 'buyer', permissions: [...ROLES.buyer, 'purchasing.requests.ask'] },
  planner: { role: 'planner', permissions: [...ROLES.planner, 'purchasing.requests.ask'] },
  productionManager: { role: 'planner', permissions: ['home.view', 'planning.view', 'workorders.view', 'purchasing.requests.ask'] },
}
type Person = keyof typeof PEOPLE
interface Case {
  person: Person
  model: AskModel
}

function make(person: Person, over: Partial<AskModel> = {}, line: ShortageLine = LINE): Case {
  const can = askCan(PEOPLE[person]!.permissions)
  return { person, model: { prefix: PREFIX, can, draft: shortageDraft(line, TODAY, REASON, can.draft), shortage: line, options: { status: 'ready', value: OPTIONS }, busy: false, offline: false, problem: null, done: null, timeZone: TIME_ZONE, ...over } }
}

const SHORT_REQUEST = asked(7, { source: 'SHORTAGE', workOrder: LINE.workOrder, shortage: { word: 'NOT_ENOUGH', short: '18.0000', uom: 'FT2', needDate: LINE.neededBy, runId: null, workOrderNumber: LINE.workOrder.number }, quantity: '18.0000', needDate: LINE.neededBy, reason: REASON })

function ShortageDesign({ model }: { model: Case }) {
  return inShell('/planning/mrp', createElement(AskDialog, { model: model.model }), PEOPLE[model.person]!.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-357',
  title: 'Buy from a shortage (a line of Short on open work orders asked, or drafted in one step)',
  view: ShortageDesign,
  cases: [
    { id: 'buyer-draft', label: 'Buyer: draft the purchase order now (default)', model: make('buyer'), note: 'One step: the request is written and drafted into the supplier’s open draft (or a new one). Nothing is sent to the supplier.' },
    { id: 'buyer-request', label: 'Buyer: send it to the buyers instead', model: make('buyer', { draft: { ...make('buyer').model.draft, then: 'REQUEST' } }) },
    { id: 'planner', label: 'Planner: sends it to the buyers (no draft right)', model: make('planner'), note: 'No RadioCard: drafting is purchasing.manage. An approval rule may ask a yes first.' },
    { id: 'production-manager', label: 'Production manager: sends it to the buyers', model: make('productionManager') },
    { id: 'delayed', label: 'On order, but too late', model: make('planner', {}, { ...LINE, word: 'DELAYED', short: '6.0000' }) },
    { id: 'held-reason', label: 'Held: say why', model: make('planner', { draft: { ...make('planner').model.draft, reason: '' } }) },
    { id: 'held-no-draft', label: 'Held: drafting needs purchasing.manage', model: make('planner', { draft: { ...make('planner').model.draft, then: 'DRAFT' } }) },
    { id: 'sending', label: 'Drafting', model: make('buyer', { busy: true }) },
    { id: 'refused-gone', label: 'Refused: not short any more', model: make('buyer', { problem: phrase('refused.shortageGone') }) },
    { id: 'refused-asked', label: 'Refused: asked already', model: make('planner', { problem: phrase('refused.shortageAsked') }) },
    { id: 'drafted-new', label: 'Drafted: a new draft PO', model: make('buyer', { done: { kind: 'drafted', request: { ...SHORT_REQUEST, status: 'CONVERTED' }, order: { id: uid('9494', 2), number: 'PO-2026-0032', created: true } } }) },
    { id: 'drafted-added', label: 'Drafted: added to the open draft', model: make('buyer', { done: { kind: 'drafted', request: { ...SHORT_REQUEST, status: 'CONVERTED' }, order: { id: uid('9494', 1), number: 'PO-2026-0031', created: false } } }) },
    { id: 'sent', label: 'Sent to the buyers', model: make('planner', { done: { kind: 'sent', request: SHORT_REQUEST } }) },
    { id: 'sent-waiting', label: 'Sent: it waits for a yes first', model: make('productionManager', { done: { kind: 'waiting', request: { ...SHORT_REQUEST, status: 'PENDING_APPROVAL' } } }) },
    { id: 'offline', label: 'Offline: held', model: make('buyer', { offline: true }) },
    { id: 'loading', label: 'Reading', model: make('planner', { options: { status: 'loading' } }) },
  ],
})
