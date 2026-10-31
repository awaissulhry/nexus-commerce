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
import { EXPIRED_RENEWAL, renewalsModel, RENEWAL_STATES, REVIEWS, TOURING_RENEWAL, URBAN_RENEWAL, URBAN_RENEWED } from '../renewals/fixtures'
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
      renewals: null,
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

// W2a (B-W2a-66): the Renewals tab of CERT-DEMO-0002 (ends 2026-11-23: every alert fired, the renewal under way).
const urban = demoDetail(byNumber('CERT-DEMO-0002'), [demoCoverage(21, byNumber('CERT-DEMO-0002').id, { styleId: JACKET.id, style: { id: JACKET.id, code: JACKET.code, name: JACKET.name } })])
const renewalsTab = (detail: CertificateDetail, over: Parameters<typeof renewalsModel>[0] = {}, role: RoleCase = 'owner') => recordCase(detail, { tab: 'renewals', renewals: renewalsModel(over) }, role)
const answerDraft = (over: Partial<ReturnType<typeof renewalsModel>['draft']> = {}) => ({ ...renewalsModel().draft, ...over })

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
    { id: 'w2a-renewals', label: 'W2a Renewals: the alerts fired, the renewal under way', model: renewalsTab(urban), note: 'The five-year bar with the window and the 180 / 90 / 30-day marks; each alert in words (whom it told, when); the task’s steps; the application recorded after the window; Link the new certificate is the next step. Below: the changes to the approved type (one waiting, one told, one approved).' },
    { id: 'w2a-renewals-before', label: 'W2a Renewals: years left, the window opens in 2028', model: renewalsTab(valid, { renewals: ready(TOURING_RENEWAL), reviews: ready([]) }), note: 'Start renewal is the next step; the alert timers are set once the dates come near; no changes since issue.' },
    { id: 'w2a-start', label: 'W2a Start renewal: the task as it will be made', model: renewalsTab(valid, { renewals: ready(TOURING_RENEWAL), dialog: { kind: 'start' } }), note: 'For me, a colleague or nobody yet; the steps in Italian or English; nothing is sent to the notified body.' },
    { id: 'w2a-applied', label: 'W2a Record the application: a day after the window', model: renewalsTab(urban, { renewals: ready({ ...URBAN_RENEWAL, renewal: { ...URBAN_RENEWAL.renewal!, appliedOn: null, reference: null, inWindow: null }, nextStep: 'APPLY' }), dialog: { kind: 'applied' } }), note: 'Recorded anyway: whether a late application is taken is the notified body’s decision.' },
    { id: 'w2a-link', label: 'W2a Link the new certificate', model: renewalsTab(urban, { dialog: { kind: 'link' }, draft: answerDraft({ successorId: URBAN_RENEWAL.candidates[0]!.id }) }) },
    { id: 'w2a-link-none', label: 'W2a Link held: no registered certificate yet', model: renewalsTab(urban, { renewals: ready({ ...URBAN_RENEWAL, candidates: [] }), dialog: { kind: 'link' } }) },
    { id: 'w2a-renewed', label: 'W2a Renewed: the alerts stopped, one style not carried over', model: renewalsTab(urban, { renewals: ready(URBAN_RENEWED) }) },
    { id: 'w2a-expired', label: 'W2a Renewals of an expired certificate', model: renewalsTab(demoDetail(byNumber('CERT-DEMO-0006'), []), { renewals: ready(EXPIRED_RENEWAL), reviews: ready([]) }) },
    { id: 'w2a-notify', label: 'W2a Tell the notified body (recorded, nothing sent)', model: renewalsTab(urban, { dialog: { kind: 'notify', reviewId: REVIEWS[0]!.id } }) },
    { id: 'w2a-not-needed', label: 'W2a Not needed: held without the reason', model: renewalsTab(urban, { dialog: { kind: 'notNeeded', reviewId: REVIEWS[0]!.id } }) },
    { id: 'w2a-answer', label: 'W2a Record the answer: approved, its PDF chosen', model: renewalsTab(urban, { dialog: { kind: 'answer', reviewId: REVIEWS[1]!.id }, draft: answerDraft({ fileName: 'demo-answer-0412.pdf', reference: 'DEMO-ADD-0008' }) }) },
    { id: 'w2a-answer-held', label: 'W2a Record the answer: held without the notified body’s letter', model: renewalsTab(urban, { dialog: { kind: 'answer', reviewId: REVIEWS[1]!.id }, draft: answerDraft({ decision: 'REFUSED' }) }) },
    { id: 'w2a-refused', label: 'W2a A renewal step refused by the API', model: renewalsTab(urban, { dialog: { kind: 'link' }, draft: answerDraft({ successorId: URBAN_RENEWAL.candidates[0]!.id }), problem: 'ren.write.refused', lines: ['Certificate CERT-DEMO-0009 is DRAFT: register the new certificate first (a draft may still change).'] }) },
    { id: 'w2a-selected', label: 'W2a Changes: two selected (Export 2)', model: renewalsTab(urban, { selected: [REVIEWS[0]!.id, REVIEWS[1]!.id] }) },
    { id: 'w2a-product', label: 'W2a Product developer: reads, every renewal step held', model: renewalsTab(urban, {}, 'production') },
    { id: 'w2a-loading', label: 'W2a Renewals loading', model: recordCase(urban, { tab: 'renewals', renewals: RENEWAL_STATES.loading }) },
    { id: 'w2a-error', label: 'W2a Renewals could not be read', model: recordCase(urban, { tab: 'renewals', renewals: RENEWAL_STATES.error }) },
  ],
})
