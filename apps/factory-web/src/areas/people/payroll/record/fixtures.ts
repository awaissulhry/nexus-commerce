import { createElement, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, PEOPLE_ROLES, PREFIX, type PeopleRole } from '../../_shared/fixtures'
import { EXPORTS, RECORD, recordOf, VALUES_CORRECTION } from '../demo/fixtures'
import { payrollCan } from '../model'
import { PREVIEW_IDLE } from '../view-model'
import { PastExportView, type PastExportModel } from './view/PastExportView'

/** SCR-159-record — Past export with made-up data: a file, its links and downloads, the numbers opened, a replaced file, a draft, the states. */

interface RecordCase {
  role: PeopleRole
  pay: boolean
  page: PastExportModel
}

function page(over: Partial<PastExportModel> = {}, role: PeopleRole = 'hr', pay = true): RecordCase {
  return {
    role,
    pay,
    page: { prefix: PREFIX, can: payrollCan([...PEOPLE_ROLES[role], ...(pay ? ['money.pay'] : [])]), loaded: { status: 'ready', value: RECORD }, live: 'live', asOf: '2026-11-02T09:42:00.000Z', values: PREVIEW_IDLE, onlyChanged: false, withdrawing: null, dialogs: { send: null, correct: null, cancel: null }, notice: null, ...over },
  }
}

const recordCase = (value: Parameters<typeof recordOf>[0], role: PeopleRole = 'hr', pay = true) => page({ loaded: { status: 'ready', value: recordOf(value) } }, role, pay)

function RecordDesign({ model }: { model: RecordCase }): ReactNode {
  return inShell('/people/payroll/[id]', createElement(PastExportView, { model: model.page }), model.role)
}

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-159-record',
  title: 'Past export',
  view: RecordDesign,
  holdsPage: true,
  cases: [
    { id: 'file', label: 'A file: seal, two files, its links, its checks as they stood', model: page() },
    { id: 'numbers', label: 'The numbers opened, what changed from → to', model: page({ values: { status: 'ready', value: VALUES_CORRECTION, problem: null } }) },
    { id: 'numbers-reading', label: 'Opening the numbers', model: page({ values: { status: 'reading', value: null, problem: null } }) },
    { id: 'numbers-refused', label: 'The numbers refused', model: page({ values: { status: 'error', value: null, problem: { key: 'problem.forbidden' } } }) },
    { id: 'replaced', label: 'A file a correction replaced: Send held with why', model: recordCase({ ...EXPORTS[1]!, correctedById: EXPORTS[0]!.id }) },
    { id: 'correction', label: 'A correction, naming the file it replaces', model: recordCase({ correctionOfId: EXPORTS[1]!.id, changed: { people: 3, values: 7 } }) },
    { id: 'unconfirmed', label: 'A file in a layout nobody confirmed: the warning', model: recordCase({ layout: EXPORTS[2]!.layout }) },
    { id: 'no-links', label: 'Not sent by link', model: recordCase({ links: [], sentTo: [], downloadedAt: null }) },
    { id: 'draft', label: 'A draft: no file, Cancel draft', model: recordCase({ ...EXPORTS[3]!, files: [] }) },
    { id: 'cancelled', label: 'A cancelled export, with its reason', model: recordCase({ ...EXPORTS[4]!, files: [], cancelReason: 'Sostituita da una nuova esportazione.', cancelledAt: '2026-07-05T10:00:00.000Z' }) },
    { id: 'no-pay', label: 'The admin without the pay grain: the files held with why', model: page({}, 'hr', false) },
    { id: 'read-only', label: 'Read-only: states and links; nothing opens', model: page({}, 'readOnly', false) },
    { id: 'withdrawn', label: 'A link withdrawn', model: page({ notice: { tone: 'success', words: { key: 'record.withdrawn', params: { email: 'studio@example.com' } } } }) },
    { id: 'loading', label: 'Loading', model: page({ loaded: { status: 'loading' }, asOf: null }) },
    { id: 'error', label: "The export couldn't be read", model: page({ loaded: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'not-found', label: 'No such export', model: page({ loaded: { status: 'notFound' } }) },
    { id: 'forbidden', label: "A role that doesn't reach every site", model: page({ loaded: { status: 'forbidden' } }) },
  ],
})
