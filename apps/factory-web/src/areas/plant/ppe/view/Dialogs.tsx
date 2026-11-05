'use client'

import { Archive, Ban, Upload } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { PPE_LIMITS } from '@nexus/factory-domain/safety/ppe/rules'
import { FileDropzone, FileRow, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { itemName, SCAN_ACCEPT, scanTypeOk, voidHeld } from '../model'
import type { ArchiveManyState, PpePageActions, PpePageModel, ScanState, VoidState } from '../view-model'
import { problemText, useWhen, useWords } from './parts'

const MAX_SCAN = 20 * 1024 * 1024

/**
 * Void an issue (design pop:void, from an Issues row): what is voided (the line, its person, its receipt), what it means — the
 * line stays on its receipt with a void mark and the reason, the person no longer holds it, nothing is deleted, a void cannot
 * be taken back (a new issue hands it over again) — and the reason. Composed from the DS Modal: the DS ActionConfirm has no
 * field for a typed reason. Esc closes; the focus returns to the opener.
 */
export function VoidDialog({ model, state, actions }: { model: PpePageModel; state: VoidState; actions?: PpePageActions | undefined }) {
  const t = useWords()
  const when = useWhen()
  const locale = useLocale()
  const close = () => actions?.onAddress?.({ void: null })
  const line = model.issues.status === 'ready' ? (model.issues.value.issues.find((row) => row.id === state.issueId) ?? null) : null
  const held = voidHeld(state.reason, state.busy, line)
  return (
    <Modal
      open
      onClose={close}
      title={t('void.title')}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="danger" heldReason={held ? t(held) : null} onClick={() => actions?.onVoid?.()}>
            {state.busy ? <Spinner size={12} /> : <Ban size={13} aria-hidden />} {t('void.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-ppe-form">
        {line ? (
          <p>
            <strong>{t('void.what', { item: itemName(line.item, locale), size: line.size ?? t('issues.oneSize'), count: line.quantity })}</strong>
            <br />
            <span className="fw-ppe-muted">{t('void.whom', { name: line.employee.name, when: when(line.issuedAt), method: t(`method.${line.method}`) })}</span>
          </p>
        ) : (
          <p className="fw-ppe-muted">{t(model.issues.status === 'loading' ? 'common.reading' : 'held.lineGone')}</p>
        )}
        <ul className="fw-ppe-list">
          <li>{t('void.stays')}</li>
          <li>{t('void.holds')}</li>
          <li>{t('void.never')}</li>
        </ul>
        <Field label={t('void.reason')} required hint={t('void.reasonHint')}>
          <Textarea value={state.reason} rows={3} maxLength={PPE_LIMITS.reason} onChange={(event) => actions?.onVoidReason?.(event.target.value)} />
        </Field>
        {state.problem && <Banner tone="danger" title={problemText(t, state.problem)} />}
      </div>
    </Modal>
  )
}

/**
 * The signed paper's scan, added to a receipt recorded without it (Issues › "Add the signed scan"; files.upload): the receipt it
 * goes on, the file (a PDF or a photo). Once the file is AVAILABLE the receipt reads "Signed on paper".
 */
export function ScanDialog({ model, state, actions }: { model: PpePageModel; state: ScanState; actions?: PpePageActions | undefined }) {
  const t = useWords()
  const when = useWhen()
  const locale = useLocale()
  const close = () => actions?.onAddress?.({ scan: null })
  const lines = model.issues.status === 'ready' ? model.issues.value.issues.filter((row) => row.receiptId === state.receiptId) : []
  const head = lines[0] ?? null
  const held = state.busy ? 'held.busy' : !model.can.upload ? 'held.upload' : !state.file ? 'held.scanFile' : !scanTypeOk(state.file.type, state.file.name) ? 'held.scanType' : head && head.receipt.state !== 'NOT_SIGNED' ? 'held.scanDone' : null
  return (
    <Modal
      open
      onClose={close}
      title={t('scan.title')}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onUploadScan?.()}>
            {state.busy ? <Spinner size={12} /> : <Upload size={13} aria-hidden />} {t('scan.upload')}
          </Button>
        </>
      }
    >
      <div className="fw-ppe-form">
        {head ? (
          <p>
            <strong>{t('scan.receiptOf', { name: head.employee.name, when: when(head.issuedAt) })}</strong>
            <br />
            <span className="fw-ppe-muted">{lines.map((line) => `${itemName(line.item, locale)} ×${line.quantity}`).join(', ')}</span>
          </p>
        ) : (
          <p className="fw-ppe-muted">{t(model.issues.status === 'loading' ? 'common.reading' : 'held.lineGone')}</p>
        )}
        <p className="fw-ppe-muted">{t('scan.why')}</p>
        {state.file ? (
          <FileRow name={state.file.name} size={state.file.size} status={scanTypeOk(state.file.type, state.file.name) ? t('issue.scanReady') : t('held.scanType')} tone={scanTypeOk(state.file.type, state.file.name) ? 'neutral' : 'danger'} onRemove={() => actions?.onScanFile?.(null)} />
        ) : (
          <FileDropzone
            accept={SCAN_ACCEPT}
            maxBytes={MAX_SCAN}
            hint={t('issue.scanHint')}
            disabled={!model.can.upload}
            onFiles={(files) => {
              const file = files[0]
              if (file) actions?.onScanFile?.(file)
            }}
          />
        )}
        {state.problem && <Banner tone="danger" title={problemText(t, state.problem)} />}
      </div>
    </Modal>
  )
}

/** Archive N: the items chosen, one call each (an item a role kit names was never selectable); what was refused is said. */
export function ArchiveManyDialog({ model, state, actions }: { model: PpePageModel; state: ArchiveManyState; actions?: PpePageActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const rows = (model.items.status === 'ready' ? model.items.value.items : []).filter((row) => state.ids.includes(row.id))
  return (
    <Modal
      open
      onClose={() => actions?.onArchiveMany?.(null)}
      title={t('archive.title', { count: rows.length })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onArchiveMany?.(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={state.busy ? t('held.busy') : rows.length === 0 ? t('held.noneArchivable') : null} onClick={() => actions?.onApplyArchiveMany?.()}>
            {state.busy ? <Spinner size={12} /> : <Archive size={13} aria-hidden />} {t('bulk.archive', { count: rows.length })}
          </Button>
        </>
      }
    >
      <div className="fw-ppe-form">
        <ul className="fw-ppe-list">
          {rows.map((row) => (
            <li key={row.id}>{`${row.code} · ${itemName(row, locale)}`}</li>
          ))}
        </ul>
        <p className="fw-ppe-muted">{t('archive.kept')}</p>
      </div>
    </Modal>
  )
}
