'use client'

import { useEffect, useMemo, useState } from 'react'
import { Download, Eye, FileText, Image as ImageIcon, Trash2, Tablet } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Checkbox, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { FileDropzone, FileRow, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { TIME_ZONE, type Words } from '../../../_shared/model'
import type { Loaded } from '../../../_shared/parts'
import { DOCUMENT_GROUPS, type DocumentGroup, type DocumentsAnswer, type MachineDocument } from '../api'
import { documentsByGroup, isImage, isPdf, sizeWords } from '../model'
import { useDepthWords, useSay } from '../parts'

export interface DocumentsState {
  loaded: Loaded<DocumentsAnswer>
  /** The upload card: the group a picked file goes in, whether the site's tablets see it. */
  upload: { group: DocumentGroup; onTablets: boolean; busy: boolean; problem: Words | null; done: string | null }
  /** A file open for a look: its bytes once read. */
  viewer: { document: MachineDocument; bytes: Uint8Array | null; url: string | null; problem: Words | null } | null
  remove: { document: MachineDocument; reason: string; busy: boolean; problem: Words | null } | null
}

export interface DocumentsActions {
  onRetry?: () => void
  onGroup?: (group: DocumentGroup) => void
  onTablets?: (on: boolean) => void
  onFiles?: (files: File[]) => void
  onView?: (document: MachineDocument) => void
  onDownload?: (document: MachineDocument) => void
  onCloseViewer?: () => void
  onRemove?: (document: MachineDocument) => void
  onRemoveReason?: (reason: string) => void
  onRemoveSubmit?: () => void
  onCloseRemove?: () => void
}

const ACCEPT: Readonly<Record<DocumentGroup, string>> = { MACHINE_CE: '.pdf,.jpg,.jpeg,.png', MANUAL: '.pdf', PHOTO: '.jpg,.jpeg,.png,.webp,.heic', OTHER: '.pdf,.jpg,.jpeg,.png,.webp' }
const MAX_BYTES = 25 * 1024 * 1024

/**
 * Machine › Documents & CE (design plant.machines rec:Machine/docs; QHS-165; D.Lgs. 81/2008 art. 71 c.4): the machine's
 * files grouped by kind — the CE declaration, the manuals, the photos, the rest (diagrams, wiring, settings sheets) —
 * each with its size, its day, whether the site's tablets see it ("at hand where it works") and the virus scan; a missing
 * CE declaration is flagged first. View opens a PDF in the DS PdfViewer (a photo as it is); Upload files one in its group;
 * Remove asks the reason. Paper today: nothing refuses a machine without its CE declaration, the tab says what is missing.
 */
export function DocumentsTab({ state, canManage, actions }: { state: DocumentsState; canManage: boolean; actions?: DocumentsActions }) {
  const t = useDepthWords()
  const say = useSay()
  const locale = useLocale()
  const loaded = state.loaded
  if (loaded.status === 'loading') {
    return (
      <Card padded aria-busy="true">
        <p className="fw-md-muted" role="status">
          <Spinner size={14} /> {t('docs.loading')}
        </p>
        <div className="fw-md-stack tight">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} height={36} />
          ))}
        </div>
      </Card>
    )
  }
  if (loaded.status !== 'ready') {
    return (
      <Card padded>
        <EmptyState
          title={t('docs.failed')}
          description={loaded.status === 'error' ? say({ key: loaded.problem }) : loaded.status === 'forbidden' ? t('docs.forbidden') : t('docs.notFound')}
          action={loaded.status === 'error' ? <Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button> : undefined}
        />
      </Card>
    )
  }
  const answer = loaded.value
  const manage = canManage && answer.canManage
  const groups = documentsByGroup(answer.documents)
  const upload = state.upload
  return (
    <div className="fw-md-stack">
      {!answer.ceOnFile && (
        <Banner tone="warning" title={t('docs.noCeTitle')}>
          {t(manage ? 'docs.noCeBody' : 'docs.noCeBodyRead')}
        </Banner>
      )}
      <div className="fw-md-split">
        <div className="fw-md-stack">
          {answer.documents.length === 0 ? (
            <Card padded>
              <EmptyState icon={<FileText size={22} aria-hidden />} title={t('docs.emptyTitle')} description={t('docs.empty')} />
            </Card>
          ) : (
            groups.map(({ group, documents }) => (
              <Card key={group} padded>
                <section className="fw-md-stack tight" aria-label={t(`docs.group.${group}`)}>
                  <h3 className="fw-md-h3">
                    {t(`docs.group.${group}`)} <span className="fw-md-muted">{documents.length}</span>
                  </h3>
                  {documents.length === 0 ? (
                    <p className="fw-md-muted">{t(group === 'MACHINE_CE' ? 'docs.groupEmptyCe' : 'docs.groupEmpty')}</p>
                  ) : (
                    <ul className="fw-md-plain fw-md-files">
                      {documents.map((document) => (
                        <li key={document.id}>
                          <FileRow
                            name={document.originalName}
                            size={document.sizeBytes}
                            tone={document.status === 'QUARANTINED' ? 'danger' : 'neutral'}
                            status={
                              <span className="fw-md-row">
                                <span>{t('docs.added', { date: formatDate(document.createdAt, { locale, timeZone: TIME_ZONE }), size: sizeWords(document.sizeBytes, locale) })}</span>
                                {document.onTablets && (
                                  <Tag tone="info">
                                    <Tablet size={11} aria-hidden /> {t('docs.onTablets')}
                                  </Tag>
                                )}
                                {document.status === 'QUARANTINED' ? <Tag tone="danger">{t('docs.quarantined')}</Tag> : document.scanStatus === 'PENDING' ? <Tag tone="neutral">{t('docs.scanning')}</Tag> : null}
                              </span>
                            }
                            actions={
                              <>
                                <Button size="sm" variant="quiet" aria-label={t('docs.viewOne', { name: document.originalName })} heldReason={document.status !== 'AVAILABLE' ? t('docs.held.notAvailable') : null} onClick={() => actions?.onView?.(document)}>
                                  <Eye size={13} aria-hidden /> {t('docs.view')}
                                </Button>
                                <Button size="sm" variant="quiet" aria-label={t('docs.downloadOne', { name: document.originalName })} heldReason={document.status !== 'AVAILABLE' ? t('docs.held.notAvailable') : null} onClick={() => actions?.onDownload?.(document)}>
                                  <Download size={13} aria-hidden />
                                </Button>
                                <Button size="sm" variant="quiet" aria-label={t('docs.removeOne', { name: document.originalName })} heldReason={manage ? null : t('docs.held.noManage')} onClick={() => actions?.onRemove?.(document)}>
                                  <Trash2 size={13} aria-hidden />
                                </Button>
                              </>
                            }
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </Card>
            ))
          )}
        </div>
        <Card padded>
          <section className="fw-md-stack tight" aria-label={t('docs.uploadTitle')}>
            <h3 className="fw-md-h3">{t('docs.uploadTitle')}</h3>
            {!manage ? (
              <p className="fw-md-muted">{t('docs.uploadHeld')}</p>
            ) : (
              <>
                <Field label={t('docs.groupLabel')}>
                  <Select value={upload.group} onChange={(event) => actions?.onGroup?.(event.target.value as DocumentGroup)} disabled={upload.busy}>
                    {DOCUMENT_GROUPS.map((group) => (
                      <option key={group} value={group}>
                        {t(`docs.group.${group}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Checkbox checked={upload.onTablets} disabled={upload.busy} onChange={(event) => actions?.onTablets?.(event.target.checked)} label={t('docs.tabletsLabel')} />
                <p className="fw-md-muted">{t('docs.tabletsHint')}</p>
                <FileDropzone accept={ACCEPT[upload.group]} maxBytes={MAX_BYTES} disabled={upload.busy} onFiles={(files) => actions?.onFiles?.(files)} />
                {upload.busy && (
                  <p className="fw-md-muted" role="status">
                    <Spinner size={12} /> {t('docs.uploading')}
                  </p>
                )}
                {upload.problem && <Banner tone="danger" title={say(upload.problem) ?? ''} />}
                {upload.done && <Banner tone="success" title={t('docs.uploaded', { name: upload.done })} />}
              </>
            )}
            <p className="fw-md-muted">{t('docs.law')}</p>
          </section>
        </Card>
      </div>
      {state.viewer && <DocumentViewer viewer={state.viewer} onClose={actions?.onCloseViewer} onDownload={() => actions?.onDownload?.(state.viewer!.document)} />}
      {state.remove && (
        <Modal
          open
          onClose={() => actions?.onCloseRemove?.()}
          title={t('docs.removeTitle', { name: state.remove.document.originalName })}
          size="sm"
          footer={
            <>
              <Button onClick={() => actions?.onCloseRemove?.()}>{t('common.cancel')}</Button>
              <Button variant="danger" heldReason={state.remove.reason.trim().length < 3 ? t('docs.held.reason') : state.remove.busy ? t('held.busy') : null} onClick={() => actions?.onRemoveSubmit?.()}>
                {state.remove.busy ? <Spinner size={12} /> : <Trash2 size={13} aria-hidden />} {t('docs.remove')}
              </Button>
            </>
          }
        >
          <div className="fw-md-form">
            <p className="fw-md-muted">{t(state.remove.document.group === 'MACHINE_CE' ? 'docs.removeCeBody' : 'docs.removeBody')}</p>
            {state.remove.problem && <Banner tone="danger" title={say(state.remove.problem) ?? ''} />}
            <Field label={t('docs.removeReason')} required>
              <Textarea rows={2} maxLength={500} value={state.remove.reason} onChange={(event) => actions?.onRemoveReason?.(event.target.value)} />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  )
}

function DocumentViewer({ viewer, onClose, onDownload }: { viewer: NonNullable<DocumentsState['viewer']>; onClose?: (() => void) | undefined; onDownload: () => void }) {
  const t = useDepthWords()
  const shell = useT('shell')
  const say = useSay()
  const document = viewer.document
  const [imageUrl, setImageUrl] = useState<string | null>(viewer.url)
  const bytes = viewer.bytes
  const pdf = useMemo(() => (bytes && isPdf(document) ? bytes : null), [bytes, document])
  useEffect(() => {
    if (!bytes || !isImage(document) || viewer.url) return
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: document.contentType }))
    setImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [bytes, document, viewer.url])
  return (
    <Modal open onClose={() => onClose?.()} title={document.originalName} size="xl" footer={<Button onClick={() => onClose?.()}>{t('common.close')}</Button>}>
      {viewer.problem ? (
        <Banner tone="danger" title={t('docs.viewFailed')}>
          {say(viewer.problem)}
        </Banner>
      ) : !bytes && !viewer.url ? (
        <p className="fw-md-muted" role="status">
          <Spinner size={14} /> {t('docs.reading')}
        </p>
      ) : pdf ? (
        <PdfViewer src={pdf} title={document.originalName} fileName={document.originalName} onDownload={onDownload} labels={pdfViewerLabels(shell)} height="70vh" />
      ) : isImage(document) && imageUrl ? (
        <img className="fw-md-photo" src={imageUrl} alt={document.originalName} />
      ) : (
        <EmptyState icon={<ImageIcon size={22} aria-hidden />} title={t('docs.noPreview')} description={t('docs.noPreviewBody')} action={<Button size="sm" onClick={onDownload}>{t('docs.download')}</Button>} />
      )}
    </Modal>
  )
}
