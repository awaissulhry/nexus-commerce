'use client'

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AudioLines, BadgeCheck, ChevronDown, ChevronUp, FileText, FolderOpen, Image as ImageIcon, Lock, Paperclip, Receipt } from 'lucide-react'
import { Skeleton } from '@nexus/ui/primitives'
import { useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { FileKind } from '../../../../record-panels/model'
import { audienceMarks, fileSeries, filesChip, versionMark, type FilesParty, type ThreadFile } from '../model'
import '../files.css'

export const FILES_NS = 'record-thread-files'

export interface FileStripModel {
  /** The record's files the reader may see (GET /files?recordType&recordId); null while they are read the first time. */
  files: readonly ThreadFile[] | null
  /** The record's party: "Customer" / "Supplier" marks follow it. */
  party: FilesParty | null
  /** The strip under the line is open (remembered on this device). */
  open: boolean
}

export interface FileStripActions {
  onToggle?: (open: boolean) => void
  /** Opens the thread's one file viewer at this file (popups/FileViewer). */
  onOpen?: (fileId: string, opener: HTMLElement | null) => void
  /** "All files": the Files view (T9). */
  onAllFiles?: () => void
}

const KIND_ICON: Readonly<Record<FileKind, (size: number) => ReactNode>> = {
  PHOTO: (size) => <ImageIcon size={size} aria-hidden />,
  DOCUMENT: (size) => <FileText size={size} aria-hidden />,
  CERTIFICATE: (size) => <BadgeCheck size={size} aria-hidden />,
  FISCAL_ARCHIVE: (size) => <Receipt size={size} aria-hidden />,
  AUDIO: (size) => <AudioLines size={size} aria-hidden />,
  ATTACHMENT: (size) => <Paperclip size={size} aria-hidden />,
}

/**
 * The files line (B-TH-210, T2; picture 8 drawn to the approved pictures' look): ONE 36 px row "Files (12)" with the three
 * newest as 24 px pictures — absent with no files —, the strip on demand (64 px tiles, newest first, the version mark, two
 * audience marks then "+N", a held file's lock and reason; ← / → walk it, Enter opens the viewer) ending with "All files".
 * Counts only the files this reader may see. Draws one view model, fetches nothing.
 */
export function FileStrip({ model, actions }: { model: FileStripModel; actions?: FileStripActions }) {
  return (
    <WithMessages namespaces={[FILES_NS]}>
      <Strip model={model} actions={actions} />
    </WithMessages>
  )
}

function Strip({ model, actions }: { model: FileStripModel; actions?: FileStripActions | undefined }) {
  const t = useT(FILES_NS)
  const stripId = useId()
  const listRef = useRef<HTMLUListElement>(null)
  const [focus, setFocus] = useState(0)
  if (model.files === null) {
    return (
      <div className="fw-rtf-line" role="status" aria-label={t('loading')}>
        <span className="fw-rtf-chip is-loading">
          {t('chip.loading')} <Skeleton width={42} height={14} />
        </span>
      </div>
    )
  }
  const series = fileSeries(model.files)
  // T2-F09: nothing empty takes a band.
  if (series.length === 0) return null
  const chip = filesChip(series)

  const walk = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-tile]') ?? [])]
    if (buttons.length === 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, focus + (event.key === 'ArrowRight' ? 1 : -1)))
    setFocus(next)
    buttons[next]?.focus()
  }

  return (
    <div className="fw-rtf">
      <div className="fw-rtf-line">
        <button type="button" className="fw-rtf-chip" aria-expanded={model.open} aria-controls={stripId} onClick={() => actions?.onToggle?.(!model.open)}>
          <span>{t('chip.label', { count: chip.count })}</span>
          <span className="fw-rtf-minis" aria-hidden>
            {chip.newest.map((file) => (
              <span key={file.id} className="fw-rtf-mini">
                {file.previewUrl && file.status === 'AVAILABLE' ? <img src={file.previewUrl} alt="" /> : file.status === 'QUARANTINED' ? <Lock size={12} /> : KIND_ICON[file.kind](12)}
              </span>
            ))}
          </span>
          {model.open ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
        </button>
      </div>
      {model.open && (
        <div id={stripId} className="fw-rtf-strip">
          <ul ref={listRef} className="fw-rtf-tiles" aria-label={t('strip.label', { count: chip.count })} onKeyDown={walk}>
            {series.map((one, index) => {
              const file = one.latest
              const version = versionMark(one)
              const { marks, more } = audienceMarks(file, model.party)
              // B-TH-231 (B-TH-083): a sheet locked for this reader shows a lock and its words, never its own name.
              const held = file.status === 'QUARANTINED' || Boolean(file.locked)
              const markWords = [...marks.map((mark) => t(`audience.${mark}`)), ...(more > 0 ? [t('audience.more', { count: more })] : [])]
              const name = [file.locked ? t('locked.sheet') : file.name, t(`kind.${file.kind}`), version ? t('version', { n: version }) : null, file.status === 'QUARANTINED' ? t('held') : null, ...markWords].filter(Boolean).join(' · ')
              return (
                <li key={one.key}>
                  <button type="button" data-tile className={`fw-rtf-tile${held ? ' is-held' : ''}`} tabIndex={index === focus ? 0 : -1} aria-label={name} title={name} onFocus={() => setFocus(index)} onClick={(event) => actions?.onOpen?.(file.id, event.currentTarget)}>
                    <span className="fw-rtf-pic">{file.previewUrl && !held ? <img src={file.previewUrl} alt="" /> : held ? <Lock size={20} aria-hidden /> : KIND_ICON[file.kind](20)}</span>
                    {version && <span className="fw-rtf-version">{t('version', { n: version })}</span>}
                    <span className="fw-rtf-marks" aria-hidden>
                      {marks.map((mark) => (
                        <span key={mark} className={`fw-rtf-mark is-${mark}`}>
                          {t(`audience.${mark}`)}
                        </span>
                      ))}
                      {more > 0 && <span className="fw-rtf-mark">+{more}</span>}
                    </span>
                  </button>
                </li>
              )
            })}
            <li>
              <button type="button" className="fw-rtf-all" tabIndex={focus >= series.length ? 0 : -1} data-tile onFocus={() => setFocus(series.length)} onClick={() => actions?.onAllFiles?.()}>
                <FolderOpen size={18} aria-hidden />
                <span>{t('strip.all')}</span>
              </button>
            </li>
          </ul>
          {series.some((one) => one.latest.status === 'QUARANTINED') && <p className="fw-rtf-note">{t('strip.heldNote')}</p>}
        </div>
      )}
    </div>
  )
}
