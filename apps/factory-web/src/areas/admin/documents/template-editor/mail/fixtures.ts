import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { inShell } from '../../../shared/fixtures'
import { DEMO } from '../../doc-templates/fixtures'
import { EVENTS, mailPreviewOf, SERVICE_IT_V2, SERVICE_IT_V3, TRACKING_EN_ALL, TRACKING_EN_ALL_V2 } from '../../mail-templates/fixtures'
import { mailDraftOf } from '../model'
import { MailTemplateEditorView, type MailEditorModel } from '../view/MailTemplateEditorView'

/**
 * SCR-633 — E-mail template (B-W2b-432; design admin.documents/sec:mail-templates "Edit with placeholders and a preview on a
 * sample record", PLT-232) with made-up words: the Demo company's draft of the service status mail beside the mail as it
 * would go out (filled with made-up values), unsaved changes, problems in the words, the publish confirm, every company's
 * tracking mail in use (New version held while its draft is open), a placeholder without a sample value, read only,
 * reading and not found. "Send me a test" is held with why (the API has no test mail yet).
 */

const SERVICE = EVENTS.events.find((event) => event.event === 'service.status_changed')!
const TRACKING = EVENTS.events.find((event) => event.event === 'shipping.tracking_link')!

const base = (over: Partial<MailEditorModel> = {}): MailEditorModel => ({
  prefix: '/w/DEMO',
  companyName: DEMO.legalName,
  read: { status: 'ready', template: SERVICE_IT_V3, mayManage: true },
  event: SERVICE,
  versions: [SERVICE_IT_V3, SERVICE_IT_V2],
  draft: mailDraftOf(SERVICE_IT_V3),
  preview: { answer: mailPreviewOf(SERVICE_IT_V3), problem: null },
  busy: false,
  notice: null,
  confirm: null,
  changedElsewhere: false,
  ...over,
})

function MailEditorDesign({ model }: { model: MailEditorModel }) {
  const readOnly = model.read.status === 'ready' && !model.read.mayManage
  return inShell('/admin/documents/mail/x', createElement(MailTemplateEditorView, { model }), readOnly ? ['home.view', 'numbering.view', 'documents.view'] : undefined)
}

const withUnknown = { ...SERVICE_IT_V3, body: `${SERVICE_IT_V3.body}\n\nRiferimento: {{order.number}}` }

export const designScreen = defineDesignScreen<MailEditorModel>({
  screen: 'SCR-633',
  title: 'E-mail template — the template editor',
  view: MailEditorDesign,
  cases: [
    { id: 'draft', label: "This company's draft of the service status mail, and the mail as it goes out", model: base(), note: 'Subject and message with Insert placeholder; the standard words beside them; Versions; Used for. Nothing is sent from here.' },
    { id: 'unsaved', label: 'Unsaved changes: the EditModeBar (⌘S); the preview says it is behind', model: base({ draft: { ...mailDraftOf(SERVICE_IT_V3), subject: 'Officina Demo · la sua pratica {{case.number}}' } }) },
    { id: 'problems', label: 'Problems in the words: an empty subject, a name the mail does not offer', model: base({ draft: { subject: '', body: `${SERVICE_IT_V3.body}\n{{ordine.numero}}` } }) },
    { id: 'confirm-publish', label: 'Publish version 3? (version 2 is retired in the same step)', model: base({ confirm: 'publish' }) },
    { id: 'all-in-use', label: "Every company's tracking mail in use while its draft is open", model: base({ companyName: null, read: { status: 'ready', template: TRACKING_EN_ALL, mayManage: true }, event: TRACKING, versions: [TRACKING_EN_ALL_V2, TRACKING_EN_ALL], draft: mailDraftOf(TRACKING_EN_ALL), preview: { answer: mailPreviewOf(TRACKING_EN_ALL), problem: null } }) },
    { id: 'missing-value', label: 'A placeholder the sample has no value for', model: base({ read: { status: 'ready', template: withUnknown, mayManage: true }, draft: mailDraftOf(withUnknown), preview: { answer: mailPreviewOf(withUnknown), problem: null } }), note: 'A saved draft that names an order number on a service case mail: the preview leaves it empty and names it.' },
    { id: 'read-only', label: 'Read only: documents.view without documents.templates.manage', model: base({ read: { status: 'ready', template: SERVICE_IT_V2, mayManage: false }, draft: mailDraftOf(SERVICE_IT_V2), preview: { answer: mailPreviewOf(SERVICE_IT_V2), problem: null } }) },
    { id: 'preview-failed', label: 'The preview could not be made', model: base({ preview: { answer: null, problem: 'problem.unavailable' } }) },
    { id: 'loading', label: 'Reading the template', model: base({ read: { status: 'loading' }, draft: null }) },
    { id: 'not-found', label: 'A version that is not there', model: base({ read: { status: 'failed', problem: 'problem.notFound' }, draft: null }) },
  ],
})
