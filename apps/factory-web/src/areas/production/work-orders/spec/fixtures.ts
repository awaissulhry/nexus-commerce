import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { REQUESTS } from '../../../products/changes/demo/fixtures'
import { demoCompare } from '../../../products/styles/versions/fixtures'
import { workOrder } from '../../_shared/fixtures'
import { recordCase, RecordDesign, type RecordCase } from '../record/fixtures'
import type { WorkOrderChangesView, WorkOrderSpecView } from './api'
import { EMPTY_DRAFT, type SpecCan, type SpecModel } from './model'

/**
 * SCR-349 — the work order's frozen spec against the master and its change requests (B-W2b-245; design production.workorders:
 * wo-frozen "'Compare with the current master' → Spec differences", wo-sizegrid "Frozen at release: a change needs a change
 * request", pop:wo-diff Spec differences, pop:wo-change Change request). Made-up data only: WO-00009 made to revision 3 of
 * DEMO-JKT-01, revision 4 released since, two bundles cut and one worked.
 */

const uid = (family: string, n: number) => `0190f0e2-${family}-7000-8000-${String(n).padStart(12, '0')}`
const WO = workOrder('IN_PROGRESS')
const R3 = { id: WO.revision!.id, revision: 3, status: 'OBSOLETE' as const }
const R4 = { id: uid('7777', 24), revision: 4, status: 'RELEASED' as const }

export function demoSpec(kind: 'newer' | 'current' | 'rework' | 'withdrawn' = 'newer', orders = false): WorkOrderSpecView {
  const current = kind === 'current'
  const withdrawn = kind === 'withdrawn'
  const revision = current ? { ...R3, status: 'RELEASED' as const } : R3
  return {
    workOrder: { id: WO.id, number: WO.number, status: WO.status, styleId: WO.style.id, styleCode: WO.style.code },
    revision,
    released: current ? revision : withdrawn ? null : R4,
    newer: {
      state: current ? 'CURRENT' : withdrawn ? 'WITHDRAWN' : 'NEWER_RELEASED',
      banner: !current,
      newPages: kind === 'rework',
      message: 'x',
      newer: current || withdrawn ? null : { id: R4.id, revision: 4, releasedOn: '2026-11-04' },
      decision: kind === 'rework' ? { disposition: 'REWORK', changeOrder: 'ECO-DEMO-0004' } : null,
    },
    differs: current ? [] : [{ section: 'bom', label: 'BOM', added: 1, removed: 0, changed: 1 }, { section: 'routing', label: 'Routing and minutes', added: 0, removed: 0, changed: 1 }],
    words: 'x',
    orders: orders
      ? [
          {
            kind: 'ORDER',
            documentId: WO.orders[0]!.id,
            number: WO.orders[0]!.number,
            status: 'IN_PRODUCTION',
            lineId: uid('6208', 9),
            seq: 10,
            colourway: 'BLK',
            pieces: 26,
            revision: { id: uid('7777', 22), revision: 2, status: 'OBSOLETE' },
            against: revision,
            state: 'DIFFERENT',
            differs: [{ section: 'bom', label: 'BOM', added: 0, removed: 0, changed: 1 }],
            words: 'x',
          },
        ]
      : [],
  }
}

const CHANGES: WorkOrderChangesView = {
  workOrder: { id: WO.id, number: WO.number, status: WO.status, companyId: WO.companyId, siteId: WO.siteId, style: { id: WO.style.id, code: WO.style.code, name: WO.style.name }, revision: R3 },
  made: { cut: { bundles: 2, pieces: 14 }, worked: { bundles: 1, pieces: 6 } },
  requests: REQUESTS.slice(0, 2).map((request) => ({ ...request, style: { id: WO.style.id, code: WO.style.code, name: WO.style.name }, workOrder: { id: WO.id, number: WO.number, status: WO.status } })),
}

const ALL: SpecCan = { compare: true, changes: true, request: true }

export function demoSpecModel(over: Partial<SpecModel> = {}): SpecModel {
  return {
    can: ALL,
    spec: { status: 'ready', value: demoSpec() },
    dialog: null,
    compare: null,
    changes: null,
    draft: EMPTY_DRAFT,
    busy: false,
    problem: null,
    raised: null,
    ...over,
  }
}

const compare = { status: 'ready' as const, value: { ...demoCompare({ cost: 'absent' }), before: { ...demoCompare().before, id: R3.id, revision: 3, status: 'OBSOLETE' as const }, after: { ...demoCompare().after, id: R4.id, revision: 4, status: 'RELEASED' as const } } }
const at = (spec: Partial<SpecModel>, role: RecordCase['role'] = 'manager'): RecordCase => recordCase(role, 'IN_PROGRESS', { spec: demoSpecModel(spec) })
const filled = { title: 'Ginocchiera spostata di 2 cm verso il basso', reason: 'Al montaggio le ginocchiere livello 2 urtano la cucitura del fianco nelle taglie 54 e 56.', priority: 'HIGH' as const }

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-349',
  title: 'Work order: spec against the master, Spec differences, Change request',
  view: RecordDesign,
  cases: [
    { id: 'newer', label: 'A newer spec is in force: the office has not decided', model: at({}), note: 'The frozen spec card says revision 4 is in force and WO-00009 keeps revision 3 until the office decides; Compare with the current master; the size run says a change needs a change request.' },
    { id: 'current', label: 'Made to the spec in force', model: at({ spec: { status: 'ready', value: demoSpec('current') } }) },
    { id: 'rework', label: 'The office decided: rework to revision 4', model: at({ spec: { status: 'ready', value: demoSpec('rework') } }) },
    { id: 'withdrawn', label: 'Its revision was withdrawn', model: at({ spec: { status: 'ready', value: demoSpec('withdrawn') } }), note: 'Compare is held: nothing released to compare with.' },
    { id: 'spec-loading', label: 'The spec is being read', model: at({ spec: { status: 'loading' } }) },
    { id: 'spec-failed', label: 'The spec could not be read', model: at({ spec: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'diff', label: 'Spec differences', model: at({ dialog: { kind: 'diff' }, compare }), note: 'The redline of revision 3 → 4, part by part; Start a change request.' },
    { id: 'diff-orders', label: 'Spec differences with an order on another revision', model: at({ dialog: { kind: 'diff' }, compare, spec: { status: 'ready', value: demoSpec('newer', true) } }) },
    { id: 'diff-no-bom', label: 'Spec differences without the BOM right', model: at({ can: { ...ALL, compare: false }, dialog: { kind: 'diff' } }), note: 'What differs by part only; the line by line needs the right to read the BOM.' },
    { id: 'diff-same', label: 'Spec differences: nothing changed', model: at({ dialog: { kind: 'diff' }, spec: { status: 'ready', value: demoSpec('current') } }) },
    { id: 'diff-reading', label: 'Spec differences: reading', model: at({ dialog: { kind: 'diff' }, compare: { status: 'loading' } }) },
    { id: 'diff-error', label: 'Spec differences: the compare failed', model: at({ dialog: { kind: 'diff' }, compare: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'change', label: 'Change request: empty', model: at({ dialog: { kind: 'change' }, changes: { status: 'ready', value: CHANGES } }), note: 'Ask for approval is held until what and why are said; 2 bundles cut, 1 worked; the requests already about WO-00009.' },
    { id: 'change-filled', label: 'Change request: ready to ask', model: at({ dialog: { kind: 'change' }, changes: { status: 'ready', value: CHANGES }, draft: filled }) },
    { id: 'change-sending', label: 'Change request: being sent', model: at({ dialog: { kind: 'change' }, changes: { status: 'ready', value: CHANGES }, draft: filled, busy: true }) },
    { id: 'change-raised', label: 'Change request raised', model: at({ dialog: { kind: 'change' }, changes: { status: 'ready', value: { ...CHANGES, requests: [{ ...CHANGES.requests[0]!, id: uid('6301', 12), number: 'CR-DEMO-0012', title: filled.title, status: 'OPEN', createdById: DEMO_USER.id }, ...CHANGES.requests] } }, raised: { id: uid('6301', 12), number: 'CR-DEMO-0012' } }) },
    { id: 'change-refused', label: 'Change request refused', model: at({ dialog: { kind: 'change' }, changes: { status: 'ready', value: CHANGES }, draft: filled, problem: { key: 'problem.writeForbidden', changes: true } }) },
    { id: 'change-reading', label: 'Change request: what is made is read', model: at({ dialog: { kind: 'change' }, changes: { status: 'loading' } }) },
    { id: 'change-no-right', label: 'Team leader: no right to raise or compare', model: at({ can: { compare: false, changes: true, request: false } }, 'teamLeader'), note: 'Change request… is held with why (⋯ and the size run); Compare stays (what differs by part).' },
    { id: 'change-no-view', label: 'Change request without the right to read changes', model: at({ can: { compare: true, changes: false, request: true }, dialog: { kind: 'change' }, changes: null }) },
    { id: 'draft', label: 'A draft work order: nothing frozen yet', model: recordCase('manager', 'DRAFT', { spec: demoSpecModel({ spec: { status: 'idle' } }) }), note: 'W1\'s release check; no spec parts before the release.' },
  ],
})
