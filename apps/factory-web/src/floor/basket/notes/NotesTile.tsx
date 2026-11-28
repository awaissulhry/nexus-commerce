'use client'

import { useState } from 'react'
import { Image as ImageIcon, StickyNote, X } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import { ReadAloudButton } from '@nexus/ui/floor/ReadAloud/index'
import { Modal, useDsWords } from '../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useFloor } from '../../FloorApp'
import type { HelpRead } from '../help/api'
import { newestFirst } from './model'
import '../help/help2.css'

/**
 * owb-fl8 step 3 — the Notes tile and its window: the office's notes for the floor of this basket's work order, read only, newest
 * first, each with its time, its words as the office wrote them and Listen. Empty → one sentence. No chat (pick C).
 */

export interface NotesProps {
  readonly read: HelpRead
  /** Taken as every tile takes it (fl5 passes the same props to the four); notes are read only, nothing changes. */
  readonly onChanged?: () => void
}

export function NotesTile({ read }: NotesProps) {
  const t = useT('floor-help2')
  const [open, setOpen] = useState(false)
  const count = read.notes.length
  return (
    <>
      <FloorButton
        className="fw-h2-tile"
        variant="secondary"
        icon={<StickyNote />}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={count > 0 ? t('tile.notesCount', { count }) : t('tile.notes')}
        onClick={() => setOpen(true)}
      >
        {t('tile.notes')}
        {count > 0 ? <span className="fw-h2-tile-count">{count}</span> : null}
      </FloorButton>
      <NotesWindow open={open} onClose={() => setOpen(false)} read={read} />
    </>
  )
}

export interface NotesWindowProps extends NotesProps {
  readonly open: boolean
  readonly onClose: () => void
}

export function NotesWindow({ open, onClose, read }: NotesWindowProps) {
  const t = useT('floor-help2')
  const ds = useDsWords()
  const locale = useLocale()
  const { me } = useFloor()
  const speech = me?.speech?.lang ?? INTL_LOCALE[locale]
  const notes = newestFirst(read.notes)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('notes.title', { code: read.basket.code })}
      size="md"
      sheet
      className="fw-floor-dialog"
      footer={
        <FloorButton size="lg" variant="quiet" icon={<X />} onClick={onClose}>
          {t('window.close')}
        </FloorButton>
      }
    >
      <div className="fw-h2-window">
        {notes.length === 0 ? (
          <p className="fw-floor-lead">{t('notes.none')}</p>
        ) : (
          <>
            <p className="fw-floor-muted">{t('notes.lead')}</p>
            <ul className="fw-h2-notes">
              {notes.map((note, index) => (
                <li key={`${note.at}-${index}`} className="fw-h2-note">
                  <p className="fw-floor-muted">{formatDateTime(note.at, { locale })}</p>
                  {/* The office's words as written: never translated, never changed. */}
                  <p className="fw-h2-note-text">{note.words}</p>
                  {note.fileIds.length > 0 ? (
                    <p className="fw-floor-muted">
                      <ImageIcon aria-hidden className="fw-floor-inline-icon" />
                      {t('notes.files', { count: note.fileIds.length })}
                    </p>
                  ) : null}
                  <ReadAloudButton text={note.words} lang={speech} labels={ds.readAloud} showVoice={index === 0} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  )
}
