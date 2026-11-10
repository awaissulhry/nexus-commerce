import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { NOW, type RoleCase } from '../../../../quality/_shared/fixtures'
import { failedRead, ready, reading } from '../../../../quality/_shared/model'
import { DECLARATION_PDF, demoDetail, NEWEST, REQUESTS } from '../../substances/_demo/fixtures'
import { DeclarationsDesign, type DeclarationsCase } from '../../substances/_demo/designs/fixtures'
import { declarationsModel } from '../fixtures'
import { declarationsAddressOf, type RecordTab } from '../model'
import type { DeclarationDetail } from '../api'
import type { RecordModel } from '../view-model'

/**
 * SCR-054-declaration — the Supplier declaration (B-W2b-267; design compliance.tests rec "Supplier declaration", a DetailModal
 * reviewed in sequence at `?view=declarations&open=<id>&tab=`; pop:ts-decl-review). Made-up data only. The four tabs in every
 * state the Owner reviews: Request (portal and office, overdue with its reminders), Answer (the supplier's upload in the
 * PdfViewer, the office recording the answer's file, writing the answer per material), Decision (accept and next with every
 * check in words, held while a material has no answer, accepted with its validity bar, rejected with its reason), Activity
 * (the history told from the request's facts), and loading, a failed read, a refused write, read-only.
 */


function recordCase(detail: DeclarationDetail | null, tab: RecordTab, over: Partial<RecordModel> = {}, role: RoleCase = 'owner', mayManage = true): DeclarationsCase {
  const id = detail?.id ?? REQUESTS[0]!.id
  return declarationsModel(
    {
      address: { ...declarationsAddressOf(null), open: id, tab },
      record: {
        id,
        read: detail ? ready({ request: detail, mayManage, asOf: NOW }) : reading(),
        pdf: detail?.file?.fileId && tab === 'answer' ? ready(DECLARATION_PDF) : null,
        lines: null,
        answer: null,
        validTo: detail?.upload?.expiresOn ?? '',
        reason: '',
        problem: null,
        ...over,
      },
    },
    role,
  )
}

const waitingPortal = demoDetail(REQUESTS[0]!)
const overdueOffice = demoDetail({ ...REQUESTS[1]!, channel: 'OFFICE' })
const overduePortal = demoDetail(REQUESTS[1]!)
const answeredUpload = demoDetail(REQUESTS[2]!)
const answeredOffice = demoDetail(REQUESTS[3]!)
const rerequest = demoDetail(REQUESTS[4]!)
const accepted = demoDetail(REQUESTS[5]!)
const refused = demoDetail(REQUESTS[6]!)
const cancelled = demoDetail(REQUESTS[7]!)
const svhcAbove = demoDetail({ ...REQUESTS[0]!, status: 'ANSWERED', shown: 'ANSWERED', answeredAt: REQUESTS[2]!.answeredAt, file: REQUESTS[2]!.file, answeredLines: 1 }, {
  upload: demoDetail(REQUESTS[2]!).upload,
  lineRows: [{ ...demoDetail(REQUESTS[0]!).lineRows[0]!, contains: true, aboveThreshold: true, substance: { id: 'svhc-1', casNumber: '117-81-7', name: 'Bis(2-ethylhexyl) phthalate (DEHP)' }, concentration: '0.15', concentrationUnit: 'PERCENT_WW' }],
  answeredListVersion: { id: NEWEST.id, publishedOn: NEWEST.publishedOn },
})

export const designScreen = defineDesignScreen<DeclarationsCase>({
  screen: 'SCR-054-declaration',
  title: 'Tests & substances › Supplier declaration (record)',
  view: DeclarationsDesign,
  cases: [
    { id: 'request-portal', label: 'Request: asked in the supplier portal, waiting (Remind is the primary)', model: recordCase(waitingPortal, 'request'), note: 'J / K walk the list’s rows; “See it as the supplier” opens its portal’s Documents page in a new tab (partners.preview).' },
    { id: 'request-overdue', label: 'Request: overdue by 9 days, 2 reminders sent, one due', model: recordCase(overduePortal, 'request') },
    { id: 'request-office', label: 'Request: asked by the office (no portal page to preview: held with why)', model: recordCase(overdueOffice, 'request') },
    { id: 'answer-waiting-portal', label: 'Answer: waiting for the portal upload (take the newest upload)', model: recordCase(waitingPortal, 'answer') },
    { id: 'answer-record-office', label: 'Answer: the office records the supplier’s file and its validity', model: recordCase(overdueOffice, 'answer', { answer: { fileName: 'declaration-nickel.pdf', validTo: '2027-10-31' } }) },
    { id: 'answer-upload', label: 'Answer: the supplier’s upload in the viewer, one material still to answer', model: recordCase(answeredUpload, 'answer') },
    { id: 'answer-lines', label: 'Answer: writing the answer per material', model: recordCase(answeredUpload, 'answer', { lines: answeredUpload.lineRows.map((line, index) => ({ lineId: line.id, answer: index === 0 ? 'none' : 'below', substanceName: index === 0 ? '' : 'PFHxA', concentration: index === 0 ? '' : '0.01' })) }) },
    { id: 'answer-svhc-above', label: 'Answer: an SVHC above 0.1 % w/w, named with its CAS', model: recordCase(svhcAbove, 'answer') },
    { id: 'answer-pdf-failed', label: 'Answer: the file could not be opened', model: recordCase(answeredOffice, 'answer', { pdf: failedRead('problem.unavailable') }) },
    { id: 'decision-held', label: 'Decision: Accept held — a material has no answer yet', model: recordCase(answeredUpload, 'decision') },
    { id: 'decision-ready', label: 'Decision: every check passes — Accept and next, or Reject with why', model: recordCase(answeredOffice, 'decision', { validTo: '2027-10-31', reason: '' }) },
    { id: 'decision-refuse-typed', label: 'Decision: the reason typed for Reject (the supplier reads it)', model: recordCase(answeredOffice, 'decision', { reason: 'The declaration does not name our article codes.' }) },
    { id: 'decision-accepted', label: 'Decision: accepted, with its validity bar', model: recordCase(accepted, 'decision') },
    { id: 'decision-rerequest', label: 'Decision: accepted against an older Candidate List (ask again)', model: recordCase(rerequest, 'decision') },
    { id: 'decision-refused', label: 'Decision: rejected, with the reason', model: recordCase(refused, 'decision') },
    { id: 'decision-cancelled', label: 'Decision: cancelled', model: recordCase(cancelled, 'decision') },
    { id: 'refused-write', label: 'A write refused (someone changed it meanwhile)', model: recordCase(answeredOffice, 'decision', { problem: 'problem.accept.conflict' }) },
    { id: 'activity', label: 'Activity: sent, reminded, uploaded, answered, still to decide', model: recordCase({ ...answeredUpload, remindersSent: 1, lastRemindedAt: '2026-10-24T03:35:00Z' }, 'activity') },
    { id: 'activity-accepted', label: 'Activity: decided', model: recordCase(accepted, 'activity') },
    { id: 'read-only', label: 'Read-only: every verb held with its reason', model: recordCase(answeredOffice, 'decision', {}, 'readOnly', false) },
    { id: 'loading', label: 'Reading the request', model: recordCase(null, 'request') },
    { id: 'error', label: 'The request could not be read', model: recordCase(null, 'request', { read: failedRead('problem.notFound') }) },
  ],
})
