'use client'

import { useMemo, useRef, useState } from 'react'
import { Camera, FileText, ImageIcon, Layers, Lock, Paperclip, RotateCw, Ruler, Upload, X } from 'lucide-react'
import { Menu, ProgressBar } from '@nexus/ui/components'
import { Button, Input } from '@nexus/ui/primitives'
import { Modal } from '../../../i18n/ds-parts'
import { INTL_LOCALE } from '../../../i18n/locales'
import { useLocale, useT } from '../../../i18n/provider'
import { sizeWords } from '../../card/model'
import { kindKey, officeInReply, pickerGroups, type DraftFile, type RecordFile, type TrayMode } from '../model'
import '../attachments.css'

/**
 * The files of the message (B-TH-206, T6; picture 4): each file with its kind, size, progress and audience ("Office only" /
 * "Shared with Brand Alpha"), Retry on a failed upload, × to take it off; a refused file names why. Draws its model.
 */
export function AttachmentTray({ files, partyName, onRemove, onRetry }: { files: readonly DraftFile[]; partyName: string; onRemove: (key: string) => void; onRetry: (key: string) => void }) {
  const t = useT('record-thread-attach')
  const locale = useLocale()
  if (files.length === 0) return null
  return (
    <ul className="fw-rt-tray" aria-label={t('tray.label')}>
      {files.map((file) => (
        <li key={file.key} className={`fw-rt-file${file.phase === 'refused' ? ' is-refused' : ''}${file.phase === 'done' && file.audience === 'OFFICE' ? ' is-office' : ''}`}>
          <span className="fw-rt-file-icon" aria-hidden="true">
            {file.contentType.startsWith('image/') ? <ImageIcon size={16} /> : <FileText size={16} />}
          </span>
          <span className="fw-rt-file-name" title={file.name}>
            {file.name}
          </span>
          <span className="fw-rt-file-meta">
            {file.phase === 'refused' ? (
              <span className="fw-rt-file-problem">{t('tray.refused', { reason: t(file.problem?.key ?? 'refused.type', file.problem?.params) })}</span>
            ) : (
              <>
                <span>
                  {t(kindKey(file.contentType))} · {sizeWords(file.sizeBytes, INTL_LOCALE[locale])}
                </span>
                {file.phase === 'uploading' && (
                  <span className="fw-rt-file-progress">
                    <ProgressBar className="fw-rt-bar" ariaLabel={t('tray.uploadingOf', { name: file.name })} value={file.progress ?? null} indeterminate={file.progress === undefined} height={4} />
                    {file.progress !== undefined ? t('tray.uploadingShare', { share: file.progress }) : t('tray.uploading')}
                  </span>
                )}
                {file.phase === 'failed' && <span className="fw-rt-file-problem">{t('tray.failed', { reason: t(file.problem?.key ?? 'failed.failed') })}</span>}
                {file.sheet && (
                  <span className="fw-rt-file-aud is-sheet">
                    <Ruler size={11} aria-hidden /> {t('sheet.mark')}
                  </span>
                )}
                <span className={`fw-rt-file-aud ${file.audience === 'OFFICE' ? 'is-office' : 'is-shared'}`}>
                  {file.audience === 'OFFICE' ? (
                    <>
                      <Lock size={11} aria-hidden /> {t('audience.office')}
                    </>
                  ) : (
                    t('audience.shared', { party: partyName })
                  )}
                </span>
              </>
            )}
          </span>
          <span className="fw-rt-file-act">
            {file.phase === 'failed' && (
              <Button size="sm" onClick={() => onRetry(file.key)}>
                <RotateCw size={12} aria-hidden /> {t('tray.retry')}
              </Button>
            )}
            <Button size="sm" variant="quiet" aria-label={t('tray.remove', { name: file.name })} onClick={() => onRemove(file.key)}>
              <X size={13} aria-hidden />
            </Button>
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The paper clip (T6-F01): Upload from this device · Take a photo (the phone's camera; elsewhere the file picker) · From this
 * record. Held with the reason when the person may not upload or read the record's files.
 */
export function ClipMenu({ canUpload, canPick, onFiles, onPick, onSheets }: { canUpload: boolean; canPick: boolean; onFiles: (files: File[]) => void; onPick: () => void; onSheets?: (files: File[]) => void }) {
  const t = useT('record-thread-attach')
  const device = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  // B-TH-283: "Measurement sheet…" — the files chosen go up as measurement sheets (a PDF or a photo).
  const sheets = useRef<HTMLInputElement>(null)
  if (!canUpload && !canPick) {
    return (
      <Button size="sm" variant="quiet" heldReason={t('clip.noRight')} aria-label={t('clip.label')}>
        <Paperclip size={15} aria-hidden />
      </Button>
    )
  }
  const take = (input: HTMLInputElement | null, as: (files: File[]) => void = onFiles) => {
    const files = [...(input?.files ?? [])]
    if (input) input.value = ''
    if (files.length > 0) as(files)
  }
  return (
    <span className="fw-rt-clip">
      <Menu
        className="fw-rt-clip-menu"
        label={<Paperclip size={15} aria-hidden />}
        triggerProps={{ 'aria-label': t('clip.label'), className: 'nds-btn quiet sm' }}
        items={[
          { id: 'device', label: t('clip.device'), icon: <Upload size={14} aria-hidden />, disabled: !canUpload, description: canUpload ? undefined : t('clip.noUpload'), onSelect: () => device.current?.click() },
          { id: 'photo', label: t('clip.photo'), icon: <Camera size={14} aria-hidden />, disabled: !canUpload, description: canUpload ? t('clip.photoHint') : t('clip.noUpload'), onSelect: () => camera.current?.click() },
          ...(onSheets ? [{ id: 'sheet', label: t('clip.sheet'), icon: <Ruler size={14} aria-hidden />, disabled: !canUpload, description: canUpload ? t('clip.sheetHint') : t('clip.noUpload'), onSelect: () => sheets.current?.click() }] : []),
          { id: 'record', label: t('clip.record'), icon: <Layers size={14} aria-hidden />, disabled: !canPick, description: canPick ? undefined : t('clip.noRead'), onSelect: onPick },
        ]}
      />
      {onSheets && <input ref={sheets} type="file" multiple accept="application/pdf,image/*" hidden tabIndex={-1} aria-hidden="true" onChange={(event) => take(event.currentTarget, onSheets)} />}
      <input ref={device} type="file" multiple hidden tabIndex={-1} aria-hidden="true" onChange={(event) => take(event.currentTarget)} />
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden tabIndex={-1} aria-hidden="true" onChange={(event) => take(event.currentTarget)} />
    </span>
  )
}

/** The lines under the box (T6-F04, F06): an office-only file in a reply (Share with the customer, or Remove it) and the mail limit. */
export function AttachmentLines({ files, mode, partyName, canShare, overMailLimit, onShare, onRemove }: { files: readonly DraftFile[]; mode: TrayMode; partyName: string; canShare: boolean; overMailLimit: boolean; onShare: (key: string) => void; onRemove: (key: string) => void }) {
  const t = useT('record-thread-attach')
  const office = officeInReply(files, mode)
  if (office.length === 0 && !overMailLimit) return null
  return (
    <div className="fw-rt-attach-lines">
      {office.map((file) => (
        <p key={file.key} className="fw-rt-attach-warn" role="note">
          <Lock size={13} aria-hidden />
          <span>{t('office.line', { name: file.name })}</span>
          {canShare ? (
            <Button size="sm" onClick={() => onShare(file.key)}>
              {t('office.share', { party: partyName })}
            </Button>
          ) : (
            <span className="fw-rt-attach-muted">{t('office.noShare')}</span>
          )}
          <Button size="sm" variant="link" onClick={() => onRemove(file.key)}>
            {t('office.remove')}
          </Button>
        </p>
      ))}
      {overMailLimit && mode === 'reply' && (
        <p className="fw-rt-attach-warn" role="note">
          {t('mailLimit')}
        </p>
      )}
    </div>
  )
}

/**
 * "From this record" (T6-F03; picture 4 state "From this record"): the record's files as cards with their kind and audience —
 * in a reply the ones the customer may already see first, then the office's (picking one asks to share it) — a search past 12
 * files, then "Add N files".
 */
export function FromRecordPicker({ open, files, mode, partyName, record, onClose, onAdd }: { open: boolean; files: readonly RecordFile[]; mode: TrayMode; partyName: string; record: string; onClose: () => void; onAdd: (ids: string[]) => void }) {
  const t = useT('record-thread-attach')
  const locale = useLocale()
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<readonly string[]>([])
  const groups = useMemo(() => pickerGroups(files, query), [files, query])
  const toggle = (id: string) => setChosen((list) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]))
  const close = () => {
    setChosen([])
    setQuery('')
    onClose()
  }
  const card = (file: RecordFile) => (
    <button key={file.id} type="button" className="fw-rt-pickcard" aria-pressed={chosen.includes(file.id)} onClick={() => toggle(file.id)}>
      <span className="fw-rt-pickcard-thumb" aria-hidden="true">
        {file.contentType.startsWith('image/') ? <ImageIcon size={20} /> : <FileText size={20} />}
      </span>
      <b title={file.name}>{file.name}</b>
      <small>
        {t(kindKey(file.contentType))} · {sizeWords(file.sizeBytes, INTL_LOCALE[locale])}
      </small>
      <small className={file.shared ? 'is-shared' : 'is-office'}>{file.shared ? t('audience.shared', { party: partyName }) : t('audience.office')}</small>
    </button>
  )
  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title={t('picker.title')}
      footer={
        <>
          <Button size="sm" onClick={close}>
            {t('picker.cancel')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            heldReason={chosen.length === 0 ? t('picker.pick') : null}
            onClick={() => {
              onAdd([...chosen])
              close()
            }}
          >
            {chosen.length === 0 ? t('picker.pick') : t('picker.add', { count: chosen.length })}
          </Button>
        </>
      }
    >
      <div className="fw-rt-picker">
        <p className="fw-rt-attach-muted">{mode !== 'note' ? t('picker.bodyReply', { party: partyName }) : t('picker.bodyNote', { record })}</p>
        {files.length > 12 && <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('picker.search')} aria-label={t('picker.search')} />}
        {groups.shared.length + groups.office.length === 0 ? (
          <p className="fw-rt-attach-muted">{t(files.length === 0 ? 'picker.none' : 'picker.noMatch')}</p>
        ) : (
          <>
            {groups.shared.length > 0 && (
              <>
                <p className="fw-rt-pickgrp">{t('picker.shared', { party: partyName, count: groups.shared.length })}</p>
                <div className="fw-rt-pick">{groups.shared.map(card)}</div>
              </>
            )}
            {groups.office.length > 0 && (
              <>
                <p className="fw-rt-pickgrp">{t('picker.office', { count: groups.office.length })}</p>
                <div className="fw-rt-pick">{groups.office.map(card)}</div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
