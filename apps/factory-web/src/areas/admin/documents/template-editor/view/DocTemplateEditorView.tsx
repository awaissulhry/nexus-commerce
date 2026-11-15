'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { ExternalLink, FilePlus2, Lock, Trash2, Undo2 } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, Menu, SummaryTable } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import type { BuilderSection } from '@nexus/ui/patterns'
import { Button, Checkbox, Pill, Skeleton, Tag } from '@nexus/ui/primitives'
import { ActionConfirm, EditModeBar } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import { adminHref } from '../../../shared/model'
import { RecordProblem } from '../../../shared/view/parts'
import { documentTemplatePreviewHref, printsNowHref, type DocumentKind, type DocumentTemplate } from '../../doc-templates/api'
import { documentChanges, documentProblems, droppedColumns, layoutColumns, newVersionHeld, publishHeld, saveHeld, STATUS_TONE, toggleColumn, type DocumentDraft, type Said } from '../model'
import { TemplateEditor, TemplateText } from './TemplateEditor'
import { useTplWords } from './words'

/**
 * SCR-631 — Template: Quote (Italiano) (B-W2b-432; design admin.documents pop:template-editor, a builder page; PLT-231):
 * the sections of the document on the left — Header (words above the lines), Lines (the optional columns shown; the
 * mandatory ones locked), Totals & what it always prints (locked: the legal data, the facts, the totals, the notices),
 * Terms, Footer —, then Versions and Use for (company and language); on the right the PDF of the saved words on the
 * company's real legal data and made-up lines (any status: a draft too). ⌘S saves the draft; "Publish template" puts it in
 * use and retires the version before; a published version never changes (New version starts a draft from it). Draws one
 * view model; DocTemplateEditorPage.tsx reads and writes.
 */

export type EditorRead<T> = { status: 'loading' } | { status: 'failed'; problem: string } | { status: 'ready'; template: T; mayManage: boolean }
export type EditorConfirm = 'publish' | 'retire' | 'delete' | null
export interface EditorNotice extends Said {
  tone: 'success' | 'info' | 'warning' | 'danger'
}

export interface DocEditorModel {
  /** `/w/<company>`. */
  prefix: string
  companyName: string | null
  read: EditorRead<DocumentTemplate>
  /** The kind's sections from `GET …/kinds` (null while read or when it failed). */
  kind: DocumentKind | null
  /** Every version of the same company, kind and language, newest first (null while read). */
  versions: readonly DocumentTemplate[] | null
  draft: DocumentDraft | null
  preview: { src: Uint8Array | null; problem: string | null }
  busy: boolean
  notice: EditorNotice | null
  confirm: EditorConfirm
  /** Someone else changed this template while it was open (live): Reload. */
  changedElsewhere?: boolean
}

export interface DocEditorActions {
  onDraft?: (change: Partial<DocumentDraft>) => void
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

export const TEMPLATE_NAMESPACES = ['admin', 'records', 'admin-templates'] as const

export function DocTemplateEditorView({ model, actions }: { model: DocEditorModel; actions?: DocEditorActions }) {
  return (
    <WithMessages namespaces={TEMPLATE_NAMESPACES}>
      <Editor model={model} actions={actions} />
    </WithMessages>
  )
}

/** "Quote", "Italiano": a kind and a language in words. */
export function useKindWords() {
  const t = useTplWords()
  return { kind: (kind: string) => t(`tpl.kind.${kind}`), language: (language: string) => t(`tpl.language.${language === 'en' ? 'en' : 'it'}`) }
}

function Editor({ model, actions }: { model: DocEditorModel; actions?: DocEditorActions }) {
  const t = useTplWords()
  const words = useKindWords()
  const back = { href: `${adminHref(model.prefix, '/documents')}?view=documents`, label: t('tpl.editor.back') }
  if (model.read.status === 'failed') return <RecordProblem problem={model.read.problem} back={<Link href={back.href}>{back.label}</Link>} onRetry={actions?.onRetry} />
  if (model.read.status === 'loading' || !model.draft)
    return (
      <div className="fw-adm fw-tpl-editor" role="status" aria-label={t('tpl.editor.loading')}>
        <Skeleton height={56} />
        <div className="fw-tpl-skeleton">
          <Skeleton height={360} />
          <Skeleton height={360} />
        </div>
      </div>
    )
  const { template, mayManage } = model.read
  const draft = model.draft
  const changed = documentChanges(template, draft)
  const problems = documentProblems(model.kind, draft)
  const problemCount = Object.values(problems).reduce((sum, list) => sum + (list?.length ?? 0), 0)
  const state = { status: template.status, mayManage, busy: model.busy, changed: changed.length, problems: problemCount }
  const readOnly = !mayManage || template.status !== 'DRAFT'
  const openDraft = template.status === 'DRAFT' ? null : (model.versions ?? []).find((version) => version.status === 'DRAFT') ?? null
  const title = t('tpl.editor.title', { kind: words.kind(template.kind), language: words.language(template.language) })
  const placeholders = model.kind?.placeholders ?? []
  const limits = model.kind?.limits ?? { header: 2000, terms: 20000, footer: 2000 }
  const save = saveHeld(state)
  const publish = publishHeld(state)

  const primary =
    template.status === 'DRAFT' ? (
      <Button size="sm" variant="primary" heldReason={publish ? t(publish) : null} onClick={() => actions?.onConfirm?.('publish')}>
        {t('tpl.editor.publish')}
      </Button>
    ) : (
      <Button size="sm" variant="primary" heldReason={heldWords(t, newVersionHeld(state, openDraft), openDraft)} onClick={() => actions?.onNewVersion?.()}>
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
          : [{ id: 'retire', icon: <Undo2 size={14} aria-hidden />, label: t('tpl.editor.retire'), onSelect: () => actions?.onConfirm?.('retire') }]
      }
    />
  )

  const sections: BuilderSection[] = [
    {
      id: 'header',
      label: t('tpl.section.header'),
      title: t('tpl.section.header'),
      badge: problems.header ? <Pill tone="danger">{problems.header.length}</Pill> : undefined,
      content: (
        <TemplateText label={t('tpl.field.header')} hint={t('tpl.field.headerHint')} value={draft.header} limit={limits.header} rows={4} placeholders={placeholders} problems={problems.header} readOnly={readOnly} onChange={(header) => actions?.onDraft?.({ header })} />
      ),
    },
    { id: 'lines', label: t('tpl.section.lines'), title: t('tpl.section.lines'), content: <LinesSection model={model} template={template} draft={draft} readOnly={readOnly} actions={actions} /> },
    { id: 'totals', label: t('tpl.section.totals'), title: t('tpl.section.totals'), content: <PartsSection kind={model.kind} /> },
    {
      id: 'terms',
      label: t('tpl.section.terms'),
      title: t('tpl.section.terms'),
      badge: problems.terms ? <Pill tone="danger">{problems.terms.length}</Pill> : undefined,
      content: <TemplateText label={t('tpl.field.terms')} hint={t('tpl.field.termsHint')} value={draft.terms} limit={limits.terms} rows={10} placeholders={placeholders} problems={problems.terms} readOnly={readOnly} onChange={(terms) => actions?.onDraft?.({ terms })} />,
    },
    {
      id: 'footer',
      label: t('tpl.section.footer'),
      title: t('tpl.section.footer'),
      badge: problems.footer ? <Pill tone="danger">{problems.footer.length}</Pill> : undefined,
      content: <TemplateText label={t('tpl.field.footer')} hint={t('tpl.field.footerHint')} value={draft.footer} limit={limits.footer} rows={2} placeholders={placeholders} problems={problems.footer} readOnly={readOnly} onChange={(footer) => actions?.onDraft?.({ footer })} />,
    },
    { id: 'versions', label: t('tpl.section.versions'), title: t('tpl.section.versions'), badge: model.versions ? <Tag>{model.versions.length}</Tag> : undefined, content: <VersionsSection model={model} template={template} /> },
    { id: 'use', label: t('tpl.section.use'), title: t('tpl.section.use'), content: <UseSection model={model} template={template} /> },
  ]

  return (
    <>
      <TemplateEditor
        back={back}
        title={title}
        meta={
          <span className="fw-tpl-meta">
            <span>{t('tpl.editor.version', { revision: template.revision })}</span>
            {model.companyName && <span>{model.companyName}</span>}
            <code className="fw-adm-code">{template.layout}</code>
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
              <Banner tone="info" title={t(template.status === 'ACTIVE' ? 'tpl.editor.inUseNote' : 'tpl.editor.retiredNote', { revision: template.revision })}>
                {openDraft && (
                  <Link className="fw-adm-docs-link" href={editorHref(model.prefix, openDraft.id)}>
                    {t('tpl.editor.openDraft', { revision: openDraft.revision })}
                  </Link>
                )}
              </Banner>
            )}
            {!mayManage && <p className="fw-adm-hint">{t('tpl.held.noRight')}</p>}
          </>
        }
        sections={sections}
        asideLabel={t('tpl.preview.label')}
        aside={<PreviewColumn model={model} template={template} title={title} unsaved={changed.length} onRetry={actions?.onRetryPreview} />}
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
      <ConfirmDialog model={model} template={template} title={title} actions={actions} />
    </>
  )
}

/** The editor page of a version (`/admin/documents/templates/<id>`). */
export const editorHref = (prefix: string, templateId: string) => adminHref(prefix, `/documents/templates/${encodeURIComponent(templateId)}`)

function heldWords(t: (key: string, params?: Record<string, string | number>) => string, key: string | null, openDraft: { revision: number } | null): string | null {
  if (!key) return null
  return key === 'tpl.held.draftOpen' && openDraft ? t(key, { revision: openDraft.revision }) : t(key)
}

function LinesSection({ model, template, draft, readOnly, actions }: { model: DocEditorModel; template: DocumentTemplate; draft: DocumentDraft; readOnly: boolean; actions?: DocEditorActions }) {
  const t = useTplWords()
  const columns = layoutColumns(template.kind, model.kind)
  const dropped = droppedColumns(template)
  if (!model.kind) return <Skeleton height={120} />
  return (
    <div className="fw-tpl-section">
      <p className="fw-adm-hint">{t('tpl.lines.intro')}</p>
      <ul className="fw-tpl-columns" aria-label={t('tpl.lines.label')}>
        {columns.map((column) => (
          <li key={column.key} className="fw-tpl-column">
            {column.mandatory ? (
              <>
                <span className="fw-adm-name">{t(`tpl.column.${column.key}`)}</span>
                <Tag>
                  <Lock size={11} aria-hidden /> {t('tpl.lines.always')}
                </Tag>
              </>
            ) : readOnly ? (
              <>
                <span className="fw-adm-name">{t(`tpl.column.${column.key}`)}</span>
                <Tag tone={draft.fieldsShown.includes(column.key) ? 'success' : 'neutral'}>{t(draft.fieldsShown.includes(column.key) ? 'tpl.lines.shown' : 'tpl.lines.left')}</Tag>
              </>
            ) : (
              <Checkbox
                label={t(`tpl.column.${column.key}`)}
                checked={draft.fieldsShown.includes(column.key)}
                onChange={(event) => actions?.onDraft?.({ fieldsShown: toggleColumn(template.kind, draft.fieldsShown, column.key, event.target.checked) })}
              />
            )}
          </li>
        ))}
      </ul>
      <p className="fw-adm-hint">{t('tpl.lines.width')}</p>
      {dropped.length > 0 && <p className="fw-adm-hint">{t(readOnly ? 'tpl.lines.droppedSaved' : 'tpl.lines.dropped', { columns: dropped.map((key) => columnWords(t, key)).join(', ') })}</p>}
    </div>
  )
}

/** A column's words; a key no column has (kept by an older version) as it is. */
function columnWords(t: (key: string) => string, key: string): string {
  const words = t(`tpl.column.${key}`)
  return words === `tpl.column.${key}` ? key : words
}

function PartsSection({ kind }: { kind: DocumentKind | null }) {
  const t = useTplWords()
  if (!kind) return <Skeleton height={120} />
  return (
    <div className="fw-tpl-section">
      <p className="fw-adm-hint">{t('tpl.parts.intro')}</p>
      <ul className="fw-tpl-parts">
        {kind.mandatoryParts.map((part) => (
          <li key={part} className="fw-tpl-part">
            <Lock size={14} aria-hidden className="fw-tpl-lock" />
            <span className="fw-tpl-part-text">
              <span className="fw-adm-name">{t(`tpl.part.${part}`)}</span>
              <span className="fw-adm-hint">{t(`tpl.partWhy.${part}`)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function VersionsSection({ model, template }: { model: DocEditorModel; template: DocumentTemplate }) {
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
              <Link key="v" className="fw-adm-docs-link" href={editorHref(model.prefix, version.id)}>
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

function UseSection({ model, template }: { model: DocEditorModel; template: DocumentTemplate }) {
  const t = useTplWords()
  const words = useKindWords()
  const language = template.language === 'en' ? 'en' : 'it'
  return (
    <div className="fw-tpl-section">
      <KeyValue
        dense
        labelCase="sentence"
        items={[
          { label: t('tpl.use.company'), value: model.companyName ?? '—' },
          { label: t('tpl.use.kind'), value: words.kind(template.kind) },
          { label: t('tpl.use.language'), value: words.language(language) },
          { label: t('tpl.use.layout'), value: <code className="fw-adm-code">{template.layout}</code> },
        ]}
      />
      <p className="fw-adm-hint">{t('tpl.use.fixed')}</p>
      <a className="fw-adm-docs-link" href={printsNowHref(template.companyId, template.kind, language)} target="_blank" rel="noopener noreferrer">
        {t('tpl.use.printsNow')} <ExternalLink size={12} aria-hidden />
        <span className="fw-adm-sr">{t('tpl.newTab')}</span>
      </a>
    </div>
  )
}

function PreviewColumn({ model, template, title, unsaved, onRetry }: { model: DocEditorModel; template: DocumentTemplate; title: string; unsaved: number; onRetry?: () => void }) {
  const t = useTplWords()
  const shell = useT('shell')
  let body: ReactNode
  if (model.preview.problem)
    body = (
      <Card padded>
        <EmptyState
          title={t('tpl.preview.failedTitle')}
          description={t(model.preview.problem)}
          action={
            model.preview.problem === 'tpl.preview.legalMissing' ? (
              <Link className="fw-adm-docs-link" href={adminHref(model.prefix, `/companies/${template.companyId}?tab=legal`)}>
                {t('tpl.preview.fixLegal')}
              </Link>
            ) : (
              <Button size="sm" onClick={() => onRetry?.()}>
                {t('tpl.retry')}
              </Button>
            )
          }
        />
      </Card>
    )
  else if (!model.preview.src)
    body = (
      <div role="status" aria-label={t('tpl.preview.loading')}>
        <Skeleton height={480} />
      </div>
    )
  else body = <PdfViewer src={model.preview.src} title={title} fileName={`${template.layout.replace(/[^A-Za-z0-9+]/g, '-')}.pdf`} labels={pdfViewerLabels(shell)} height="min(72vh, 820px)" />
  return (
    <div className="fw-tpl-preview">
      <div className="fw-tpl-preview-head">
        <span className="fw-adm-hint">{unsaved > 0 ? t('tpl.preview.unsaved', { count: unsaved }) : t('tpl.preview.saved')}</span>
        <a className="fw-adm-docs-link" href={documentTemplatePreviewHref(template.id)} target="_blank" rel="noopener noreferrer">
          {t('tpl.preview.newTab')} <ExternalLink size={12} aria-hidden />
        </a>
      </div>
      {body}
      <p className="fw-adm-hint">{t('tpl.preview.sample')}</p>
    </div>
  )
}

function ConfirmDialog({ model, template, title, actions }: { model: DocEditorModel; template: DocumentTemplate; title: string; actions?: DocEditorActions }) {
  const t = useTplWords()
  const words = useKindWords()
  if (!model.confirm || model.read.status !== 'ready') return null
  const active = (model.versions ?? []).find((version) => version.status === 'ACTIVE' && version.id !== template.id) ?? null
  const kind = words.kind(template.kind)
  const busy = model.busy
  const impact =
    model.confirm === 'publish'
      ? {
          title: t('tpl.confirm.publishTitle', { title, revision: template.revision }),
          confirmLabel: busy ? t('tpl.busy') : t('tpl.editor.publish'),
          consequences: [t('tpl.confirm.publishUse', { kind }), active ? t('tpl.confirm.publishRetires', { revision: active.revision }) : t('tpl.confirm.publishFirst'), t('tpl.confirm.publishFrozen')],
          reversal: { verb: t('tpl.confirm.publishBack'), fidelity: 'exact' as const },
        }
      : model.confirm === 'retire'
        ? {
            title: t('tpl.confirm.retireTitle', { title, revision: template.revision }),
            confirmLabel: busy ? t('tpl.busy') : t('tpl.editor.retire'),
            consequences: [t('tpl.confirm.retireFixed', { kind }), t('tpl.confirm.retireKept')],
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
