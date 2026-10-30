import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canAs, EXPORT_DONE, inShell, RECORD_SEPTEMBER, type Role } from '../demo/fixtures'
import { ExportFilesView, type ExportFilesModel } from './view/ExportFilesView'

/**
 * SCR-156-files — Accounting export › Export files (design finance.accounting tab:files), made-up data only: one batch
 * with its files and the checks passed over with their explanations, two batches together, a person without the cost
 * grain (the purchases journal held), reading, failed, none named, no permission.
 */

interface Case {
  role: Role
  page: ExportFilesModel
}

const base = (role: Role, over: Partial<ExportFilesModel> = {}): Case => ({
  role,
  page: { can: canAs(role), ids: [EXPORT_DONE.id], batches: { [EXPORT_DONE.id]: { value: EXPORT_DONE, problem: null } }, problem: null, ...over },
})

function FilesDesign({ model }: { model: Case }) {
  return inShell('/finance/accounting/files', createElement(ExportFilesView, { model: model.page }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-156-files',
  title: 'Export files: the files of a batch for the accountant, with the checks passed over',
  view: FilesDesign,
  cases: [
    { id: 'one', label: 'EXP-2026-0004 · four files, four checks passed over with their explanation', model: base('finance') },
    { id: 'two', label: 'Files of 2 batches', model: base('finance', { ids: [EXPORT_DONE.id, RECORD_SEPTEMBER.id], batches: { [EXPORT_DONE.id]: { value: EXPORT_DONE, problem: null }, [RECORD_SEPTEMBER.id]: { value: RECORD_SEPTEMBER, problem: null } } }) },
    { id: 'no-cost', label: 'Without the cost grain · the purchases journal held', model: base('financePrice') },
    { id: 'download-refused', label: 'A download refused', model: base('finance', { problem: { key: 'problem.write.unavailable', reload: false } }) },
    { id: 'loading', label: 'Reading', model: base('finance', { batches: {} }) },
    { id: 'error', label: "Couldn't load this batch", model: base('finance', { batches: { [EXPORT_DONE.id]: { value: null, problem: 'problem.read.not_found' } } }) },
    { id: 'none', label: 'No batch named', model: base('finance', { ids: [], batches: {} }) },
    { id: 'no-permission', label: 'Sales · no accounting permission', model: base('sales', { batches: {} }) },
  ],
})
