import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { samplePdf } from '../../../_shared/document-send/sample-pdf'
import { PEOPLE_ROLES } from '../../_shared/fixtures'
import { RECORD, recordOf } from '../demo/fixtures'
import { payrollCan } from '../model'
import { ExportFileView, type ExportFileModel } from './view/ExportFileView'

/** SCR-159-file — a file's new tab with made-up data: the summary PDF, the export file, each one held with why, the states. */

const can = (pay = true, role: keyof typeof PEOPLE_ROLES = 'hr') => payrollCan([...PEOPLE_ROLES[role], ...(pay ? ['money.pay'] : [])])
const file = (over: Partial<ExportFileModel> = {}): ExportFileModel => ({ can: can(), kind: 'summary', loaded: { status: 'ready', value: RECORD }, pdf: samplePdf(['Riepilogo esportazione paghe · settembre 2026 · v2', 'Matricola D-0001 · Ore ordinarie 168,00', 'Matricola D-0002 · Ore ordinarie 152,00 · Ferie 16,00', 'Dati di esempio']), problem: null, ...over })

export const designScreen = defineDesignScreen<ExportFileModel>({
  screen: 'SCR-159-file',
  title: 'Export summary and file',
  view: ExportFileView,
  cases: [
    { id: 'summary', label: 'Export summary (PDF)', model: file() },
    { id: 'summary-unconfirmed', label: 'A summary in a layout nobody confirmed', model: file({ loaded: { status: 'ready', value: recordOf({ layout: { id: 'l', name: 'Importazione Zucchetti', format: 'FIXED_WIDTH', provider: 'Zucchetti', confirmed: false } }) } }) },
    { id: 'summary-opening', label: 'Opening the summary', model: file({ pdf: null }) },
    { id: 'summary-failed', label: "The summary couldn't be opened", model: file({ pdf: null, problem: { key: 'problem.unavailable' } }) },
    { id: 'file', label: 'Export file: Download, seal', model: file({ kind: 'data', pdf: null }) },
    { id: 'file-refused', label: 'A download refused', model: file({ kind: 'data', pdf: null, problem: { key: 'problem.forbidden' } }) },
    { id: 'no-pay', label: 'A file with amounts, without the pay grain', model: file({ can: can(false), pdf: null }) },
    { id: 'no-records', label: 'Without people.payroll.records', model: file({ can: can(false, 'readOnly'), pdf: null }) },
    { id: 'loading', label: 'Loading', model: file({ loaded: { status: 'loading' }, pdf: null }) },
    { id: 'error', label: "The export couldn't be read", model: file({ loaded: { status: 'error', problem: 'problem.unavailable' }, pdf: null }) },
    { id: 'not-found', label: 'No such export', model: file({ loaded: { status: 'notFound' }, pdf: null }) },
  ],
})
