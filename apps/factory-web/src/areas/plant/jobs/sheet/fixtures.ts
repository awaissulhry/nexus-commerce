import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { CARDS, inShell, JOBS, NOW, REQUESTS } from '../../_shared/fixtures'
import { JobSheetView, type JobSheetModel } from './view/JobSheetView'

/** SCR-149-sheet — a maintenance job on paper (a new tab from the job), made-up data only. */

const model = (over: Partial<JobSheetModel> = {}): JobSheetModel => ({
  person: 'Alex Demo',
  at: NOW,
  address: `https://factory.example/w/DEMO/plant/jobs/${JOBS.safety.id}`,
  job: { value: { job: { ...JOBS.safety, assignee: { kind: 'WORKER', id: null, name: 'Luca Demo' } }, card: CARDS.sew2, requests: [REQUESTS.unsafe], canManage: true, canWork: true }, problem: null },
  ...over,
})

function SheetDesign({ model }: { model: JobSheetModel }) {
  return inShell(`/plant/jobs/${JOBS.safety.id}/sheet`, createElement(JobSheetView, { model }))
}

export const designScreen = defineDesignScreen<JobSheetModel>({
  screen: 'SCR-149-sheet',
  title: 'Job sheet (print for the technician, with a QR to the job)',
  view: SheetDesign,
  cases: [
    { id: 'safety', label: 'A safety job on a machine locked as unsafe, with its request', model: model(), note: 'The QR opens the job on a phone; the browser prints it or saves it as a PDF.' },
    { id: 'planned', label: 'A planned statutory check, nobody assigned yet', model: model({ job: { value: { job: JOBS.planned, card: CARDS.heat, requests: [], canManage: true, canWork: true }, problem: null } }) },
    { id: 'loading', label: 'Still reading', model: model({ job: { value: null, problem: null } }) },
    { id: 'error', label: "The job couldn't be read", model: model({ job: { value: null, problem: 'problem.notFound' } }) },
  ],
})
