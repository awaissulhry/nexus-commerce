'use client'

import { Mail } from 'lucide-react'
import { Button, Tag } from '@nexus/ui/primitives'
import { FileDropzone, FileRow } from '../../i18n/ds-parts'
import { fileHeldKey, fileKindOf } from '../model'
import type { DraftFile, DraftFilePart } from '../schema'
import { useDraftWords } from '../words'

/**
 * The draft's files, in the mail's Attachments box and in a row's files window (od-w1.2, R2 — moved out of the draft's three files
 * cards, F-CP-151): each file with what it is, held for the virus scan where one runs, × takes it out (its version); the files going
 * up now, or that did not go; the drop area — or, while uploads from outside are closed, the e-mail way naming the draft. Files go up
 * only where the API says they may. In the mail a file may be marked "Logo" (the logo mark the artwork carry reads).
 */

/** A file going up now, or one that did not go (its words). `lineId`: the row it goes onto (null: the mail's Attachments). */
export interface UploadRow {
  key: string
  part: DraftFilePart
  lineId?: string | null
  name: string
  state: 'uploading' | 'failed'
  failure?: string
}

/** What a part takes (the API checks again: a picture up to 15 MB, any other file up to 25 MB; never a page or a script). */
export const ACCEPT: Readonly<Record<DraftFilePart, string>> = {
  LOGO: '.ai,.eps,.ps,.pdf,.png,.jpg,.jpeg,.webp,.heic,.psd,.zip',
  REFERENCE: '.ai,.eps,.ps,.pdf,.png,.jpg,.jpeg,.webp,.heic,.psd,.zip',
  SHEET: '.pdf,.png,.jpg,.jpeg,.webp,.heic,.xlsx,.xls,.csv',
}

export interface FilesBoxModel {
  files: readonly DraftFile[]
  /** The mail: which of them are logos (filed as artwork). */
  logos?: readonly string[]
  uploading: readonly UploadRow[]
  /** Files go up here now (else the e-mail way). */
  open: boolean
  /** Why a file cannot be added now (words: a preview, offline, the cap), or null. */
  addHeld: string | null
  /** Why a file cannot be taken out (or marked) now (words), or null. */
  removeHeld: string | null
  /** How the e-mail way names the draft (their PO, else its title). */
  draftName: string
  /** The drop area's words (a key of the part). */
  dropKey: string
  accept: string
}

export interface FilesBoxActions {
  onFiles?: (files: File[]) => void
  onRemove?: (file: DraftFile) => void
  /** The mail only: mark a file a logo (absent: no Logo toggle). */
  onLogo?: (file: DraftFile, on: boolean) => void
}

export function FilesBox({ model, actions, logo = false }: { model: FilesBoxModel; actions?: FilesBoxActions; logo?: boolean }) {
  const { t } = useDraftWords()
  return (
    <div className="fw-od-files">
      {model.files.length > 0 || model.uploading.length > 0 ? (
        <ul className="fw-od-filelist">
          {model.files.map((file) => {
            const held = fileHeldKey(file)
            const isLogo = model.logos?.includes(file.id) ?? false
            return (
              <li key={file.id}>
                <FileRow
                  name={file.originalName ?? '—'}
                  size={file.sizeBytes}
                  status={held ? `${t(`draftPage.files.kind.${fileKindOf(file)}`)} · ${t(held)}` : t(`draftPage.files.kind.${fileKindOf(file)}`)}
                  disabled={model.removeHeld !== null}
                  actions={
                    // R2: the Logo mark — a pressed toggle where the host can change it, else the mark as a tag on a logo.
                    logo && actions?.onLogo ? (
                      <Button size="sm" variant={isLogo ? 'secondary' : 'quiet'} aria-pressed={isLogo} aria-label={t('mail.logoAria', { name: file.originalName ?? '—' })} heldReason={model.removeHeld} onClick={() => actions.onLogo?.(file, !isLogo)}>
                        {t('mail.logo')}
                      </Button>
                    ) : logo && isLogo ? (
                      <Tag tone="info">{t('mail.logo')}</Tag>
                    ) : undefined
                  }
                  {...(model.removeHeld === null ? { onRemove: () => actions?.onRemove?.(file) } : {})}
                />
              </li>
            )
          })}
          {model.uploading.map((row) => (
            <li key={row.key}>
              <FileRow name={row.name} status={row.state === 'uploading' ? t('draftPage.files.uploading') : t('draftPage.files.failed', { reason: row.failure ?? t('refusal.other') })} tone={row.state === 'failed' ? 'danger' : 'neutral'} disabled />
            </li>
          ))}
        </ul>
      ) : null}
      {model.open ? (
        model.addHeld ? (
          <p className="fw-od-held">{model.addHeld}</p>
        ) : (
          <FileDropzone multiple accept={model.accept} hint={t(model.dropKey)} onFiles={(files) => actions?.onFiles?.(files)} />
        )
      ) : (
        // D14: on live, until the virus scanner runs — the e-mail way, naming the draft.
        <p className="fw-od-mailway" role="note">
          <Mail size={16} aria-hidden /> <span>{t('draftPage.files.closed', { draft: model.draftName })}</span>
        </p>
      )}
    </div>
  )
}
