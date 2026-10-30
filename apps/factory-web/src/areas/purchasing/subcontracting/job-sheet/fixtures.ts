import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, order, TIME_ZONE, withoutFees } from '../demo/fixtures'
import type { JobSheetModel } from './view/JobSheetView'
import { JobSheetView } from './view/JobSheetView'

/**
 * SCR-128-job-sheet — the job sheet of a subcontract order (design tab:job-sheet, "printed and sent with the kit"), with
 * made-up data only: an order sent to the workshop with its kit, one without a kit, loading, and a failed read. No price
 * on it, whoever prints it.
 */

const issued = withoutFees(order('ISSUED'))
const base: JobSheetModel = { company: 'Officina Demo S.r.l.', person: 'Utente Demo', readAt: '2026-11-18T09:30:00.000Z', order: { value: issued, problem: null }, timeZone: TIME_ZONE }

function SheetDesign({ model }: { model: JobSheetModel }) {
  return inShell(`/purchasing/subcontracting/${issued.id}/job-sheet`, createElement(JobSheetView, { model }), 'buyer')
}

export const designScreen = defineDesignScreen<JobSheetModel>({
  screen: 'SCR-128-job-sheet',
  title: 'Subcontract order · job sheet',
  view: SheetDesign,
  cases: [
    { id: 'issued', label: 'Sent to the workshop: operations by size, the kit, the note — no price', model: base },
    { id: 'no-kit', label: 'Without a kit: the pieces travel alone', model: { ...base, order: { value: { ...issued, kitLines: [] }, problem: null } } },
    { id: 'loading', label: 'Loading', model: { ...base, readAt: null, order: { value: null, problem: null } } },
    { id: 'error', label: "The order couldn't be read", model: { ...base, readAt: null, order: { value: null, problem: 'problem.offline' } } },
  ],
})
