import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Rma } from '../api'
import { inShell, RMA_RECEIVED, type RoleCase } from '../demo/fixtures'
import { rmaModel } from '../record/fixtures'
import { RmaRecordView } from '../record/view/RmaRecordView'
import type { RmaModel } from '../view-model'
import type { RemakeView } from './api'
import { remakePartOf, type Phrase } from './model'
import { RemakeOutcome } from './view/RemakeOutcome'

/**
 * SCR-112-outcome-remake — a remake as a return outcome on the RMA record (B-W2b-368, XF1:03), Inspection & decision, with made-up
 * data only: a returned made-to-measure unit drafted Remake (its outcomes: scrapped or quarantined; Make the remake order held
 * until the decision is saved), decided Remake (Make the remake order), the remake order made and waiting for the factory review,
 * a role without the rights (held with why), made-to-measure stopped for the template, Remake drafted on a line that is no unit,
 * reading, a read that failed, a refused write.
 */

const uid = (n: number) => `0190f0e2-3682-7000-8000-${String(n).padStart(12, '0')}`
const UNIT_LINE = RMA_RECEIVED.lines[0]!
const OTHER_LINE = RMA_RECEIVED.lines[1]!
const ALL = ['sales.returns.view', 'sales.returns.decide', 'orders.manage', 'sales.measurements.view']

const view = (over: { started?: boolean; disposition?: string | null; order?: 'PENDING_APPROVAL' | 'CONFIRMED' | null; status?: string } = {}): RemakeView => ({
  returnId: RMA_RECEIVED.id,
  number: RMA_RECEIVED.number,
  status: over.status ?? 'RECEIVED',
  version: 6,
  lines: [
    {
      lineId: UNIT_LINE.id,
      seq: 10,
      description: 'Giacca su misura demo, nero',
      disposition: over.disposition === undefined ? null : over.disposition,
      goodsOutcome: over.disposition === 'REMAKE' ? 'SCRAP' : null,
      unit: { orderLineId: uid(1), orderId: uid(2), orderNumber: 'SO-DEMO-0071', seq: 10, style: 'DEMO-JKT-MTM', colourway: 'BLK', baseSize: '52', madeTo: { id: uid(3), revision: 1, review: 'CONFIRMED' }, newest: { id: uid(4), revision: 2, review: 'WAITING' }, started: over.started ?? true },
      remakeOrder: over.order ? { orderId: uid(5), number: 'SO-DEMO-0090', orderLineId: uid(6), profileId: uid(4), status: over.order } : null,
      held: null,
    },
    { lineId: OTHER_LINE.id, seq: 20, description: OTHER_LINE.description, disposition: null, goodsOutcome: null, unit: null, remakeOrder: null, held: null },
  ],
  outcomes: ['SCRAP', 'QUARANTINE'],
  may: { order: true },
  why: null,
})

const decidedRma: Rma = { ...RMA_RECEIVED, lines: [{ ...UNIT_LINE, disposition: 'REMAKE', goodsOutcome: 'SCRAP', decidedAt: RMA_RECEIVED.receivedAt, creditAmount: 0, followUp: null }, OTHER_LINE] }
type Case = { readonly role: RoleCase; readonly model: RmaModel }
const DRAFTED = { [UNIT_LINE.id]: { disposition: 'REMAKE' as const, outcome: '' as const, credit: '' } }

function caseOf(role: RoleCase, rma: Rma, remake: RemakeView | null, options: { permissions?: readonly string[]; problem?: Phrase | null; writeProblem?: Phrase | null; drafts?: RmaModel['decisions'] } = {}): Case {
  return {
    role,
    model: rmaModel(role, {
      rma,
      tab: 'inspection',
      decisions: options.drafts ?? {},
      remakeLine: (lineId, disposition) => {
        const part = remakePartOf(remake, options.problem ?? null, lineId, { permissions: options.permissions ?? ALL, offline: false, busy: false, disposition, prefix: '/w/DEMO', writeProblem: options.writeProblem ?? null })
        return part ? createElement(RemakeOutcome, { part }) : null
      },
    }),
  }
}

function RemakeDesign({ model }: { model: Case }) {
  return inShell('/sales/returns', createElement(RmaRecordView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-112-outcome-remake',
  title: 'Return record › Inspection & decision › a remake (made-to-measure)',
  view: RemakeDesign,
  cases: [
    { id: 'drafted', label: 'Owner · Remake drafted on the unit: scrapped or quarantined; the order waits for the saved decision', model: caseOf('owner', RMA_RECEIVED, view(), { drafts: DRAFTED }), note: 'The outcome list offers Scrapped and Quarantine only (a unit made to a body never goes back into stock).' },
    { id: 'decided', label: 'Owner · Decided Remake: Make the remake order (on the rider’s newest revision)', model: caseOf('owner', decidedRma, view({ disposition: 'REMAKE' })) },
    { id: 'made', label: 'Owner · The remake order made: it waits for the factory review (Open the order)', model: caseOf('owner', decidedRma, view({ disposition: 'REMAKE', order: 'PENDING_APPROVAL' })) },
    { id: 'no-right', label: 'Sales without the measurements right · Make the remake order held with why', model: caseOf('sales', decidedRma, view({ disposition: 'REMAKE' }), { permissions: ['sales.returns.view', 'sales.returns.decide', 'orders.manage'] }) },
    { id: 'off', label: 'Owner · Made-to-measure stopped for the template: held (the off state in words)', model: caseOf('owner', decidedRma, view({ disposition: 'REMAKE', started: false })) },
    { id: 'not-unit', label: 'Owner · Remake drafted on a line that is no made-to-measure unit: said beside it', model: caseOf('owner', RMA_RECEIVED, view(), { drafts: { [OTHER_LINE.id]: { disposition: 'REMAKE', outcome: '', credit: '' } } }) },
    { id: 'reading', label: 'Owner · Reading the unit', model: caseOf('owner', decidedRma, null) },
    { id: 'failed', label: 'Owner · The unit couldn’t be read (Try again)', model: caseOf('owner', decidedRma, null, { problem: { key: 'remake.problem.unavailable' } }) },
    { id: 'refused', label: 'Owner · Make the remake order refused: the return changed meanwhile', model: caseOf('owner', decidedRma, view({ disposition: 'REMAKE' }), { writeProblem: { key: 'remake.problem.moved' } }) },
  ],
})
