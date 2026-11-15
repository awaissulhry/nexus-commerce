'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { FilePlus2, Mail, Trash2, Undo2 } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, Menu, SummaryTable } from '@nexus/ui/components'
import type { BuilderSection } from '@nexus/ui/patterns'
import { Button, Pill, Skeleton, Tag } from '@nexus/ui/primitives'
import { ActionConfirm, EditModeBar } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { adminHref } from '../../../shared/model'
import { RecordProblem } from '../../../shared/view/parts'
import type { EmailTemplate, MailEventInfo, MailPreview } from '../../mail-templates/api'
import { MAIL_LIMITS, mailChanges, mailProblems, newVersionHeld, placeholderToken, publishHeld, saveHeld, STATUS_TONE, type MailDraft } from '../model'
import { TEMPLATE_NAMESPACES, useKindWords, type EditorConfirm, type EditorNotice, type EditorRead } from './DocTemplateEditorView'
import { TemplateEditor, TemplateText } from './TemplateEditor'
import { useTplWords } from './words'

/**
 * SCR-633 — E-mail template (B-W2b-432; design admin.documents sec:mail-templates "Edit with placeholders and a preview on
 * a sample record"; PLT-232): the subject and the body with the event's placeholders, the code's own words beside them
 * (start from them), the versions and what it is used for (a company's own, or every company's); on the right the mail as
 * it would go out, filled with made-up sample values (nothing is sent). "Send me a test" waits: the API has no test mail
 * yet (B-W2b-422's gap 1). Same builder page as the document templates (TemplateEditor). Draws one view model;
 * MailTemplateEditorPage.tsx reads and writes.
 */

export interface MailEditorModel {
  prefix: string
  /** The template's company; null: every company's. */
  companyName: string | null
  read: EditorRead<EmailTemplate>
  /** The event's placeholders and the code's words (null while read). */
  event: MailEventInfo | null
  versions: readonly EmailTemplate[] | null
  draft: MailDraft | null
  preview: { answer: MailPreview | null; problem: string | null }
  busy: boolean
  notice: EditorNotice | null
  confirm: EditorConfirm
  changedElsewhere?: boolean
}

export interface MailEditorActions {
  onDraft?: (change: Partial<MailDraft>) => void
  onDiscard?: () => void
  onSave?: () => void
  onConfirm?: (confirm: EditorConfirm) => void
  onPublish?: () => void
  onRetire?: () => void
  onDelete?: () => void
  onNewVersion?: () => void
  onRetry?: () => void
  onRetryPreview?: () => void
  onDismissNotice?: () => void
}

export function MailTemplateEditorView({ model, actions }: { model: MailEditorModel; actions?: MailEditorActions }) {
  return (
    <WithMessages namespaces={TEMPLATE_NAMESPACES}>
      <Editor model={model} actions={actions} />
    </WithMessages>
  )
}

/** The editor page of an e-mail template's version (`/admin/documents/mail/<id>`). */
export const mailEditorHref = (prefix: string, templateId: string) => adminHref(prefix, `/documents/mail/${encodeURIComponent(templateId)}`)

function Editor({ model, actions }: { model: MailEditorModel; actions?: MailEditorActions }) {
  const t = useTplWords()
  const words = useKindWords()
  const back = { href: `${adminHref(model.prefix, '/documents')}?view=mail`, label: t('tpl.editor.backMail') }
  if (model.read.status === 'failed') return <RecordProblem problem={model.read.problem} back={<Link href={back.href}>{back.label}</Link>} onRetry={actions?.onRetry} />
  if (model.read.status === 'loading' || !model.draft)
    return (
      <div className="fw-adm fw-tpl-editor" role="status" aria-label={t('tpl.editor.loading')}>
        <Skeleton height={56} />
        <div className="fw-tpl-skeleton">
          <Skeleton height={320} />
          <Skeleton height={320} />
        </div>
      </div>
    )
  const { template, mayManage } = model.read
  const draft = model.draft
  const language = template.language === 'en' ? 'en' : 'it'
  const changed = mailChanges(template, draft)
  const problems = mailProblems(model.event?.placeholders ?? null, draft)
  const problemCount = (problems.subject?.length ?? 0) + (problems.body?.length ?? 0)
  const state = { status: template.status, mayManage, busy: model.busy, changed: changed.length, problems: problemCount }
  const readOnly = !mayManage || template.status !== 'DRAFT'
  const openDraft = template.status === 'DRAFT' ? null : (model.versions ?? []).find((version) => version.status === 'DRAFT') ?? null
  const title = t('tpl.mailEditor.title', { event: t(`tpl.event.${template.event}`), language: words.language(language) })
  const placeholders = model.event?.placeholders ?? []
  const code = model.event?.words[language] ?? null
  const save = saveHeld(state)
  const publish = publishHeld(state)
  const newHeld = newVersionHeld(state, openDraft)

  const primary =
    template.status === 'DRAFT' ? (
      <Button size="sm" variant="primary" heldReason={publish ? t(publish) : null} onClick={() => actions?.onConfirm?.('publish')}>
        {t('tpl.editor.publish')}
      </Button>
    ) : (
      <Button size="sm" variant="primary" heldReason={newHeld ? t(newHeld, { revision: openDraft?.revision ?? 0 }) : null} onClick={() => actions?.onNewVersion?.()}>
        <FilePlus2 size={14} aria-hidden /> {t('tpl.editor.newVersion')}
      </Button>
    )
  const more = mayManage && (template.status === 'DRAFT' || template.status === 'ACTIVE') && (
    <Menu
      label={t('tpl.editor.more')}
      align="right"
      items={
        template.status === 'DRAFT'
          ? [{ id: 'delete', icon: <Trash2 size={14} aria-hidden />, tone: 'danger', label: t('tpl.editor.delete'), onSelect: () => actions?.onConfirm?.('delete') }]
          : [{ id: 'retire', icon: <Undo2 size={14} aria-hidden />, label: t('tpl.mailEditor.retire'), onSelect: () => actions?.onConfirm?.('retire') }]
      }
    />
  )

  const sections: BuilderSection[] = [
    {
      id: 'subject',
      label: t('tpl.section.subject'),
      title: t('tpl.section.subject'),
      badge: problems.subject ? <Pill tone="danger">{problems.subject.length}</Pill> : undefined,
      content: <TemplateText label={t('tpl.field.subject')} hint={t('tpl.field.subjectHint')} value={draft.subject} limit={MAIL_LIMITS.subject} rows={2} placeholders={placeholders} problems={problems.subject} readOnly={readOnly} onChange={(subject) => actions?.onDraft?.({ subject })} />,
    },
    {
      id: 'body',
      label: t('tpl.section.body'),
      title: t('tpl.section.body'),
      badge: problems.body ? <Pill tone="danger">{problems.body.length}</Pill> : undefined,
      content: <TemplateText label={t('tpl.field.body')} hint={t('tpl.field.bodyHint')} value={draft.body} limit={MAIL_LIMITS.body} rows={12} placeholders={placeholders} problems={problems.body} readOnly={readOnly} onChange={(body) => actions?.onDraft?.({ body })} />,
    },
    {
      id: 'code',
      label: t('tpl.section.code'),
      title: t('tpl.section.code'),
      content: !model.event ? (
        <Skeleton height={120} />
      ) : (
        <div className="fw-tpl-section">
          <p className="fw-adm-hint">{t('tpl.code.intro')}</p>
          {code ? (
            <Card padded>
              <div className="fw-tpl-mail">
                <p className="fw-tpl-mail-subject">{code.subject}</p>
                <pre className="fw-tpl-mail-body">{code.body}</pre>
              </div>
            </Card>
          ) : (
            <p className="fw-adm-hint">{t('tpl.code.none')}</p>
          )}
          {code && !readOnly && (
            <span>
              <Button size="sm" onClick={() => actions?.onDraft?.({ subject: code.subject, body: code.body })}>
                {t('tpl.code.start')}
              </Button>
            </span>
          )}
        </div>
      ),
    },
    { id: 'versions', label: t('tpl.section.versions'), title: t('tpl.section.versions'), badge: model.versions ? <Tag>{model.versions.length}</Tag> : undefined, content: <MailVersions model={model} template={template} /> },
    {
      id: 'use',
      label: t('tpl.section.use'),
      title: t('tpl.section.use'),
      content: (
        <div className="fw-tpl-section">
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('tpl.use.company'), value: template.companyId === null ? t('tpl.mail.allCompanies') : (model.companyName ?? '—') },
              { label: t('tpl.use.event'), value: t(`tpl.event.${template.event}`) },
              { label: t('tpl.use.sentWhen'), value: t(`tpl.eventWhen.${template.event}`) },
              { label: t('tpl.use.language'), value: words.language(language) },
            ]}
          />
          <p className="fw-adm-hint">{t(template.companyId === null ? 'tpl.use.allWins' : 'tpl.use.companyWins')}</p>
        </div>
      ),
    },
  ]

  return (
    <>
      <TemplateEditor
        back={back}
        title={title}
        meta={
          <span className="fw-tpl-meta">
            <span>{t('tpl.editor.version', { revision: template.revision })}</span>
            <span>{template.companyId === null ? t('tpl.mail.allCompanies') : (model.companyName ?? '—')}</span>
          </span>
        }
        status={<Pill tone={STATUS_TONE[template.status]}>{t(`tpl.status.${template.status}`)}</Pill>}
        actions={
          <>
            {more}
            {primary}
          </>
        }
        notices={
          <>
            {model.notice && (
              <Banner
                tone={model.notice.tone}
                title={t(model.notice.key, model.notice.params)}
                action={
                  <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                    {t('tpl.dismiss')}
                  </Button>
                }
              />
            )}
            {model.changedElsewhere && <Banner tone="warning" title={t('tpl.editor.changedElsewhere')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('tpl.editor.reload')}</Button>} />}
            {template.status !== 'DRAFT' && (
              <Banner tone="info" title={t(template.status === 'ACTIVE' ? 'tpl.mailEditor.inUseNote' : 'tpl.editor.retiredNote', { revision: template.revision })}>
                {openDraft && (
                  <Link className="fw-adm-docs-link" href={mailEditorHref(model.prefix, openDraft.id)}>
                    {t('tpl.editor.openDraft', { revision: openDraft.revision })}
                  </Link>
                )}
              </Banner>
            )}
            {!mayManage && <p className="fw-adm-hint">{t('tpl.held.noRight')}</p>}
          </>
        }
        sections={sections}
        asideLabel={t('tpl.preview.mailLabel')}
        aside={<MailPreviewColumn model={model} unsaved={changed.length} onRetry={actions?.onRetryPreview} />}
        footer={
          changed.length > 0 && !readOnly ? (
            <EditModeBar
              count={changed.length}
              message={t('tpl.editor.unsaved', { count: changed.length })}
              applyLabel={t('tpl.editor.save')}
              applyHeldReason={save ? t(save) : null}
              busy={model.busy}
              saveShortcut
              onDiscard={() => actions?.onDiscard?.()}
              onApply={() => actions?.onSave?.()}
            />
          ) : undefined
        }
      />
      <MailConfirm model={model} template={template} title={title} actions={actions} />
    </>
  )
}

function MailVersions({ model, template }: { model: MailEditorModel; template: EmailTemplate }) {
  const t = useTplWords()
  const locale = useLocale()
  if (!model.versions) return <Skeleton height={120} />
  return (
    <div className="fw-adm-table">
      <SummaryTable
        label={t('tpl.versions.label')}
        density="roomy"
        stackOnPhone
        columns={[t('tpl.versions.col.version'), t('tpl.versions.col.status'), t('tpl.versions.col.published'), t('tpl.versions.col.changed')]}
        widths={['20%', '20%', '35%', '25%']}
        align={['left', 'left', 'left', 'left']}
        rows={model.versions.map((version) => ({
          id: version.id,
          cells: [
            version.id === template.id ? (
              <span key="v" className="fw-adm-name" aria-current="page">
                {t('tpl.editor.version', { revision: version.revision })} · {t('tpl.versions.thisOne')}
              </span>
            ) : (
              <Link key="v" className="fw-adm-docs-link" href={mailEditorHref(model.prefix, version.id)}>
                {t('tpl.editor.version', { revision: version.revision })}
              </Link>
            ),
            <Pill key="s" tone={STATUS_TONE[version.status]}>
              {t(`tpl.status.${version.status}`)}
            </Pill>,
            <span key="p">{version.publishedAt ? t('tpl.versions.publishedBy', { date: formatDate(version.publishedAt, { locale }), name: version.publishedBy?.name ?? '—' }) : '—'}</span>,
            <span key="c">{formatDateTime(version.updatedAt, { locale })}</span>,
          ],
        }))}
      />
    </div>
  )
}

function MailPreviewColumn({ model, unsaved, onRetry }: { model: MailEditorModel; unsaved: number; onRetry?: () => void }) {
  const t = useTplWords()
  let body: ReactNode
  if (model.preview.problem)
    body = <EmptyState title={t('tpl.preview.failedTitle')} description={t(model.preview.problem)} action={<Button size="sm" onClick={() => onRetry?.()}>{t('tpl.retry')}</Button>} />
  else if (!model.preview.answer)
    body = (
      <div role="status" aria-label={t('tpl.preview.loading')}>
        <Skeleton height={240} />
      </div>
    )
  else
    body = (
      <div className="fw-tpl-mail">
        <p className="fw-tpl-mail-subject">{model.preview.answer.subject}</p>
        <pre className="fw-tpl-mail-body">{model.preview.answer.body}</pre>
        {model.preview.answer.missing.length > 0 && (
          <div className="fw-tpl-section">
            <span className="fw-adm-hint">{t('tpl.preview.missing', { count: model.preview.answer.missing.length })}</span>
            <span className="fw-tpl-chips">
              {model.preview.answer.missing.map((name) => (
                <Tag key={name} tone="warning">
                  {placeholderToken(name)}
                </Tag>
              ))}
            </span>
          </div>
        )}
      </div>
    )
  return (
    <div className="fw-tpl-preview">
      <div className="fw-tpl-preview-head">
        <span className="fw-adm-hint">{unsaved > 0 ? t('tpl.preview.unsaved', { count: unsaved }) : t('tpl.preview.saved')}</span>
        <Button size="sm" heldReason={t('tpl.preview.testHeld')}>
          <Mail size={14} aria-hidden /> {t('tpl.preview.test')}
        </Button>
      </div>
      <Card padded>{body}</Card>
      <p className="fw-adm-hint">{t('tpl.preview.mailSample')}</p>
    </div>
  )
}

function MailConfirm({ model, template, title, actions }: { model: MailEditorModel; template: EmailTemplate; title: string; actions?: MailEditorActions }) {
  const t = useTplWords()
  if (!model.confirm || model.read.status !== 'ready') return null
  const active = (model.versions ?? []).find((version) => version.status === 'ACTIVE' && version.id !== template.id) ?? null
  const busy = model.busy
  const whose = template.companyId === null ? t('tpl.mail.allCompanies') : (model.companyName ?? '—')
  const impact =
    model.confirm === 'publish'
      ? {
          title: t('tpl.confirm.publishTitle', { title, revision: template.revision }),
          confirmLabel: busy ? t('tpl.busy') : t('tpl.editor.publish'),
          consequences: [t('tpl.confirm.mailUse', { whose }), active ? t('tpl.confirm.publishRetires', { revision: active.revision }) : t('tpl.confirm.mailFirst'), t('tpl.confirm.publishFrozen')],
          reversal: { verb: t('tpl.confirm.publishBack'), fidelity: 'exact' as const },
        }
      : model.confirm === 'retire'
        ? {
            title: t('tpl.confirm.retireTitle', { title, revision: template.revision }),
            confirmLabel: busy ? t('tpl.busy') : t('tpl.mailEditor.retire'),
            consequences: [t(template.companyId === null ? 'tpl.confirm.mailRetireAll' : 'tpl.confirm.mailRetireCompany'), t('tpl.confirm.retireKept')],
            reversal: { verb: t('tpl.confirm.retireBack'), fidelity: 'lossy' as const },
          }
        : {
            title: t('tpl.confirm.deleteTitle', { revision: template.revision }),
            confirmLabel: busy ? t('tpl.busy') : t('tpl.editor.delete'),
            consequences: [t('tpl.confirm.deleteGone'), t('tpl.confirm.deleteKept')],
            reversal: { verb: t('tpl.confirm.deleteBack'), fidelity: 'none' as const },
          }
  return (
    <ActionConfirm
      impact={{ level: 'confirm', reach: 'local', ...impact, ...(model.confirm === 'delete' ? { acknowledge: t('tpl.confirm.deleteAck') } : {}) }}
      onConfirm={() => (model.confirm === 'publish' ? actions?.onPublish?.() : model.confirm === 'retire' ? actions?.onRetire?.() : actions?.onDelete?.())}
      onCancel={() => (busy ? undefined : actions?.onConfirm?.(null))}
    />
  )
}
