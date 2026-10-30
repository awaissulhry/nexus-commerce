import { createElement, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import { RecordPanelsView } from '../../../../record-panels/view/RecordPanelsView'
import { at, COMPANY_ID, inShell, NOW, PREFIX, ROLE_PERMISSIONS, uid, type RoleCase } from '../../../quality/_shared/fixtures'
import { failedRead, reading, ready } from '../../../quality/_shared/model'
import type { CertificateDetail, CertificateFile } from '../api'
import { BRANDS, byNumber, CERTIFICATES, COMPANIES, COVERAGE_0001, coveredBy, demoCoverage, demoDetail, JACKET, PROTECTOR, refusedFor, STYLE_FACTS, STYLE_OPTIONS, TODAY, TROUSERS } from '../fixtures'
import { blankCheck, blankCoverage, certCan, defaultLapseDate, draftOf, lapseSummary, type CertificateRecordModel, type LapseAnswer, type LapseModel, type RecordTab } from '../model'
import { CertificateRecordView } from './view/CertificateRecordView'

/**
 * SCR-051 — the certificate record, made-up data only (the CERT-DEMO-… register of SCR-050; "Demo Test Lab" 0000). Each
 * case is one state the Owner reviews: a valid certificate with its coverage per style (colourway × size), the parts it
 * covers and the lapse check that shows what the gate refuses the day after its last valid day; a draft not ready and
 * one ready to register with the confirm; editing a draft's details with the five-year rule; suspended, withdrawn and
 * expired certificates; the status dialogs; Add coverage for a style and for a part; End coverage; Check a garment; the
 * Notified body, Files and Activity tabs; the thread beside a tab; loading, failed, not found; the role cases.
 */

const conversation = panelsScreen.cases.find((item) => item.id === 'conversation')!.model as RecordPanelsViewModel

function panelsFor(certificate: CertificateDetail): ReactNode {
  const model: RecordPanelsViewModel = { ...conversation, record: { type: 'Certificate', id: certificate.id, companyId: certificate.companyId, siteId: null }, title: certificate.number, party: null }
  return createElement(RecordPanelsView, { model })
}

interface RecordCase {
  readonly model: CertificateRecordModel
  readonly role: RoleCase
  readonly panels: boolean
}

const idleLapse = (validTo: string): LapseModel => ({ date: defaultLapseDate(validTo), state: 'idle', done: 0, total: 0, capped: false, summary: null })

function recordCase(detail: CertificateDetail | null, over: Partial<CertificateRecordModel> = {}, role: RoleCase = 'owner', panels = true): RecordCase {
  return {
    role,
    panels,
    model: {
      prefix: PREFIX,
      tab: 'coverage' as RecordTab,
      can: certCan(ROLE_PERMISSIONS[role]),
      today: TODAY,
      companies: COMPANIES,
      brands: BRANDS,
      detail: detail ? ready(detail) : reading(),
      styles: STYLE_FACTS,
      sameBody: null,
      files: null,
      asOf: NOW,
      live: 'live',
      notice: null,
      dialog: null,
      edit: null,
      statusReason: '',
      coverageDraft: blankCoverage(),
      endReason: '',
      check: null,
      lapse: idleLapse(detail?.validTo ?? TODAY),
      busy: false,
      dialogProblem: null,
      dialogLines: [],
      dockOpen: false,
      ...over,
    },
  }
}

function RecordDesign({ model }: { model: RecordCase }) {
  const detail = model.model.detail.value
  const page = createElement(CertificateRecordView, { model: model.model, panels: model.panels && detail && model.model.can.threads ? panelsFor(detail) : undefined })
  return inShell('/compliance/certificates', page, model.role)
}

// ---- the certificates of the cases ------------------------------------------------------------------------------------

const valid = demoDetail(byNumber('CERT-DEMO-0001'), COVERAGE_0001)
const draftCertificate = byNumber('CERT-DEMO-0005')
const draftNotReady = demoDetail(draftCertificate, [], false)
const draftReady = demoDetail(draftCertificate, [demoCoverage(11, draftCertificate.id, { styleId: JACKET.id, style: { id: JACKET.id, code: JACKET.code, name: JACKET.name }, sizes: ['50', '52', '54'] })], true)
const suspended = demoDetail(byNumber('CERT-DEMO-0004'), [demoCoverage(12, byNumber('CERT-DEMO-0004').id, { styleId: JACKET.id, style: { id: JACKET.id, code: JACKET.code, name: JACKET.name }, colourwayIds: [JACKET.colourways[2]!.id] })])
const withdrawn = demoDetail(byNumber('CERT-DEMO-0007'), [demoCoverage(13, byNumber('CERT-DEMO-0007').id, { itemId: uid('5505', 2), item: { id: uid('5505', 2), code: 'DEMO-PROT-SCHIENA', name: 'Demo back protector level 1' }, status: 'ARCHIVED', updatedAt: at(9, 10) })])
const expired = demoDetail(byNumber('CERT-DEMO-0006'), [])

// The lapse check of CERT-DEMO-0001 on the day after its last valid day: the jacket is refused everywhere but RED 48–54,
// which another certificate still covers; the trousers it covers are refused.
const lapseDate = defaultLapseDate(valid.validTo)
const answers: LapseAnswer[] = []
for (const colourway of JACKET.colourways)
  for (const size of colourway.offeredSizes) {
    const cell = { styleId: JACKET.id, styleCode: JACKET.code, colourwayId: colourway.id, colourwayCode: colourway.code, size }
    answers.push({
      cell,
      result:
        colourway.code === 'RED'
          ? coveredBy(byNumber('CERT-DEMO-0008'), JACKET, colourway.id, size, lapseDate)
          : refusedFor(JACKET, colourway.id, size, lapseDate, [{ code: 'certificate_expired', message: `Certificate CERT-DEMO-0001 ended on ${valid.validTo}.`, certificateId: valid.id }]),
    })
  }
for (const size of ['46', '48', '50', '52'])
  answers.push({
    cell: { styleId: TROUSERS.id, styleCode: TROUSERS.code, colourwayId: TROUSERS.colourways[0]!.id, colourwayCode: 'BLK', size },
    result: refusedFor(TROUSERS, TROUSERS.colourways[0]!.id, size, lapseDate, [{ code: 'certificate_expired', message: `Certificate CERT-DEMO-0001 ended on ${valid.validTo}.`, certificateId: valid.id }]),
  })
const lapseDone: LapseModel = { date: lapseDate, state: 'done', done: answers.length, total: answers.length, capped: false, summary: lapseSummary(answers) }
const lapseRunning: LapseModel = { date: lapseDate, state: 'running', done: 9, total: answers.length, capped: false, summary: null }
const lapseToday: LapseModel = { date: TODAY, state: 'done', done: 4, total: 4, capped: false, summary: lapseSummary(answers.slice(0, 4).map((answer) => ({ cell: answer.cell, result: coveredBy(valid, JACKET, answer.cell.colourwayId, answer.cell.size) }))) }

const file = (n: number, name: string, extra: Partial<CertificateFile> = {}): CertificateFile => ({
  id: uid('5507', n),
  companyId: COMPANY_ID,
  recordType: 'Certificate',
  recordId: valid.id,
  kind: 'CERTIFICATE',
  originalName: name,
  contentType: 'application/pdf',
  sizeBytes: 482_113,
  status: 'AVAILABLE',
  visibility: ['OFFICE'],
  retainUntil: '2039-03-11T23:59:59.999Z',
  quarantineReason: null,
  availableAt: at(3, 10),
  createdAt: at(3, 10),
  version: 1,
  ...extra,
})
const FILES: CertificateFile[] = [file(1, 'demo-cert-0001.pdf'), file(2, 'demo-type-examination-report.pdf', { kind: 'ATTACHMENT', sizeBytes: 1_204_550, createdAt: at(4, 12) })]

const sameBody = ready(CERTIFICATES.filter((entry) => entry.notifiedBodyNumber === valid.notifiedBodyNumber && entry.id !== valid.id))

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-051',
  title: 'Certificate record (coverage, lapse check, status)',
  view: RecordDesign,
  cases: [
    { id: 'valid', label: 'Valid: coverage per style, the parts, the lapse check ready', model: recordCase(valid), note: 'Registered: only its status changes. The jacket covers every colourway and size; the trousers only BLK 46–52.' },
    { id: 'lapse-refused', label: 'Lapse check: the day after its last valid day', model: recordCase(valid, { lapse: lapseDone }), note: 'What the gate would refuse and why; what that stops (release, label, shipping); RED still covered by another certificate.' },
    { id: 'lapse-running', label: 'Lapse check running', model: recordCase(valid, { lapse: lapseRunning }) },
    { id: 'lapse-today', label: 'Lapse check today: all covered', model: recordCase(valid, { lapse: lapseToday }) },
    { id: 'draft-not-ready', label: 'Draft: no PDF, nothing covered yet', model: recordCase(draftNotReady), note: 'Register is held with the first open check.' },
    { id: 'draft-ready', label: 'Draft ready to register', model: recordCase(draftReady) },
    { id: 'register', label: 'Register: the confirm with its checks', model: recordCase(draftReady, { dialog: { kind: 'register' } }) },
    { id: 'register-held', label: 'Register held: the checks that are open', model: recordCase(draftNotReady, { dialog: { kind: 'register' } }) },
    {
      id: 'register-refused',
      label: 'Register refused by the API (its sentences under our words)',
      model: recordCase(draftReady, { dialog: { kind: 'register' }, dialogProblem: 'write.invalid', dialogLines: ["Certificate CERT-DEMO-0005 cannot become VALID: the certificate's PDF from the notified body, uploaded on the certificate."] }),
    },
    { id: 'edit', label: 'Draft details: editing, the five-year rule', model: recordCase(draftReady, { edit: { draft: { ...draftOf(draftReady), validTo: '2031-12-31' }, touched: ['validTo'], busy: false, problem: null, lines: [] } }) },
    { id: 'suspended', label: 'Suspended by the notified body', model: recordCase(suspended), note: 'Reinstate is the primary; the body’s words under the banner.' },
    { id: 'suspend-dialog', label: 'Mark suspended: the impact first, the body’s words', model: recordCase(valid, { dialog: { kind: 'status', move: 'suspend' }, statusReason: 'Notified body letter DEMO-NB-2026-121.' }) },
    { id: 'withdraw-dialog', label: 'Mark withdrawn (final)', model: recordCase(valid, { dialog: { kind: 'status', move: 'withdraw' } }) },
    { id: 'reinstate-dialog', label: 'Reinstate a suspended certificate', model: recordCase(suspended, { dialog: { kind: 'status', move: 'reinstate' } }) },
    { id: 'withdrawn', label: 'Withdrawn: covers nothing', model: recordCase(withdrawn) },
    { id: 'expired', label: 'Expired: what it covered is refused', model: recordCase(expired) },
    {
      id: 'coverage-add',
      label: 'Add coverage: a style, some colourways, sizes 50–54',
      model: recordCase(draftReady, { dialog: { kind: 'coverage' }, coverageDraft: { ...blankCoverage(), style: ready(TROUSERS), allColours: false, colourwayIds: [TROUSERS.colourways[0]!.id], wholeRange: false, sizes: ['50', '52', '54'] } }),
    },
    { id: 'coverage-search', label: 'Add coverage: searching a style', model: recordCase(draftReady, { dialog: { kind: 'coverage' }, coverageDraft: { ...blankCoverage(), query: 'touring', styles: ready(STYLE_OPTIONS) } }) },
    { id: 'coverage-held', label: 'Add coverage: the style is covered already', model: recordCase(valid, { dialog: { kind: 'coverage' }, coverageDraft: { ...blankCoverage(), style: ready(JACKET) } }) },
    { id: 'coverage-item', label: 'Add coverage: a protector', model: recordCase(valid, { dialog: { kind: 'coverage' }, coverageDraft: { ...blankCoverage(), target: 'item', item: { ...PROTECTOR, code: 'DEMO-PROT-GOMITO', name: 'Demo elbow protector level 2', kind: 'PROTECTOR', isPpeComponent: true } } }) },
    { id: 'end-coverage', label: 'End coverage (archived with the reason)', model: recordCase(valid, { dialog: { kind: 'endCoverage', coverageId: COVERAGE_0001[1]!.id }, endReason: 'Trousers moved to CERT-DEMO-0008.' }) },
    { id: 'check', label: 'Check a garment from the certificate', model: recordCase(valid, { dialog: { kind: 'check' }, check: { ...blankCheck(TODAY), style: ready(JACKET), colourwayId: JACKET.colourways[0]!.id, size: '52', result: coveredBy(valid, JACKET, JACKET.colourways[0]!.id, '52') } }) },
    { id: 'body', label: 'Notified body: other certificates from 0000', model: recordCase(valid, { tab: 'body', sameBody }) },
    { id: 'files', label: 'Files: the PDF, kept 10 years after its last day', model: recordCase(valid, { tab: 'files', files: ready(FILES) }) },
    { id: 'files-empty', label: 'Files: a draft without its PDF', model: recordCase(draftNotReady, { tab: 'files', files: ready([]) }) },
    { id: 'activity', label: 'Activity: the thread, files and history', model: recordCase(valid, { tab: 'activity' }) },
    { id: 'dock', label: 'The thread beside the coverage (wide screens, ⌘J)', model: recordCase(valid, { dockOpen: true }) },
    { id: 'product', label: 'Product developer (production manager): every write held', model: recordCase(draftReady, {}, 'production', false), note: 'Reads everything; Register, Edit, Add coverage and the moves say why they are held.' },
    { id: 'quality', label: 'Quality (inspector): registers and keeps coverage', model: recordCase(draftReady, {}, 'inspector') },
    { id: 'no-permission', label: 'Sales: not for this role', model: recordCase(valid, {}, 'sales', false) },
    { id: 'loading', label: 'Loading', model: recordCase(null, { asOf: null, live: 'connecting' }, 'owner', false) },
    { id: 'error', label: "The API didn't answer", model: recordCase(null, { detail: failedRead('problem.unavailable') }, 'owner', false) },
    { id: 'not-found', label: 'Not found (another company’s certificate)', model: recordCase(null, { detail: failedRead('problem.notFound') }, 'owner', false) },
    { id: 'shortcuts', label: 'The keys (?)', model: recordCase(valid, { dialog: { kind: 'shortcuts' } }) },
  ],
})
