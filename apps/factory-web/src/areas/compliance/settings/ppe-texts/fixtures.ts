import { STEP_UP_CLOSED } from '../../../quality/_shared/hooks'
import type { RulesRoleDemo } from '../_demo/fixtures'
import type { SettingsAddress } from '../model'
import type { RulesMarketsModel } from '../view-model'
import type { Approval, Template, TemplatesAnswer } from './api'
import { emptyRecordDraft, templateKeyOf } from './model'
import type { TemplatesState } from './use-ppe-texts'

/**
 * SCR-262 › Templates (B-W2b-288, FU2:01; GATE-PPE-TEXTS): the design cases `w2b-288-templates-*`, spread into SCR-262's own
 * cases (settings/fixtures.ts). Made-up data only: an invented consultant, firm, labels and people; the template keys are the
 * generators' own (annex-ix, annex-ii-1.4). The owner records and withdraws (compliance.ppeTexts.manage); the quality inspector
 * reads (the button says why it is held).
 */

const uid = (n: number) => `0190f0e2-0288-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = '0190f0e2-0001-7000-8000-000000000001'
const NOW = '2026-11-10T08:42:00.000Z'
const ready = <T,>(value: T) => ({ status: 'ready' as const, value })

const CONSULTANT = 'Dott.ssa Demo Consulente, Studio Esempio Sicurezza (made-up)'
const person = (n: number, name: string) => ({ id: uid(900 + n), name })

const label = (code: string, revision: number, name: string, companyId: string | null): NonNullable<Template['label']> => ({ id: uid(100 + revision), code, revision, name, status: 'ACTIVE', companyId, languages: ['it', 'en', 'de'] })

export const DEMO_TEMPLATES: Template[] = [
  { templateKind: 'DOC', templateKey: 'annex-ix', templateVersion: 1, templateId: 'annex-ix.1', label: null, state: 'APPROVED', liveLanguages: ['en', 'it'], approvals: 2 },
  { templateKind: 'USER_INFORMATION', templateKey: 'annex-ii-1.4', templateVersion: 1, templateId: 'annex-ii-1.4.1', label: null, state: 'NONE', liveLanguages: [], approvals: 0 },
  { templateKind: 'LABEL_WARNING', templateKey: 'DEMO-LBL-JKT-01', templateVersion: 2, templateId: 'DEMO-LBL-JKT-01.2', label: label('DEMO-LBL-JKT-01', 2, 'Giacca demo, etichetta cucita', null), state: 'WITHDRAWN', liveLanguages: [], approvals: 1 },
  { templateKind: 'LABEL_WARNING', templateKey: 'DEMO-LBL-PNT-01', templateVersion: 1, templateId: 'DEMO-LBL-PNT-01.1', label: label('DEMO-LBL-PNT-01', 1, 'Pantalone demo', COMPANY), state: 'NONE', liveLanguages: [], approvals: 0 },
]

const approval = (over: Partial<Approval> & Pick<Approval, 'id' | 'templateKind' | 'templateKey' | 'templateVersion'>): Approval => ({
  companyId: COMPANY,
  templateId: `${over.templateKey}.${over.templateVersion}`,
  languages: ['it', 'en'],
  checkedBy: CONSULTANT,
  recordedAt: '2026-11-04T09:30:00.000Z',
  recordedBy: person(1, 'Titolare Demo'),
  evidence: { id: uid(500 + Number(over.id.slice(-2))), originalName: 'verifica-consulente-annex-ix.pdf', contentType: 'application/pdf', status: 'AVAILABLE' },
  withdrawnAt: null,
  withdrawnBy: null,
  withdrawReason: null,
  live: true,
  version: 1,
  mayWithdraw: true,
  ...over,
})

export const DEMO_APPROVALS: Approval[] = [
  approval({ id: uid(1), templateKind: 'DOC', templateKey: 'annex-ix', templateVersion: 1 }),
  approval({
    id: uid(2),
    templateKind: 'DOC',
    templateKey: 'annex-ix',
    templateVersion: 1,
    companyId: null,
    languages: ['de'],
    recordedAt: '2026-10-20T10:00:00.000Z',
    withdrawnAt: '2026-11-02T15:00:00.000Z',
    withdrawnBy: person(1, 'Titolare Demo'),
    withdrawReason: 'Il consulente chiede una nuova formulazione del punto 9 (dato di prova).',
    live: false,
    version: 2,
    mayWithdraw: false,
  }),
  approval({ id: uid(3), templateKind: 'LABEL_WARNING', templateKey: 'DEMO-LBL-JKT-01', templateVersion: 2, companyId: null, languages: ['it'], live: false, withdrawnAt: '2026-11-06T15:00:00.000Z', withdrawnBy: person(1, 'Titolare Demo'), withdrawReason: 'Nuova revisione della giacca in arrivo.', mayWithdraw: false, version: 2 }),
]

export const demoAnswer = (mayRecord: { company: boolean; everyCompany: boolean }, templates: Template[] = DEMO_TEMPLATES, approvals: Approval[] = DEMO_APPROVALS): TemplatesAnswer => ({ templates, approvals, mayRecord, asOf: NOW })

const OWNER = { company: true, everyCompany: true }
const READER = { company: false, everyCompany: false }
const IDLE = { busy: false, problem: null }

const templatesState = (over: Partial<TemplatesState> = {}, may = OWNER): TemplatesState => ({ read: ready(demoAnswer(may)), record: null, withdraw: null, stepUp: STEP_UP_CLOSED, notice: null, ...over })

type Base = (role: RulesRoleDemo, address: Partial<SettingsAddress>, over?: Partial<RulesMarketsModel>) => { role: RulesRoleDemo; model: RulesMarketsModel }

const DOC_KEY = templateKeyOf(DEMO_TEMPLATES[0]!)
const LABEL_KEY = templateKeyOf(DEMO_TEMPLATES[2]!)
const CHECK_FILE = (): File | null => (typeof File === 'undefined' ? null : new File([new Uint8Array([37, 80, 68, 70])], 'verifica-consulente-annex-ii.pdf', { type: 'application/pdf' }))

/** The Templates tab's cases (`w2b-288-templates-*`), on SCR-262's own base model. */
export function templatesCases(base: Base) {
  const tab = { tab: 'templates' as const }
  const filled = { ...emptyRecordDraft('USER_INFORMATION:annex-ii-1.4.1', true), languages: 'it, en', checkedBy: CONSULTANT, file: CHECK_FILE(), fileName: 'verifica-consulente-annex-ii.pdf' }
  return [
    { id: 'w2b-288-templates', label: 'Templates: the declaration, the user information and each PPE garment label, with the consultant’s yes in force or not', model: base('owner', tab, { templates: templatesState() }), note: 'GATE-PPE-TEXTS: the banner says what a yes allows; the owner records it (c).' },
    { id: 'w2b-288-templates-quality', label: 'Quality inspector: reads the templates; “Record a consultant’s yes” held (the owner’s decision)', model: base('quality', tab, { templates: templatesState({}, READER) }) },
    { id: 'w2b-288-templates-window', label: 'The declaration’s window: a yes in force (it, en) and one withdrawn with its reason, each with the consultant’s file', model: base('owner', { ...tab, open: DOC_KEY }, { templates: templatesState() }) },
    { id: 'w2b-288-templates-window-label', label: 'A label’s class warnings: the label, its languages, a withdrawn yes', model: base('owner', { ...tab, open: LABEL_KEY }, { templates: templatesState() }) },
    { id: 'w2b-288-templates-withdraw', label: 'Withdraw a yes: the reason, “Withdraw the yes”', model: base('owner', { ...tab, open: DOC_KEY }, { templates: templatesState({ withdraw: { approvalId: uid(1), reason: 'Il consulente chiede di rivedere il punto 6 (dato di prova).', writing: IDLE } }) }) },
    { id: 'w2b-288-templates-withdraw-held', label: 'Withdraw held until a reason is typed', model: base('owner', { ...tab, open: DOC_KEY }, { templates: templatesState({ withdraw: { approvalId: uid(1), reason: '', writing: IDLE } }) }) },
    { id: 'w2b-288-templates-withdraw-refused', label: 'Withdraw refused: someone changed it meanwhile (in our words)', model: base('owner', { ...tab, open: DOC_KEY }, { templates: templatesState({ withdraw: { approvalId: uid(1), reason: 'Rivedere il punto 6.', writing: { busy: false, problem: { key: 'ppe.problem.stale' } } } }) }) },
    { id: 'w2b-288-templates-record', label: 'Record a consultant’s yes: the template, whose texts, the languages, the consultant, the file (held until each is there)', model: base('owner', { ...tab, add: true }, { templates: templatesState({ record: { draft: emptyRecordDraft(null, true), writing: IDLE } }) }) },
    { id: 'w2b-288-templates-record-ready', label: 'Record a consultant’s yes: everything typed, “Record the yes” ready', model: base('owner', { ...tab, add: true }, { templates: templatesState({ record: { draft: filled, writing: IDLE } }) }) },
    { id: 'w2b-288-templates-record-refused', label: 'Record refused: this yes is recorded already (in our words)', model: base('owner', { ...tab, add: true }, { templates: templatesState({ record: { draft: filled, writing: { busy: false, problem: { key: 'ppe.refusal.RECORDED' } } } }) }) },
    { id: 'w2b-288-templates-step-up', label: 'Recording a yes asks a fresh code', model: base('owner', { ...tab, add: true }, { templates: templatesState({ record: { draft: filled, writing: { busy: true, problem: null } }, stepUp: { open: true, busy: false, sentence: 'ppe.stepUp.record', problem: null } }) }) },
    { id: 'w2b-288-templates-recorded', label: 'After recording: the notice and the template’s window', model: base('owner', { ...tab, open: DOC_KEY }, { templates: templatesState({ notice: { tone: 'success', key: 'ppe.notice.recorded', params: { languages: 'it, en' } } }) }) },
    { id: 'w2b-288-templates-filtered', label: 'No template matches the filters: Clear filters', model: base('owner', { ...tab, q: 'nessuno' }, { templates: templatesState() }) },
    { id: 'w2b-288-templates-loading', label: 'Templates loading', model: base('owner', tab, { templates: templatesState({ read: { status: 'loading' } }), readAt: null }) },
    { id: 'w2b-288-templates-error', label: 'Templates failed: said with Try again', model: base('owner', tab, { templates: templatesState({ read: { status: 'error', problem: 'problem.read' } }) }) },
    { id: 'w2b-288-templates-offline', label: 'Offline: recording and withdrawing held with why', model: base('owner', { ...tab, open: DOC_KEY }, { live: 'offline', templates: templatesState() }) },
  ]
}
