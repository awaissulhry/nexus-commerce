import type { MentionPerson } from '../../../../lib/record-thread/helpers/model'
import type { NoteCheck } from './api'
import { bodyOf, draftKeyOf, NEW_DRAFT, type NoteDialogModel, type NoteDraft, type NoteRecord, type NoteResult, type NoteTargets } from './model'

/**
 * F-PR-22 — made-up note dialogs (the design index and the tests): 12 work orders of two made-up customers (Brand Alpha 8, Brand
 * Beta 4) with their 9 sales orders, the @ list with the supervisor tagged first, the check's answers (a person who cannot read 2 of
 * the 12, two customers, the other-customer hold) and a result with a refused row and two records counted, never named.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const ALPHA = { id: uid('6a6a', 1), name: 'Brand Alpha' }
const BETA = { id: uid('6a6a', 2), name: 'Brand Beta' }
const COMPANY = uid('1010', 1)

const workOrder = (n: number, customer: typeof ALPHA): NoteRecord => ({ type: 'WorkOrder', id: uid('9a9a', n), label: `WO-${String(300 + n).padStart(4, '0')}`, partyId: customer.id, partyName: customer.name, companyId: COMPANY })
const salesOrder = (n: number, customer: typeof ALPHA): NoteRecord => ({ type: 'SalesOrder', id: uid('5a5a', n), label: `SO-DEMO-${String(140 + n).padStart(4, '0')}`, partyId: customer.id, partyName: customer.name, companyId: COMPANY })

export const NOTE_TARGETS: NoteTargets = {
  workOrders: [...Array.from({ length: 8 }, (_, index) => workOrder(index + 1, ALPHA)), ...Array.from({ length: 4 }, (_, index) => workOrder(index + 9, BETA))],
  salesOrders: [...Array.from({ length: 6 }, (_, index) => salesOrder(index + 1, ALPHA)), ...Array.from({ length: 3 }, (_, index) => salesOrder(index + 7, BETA))],
  withoutOrder: 0,
}

export const NOTE_PEOPLE: MentionPerson[] = [
  { id: uid('7a7a', 1), name: 'Bea Esempio', tag: 'Supervisor' },
  { id: uid('7a7a', 2), name: 'Alex Demo' },
  { id: uid('7a7a', 3), name: 'Dora Campione' },
]
const DORA = NOTE_PEOPLE[2]!

const TEXT = 'Hides for lot 44 arrive Thursday. @Dora Campione please check the cut plan.'

const view = (record: NoteRecord) => ({ type: record.type, id: record.id, label: record.label })

/** The check of the 12 work orders: Dora cannot read two of them (Brand Beta's), two customers, two without a supervisor yet. */
export const NOTE_CHECK: NoteCheck = {
  records: NOTE_TARGETS.workOrders.map((record, index) => ({ ...view(record), customer: { id: record.partyId!, name: record.partyName! }, canWrite: true, why: null, supervisor: index < 10 ? ('SOMEONE_ELSE' as const) : ('NOT_SET' as const) })),
  unknown: 0,
  customers: 2,
  people: [{ userId: DORA.id, name: DORA.name, cannotRead: [view(NOTE_TARGETS.workOrders[8]!), view(NOTE_TARGETS.workOrders[9]!)] }],
  noSupervisor: [view(NOTE_TARGETS.workOrders[10]!), view(NOTE_TARGETS.workOrders[11]!)],
  noIssue: [],
  namesOtherCustomer: [],
  held: false,
}

/** The same with a text naming Brand Beta on Brand Alpha's work orders: Send held until the text changes or the tick. */
export const NOTE_CHECK_HOLD: NoteCheck = {
  ...NOTE_CHECK,
  namesOtherCustomer: NOTE_TARGETS.workOrders.slice(0, 2).map((record) => ({ ...view(record), names: [BETA.name] })),
  held: true,
}

export const NOTE_RESULT: NoteResult = {
  lines: [
    ...NOTE_TARGETS.workOrders.slice(0, 9).map((record, index) => ({ key: `WorkOrder:${record.id}`, label: record.label, state: 'written' as const, mentioned: index === 8 ? 1 : 2, supervisorAsked: true, issue: false })),
    { key: `WorkOrder:${NOTE_TARGETS.workOrders[9]!.id}`, label: NOTE_TARGETS.workOrders[9]!.label, state: 'skipped', why: 'skip.THREAD_CLOSED' },
  ],
  written: 9,
  unknown: 2,
  notMentioned: [{ key: 'result.notMentioned', params: { name: DORA.name, records: `${NOTE_TARGETS.workOrders[8]!.label}, ${NOTE_TARGETS.workOrders[9]!.label}` } }],
  tasks: [],
  notRaised: [],
}

/** A note dialog over the 12 work orders (from a selection), with the check of its draft. */
export function noteModel(over: Omit<Partial<NoteDialogModel>, 'draft'> & { readonly draft?: Partial<NoteDraft>; readonly answer?: NoteCheck | null } = {}): NoteDialogModel {
  const { draft: draftOver, answer = NOTE_CHECK, ...rest } = over
  const targets = rest.targets ?? NOTE_TARGETS
  const draft: NoteDraft = { ...NEW_DRAFT, body: TEXT, ...draftOver }
  const key = draftKeyOf(bodyOf(targets, draft, NOTE_PEOPLE))
  return {
    from: 'selection',
    targets,
    draft,
    people: { status: 'ready', people: NOTE_PEOPLE, complete: true },
    check: answer ? { status: 'ready', key, answer } : { status: 'checking', key },
    offline: false,
    busy: false,
    can: true,
    problem: null,
    result: null,
    ...rest,
  }
}
