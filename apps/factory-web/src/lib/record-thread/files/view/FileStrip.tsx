'use client'

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AudioLines, BadgeCheck, ChevronDown, ChevronUp, FileText, FolderOpen, Image as ImageIcon, Lock, Paperclip, Receipt } from 'lucide-react'
import { Skeleton } from '@nexus/ui/primitives'
import { useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { FileKind } from '../../../../record-panels/model'
import { audienceMarks, fileSeries, filesChip, versionMark, type FilesParty, type ThreadFile } from '../model'
// B-TH-286 (B-TH-091; T2-F07): "2 pinned" on the same line.
import { Pin, PinOff } from 'lucide-react'
import { DetailPopover } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useLocale } from '../../../i18n/provider'
import { formatDate } from '../../../i18n/format'
import { pinText, type PinLine } from '../model'
import '../files.css'

export const FILES_NS = 'record-thread-files'

export interface FileStripModel {
  /** The record's files the reader may see (GET /files?recordType&recordId); null while they are read the first time. */
  files: readonly ThreadFile[] | null
  /** The record's party: "Customer" / "Supplier" marks follow it. */
  party: FilesParty | null
  /** The strip under the line is open (remembered on this device). */
  open: boolean
  // ---- B-TH-286 (B-TH-091; T2-F07): the conversation's pins (oldest first); null or absent: not read, no chip.
  pins?: readonly PinLine[] | null
  /** "Unpin" on each line: threads.post, online (the API checks again). */
  canUnpin?: boolean
  // ---- end B-TH-286
}

export interface FileStripActions {
  onToggle?: (open: boolean) => void
  /** Opens the thread's one file viewer at this file (popups/FileViewer). */
  onOpen?: (fileId: string, opener: HTMLElement | null) => void
  /** "All files": the Files view (T9). */
  onAllFiles?: () => void
  // ---- B-TH-286: a pin's line jumps to its message (the container loads older pages until it is there); Unpin.
  onPin?: (messageId: string) => void
  onUnpin?: (messageId: string) => void
  // ---- end B-TH-286
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
  // B-TH-286: the pins chip leads the line (pins are what was decided; files follow).
  const pins = model.pins && model.pins.length > 0 ? <PinsChip pins={model.pins} canUnpin={model.canUnpin ?? false} actions={actions} /> : null
  if (model.files === null) {
    return (
      <div className="fw-rtf-line" role="status" aria-label={t('loading')}>
        {pins}
        <span className="fw-rtf-chip is-loading">
          {t('chip.loading')} <Skeleton width={42} height={14} />
        </span>
      </div>
    )
  }
  const series = fileSeries(model.files)
  // T2-F09: nothing empty takes a band (no pins and no files: no line).
  if (series.length === 0) {
    return pins ? (
      <div className="fw-rtf">
        <div className="fw-rtf-line">{pins}</div>
      </div>
    ) : null
  }
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
        {pins}
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
              // B-TH-283: a sheet this reader opens is named as one ("each opening is recorded").
              const name = [file.locked ? t('locked.sheet') : file.name, file.sheet ? t('sheet.open') : null, t(`kind.${file.kind}`), version ? t('version', { n: version }) : null, file.status === 'QUARANTINED' ? t('held') : null, ...markWords].filter(Boolean).join(' · ')
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

// ---- B-TH-286 (B-TH-091; T2-F07 "2 pinned"): the chip and its popover — one line per pin (who, when, one line of its words or why
// not), Enter on a line jumps to the message; "Unpin" for whoever may write here. A pin is a pointer to its message, never a copy.
function PinsChip({ pins, canUnpin, actions }: { pins: readonly PinLine[]; canUnpin: boolean; actions?: FileStripActions | undefined }) {
  const t = useT(FILES_NS)
  const locale = useLocale()
  return (
    <DetailPopover
      trigger={
        <span className="fw-rtf-pinchip">
          <Pin size={13} aria-hidden /> {t('pins.chip', { count: pins.length })}
        </span>
      }
      triggerLabel={t('pins.label', { count: pins.length })}
      triggerClassName="fw-rtf-chip"
      panelClassName="nds-detailpop-scroll"
      label={t('pins.title', { count: pins.length })}
      hoverDelay={0}
    >
      {({ close }) => (
        <div className="fw-rtf-pins">
          <p className="fw-rtf-pins-title">{t('pins.title', { count: pins.length })}</p>
          <ul className="fw-rtf-pins-lines">
            {pins.map((pin) => {
              const said = pinText(pin)
              const words = 'text' in said ? said.text : t(said.key, said.params)
              const who = pin.author ?? t('pins.someone')
              const meta = [who, formatDate(pin.at, { locale }), pin.office ? t('pins.office') : null].filter(Boolean).join(' · ')
              return (
                <li key={pin.messageId} className="fw-rtf-pin">
                  <button
                    type="button"
                    className={`fw-rtf-pin-go${pin.removed ? ' is-removed' : ''}`}
                    aria-label={t('pins.go', { who, words })}
                    onClick={() => {
                      close({ returnFocus: false })
                      actions?.onPin?.(pin.messageId)
                    }}
                  >
                    <span className="fw-rtf-pin-words">
                      {pin.office && <Lock size={12} aria-hidden />} {words}
                    </span>
                    <span className="fw-rtf-pin-meta">{meta}</span>
                    {pin.pinnedBy && <span className="fw-rtf-pin-meta">{t('pins.by', { name: pin.pinnedBy, date: formatDate(pin.pinnedAt, { locale }) })}</span>}
                  </button>
                  {canUnpin && (
                    <Button size="sm" variant="quiet" aria-label={t('pins.unpinLabel', { words })} onClick={() => actions?.onUnpin?.(pin.messageId)}>
                      <PinOff size={13} aria-hidden /> {t('pins.unpin')}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="fw-rtf-note">{t('pins.everyone')}</p>
        </div>
      )}
    </DetailPopover>
  )
}
// ---- end B-TH-286
