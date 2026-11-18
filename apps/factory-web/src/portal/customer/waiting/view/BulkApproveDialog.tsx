'use client'

import { AlertCircle, FileText, ImageIcon } from 'lucide-react'
import { Banner, ChangeReview, KeyValue, type ChangeReviewItem } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { SignBlock } from '@nexus/ui/components/SignBlock/index'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatDateTime, DEFAULT_TIME_ZONE } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../lib/pdf/labels'
import type { ApproveResult, ApproveRow } from '../../production/bulk/approve-model'
import '../waiting.css'

/**
 * F-PR-23b — Approve N from My production, beside F-PR-14's answer dialogs (one answering family; production plan §3 "Bulk 'Approve'
 * cannot be undone; the dialog says so before Send"; lead pick L26; 17-web-r2 §1.5): one list of the approvals waiting on the picked
 * orders, each with its photo or PDF (opened here, one at a time), ticked one by one (DS ChangeReview); a row this person may not
 * answer is held with why (a price: your buyer; a named approver: Waiting for <name>; "Open it to answer"); the words that it cannot
 * be undone stand above the typed name (DS SignBlock), which signs every ticked approval; after Send one result per approval.
 * A DS Modal (a sheet on a phone); while sending it cannot be closed.
 */

export interface BulkApproveFile {
  readonly id: string
  readonly name: string
  readonly state: 'loading' | 'error' | 'ready'
  readonly src: Uint8Array | string | null
  readonly pdf: boolean
}

export interface BulkApproveDialogModel {
  readonly state: 'loading' | 'error' | 'ready'
  /** Why the list could not be read (words), with Try again. */
  readonly readProblem: string | null
  /** How many of the picked orders are named. */
  readonly orders: number
  readonly rows: readonly ApproveRow[]
  readonly ticked: readonly string[]
  /** More approvals wait on these orders than the list holds: Waiting for you (an address), else null. */
  readonly more: string | null
  /** "A signed approval cannot be undone here …" in the person's language (the API's words), said before Send. */
  readonly undo: string
  readonly phase: 'edit' | 'sending' | 'done'
  /** Why Approve waits, in words; null: it signs. */
  readonly held: string | null
  /** A send that did not go (Approve tries again with the same key). */
  readonly problem: string | null
  readonly results: readonly ApproveResult[] | null
  readonly doneLine: { readonly line: string; readonly tone: 'success' | 'warning' | 'danger' } | null
  /** The photo or PDF open in the dialog. */
  readonly file: BulkApproveFile | null
}

export interface BulkApproveActions {
  onTick?: (ids: string[]) => void
  onOpenFile?: (fileId: string | null) => void
  onRetry?: () => void
  onSign?: (typedName: string) => void
  onClose?: () => void
}

export const WAITING_NS = 'portal-waiting'

export function BulkApproveDialog({ model, actions }: { model: BulkApproveDialogModel; actions?: BulkApproveActions }) {
  const t = useT(WAITING_NS)
  const shell = useT('shell')
  const locale = useLocale()
  const at = (iso: string) => formatDateTime(iso, { locale, timeZone: DEFAULT_TIME_ZONE })
  const sending = model.phase === 'sending'
  const done = model.phase === 'done'
  const items: ChangeReviewItem[] = model.rows.map((row) => ({
    id: row.id,
    label: row.label,
    status: row.held ? <Tag tone="neutral">{row.held}</Tag> : <Tag tone="warning">{t('bulk.dueBy', { date: at(row.dueAt) })}</Tag>,
    note: row.question,
    selectable: row.held === null,
    values: [
      { label: t('bulk.orders'), value: row.orders },
      ...row.facts.map((fact) => ({ label: fact.label, value: fact.value })),
      ...(row.files.length > 0
        ? [
            {
              label: t('bulk.files'),
              value: (
                <span className="fw-pwait-bulk-files">
                  {row.files.map((file) => (
                    <Button key={file.id} size="sm" aria-pressed={model.file?.id === file.id} aria-label={t('bulk.openFile', { name: file.name })} onClick={() => actions?.onOpenFile?.(model.file?.id === file.id ? null : file.id)}>
                      {file.picture ? <ImageIcon size={14} aria-hidden /> : <FileText size={14} aria-hidden />} {file.name}
                    </Button>
                  ))}
                </span>
              ),
            },
          ]
        : []),
    ],
  }))
  const file = model.file
  return (
    <Modal
      open
      sheet
      size="lg"
      onClose={() => actions?.onClose?.()}
      closeHeld={sending ? t('bulk.sending') : null}
      initialFocus="dialog"
      title={done ? t('bulk.doneTitle') : t('bulk.title', { count: model.orders })}
      footer={
        done || model.state !== 'ready' || model.rows.length === 0 ? (
          <Button variant="primary" onClick={() => actions?.onClose?.()}>
            {t('bulk.close')}
          </Button>
        ) : undefined
      }
    >
      <div className="fw-pwait-bulk">
        {model.state === 'loading' ? (
          <div className="fw-pwait-loading" role="status" aria-label={t('bulk.loading')}>
            <Skeleton height={72} />
            <Skeleton height={72} />
          </div>
        ) : model.state === 'error' ? (
          <div className="fw-pwait-bulk-state" role="alert">
            <AlertCircle size={18} aria-hidden />
            <span>{model.readProblem ?? t('bulk.failed')}</span>
            {actions?.onRetry ? <Button onClick={actions.onRetry}>{t('retry')}</Button> : null}
          </div>
        ) : done && model.results ? (
          <>
            {model.doneLine ? <Banner tone={model.doneLine.tone} title={model.doneLine.line} /> : null}
            <KeyValue labelCase="sentence" items={model.results.map((result) => ({ label: result.label, value: <Tag tone={result.tone}>{result.words}</Tag> }))} />
          </>
        ) : model.rows.length === 0 ? (
          <Banner tone="info" title={t('bulk.none')} />
        ) : (
          <>
            <p className="fw-pwait-bulk-sub">{t('bulk.hint')}</p>
            <ChangeReview label={t('bulk.listLabel')} items={items} selectedIds={[...model.ticked]} disabled={sending} onSelectionChange={(ids) => actions?.onTick?.(ids)} />
            {model.more ? (
              <p className="fw-pwait-bulk-sub">
                {t('bulk.more')}{' '}
                <a href={model.more}>{t('bulk.moreLink')}</a>
              </p>
            ) : null}
            {file ? (
              <section className="fw-pwait-bulk-file" aria-label={file.name}>
                {file.state === 'loading' ? (
                  <p className="fw-pwait-bulk-sub" role="status">
                    {t('bulk.fileLoading', { name: file.name })}
                  </p>
                ) : file.state === 'error' || !file.src ? (
                  <Banner tone="warning" title={t('bulk.fileFailed', { name: file.name })} action={<Button size="sm" onClick={() => actions?.onOpenFile?.(file.id)}>{t('retry')}</Button>} />
                ) : file.pdf && file.src instanceof Uint8Array ? (
                  <PdfViewer src={file.src} title={file.name} fileName={file.name} labels={pdfViewerLabels(shell)} height="min(60vh, 640px)" />
                ) : typeof file.src === 'string' ? (
                  <img className="fw-pwait-bulk-img" src={file.src} alt={file.name} />
                ) : null}
                <Button size="sm" variant="quiet" onClick={() => actions?.onOpenFile?.(null)}>
                  {t('bulk.fileClose')}
                </Button>
              </section>
            ) : null}
            <SignBlock
              title={<span className="fw-pwait-bulk-title">{t('bulk.sign.title')}</span>}
              summary={<p className="fw-pwait-bulk-sub">{t('bulk.sign.summary', { count: model.ticked.length })}</p>}
              legal={<Banner tone="warning" title={model.undo} />}
              nameLabel={t('bulk.sign.name')}
              nameHint={t('bulk.sign.nameHint')}
              nameEmptyLabel={t('bulk.sign.nameEmpty')}
              acceptLabel={t('bulk.sign.go', { count: model.ticked.length })}
              onAccept={(signed) => actions?.onSign?.(signed.name)}
              state={sending ? 'busy' : 'idle'}
              busyLabel={t('bulk.sending')}
              heldReason={model.held}
              message={model.problem ?? undefined}
              messageTone="danger"
            />
          </>
        )}
      </div>
    </Modal>
  )
}
