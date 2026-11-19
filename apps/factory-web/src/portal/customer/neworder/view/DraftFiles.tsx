'use client'

import { Mail, ShieldCheck } from 'lucide-react'
import { Card } from '@nexus/ui/components'
import { Toggle } from '@nexus/ui/primitives'
import { FileDropzone, FileRow } from '../../../../lib/i18n/ds-parts'
import type { DraftFile, DraftFilePart, DraftLine } from '../api'
import { fileHeldKey, fileKindOf, fileWhereWords, type DraftChip } from '../model'
import { useOrderingWords } from '../words'
import { PartHeading } from './DraftChecklist'

/**
 * F-CP-151 (customer page plan C5; 12 §2 parts 2–4; D14 — O7, the virus scanner's spend, is NOT approved): the draft's files.
 * Logos (filed as artwork: "Vector files (AI, EPS, PDF) print best; a picture is fine to start" — never refused for being a
 * picture), References (pictures or PDFs of what they mean) and Measurement sheets (body data, in People and sizes, with one
 * line on who opens them). Each file says what it is and where it sits ("vector · on the draft", "picture · on line 2"), held for
 * the virus scan where one runs, × takes it out (its version). Files go up only where the API says they may: on live, until the
 * scanner runs, each card shows the e-mail way naming the draft instead of a drop area — lines, sizes and notes still work.
 * "Sending later" marks the part once the API keeps the mark (B-CP-075). The draft holds at most 50 files (held with words).
 */

/** A file going up now, or one that did not go (its words). */
export interface UploadRow {
  key: string
  part: DraftFilePart
  name: string
  state: 'uploading' | 'failed'
  failure?: string
}

export interface DraftFilesModel {
  part: DraftFilePart
  files: readonly DraftFile[]
  lines: readonly Pick<DraftLine, 'id' | 'seq'>[]
  uploading: readonly UploadRow[]
  /** Files go up here now (else the e-mail way). */
  open: boolean
  /** Why a file cannot be added now (words: a preview, offline, the cap), or null. */
  addHeld: string | null
  /** Why a file cannot be taken out now (words), or null. */
  removeHeld: string | null
  /** "Sending later" (null: the API does not keep the mark yet — no toggle). */
  later: { on: boolean; held: string | null } | null
  /** How the e-mail way names the draft (their PO, else its title). */
  draftName: string
}

export interface DraftFilesActions {
  onFiles?: (part: DraftFilePart, files: File[]) => void
  onRemove?: (file: DraftFile) => void
  onLater?: (part: DraftFilePart, on: boolean) => void
}

const ADD_KEY: Readonly<Record<DraftFilePart, string>> = { LOGO: 'draftPage.files.addLogos', REFERENCE: 'draftPage.files.addReferences', SHEET: 'draftPage.files.addSheets' }
const NONE_KEY: Readonly<Record<DraftFilePart, string>> = { LOGO: 'draftPage.files.noLogos', REFERENCE: 'draftPage.files.noReferences', SHEET: 'draftPage.files.noSheets' }
/** What a part takes (the API checks again: a picture up to 15 MB, any other file up to 25 MB; never a page or a script). */
const ACCEPT: Readonly<Record<DraftFilePart, string>> = {
  LOGO: '.ai,.eps,.ps,.pdf,.png,.jpg,.jpeg,.webp,.heic,.psd,.zip',
  REFERENCE: '.pdf,.png,.jpg,.jpeg,.webp,.heic',
  SHEET: '.pdf,.png,.jpg,.jpeg,.webp,.heic,.xlsx,.xls,.csv',
}

/** The files of one part: their rows, what is going up, the drop area (or the e-mail way), "Sending later". */
export function DraftFilesBody({ model, actions }: { model: DraftFilesModel; actions?: DraftFilesActions }) {
  const words = useOrderingWords()
  const { t } = words
  const uploading = model.uploading.filter((row) => row.part === model.part)
  return (
    <div className="fw-pno-files">
      {model.part === 'LOGO' ? <p className="fw-pno-quiet">{t('draftPage.files.logoHint')}</p> : null}
      {model.files.length === 0 && uploading.length === 0 ? <p className="fw-pno-quiet">{t(NONE_KEY[model.part])}</p> : null}
      {model.files.length > 0 || uploading.length > 0 ? (
        <ul className="fw-pno-filelist">
          {model.files.map((file) => {
            const held = fileHeldKey(file)
            const what = model.part === 'LOGO' ? `${t(`draftPage.files.kind.${fileKindOf(file)}`)} · ${fileWhereWords(file, model.lines, t)}` : fileWhereWords(file, model.lines, t)
            return (
              <li key={file.id}>
                <FileRow name={file.originalName} size={file.sizeBytes} status={held ? `${what} · ${t(held)}` : what} disabled={model.removeHeld !== null} {...(model.removeHeld === null ? { onRemove: () => actions?.onRemove?.(file) } : {})} />
              </li>
            )
          })}
          {uploading.map((row) => (
            <li key={row.key}>
              <FileRow name={row.name} status={row.state === 'uploading' ? t('draftPage.files.uploading') : t('draftPage.files.failed', { reason: row.failure ?? t('refusal.other') })} tone={row.state === 'failed' ? 'danger' : 'neutral'} disabled />
            </li>
          ))}
        </ul>
      ) : null}
      {model.open ? (
        model.addHeld ? (
          <p className="fw-pno-held">{model.addHeld}</p>
        ) : (
          <FileDropzone multiple accept={ACCEPT[model.part]} hint={t(ADD_KEY[model.part])} onFiles={(files) => actions?.onFiles?.(model.part, files)} />
        )
      ) : (
        // D14: on live, until the virus scanner runs — the e-mail way, naming the draft.
        <p className="fw-pno-mailway" role="note">
          <Mail size={16} aria-hidden /> <span>{t(model.part === 'SHEET' ? 'draftPage.files.sheetsClosed' : 'draftPage.files.closed', { draft: model.draftName })}</span>
        </p>
      )}
      {model.later ? (
        <span className="fw-pno-later">
          <Toggle size="sm" checked={model.later.on} disabled={model.later.held !== null} title={model.later.held ?? undefined} onChange={(next) => actions?.onLater?.(model.part, next)} aria-label={t('draftPage.files.later')} />
          <span aria-hidden>{t('draftPage.files.later')}</span>
        </span>
      ) : null}
    </div>
  )
}

/** 2 Logos or 3 References: a part card of its own. */
export function DraftFilesCard({ chip, model, actions }: { chip: DraftChip; model: DraftFilesModel; actions?: DraftFilesActions }) {
  return (
    <Card padded>
      <section className="fw-pno-section" id={chip.target} tabIndex={-1} aria-labelledby={`${chip.target}-title`}>
        <PartHeading chip={chip} id={`${chip.target}-title`} />
        <DraftFilesBody model={model} actions={actions} />
      </section>
    </Card>
  )
}

/** Measurement sheets, inside People and sizes: their files and the line on who opens them (body data, review G6). */
export function DraftSheets({ model, actions }: { model: DraftFilesModel; actions?: DraftFilesActions }) {
  const { t } = useOrderingWords()
  return (
    <div className="fw-pno-sheets">
      <h3 className="fw-pno-h3">{t('draftPage.files.sheetsTitle')}</h3>
      <p className="fw-pno-quiet">
        <ShieldCheck size={14} aria-hidden /> {t('draftPage.files.sheetsPrivacy')}
      </p>
      <DraftFilesBody model={model} actions={actions} />
    </div>
  )
}
