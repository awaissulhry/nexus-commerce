import { createElement } from 'react'
import { companyValues, fillMail, MAIL_EVENT_DEFINITIONS, MAIL_EVENTS } from '@nexus/factory-domain/templates/mail'
import { missingValues } from '@nexus/factory-domain/templates/placeholders'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { at, COMPANIES, inShell } from '../../shared/fixtures'
import type { TemplateLanguage } from '../doc-templates/api'
import { DEMO } from '../doc-templates/fixtures'
import type { EmailTemplate, EmailTemplatesAnswer, MailEventsAnswer, MailPreview } from './api'
import { MailTemplatesView } from './view/MailTemplatesView'
import { mailRowId, mailRowsOf, type MailTemplatesModel } from './model'

/**
 * Made-up e-mail templates of the Demo company and of every company (B-W2b-432), for the design cases of the list (SCR-632)
 * and the editor (SCR-633). The events and the standard words are factory-domain's own registry; the previews are filled
 * as the API fills them (its made-up sample values and the company's names).
 */

export const mid = (n: number) => `0190f0e2-7c20-7000-8000-${String(n).padStart(12, '0')}`
const LUCIA = { id: '0190f0e2-1111-7000-8000-000000000031', name: 'Lucia Esempio' }

export function mailTemplate(n: number, over: Partial<EmailTemplate>): EmailTemplate {
  const event = over.event ?? 'service.status_changed'
  const language = (over.language ?? 'it') as TemplateLanguage
  const words = MAIL_EVENT_DEFINITIONS[event].words[language]
  return {
    id: mid(n),
    companyId: DEMO.id,
    event,
    language,
    revision: 1,
    status: 'DRAFT',
    subject: words.subject,
    body: words.body,
    publishedAt: null,
    publishedBy: null,
    retiredAt: null,
    createdAt: at(12, 9),
    createdBy: LUCIA,
    updatedAt: at(12, 9),
    version: 1,
    ...over,
  }
}

const SERVICE_IT = MAIL_EVENT_DEFINITIONS['service.status_changed'].words.it
export const SERVICE_IT_V2 = mailTemplate(1, { revision: 2, status: 'ACTIVE', subject: `Officina Demo · ${SERVICE_IT.subject}`, publishedAt: at(18, 10), publishedBy: LUCIA, updatedAt: at(18, 10), version: 2 })
export const SERVICE_IT_V3 = mailTemplate(2, { revision: 3, status: 'DRAFT', subject: `Officina Demo · ${SERVICE_IT.subject}`, body: SERVICE_IT.body.replace('Per qualsiasi domanda', 'Per qualsiasi domanda sulla riparazione'), updatedAt: at(28, 16, 5), version: 3 })
export const TRACKING_IT_ALL = mailTemplate(3, { companyId: null, event: 'shipping.tracking_link', revision: 1, status: 'ACTIVE', publishedAt: at(3, 9), publishedBy: LUCIA, updatedAt: at(3, 9), version: 2 })
export const TRACKING_EN_ALL = mailTemplate(4, { companyId: null, event: 'shipping.tracking_link', language: 'en', revision: 1, status: 'ACTIVE', publishedAt: at(3, 9), publishedBy: LUCIA, updatedAt: at(3, 9), version: 2 })
export const TRACKING_EN_ALL_V2 = mailTemplate(5, { companyId: null, event: 'shipping.tracking_link', language: 'en', revision: 2, status: 'DRAFT', updatedAt: at(27, 11), version: 1 })

export const MAIL_TEMPLATES: EmailTemplate[] = [SERVICE_IT_V3, SERVICE_IT_V2, TRACKING_IT_ALL, TRACKING_EN_ALL_V2, TRACKING_EN_ALL]

export const EVENTS: MailEventsAnswer = {
  events: MAIL_EVENTS.map((event) => ({ event, recordType: MAIL_EVENT_DEFINITIONS[event].recordType, placeholders: [...MAIL_EVENT_DEFINITIONS[event].placeholders], words: { ...MAIL_EVENT_DEFINITIONS[event].words } })),
  languages: ['it', 'en'],
}

/** The slots of a set of versions for the Demo company, as `GET /templates/mail` answers them. */
export function mailAnswerOf(templates: readonly EmailTemplate[], mayManage = { company: true, all: true }): EmailTemplatesAnswer {
  const version = (template: EmailTemplate | undefined, by: 'publishedAt' | 'updatedAt') => (template ? { id: template.id, revision: template.revision, at: template[by] ?? template.updatedAt } : null)
  const slots = MAIL_EVENTS.flatMap((event) =>
    (['it', 'en'] as TemplateLanguage[]).map((language) => {
      const of = (companyId: string | null, status: EmailTemplate['status']) => templates.find((template) => template.event === event && template.language === language && template.companyId === companyId && template.status === status)
      const company = { active: version(of(DEMO.id, 'ACTIVE'), 'publishedAt'), draft: version(of(DEMO.id, 'DRAFT'), 'updatedAt') }
      const all = { active: version(of(null, 'ACTIVE'), 'publishedAt'), draft: version(of(null, 'DRAFT'), 'updatedAt') }
      const last = templates.filter((template) => template.event === event && template.language === language).map((template) => template.updatedAt).sort().at(-1) ?? null
      return { event, language, inUse: company.active ? ('COMPANY' as const) : all.active ? ('ALL' as const) : ('CODE' as const), company, all, lastChangedAt: last }
    }),
  )
  return { templates: [...templates], slots, mayManage }
}

/** The preview `POST …/preview` answers: the words filled with the event's sample and the company's names. */
export function mailPreviewOf(template: Pick<EmailTemplate, 'event' | 'language' | 'subject' | 'body'>): MailPreview {
  const language = template.language === 'en' ? 'en' : 'it'
  const values = { ...MAIL_EVENT_DEFINITIONS[template.event].sample[language], ...companyValues({ legalName: DEMO.legalName, tradeName: null }) }
  const filled = fillMail({ subject: template.subject, body: template.body }, values)
  return { subject: filled.subject, body: filled.body, missing: [...new Set([...missingValues(template.subject, values), ...missingValues(template.body, values)])] }
}

/**
 * SCR-632 — Admin › Documents & numbering › E-mail templates (B-W2b-432; design admin.documents/sec:mail-templates, PLT-232)
 * with made-up versions: the service status mail in Italian with the Demo company's own version in use (2) and a draft (3),
 * the English one on the standard words, the tracking link mail with every company's version in use (and an English draft);
 * ticked rows and their bulk actions, the confirm, a person who may write only this company's (no "Write every company's"),
 * read only, reading and failed. Nothing is sent from this list.
 */

const companies = COMPANIES.map((company) => ({ id: company.id, name: company.legalName }))
const ANSWER = { list: mailAnswerOf(MAIL_TEMPLATES), events: EVENTS }
const ROWS = mailRowsOf(ANSWER)
const row = (id: string) => ROWS.find((entry) => entry.id === id)!

const base = (over: Partial<MailTemplatesModel> = {}): MailTemplatesModel => ({
  prefix: '/w/DEMO',
  companies,
  companyId: DEMO.id,
  read: { status: 'ready', answer: ANSWER },
  selected: [],
  confirm: null,
  busy: false,
  notice: null,
  asOf: at(29, 9, 42),
  updates: 0,
  ...over,
})

function MailTemplatesDesign({ model }: { model: MailTemplatesModel }) {
  const may = model.read.status === 'ready' ? model.read.answer.list.mayManage : { company: true, all: true }
  return inShell('/admin/documents', createElement(MailTemplatesView, { model }), !may.company && !may.all ? ['home.view', 'numbering.view', 'documents.view'] : undefined)
}

const SELECTED = [mailRowId('service.status_changed', 'it'), mailRowId('shipping.tracking_link', 'en')]

export const designScreen = defineDesignScreen<MailTemplatesModel>({
  screen: 'SCR-632',
  title: 'Documents & numbering › E-mail templates',
  view: MailTemplatesDesign,
  cases: [
    { id: 'company', label: "What the company's mails go out with, per event and language", model: base(), note: "This company's version, every company's, or the standard words; the subject as it goes out; a row opens the version that decides it (SCR-633)." },
    { id: 'selected', label: 'Two rows ticked: Publish 2, Back to the default 1, Delete 2', model: base({ selected: SELECTED }) },
    { id: 'confirm-publish', label: 'Publish 2 drafts? (the DS ActionConfirm)', model: base({ selected: SELECTED, confirm: { action: 'publish', rows: SELECTED.map(row) } }) },
    { id: 'done', label: 'After a bulk run', model: base({ notice: { key: 'tpl.bulk.done.publish', tone: 'success', params: { count: 2 } } }) },
    { id: 'company-only', label: "May write only this company's: no \"Write every company's\"", model: base({ read: { status: 'ready', answer: { list: mailAnswerOf(MAIL_TEMPLATES, { company: true, all: false }), events: EVENTS } } }) },
    { id: 'standard', label: 'No template yet: every mail on the standard words', model: base({ read: { status: 'ready', answer: { list: mailAnswerOf([]), events: EVENTS } } }) },
    { id: 'read-only', label: 'Read only: documents.view without documents.templates.manage', model: base({ read: { status: 'ready', answer: { list: mailAnswerOf(MAIL_TEMPLATES, { company: false, all: false }), events: EVENTS } } }) },
    { id: 'loading', label: 'Reading the e-mail templates', model: base({ read: { status: 'loading' }, asOf: null }) },
    { id: 'failed', label: 'The e-mail templates could not be read', model: base({ read: { status: 'failed', problem: 'problem.unavailable' } }) },
  ],
})
