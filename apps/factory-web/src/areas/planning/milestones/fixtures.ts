import { createElement, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { permissionCheck } from '../../../lib/session/session'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, rolePermissions } from '../../../shell/design-data'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import type { Gate, GateAction, GateChoices, Milestone, Milestones, Order } from './api'
import { canOf, DEFAULT_CONTROLS, draftOfGate, emptyDraft, type Controls } from './model'
import type { MilestonesModel } from './view-model'
import { MilestonesView } from './view/MilestonesView'

/**
 * SCR-253 Time & action with made-up data: invented orders ("SO-DEMO-2041"), customers ("Demo Moto Srl"), styles
 * ("JKT-DEMO-07"), sample rounds ("SR-DEMO-0031"), planners ("Pia Demo", "Marco Demo"). Nothing here is a real company,
 * customer, person or number. Drawn inside the Office shell with the role's navigation; the role decides what is held.
 */

const uid = (block: string, n: number) => `0190f0e4-${block}-7000-8000-${String(n).padStart(12, '0')}`
const TODAY = '2026-11-16'
const PIA = { id: uid('1111', 1), name: 'Pia Demo' }
const MARCO = { id: uid('1111', 2), name: 'Marco Demo' }

const allowed: GateAction = { allowed: true, refusal: null, needs: null }
const refused = (code: NonNullable<GateAction['refusal']>['code']): GateAction => ({ allowed: false, refusal: { code, message: '' }, needs: null })
const needs = (permission: string): GateAction => ({ allowed: false, refusal: null, needs: permission })

function gate(n: number, order: string, over: Partial<Gate>): Gate {
  return {
    id: uid('2222', n),
    salesOrderId: order,
    kind: 'OTHER',
    label: null,
    targetDate: null,
    sampleRound: null,
    owner: PIA,
    ownerId: PIA.id,
    makerId: PIA.id,
    state: 'WAITING',
    passedOn: null,
    passedAt: null,
    passedBy: null,
    via: null,
    startedBefore: null,
    leather: null,
    holds: 2,
    version: 1,
    actions: { pass: allowed, startBefore: needs('planning.milestones.override'), edit: allowed, remove: allowed },
    ...over,
  }
}

const milestoneOf = (order: string, row: Gate, today = TODAY): Milestone => {
  const actual = row.passedOn
  const late = row.targetDate && row.state !== 'STARTED_BEFORE' ? Math.max(0, Math.round((Date.parse(actual ?? today) - Date.parse(row.targetDate)) / 86_400_000)) : 0
  return {
    id: `gate:${row.id}`,
    kind: 'GATE',
    gateId: row.id,
    gateKind: row.kind,
    label: row.label,
    salesOrderId: order,
    target: row.targetDate,
    actual,
    state: row.state === 'PASSED' ? 'DONE' : row.state,
    late: late > 0 ? late : null,
    owner: row.owner,
  }
}

const other = (order: string, kind: 'START' | 'SHIP', target: string | null, actual: string | null): Milestone => {
  const late = target ? Math.round((Date.parse(actual ?? TODAY) - Date.parse(target)) / 86_400_000) : 0
  return { id: `${kind.toLowerCase()}:${order}`, kind, gateId: null, gateKind: null, label: null, salesOrderId: order, target, actual, state: actual ? 'DONE' : 'TO_COME', late: late > 0 ? late : null, owner: null }
}

function order(n: number, over: Partial<Order> & { gates: Gate[]; start?: [string | null, string | null] | null; ship: string | null }): Order {
  const id = uid('3333', n)
  const gates = over.gates.map((entry) => ({ ...entry, salesOrderId: id }))
  const milestones = [...gates.map((entry) => milestoneOf(id, entry)), ...(over.start ? [other(id, 'START', over.start[0], over.start[1])] : []), other(id, 'SHIP', over.ship, null)].sort((a, b) => (a.target ?? '9999').localeCompare(b.target ?? '9999'))
  const next = milestones.find((row) => row.state === 'WAITING' || row.state === 'TO_COME')
  return {
    id,
    number: `SO-DEMO-20${40 + n}`,
    companyId: uid('0000', 1),
    customer: { id: uid('4444', n), code: `C-DEMO-${n}`, name: ['Demo Moto Srl', 'Pista Demo SpA', 'Strada Demo Snc', 'Racing Demo GmbH'][n % 4]! },
    status: 'CONFIRMED',
    promiseDate: over.ship,
    customerRef: n === 1 ? 'PO-DEMO-77' : null,
    workOrders: { count: over.start ? 2 : 0, notStarted: over.start?.[1] ? 1 : over.start ? 2 : 0, byKind: over.start ? [{ kind: 'SIZE_GRID' as const, count: 2, notStarted: over.start[1] ? 1 : 2 }] : [] },
    gates,
    milestones,
    waiting: gates.filter((entry) => entry.state === 'WAITING').map((entry) => entry.kind),
    late: milestones.filter((row) => row.late !== null && row.state !== 'DONE').length,
    next: next?.id ?? null,
    mayAddGate: { allowed: true, needs: null, refusal: null },
    ...Object.fromEntries(Object.entries(over).filter(([key]) => !['gates', 'start', 'ship'].includes(key))),
  }
}

const ROUND_PP = { id: uid('5555', 1), number: 'SR-DEMO-0031', kind: 'PRE_PRODUCTION', decision: null }
const ROUND_FIT = { id: uid('5555', 2), number: 'SR-DEMO-0028', kind: 'FIT', decision: 'APPROVED_WITH_COMMENTS' }

const PP_WAITING = gate(1, '', { kind: 'PP_SAMPLE', targetDate: '2026-11-20', sampleRound: ROUND_PP, actions: { pass: refused('ROUND_NOT_APPROVED'), startBefore: needs('planning.milestones.override'), edit: allowed, remove: allowed } })
const ARTWORK = gate(2, '', { kind: 'OTHER', label: 'Hang tag artwork confirmed by the brand', targetDate: '2026-11-12' })
const LEATHER_PASSED = gate(3, '', { kind: 'LEATHER_APPROVED', targetDate: '2026-11-10', state: 'PASSED', passedOn: '2026-11-09', passedAt: '2026-11-09T09:12:00.000Z', via: 'LOT', leather: 'PASSED', holds: 0, actions: { pass: refused('PASSED'), startBefore: refused('PASSED'), edit: refused('PASSED'), remove: refused('KEPT') } })
const TRIMS_STARTED = gate(4, '', {
  kind: 'TRIMS_IN',
  targetDate: '2026-11-13',
  state: 'STARTED_BEFORE',
  startedBefore: { at: '2026-11-12T15:40:00.000Z', by: MARCO, reason: 'Zips from the second supplier arrive Monday; cutting can start without them (made up).' },
  actions: { pass: allowed, startBefore: refused('STARTED_BEFORE'), edit: allowed, remove: refused('KEPT') },
})
const SAMPLE_PASSED = gate(5, '', { kind: 'SAMPLE_APPROVED', targetDate: '2026-11-06', sampleRound: ROUND_FIT, state: 'PASSED', passedOn: '2026-11-05', passedAt: '2026-11-05T10:00:00.000Z', via: 'SAMPLE', holds: 0, actions: { pass: refused('PASSED'), startBefore: refused('PASSED'), edit: refused('PASSED'), remove: refused('KEPT') } })
const LEATHER_WAITING = gate(6, '', { kind: 'LEATHER_APPROVED', targetDate: '2026-11-18', leather: 'NOT_PASSED', owner: MARCO, ownerId: MARCO.id, makerId: MARCO.id })
const LEATHER_NONE = gate(7, '', { kind: 'LEATHER_APPROVED', targetDate: '2026-11-25', leather: 'NOT_RECEIVED' })
const LAB = gate(8, '', { kind: 'LAB_PASSED', targetDate: '2026-11-24', holds: 1 })
const TRIMS_LATE = gate(9, '', { kind: 'TRIMS_IN', targetDate: '2026-11-11', owner: MARCO, ownerId: MARCO.id, makerId: MARCO.id })

const ORDERS: Order[] = [
  order(1, { gates: [SAMPLE_PASSED, LEATHER_PASSED, ARTWORK, TRIMS_STARTED, PP_WAITING], start: ['2026-11-23', null], ship: '2026-12-04' }),
  order(2, { gates: [LEATHER_WAITING, LAB], start: ['2026-11-26', null], ship: '2026-12-11' }),
  order(3, { gates: [TRIMS_LATE, LEATHER_NONE], start: ['2026-11-17', '2026-11-16'], ship: '2026-11-30' }),
  order(4, { gates: [], ship: '2026-12-18' }),
]
const WORLD: Milestones = { today: TODAY, timeZone: 'Europe/Rome', tiles: { SAMPLE: 1, LEATHER_NOT_RECEIVED: 1, LEATHER_NOT_PASSED: 1, TRIMS: 1, OTHER: 2 }, orders: ORDERS, truncated: false }

const gateIn = (id: string): Gate => ORDERS.flatMap((entry) => entry.gates).find((entry) => entry.id === id)!
const CHOICES: GateChoices = {
  order: { id: ORDERS[1]!.id, number: ORDERS[1]!.number, kinds: ['LEATHER_APPROVED', 'LAB_PASSED'] },
  rounds: [
    { id: ROUND_PP.id, number: ROUND_PP.number, kind: 'PRE_PRODUCTION', roundNo: 1, decision: null, stage: 'UNDER_REVIEW', style: { id: uid('6666', 1), code: 'JKT-DEMO-07' } },
    { id: ROUND_FIT.id, number: ROUND_FIT.number, kind: 'FIT', roundNo: 2, decision: 'APPROVED_WITH_COMMENTS', stage: 'DECIDED', style: { id: uid('6666', 1), code: 'JKT-DEMO-07' } },
  ],
  owners: [
    { id: DEMO_USER.id, name: DEMO_USER.displayName, me: true },
    { id: PIA.id, name: PIA.name, me: false },
    { id: MARCO.id, name: MARCO.name, me: false },
  ],
}

export interface MilestonesCase {
  model: MilestonesModel
  permissions: readonly string[]
}

function inShell(page: ReactNode, permissions: readonly string[]): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(permissions)),
    path: '/planning/milestones',
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path: '/planning/milestones' },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

function MilestonesDesign({ model }: { model: MilestonesCase }) {
  return inShell(createElement(MilestonesView, { model: model.model }), model.permissions)
}

const PLANNER = rolePermissions('planner')
const MANAGER = rolePermissions('production_manager')

function make(over: Partial<Omit<MilestonesModel, 'controls'>> & { controls?: Partial<Controls> } = {}, permissions: readonly string[] = PLANNER): MilestonesCase {
  const { controls, ...rest } = over
  return {
    permissions,
    model: { prefix: '/w/DEMO', can: canOf(permissions), me: DEMO_USER.id, world: { status: 'ready', value: WORLD }, live: 'live', updates: 0, notice: null, dialog: null, ...rest, controls: { ...DEFAULT_CONTROLS, ...controls } },
  }
}

/** The production manager's world: may start before the gates Pia owns (not the ones Marco — the manager here — owns). */
const managerWorld = (): Milestones => ({
  ...WORLD,
  orders: ORDERS.map((entry) => ({
    ...entry,
    gates: entry.gates.map((row) => (row.state === 'WAITING' ? { ...row, actions: { ...row.actions, startBefore: row.ownerId === MARCO.id ? refused('OWN_GATE') : allowed } } : row)),
  })),
})
/** B-W2b-284: the first order also has its pre-production round's sample work order and a repair (neither starts its production). */
const startWorld = (): Milestones => ({
  ...WORLD,
  orders: ORDERS.map((entry, index) =>
    index === 0
      ? {
          ...entry,
          workOrders: {
            count: 4,
            notStarted: 4,
            byKind: [
              { kind: 'SIZE_GRID', count: 2, notStarted: 2 },
              { kind: 'SAMPLE', count: 1, notStarted: 1 },
              { kind: 'REPAIR', count: 1, notStarted: 1 },
            ],
          },
        }
      : entry,
  ),
})
const readOnlyWorld = (): Milestones => ({
  ...WORLD,
  orders: ORDERS.map((entry) => ({ ...entry, mayAddGate: { allowed: false, needs: 'planning.milestones.manage', refusal: null }, gates: entry.gates.map((row) => ({ ...row, actions: { pass: needs('planning.milestones.manage'), startBefore: needs('planning.milestones.override'), edit: needs('planning.milestones.manage'), remove: needs('planning.milestones.manage') } })) })),
})

export const designScreen = defineDesignScreen<MilestonesCase>({
  screen: 'SCR-253',
  title: 'Time & action',
  view: MilestonesDesign,
  cases: [
    { id: 'calendar', label: 'The planner: Waiting on a gate, the calendar of November', model: make({ day: '2026-11-20' }), note: 'Tiles are saved filters; a day lists its milestones (late · a gate waits · due · done); ← / → months, t today, 1/2/3 the views.' },
    { id: 'list', label: 'List: every milestone with target, actual, state, late', model: make({ controls: { view: 'list' } }), note: 'Only a gate that may be marked done now can be ticked (the reason on the box); d marks the focused gate done.' },
    { id: 'list-selected', label: 'List: two gates ticked — Mark 2 done', model: make({ controls: { view: 'list' }, selected: [`gate:${ARTWORK.id}`, `gate:${LAB.id}`] }) },
    { id: 'keyboard', label: 'List keyboard: the keys sit in the footer icon', model: make({ controls: { view: 'list' }, focusRow: 1, keysOpen: true }) },
    { id: 'orders', label: 'Per order: dots per milestone, what it waits on, the next one', model: make({ controls: { view: 'orders' } }) },
    { id: 'tile-sample', label: 'Tile Sample not approved pressed (list)', model: make({ controls: { view: 'list', tile: 'SAMPLE' } }) },
    { id: 'tile-leather', label: 'Tile Leather not received pressed (per order)', model: make({ controls: { view: 'orders', tile: 'LEATHER_NOT_RECEIVED' } }) },
    { id: 'search-empty', label: 'A search that matches nothing', model: make({ controls: { view: 'list', q: 'zzz' } }) },
    { id: 'milestone-waiting', label: 'Milestone dialog: the PP sample waits for its round (Mark done held), the board holds 2 work orders', model: make({ controls: { open: `gate:${PP_WAITING.id}` } }) },
    { id: 'milestone-passed', label: 'Milestone dialog: leather passed by its release', model: make({ controls: { open: `gate:${LEATHER_PASSED.id}` } }) },
    { id: 'milestone-started', label: 'Milestone dialog: trims — started before, with who, when and why', model: make({ controls: { open: `gate:${TRIMS_STARTED.id}` } }) },
    { id: 'milestone-ship', label: 'Milestone dialog: Ship follows the promise date and the shipments', model: make({ controls: { open: `ship:${ORDERS[0]!.id}` } }) },
    // B-W2b-284 (F22's follow-up): production start follows the production work orders only; the order's work orders per kind.
    { id: 'w2b-284-start-production', label: 'Milestone dialog: Production start follows the 2 production work orders; the sample and the repair are not counted', model: make({ world: { status: 'ready', value: startWorld() }, controls: { open: `start:${ORDERS[0]!.id}` } }) },
    { id: 'mark-done', label: 'Mark done on a day', model: make({ dialog: { kind: 'pass', gateIds: [ARTWORK.id], on: TODAY, busy: false, problem: null } }) },
    { id: 'mark-done-future', label: 'Mark done refused: a day to come', model: make({ dialog: { kind: 'pass', gateIds: [ARTWORK.id, LAB.id], on: '2026-11-30', busy: false, problem: null } }) },
    { id: 'start-before', label: 'Start before the gate? The production manager, a reason typed', model: make({ world: { status: 'ready', value: managerWorld() }, dialog: { kind: 'startBefore', gateIds: [PP_WAITING.id], reason: 'The brand approved by phone; the PP sample comes Friday (made up).', busy: false, problem: null } }, MANAGER) },
    { id: 'start-before-board', label: 'From a planning board drop the board held: Start before 2 gates? (artwork and PP sample of SO-DEMO-2041)', model: make({ world: { status: 'ready', value: managerWorld() }, dialog: { kind: 'startBefore', gateIds: [ARTWORK.id, PP_WAITING.id], reason: 'Cutting starts Monday; the brand confirmed both by mail (made up).', busy: false, problem: null } }, MANAGER), note: 'The board opens this dialog (milestones/use-start-before.tsx) on 409 refusal/GATE_NOT_PASSED, then sends its drop again.' },
    { id: 'start-before-held', label: 'Start before held: no reason yet', model: make({ world: { status: 'ready', value: managerWorld() }, dialog: { kind: 'startBefore', gateIds: [PP_WAITING.id], reason: '', busy: false, problem: null } }, MANAGER) },
    { id: 'start-before-own', label: 'Start before held: the manager is the gate’s planner', model: make({ world: { status: 'ready', value: managerWorld() }, dialog: { kind: 'startBefore', gateIds: [LEATHER_WAITING.id], reason: 'Made up', busy: false, problem: null } }, MANAGER) },
    { id: 'start-before-planner', label: 'The planner: Start before the gate held (needs a production manager)', model: make({ controls: { open: `gate:${ARTWORK.id}` } }) },
    { id: 'add', label: 'Add a gate: pick the order', model: make({ dialog: { kind: 'add', orderId: null, draft: emptyDraft(), choices: null, busy: false, problem: null } }) },
    { id: 'add-order', label: 'Add a gate to SO-DEMO-2042: a pre-production sample with its round', model: make({ dialog: { kind: 'add', orderId: ORDERS[1]!.id, draft: { ...emptyDraft('PP_SAMPLE'), sampleRoundId: ROUND_PP.id, targetDate: '2026-11-27' }, choices: { status: 'ready', value: CHOICES }, busy: false, problem: null } }) },
    { id: 'add-other', label: 'Add a gate of kind Other: held until it says what it is', model: make({ dialog: { kind: 'add', orderId: ORDERS[1]!.id, draft: emptyDraft('OTHER'), choices: { status: 'ready', value: CHOICES }, busy: false, problem: null } }) },
    { id: 'add-refused', label: 'Add refused: the order has that kind already', model: make({ dialog: { kind: 'add', orderId: ORDERS[1]!.id, draft: emptyDraft('LAB_PASSED'), choices: { status: 'ready', value: CHOICES }, busy: false, problem: 'refusal.GATE_EXISTS' } }) },
    { id: 'edit', label: 'Change the gate: target date and planner', model: make({ dialog: { kind: 'edit', gateId: LAB.id, draft: draftOfGate(gateIn(LAB.id)), choices: { status: 'ready', value: CHOICES }, busy: false, problem: null } }) },
    { id: 'remove', label: 'Remove the gate (a confirm)', model: make({ dialog: { kind: 'remove', gateId: LAB.id, busy: false, problem: null } }) },
    { id: 'passed-notice', label: 'After Mark done: the notice', model: make({ notice: { tone: 'success', key: 'notice.passed', params: { count: 2 } } }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: make({ dialog: { kind: 'keys' } }) },
    { id: 'empty', label: 'No open order: tiles 0, no milestones', model: make({ world: { status: 'ready', value: { ...WORLD, orders: [], tiles: { SAMPLE: 0, LEATHER_NOT_RECEIVED: 0, LEATHER_NOT_PASSED: 0, TRIMS: 0, OTHER: 0 } } } }) },
    { id: 'empty-list', label: 'No open order (list)', model: make({ controls: { view: 'list' }, world: { status: 'ready', value: { ...WORLD, orders: [], tiles: { SAMPLE: 0, LEATHER_NOT_RECEIVED: 0, LEATHER_NOT_PASSED: 0, TRIMS: 0, OTHER: 0 } } } }) },
    { id: 'loading', label: 'Loading: tiles say —, the month a skeleton', model: make({ world: { status: 'loading' }, live: 'connecting' }) },
    { id: 'error', label: 'Couldn’t load: the reason in words and Try again', model: make({ world: { status: 'error', problem: 'error.offline' }, live: 'offline' }), note: 'A failed read is never drawn as empty.' },
    { id: 'offline', label: 'Offline: the live line says so', model: make({ live: 'offline' }) },
    { id: 'read-only', label: 'Read-only: reads it all, every action held with the permission in words', model: make({ world: { status: 'ready', value: readOnlyWorld() }, controls: { open: `gate:${ARTWORK.id}` } }, rolePermissions('read_only')) },
    { id: 'no-permission', label: 'Sales: no planning.view — the page says so', model: make({}, rolePermissions('sales')) },
  ],
})

export const FIXTURES = { WORLD, ORDERS, CHOICES, PP_WAITING, ARTWORK, LEATHER_PASSED, TRIMS_STARTED, LEATHER_WAITING, LAB }
