'use client'

import { Lock, Paperclip, RotateCw } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Checkbox } from '@nexus/ui/primitives'
import { FileDropzone, FileRow } from '../../i18n/ds-parts'
import { useT } from '../../i18n/provider'
import { filesOutcome, heldCount, takesSheetTick, uploading, type HeldFile } from '../files'
import { COMPOSE_NS } from '../model'
import '../request-compose.css'

/**
 * B-TH-282 — the customer's files (P-CUS-NEW.files, X-P-CUS-REQ.thread "files after the scanner"; T6-F05, T6-F08): a drop area
 * (drop, paste, browse; the phone's camera through the picker), each file with its name, size and state — waiting to go,
 * uploading, sent, held for the virus scan, failed with its words and Retry, refused with why (SVG naming the way out); a PDF or
 * a photo with "This is a measurement sheet" (body data); a design file "kept as it is, download only". While uploads from
 * outside are closed the area says the API's own sentence and takes nothing (production until the virus scanner). New order
 * holds them ("They go right after Send"); the request page sends them at once. Draws its model; the container uploads.
 */

export interface ComposeFilesModel {
  /** Uploads are open; else `closedWords` (the API's own sentence) stands in place of the drop area. */
  open: boolean
  closedWords: string | null
  held: readonly HeldFile[]
  /** Files left out of the last drop (more than 20). */
  leftOut: number
  /** `hold`: New order (they go after Send); `send`: the request page (they go now). */
  when: 'hold' | 'send'
  /** Read only (an office preview of the portal, or offline): nothing is added. */
  readOnly: boolean
  /** Why nothing can be added now, in words (offline, a preview), or null. */
  heldReason?: string | null
}

export interface ComposeFilesActions {
  onDrop?: (files: File[]) => void
  onSheet?: (key: string, sheet: boolean) => void
  onRemove?: (key: string) => void
  onRetry?: () => void
  /** The request page: send what was added. */
  onSend?: () => void
}

export function ComposeFiles({ model, actions, title = true }: { model: ComposeFilesModel; actions?: ComposeFilesActions; title?: boolean }) {
  const t = useT(COMPOSE_NS)
  const busy = uploading(model.held)
  const outcome = filesOutcome(model.held)
  const count = heldCount(model.held)
  const locked = model.readOnly || busy
  return (
    <div className="fw-rqc-files is-open" role="group" aria-labelledby="fw-rqc-files-title">
      <div className="fw-rqc-files-head">
        <Paperclip size={18} aria-hidden />
        <div className="fw-rqc-files-text">
          {title ? (
            <span id="fw-rqc-files-title" className="fw-rqc-files-title">
              {count > 0 ? t('files.titleCount', { count }) : t('files.title')}
            </span>
          ) : (
            <span id="fw-rqc-files-title" className="nds-vh">
              {t('files.title')}
            </span>
          )}
          <span>{model.open ? t(model.when === 'hold' ? 'files.hintHold' : 'files.hintSend') : (model.closedWords ?? t('files.closed'))}</span>
        </div>
      </div>
      {model.open ? (
        <FileDropzone multiple disabled={locked} onFiles={(files) => actions?.onDrop?.(files)} hint={model.heldReason ?? t('files.drop')} />
      ) : (
        <p className="fw-rqc-files-closed">
          <Lock size={14} aria-hidden /> {t('files.closedShort')}
        </p>
      )}
      {model.leftOut > 0 && <Banner tone="warning" title={t('files.leftOut', { count: model.leftOut })} />}
      {model.held.length > 0 && (
        <ul className="fw-rqc-files-list" aria-label={t('files.listLabel')}>
          {model.held.map((file) => (
            <li key={file.key}>
              <FileRow
                name={file.name}
                size={file.sizeBytes}
                tone={file.problem || file.state === 'failed' ? 'danger' : 'neutral'}
                status={statusOf(file, t)}
                {...(file.state === 'held' || file.state === 'failed' || file.problem ? (locked ? {} : { onRemove: () => actions?.onRemove?.(file.key) }) : {})}
                labels={{ remove: t('files.remove', { name: file.name }) }}
              />
              {takesSheetTick(file) && (
                <Checkbox
                  className="fw-rqc-files-sheet"
                  label={
                    <span>
                      {t('files.sheet')} <span className="fw-rqc-quiet">· {t('files.sheetHint')}</span>
                    </span>
                  }
                  checked={file.sheet}
                  disabled={locked || (file.state !== 'held' && file.state !== 'failed')}
                  onChange={(event) => actions?.onSheet?.(file.key, event.target.checked)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {(outcome.failed > 0 || (model.when === 'send' && outcome.waiting > 0)) && (
        <div className="fw-rqc-files-actions">
          {outcome.failed > 0 && (
            <Button size="sm" heldReason={busy ? t('files.state.uploading') : model.readOnly ? (model.heldReason ?? null) : null} onClick={() => actions?.onRetry?.()}>
              <RotateCw size={13} aria-hidden /> {t('files.retry', { count: outcome.failed })}
            </Button>
          )}
          {model.when === 'send' && outcome.waiting > 0 && (
            <Button size="sm" variant="primary" heldReason={busy ? t('files.state.uploading') : model.readOnly ? (model.heldReason ?? null) : null} onClick={() => actions?.onSend?.()}>
              {t('files.send', { count: outcome.waiting })}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** The line under a file: why it is refused, or its state (and "download only" for a design file). */
function statusOf(file: HeldFile, t: (key: string, params?: Readonly<Record<string, string | number>>) => string): string | null {
  if (file.problem) return t(file.problem.key, file.problem.params)
  const parts: string[] = []
  if (file.state === 'failed') parts.push(file.failure ? t('files.state.failedWhy', { reason: file.failure }) : t('files.state.failed'))
  else if (file.state !== 'held') parts.push(t(`files.state.${file.state}`))
  if (file.design) parts.push(t('files.design'))
  if (file.sheet && file.state !== 'held') parts.push(t('files.sheetShort'))
  return parts.length > 0 ? parts.join(' · ') : null
}

/** The files' outcome after a send, one line (the receipt): "3 files sent · 1 held for the virus scan · 1 did not go". */
export function ComposeFilesOutcome({ held, onRetry, openHref }: { held: readonly HeldFile[]; onRetry?: () => void; openHref?: string }) {
  const t = useT(COMPOSE_NS)
  const outcome = filesOutcome(held)
  if (held.length === 0) return null
  const parts = [
    outcome.waiting > 0 ? t('files.outcome.waiting', { count: outcome.waiting }) : null,
    outcome.sent > 0 ? t('files.outcome.sent', { count: outcome.sent }) : null,
    outcome.scanning > 0 ? t('files.outcome.scanning', { count: outcome.scanning }) : null,
    outcome.failed > 0 ? t('files.outcome.failed', { count: outcome.failed }) : null,
  ].filter((part): part is string => part !== null)
  if (parts.length === 0) return null
  return (
    <Banner
      tone={outcome.failed > 0 ? 'warning' : 'info'}
      title={parts.join(' · ')}
      action={
        outcome.failed > 0 ? (
          <span className="fw-rqc-files-actions">
            <Button size="sm" heldReason={uploading(held) ? t('files.state.uploading') : null} onClick={() => onRetry?.()}>
              <RotateCw size={13} aria-hidden /> {t('files.retry', { count: outcome.failed })}
            </Button>
            {openHref ? (
              <Button size="sm" variant="quiet" asChild>
                <a href={openHref}>{t('files.openRequest')}</a>
              </Button>
            ) : null}
          </span>
        ) : undefined
      }
    >
      {outcome.scanning > 0 ? t('files.scanningBody') : null}
    </Banner>
  )
}
