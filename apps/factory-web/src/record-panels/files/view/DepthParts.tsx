'use client'

import type { ReactNode } from 'react'
import { ArrowLeftRight, CalendarClock, History, PenLine } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { PhotoCapture } from '@nexus/ui/components/PhotoCapture/index'
import { Button, Checkbox, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { usePhotoWords, PHOTO_KIT_NAMESPACE } from '../../../lib/ds-words/photo-capture'
import { DateField, Modal, Textarea } from '../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../i18n'
import type { PanelFile } from '../../model'
import type { FileDepthActions } from '../actions'
import {
  CATEGORY_CHOICES,
  compareHeld,
  expiryTag,
  markupHeld,
  markupSaveHeld,
  moveState,
  openMoves,
  requirementTone,
  tagHeld,
  type FileDepthModel,
  type MarkupItem,
  type VersionRow,
} from '../model'
import { MarkSketch } from './MarkSketch'
import '../files.css'

/**
 * The files panel in depth (B-W2b-177), drawn inside SCR-006's Files tab: what each move still needs (the record frame's
 * "What is missing", design shell.panels/sec:guards: GuardList is not in the DS, composed here), each file's document type
 * and expiry, its depth actions (Versions, Mark up, What it is), and the three pop-ups (pop:file-versions with side by side,
 * the document's type and expiry, markup with the DS PhotoCapture). One view model, nothing fetched.
 */

export const DEPTH_NAMESPACES = ['records', 'record-files', PHOTO_KIT_NAMESPACE, 'shell'] as const

const Words = ({ children }: { children: ReactNode }) => <WithMessages namespaces={DEPTH_NAMESPACES}>{children}</WithMessages>

/** Above the list: what a depth action did, and what each status move of the record still needs. */
export function DepthTop({ depth, actions }: { depth: FileDepthModel | undefined; actions?: FileDepthActions }) {
  if (!depth) return null
  return (
    <Words>
      <DepthTopBody depth={depth} actions={actions} />
    </Words>
  )
}

function DepthTopBody({ depth, actions }: { depth: FileDepthModel; actions?: FileDepthActions }) {
  const t = useT('record-files')
  const locale = useLocale()
  const docs = depth.documents
  return (
    <>
      {depth.notice && <Banner tone={depth.notice.tone} title={t(depth.notice.key)} onDismiss={actions?.onDismissNotice} />}
      {docs.status === 'failed' && <Banner tone="warning" title={t('required.unreadable')} action={<Button size="sm" onClick={actions?.onRetryDocuments}>{t('required.retry')}</Button>} />}
      {docs.status === 'ready' &&
        openMoves(docs.value.moves).map((move) => {
          const state = moveState(move)
          const status = t(`status.${move.toStatus}`)
          return (
            <section key={move.toStatus} className="fw-rf-guards" aria-label={t('required.label', { status })}>
              <Banner
                tone={state.blocks > 0 ? 'danger' : 'warning'}
                title={state.blocks > 0 ? t('required.blocks', { status, count: state.blocks }) : t('required.warns', { status, count: state.warnings })}
              />
              <ul className="fw-rf-guard-list">
                {move.requirements.map((requirement) => (
                  <li key={requirement.ruleId} className="fw-rf-guard">
                    <Tag tone={requirementTone(requirement)}>{t(`required.reason.${requirement.reason}`)}</Tag>
                    <span>
                      {t(`category.${requirement.category}`)}
                      {requirement.reason === 'EXPIRED' && requirement.expiresOn ? ` · ${t('required.expiredOn', { date: formatDate(requirement.expiresOn, { locale }) })}` : ''}
                    </span>
                    <span className="fw-rp-muted fw-rp-small">{t(requirement.level === 'BLOCK' ? 'required.level.BLOCK' : 'required.level.WARN')}</span>
                  </li>
                ))}
              </ul>
              {move.requirements.some((requirement) => requirement.reason !== 'MET') && <p className="fw-rp-muted fw-rp-small">{t('required.how')}</p>}
            </section>
          )
        })}
      {docs.status === 'ready' && docs.value.partyDocuments.length > 0 && (
        <p className="fw-rp-muted fw-rp-small">
          {t('required.partyDocuments', { names: docs.value.partyDocuments.map((doc) => `${doc.name}${doc.expiresOn ? ` (${formatDate(doc.expiresOn, { locale })})` : ''}`).join(', ') })}
        </p>
      )}
    </>
  )
}

/** A file's document type and expiry, beside its audience tags. */
export function DepthTags({ depth, file }: { depth: FileDepthModel | undefined; file: PanelFile }) {
  if (!depth || depth.documents.status !== 'ready') return null
  const info = depth.documents.value.byFile[file.id]
  if (!info) return null
  return (
    <Words>
      <DepthTagsBody category={info.category} expiry={expiryTag(info)} />
    </Words>
  )
}

function DepthTagsBody({ category, expiry }: { category: string | null; expiry: ReturnType<typeof expiryTag> }) {
  const t = useT('record-files')
  const locale = useLocale()
  return (
    <>
      {category && <Tag tone="neutral">{t(`category.${category}`)}</Tag>}
      {expiry && <Tag tone={expiry.tone}>{t(expiry.key, { ...expiry.params, date: formatDate(String(expiry.params.date), { locale }) })}</Tag>}
    </>
  )
}

/** A file's depth actions, each held with its reason. */
export function DepthActions({ depth, file, actions }: { depth: FileDepthModel | undefined; file: PanelFile; actions?: FileDepthActions }) {
  if (!depth) return null
  return (
    <Words>
      <DepthActionsBody depth={depth} file={file} actions={actions} />
    </Words>
  )
}

function DepthActionsBody({ depth, file, actions }: { depth: FileDepthModel; file: PanelFile; actions?: FileDepthActions }) {
  const t = useT('record-files')
  const markHeld = markupHeld(file, depth.canUpload)
  const typeHeld = tagHeld(file, depth.documents)
  return (
    <>
      {file.versionNo !== undefined && (
        <Button size="sm" variant="quiet" onClick={() => actions?.onOpenVersions?.(file.id)} aria-label={t('versions.openNamed', { name: file.name })}>
          <History size={14} aria-hidden /> {t('versions.open')}
        </Button>
      )}
      <Button size="sm" variant="quiet" heldReason={markHeld ? t(markHeld) : null} onClick={() => actions?.onOpenMarkup?.(file.id)} aria-label={t('markup.openNamed', { name: file.name })}>
        <PenLine size={14} aria-hidden /> {t('markup.open')}
      </Button>
      <Button size="sm" variant="quiet" heldReason={typeHeld ? t(typeHeld) : null} onClick={() => actions?.onOpenTag?.(file.id)} aria-label={t('tag.openNamed', { name: file.name })}>
        <CalendarClock size={14} aria-hidden /> {t('tag.open')}
      </Button>
    </>
  )
}

/** The three pop-ups. */
export function DepthDialogs({ depth, actions }: { depth: FileDepthModel | undefined; actions?: FileDepthActions }) {
  if (!depth || (!depth.versions && !depth.tag && !depth.markup)) return null
  return (
    <Words>
      {depth.versions && <VersionsPopup depth={depth} actions={actions} />}
      {depth.tag && <TagPopup depth={depth} actions={actions} />}
      {depth.markup && <MarkupPopup depth={depth} actions={actions} />}
    </Words>
  )
}

const sizeWords = (bytes: number, locale: string): string =>
  bytes >= 1_048_576 ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1_048_576)} MB` : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.max(1, bytes / 1024))} KB`

function VersionsPopup({ depth, actions }: { depth: FileDepthModel; actions?: FileDepthActions }) {
  const t = useT('record-files')
  const locale = useLocale()
  const dialog = depth.versions!
  const rows = dialog.read.status === 'ready' ? dialog.read.value : []
  const held = compareHeld(rows, dialog.picked)
  const typeWord = (type: string) => {
    const word = t(`recordType.${type}`)
    return word === `recordType.${type}` ? type : word
  }
  const who = (row: VersionRow) => (row.addedBy ? (row.fromPartner ? t('versions.byPartner', { name: row.addedBy }) : row.addedBy) : t('versions.bySystem'))
  return (
    <Modal
      open
      onClose={() => actions?.onCloseVersions?.()}
      title={t('versions.title', { name: dialog.name })}
      size="xl"
      footer={
        <>
          <Button onClick={() => actions?.onCloseVersions?.()}>{t('versions.close')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onCompare?.()}>
            <ArrowLeftRight size={14} aria-hidden /> {t('versions.compare')}
          </Button>
        </>
      }
    >
      <div className="fw-rf-versions">
        <p className="fw-rp-muted fw-rp-small">{t('versions.intro')}</p>
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        {dialog.read.status === 'loading' && (
          <p className="fw-rp-loading" role="status">
            <Spinner size={14} /> {t('versions.loading')}
          </p>
        )}
        {dialog.read.status === 'failed' && <Banner tone="danger" title={t(dialog.read.problem)} action={<Button size="sm" onClick={actions?.onRetryVersions}>{t('required.retry')}</Button>} />}
        {dialog.read.status === 'ready' && (
          <SummaryTable
            label={t('versions.tableLabel', { name: dialog.name })}
            density="roomy"
            stackOnPhone
            columns={[t('versions.col.pick'), t('versions.col.version'), t('versions.col.who'), t('versions.col.when'), t('versions.col.size'), t('versions.col.uses'), t('versions.col.actions')]}
            widths={['64px', '18%', '15%', '14%', '11%', undefined, '210px']}
            rows={rows.map((row) => ({
              id: row.id,
              cells: [
                <Checkbox key="pick" aria-label={t('versions.pickNamed', { n: row.versionNo })} checked={dialog.picked.includes(row.id)} onChange={(event) => actions?.onPickVersion?.(row.id, event.target.checked)} />,
                <span key="version" className="fw-rf-version">
                  <strong>{t('versions.number', { n: row.versionNo })}</strong> {row.current ? <Tag tone="success">{t('versions.current')}</Tag> : <Tag tone="neutral">{t('versions.earlier')}</Tag>}
                  <span className="fw-rp-small">{row.name}</span>
                  {row.madeByMarkup && <span className="fw-rp-muted fw-rp-small">{t('versions.madeByMarkup', { count: row.madeByMarkup.marks })}{row.madeByMarkup.note ? `: ${row.madeByMarkup.note}` : ''}</span>}
                  {row.markups > 0 && <span className="fw-rp-muted fw-rp-small">{t('versions.markups', { count: row.markups })}</span>}
                </span>,
                who(row),
                formatDateTime(row.addedAt, { locale }),
                sizeWords(row.sizeBytes, locale),
                row.usedBy.length === 0 ? (
                  <span key="uses" className="fw-rp-muted">{t('versions.usedByNone')}</span>
                ) : (
                  <ul key="uses" className="fw-rf-uses">
                    {row.usedBy.map((use) => (
                      <li key={use.href}>
                        <a href={use.href}>{t('versions.usedBy', { record: use.label ?? typeWord(use.typeKey), n: row.versionNo })}</a>
                      </li>
                    ))}
                  </ul>
                ),
                <span key="actions" className="fw-rf-row-actions">
                  <Button size="sm" variant="quiet" onClick={() => actions?.onPreviewVersion?.(row.id)} heldReason={row.status !== 'AVAILABLE' ? t('versions.held.notAvailable') : null}>
                    {t('versions.preview')}
                  </Button>
                  <Button size="sm" heldReason={row.restoreHeld ? t(row.restoreHeld) : dialog.busy ? t('versions.held.busy') : null} onClick={() => actions?.onRestore?.(row.id)}>
                    {t('versions.restore')}
                  </Button>
                </span>,
              ],
            }))}
          />
        )}
        {dialog.compare && (
          <section className="fw-rf-compare" aria-label={t('versions.compareLabel')}>
            {dialog.compare.status === 'loading' && (
              <p className="fw-rp-loading" role="status">
                <Spinner size={14} /> {t('versions.compareLoading')}
              </p>
            )}
            {dialog.compare.status === 'failed' && <Banner tone="danger" title={t(dialog.compare.problem)} />}
            {dialog.compare.status === 'ready' &&
              dialog.compare.value.map((picture) => (
                <figure key={picture.versionNo} className="fw-rf-figure">
                  <img src={picture.src} alt={t('versions.pictureAlt', { n: picture.versionNo, name: dialog.name })} />
                  <figcaption>{t('versions.number', { n: picture.versionNo })}</figcaption>
                </figure>
              ))}
            <div className="fw-rf-compare-close">
              <Button size="sm" variant="quiet" onClick={() => actions?.onCloseCompare?.()}>
                {t('versions.compareClose')}
              </Button>
            </div>
          </section>
        )}
      </div>
    </Modal>
  )
}

function TagPopup({ depth, actions }: { depth: FileDepthModel; actions?: FileDepthActions }) {
  const t = useT('record-files')
  const locale = useLocale()
  const dialog = depth.tag!
  return (
    <Modal
      open
      onClose={() => actions?.onCloseTag?.()}
      title={t('tag.title', { name: dialog.name })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onCloseTag?.()}>{t('tag.cancel')}</Button>
          <Button variant="primary" heldReason={dialog.busy ? t('tag.saving') : null} onClick={() => actions?.onSaveTag?.()}>
            {t('tag.save')}
          </Button>
        </>
      }
    >
      <div className="fw-rf-form">
        <p className="fw-rp-muted fw-rp-small">{t('tag.intro')}</p>
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        <Field label={t('tag.category')} hint={t('tag.categoryHint')}>
          <Select value={dialog.category ?? ''} onChange={(event) => actions?.onTagDraft?.({ category: event.target.value === '' ? null : event.target.value })}>
            <option value="">{t('tag.categoryNone')}</option>
            {CATEGORY_CHOICES.map((category) => (
              <option key={category} value={category}>
                {t(`category.${category}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('tag.expiresOn')} hint={t('tag.expiresHint')}>
          <DateField value={dialog.expiresOn} onChange={(value) => actions?.onTagDraft?.({ expiresOn: value })} locale={locale} clearable clearLabel={t('tag.noExpiry')} ariaLabel={t('tag.expiresOn')} />
        </Field>
      </div>
    </Modal>
  )
}

function MarkupPopup({ depth, actions }: { depth: FileDepthModel; actions?: FileDepthActions }) {
  const t = useT('record-files')
  const locale = useLocale()
  const photoWords = usePhotoWords()
  const dialog = depth.markup!
  const onPage = dialog.markups.status === 'ready' ? dialog.markups.value.filter((item) => dialog.target !== 'pdf' || item.page === dialog.page) : []
  const image = dialog.image.status === 'ready' ? dialog.image.value : null
  return (
    <Modal open onClose={() => actions?.onCloseMarkup?.()} title={t('markup.title', { name: dialog.name })} size="xl" footer={<Button onClick={() => actions?.onCloseMarkup?.()}>{t('markup.close')}</Button>}>
      <div className="fw-rf-markup">
        <p className="fw-rp-muted fw-rp-small">{t(dialog.target === 'pdf' ? 'markup.introPdf' : 'markup.introPicture')}</p>
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        {dialog.target === 'pdf' && (
          <div className="fw-rf-pages" role="group" aria-label={t('markup.pagesLabel')}>
            <Button size="sm" heldReason={dialog.page <= 1 ? t('markup.held.firstPage') : null} onClick={() => actions?.onMarkupPage?.(dialog.page - 1)}>
              {t('markup.previousPage')}
            </Button>
            <span aria-live="polite">{dialog.pages ? t('markup.pageOf', { page: dialog.page, pages: dialog.pages }) : t('markup.page', { page: dialog.page })}</span>
            <Button size="sm" heldReason={dialog.pages !== null && dialog.page >= dialog.pages ? t('markup.held.lastPage') : null} onClick={() => actions?.onMarkupPage?.(dialog.page + 1)}>
              {t('markup.nextPage')}
            </Button>
          </div>
        )}
        <div className="fw-rf-markup-grid">
          <div className="fw-rf-markup-draw">
            {/* The note first: it is sent with the marks. */}
            <Field label={t('markup.note')} hint={t('markup.noteHint')}>
              <Textarea value={dialog.note} rows={2} limit={2000} onChange={(event) => actions?.onMarkupNote?.(event.target.value)} />
            </Field>
            {dialog.image.status === 'loading' && (
              <p className="fw-rp-loading" role="status">
                <Spinner size={14} /> {t(dialog.target === 'pdf' ? 'markup.loadingPage' : 'markup.loadingPicture')}
              </p>
            )}
            {dialog.image.status === 'failed' && <Banner tone="danger" title={t(dialog.image.problem)} />}
            {image && (
              <PhotoCapture
                key={image.src}
                label={t('markup.surface', { name: dialog.name })}
                defaultPhoto={image}
                markup
                guide="none"
                facesHint={false}
                heldReason={dialog.busy ? t('markup.saving') : null}
                useHeldReason={(marks) => {
                  const held = markupSaveHeld(marks)
                  return held ? t(held) : null
                }}
                words={{ ...photoWords, usePhoto: t(dialog.target === 'pdf' ? 'markup.savePdf' : 'markup.savePicture') }}
                onCapture={(photo) => actions?.onSaveMarkup?.(photo)}
              />
            )}
          </div>
          <aside className="fw-rf-markup-list" aria-label={t('markup.earlierLabel')}>
            <h3 className="fw-rf-h">{t(dialog.target === 'pdf' ? 'markup.earlierPage' : 'markup.earlier')}</h3>
            {dialog.markups.status === 'loading' && <Spinner size={14} />}
            {dialog.markups.status === 'failed' && <Banner tone="warning" title={t(dialog.markups.problem)} />}
            {dialog.markups.status === 'ready' && onPage.length === 0 && <p className="fw-rp-muted fw-rp-small">{t('markup.none')}</p>}
            {image && dialog.target === 'pdf' && onPage.length > 0 && <MarkSketch src={image.src} width={image.width} height={image.height} marks={onPage.flatMap((item) => item.marks)} label={t('markup.overlayLabel', { page: dialog.page })} />}
            <ul className="fw-rf-markup-items">
              {onPage.map((item: MarkupItem) => (
                <li key={item.id}>
                  <span>{item.note ?? t('markup.noNote')}</span>
                  <span className="fw-rp-muted fw-rp-small">
                    {t('markup.itemMeta', { who: item.by ?? t('versions.bySystem'), at: formatDateTime(item.at, { locale }), count: item.marks.length })}
                    {item.versionNo !== null ? ` · ${t('versions.number', { n: item.versionNo })}` : ''}
                    {item.madeVersion ? ` · ${t('markup.madeVersion')}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </div>
    </Modal>
  )
}
