'use client'

/**
 * PrivacyNote — one line that says what level of personal data a view shows (B-W2b-28, design part PrivacyNote): line,
 * team, one person, or protected; who may see more; the law; and "Opening this is recorded" when it is.
 *
 *   <PrivacyNote level="line" text="Totali di linea · dati individuali riservati" whoMore="HR e il lavoratore vedono i dati individuali"
 *                law={<LawRef law="Statuto dei Lavoratori art. 4" plain="…" />} labels={ds.privacyNote} />
 *   <PrivacyNote level="protected" variant="panel" recorded whoMore="Solo HR e sicurezza" action={<a href=…>Registro accessi</a>} />
 *
 * - `pill` (default) sits in the page band or under it; `panel` is a full-width line inside a tab or a dialog. The same
 *   words in both, every one on screen (`privacyNoteModel.ts`); nothing only on hover.
 * - An icon per level (line, team, person, lock) and a tone (protected: warning; one person: info), never colour alone.
 * - `role="note"`, named "Privacy", so a screen reader meets it before the data.
 */
import { createElement, type ReactNode } from 'react'
import { Eye, Factory, Lock, User, Users } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { PRIVACY_NOTE_LABELS, type PrivacyNoteLabels } from './PrivacyNoteLabels'
import { privacyTone, type PrivacyLevel } from './privacyNoteModel'
import './privacyNote.css'

export interface PrivacyNoteProps {
  level: PrivacyLevel
  /** `pill` (default): in the band. `panel`: a full-width line. */
  variant?: 'pill' | 'panel'
  /** The host's own words for the level ("Line totals · individual figures private"). */
  text?: string
  /** Who may see more ("HR and the worker see individual figures"). */
  whoMore?: string
  /** The law (a `LawRef`). */
  law?: ReactNode
  /** Opening this view writes a view log. */
  recorded?: boolean
  /** A link (the view log for HR and the DPO). */
  action?: ReactNode
  labels?: Partial<PrivacyNoteLabels>
  id?: string
}

const LEVEL_ICON = { line: Factory, team: Users, individual: User, protected: Lock } as const

export function PrivacyNote({ level, variant = 'pill', text, whoMore, law, recorded, action, labels, id }: PrivacyNoteProps) {
  const lw = mergeLabels(PRIVACY_NOTE_LABELS, labels)
  const levels = { ...PRIVACY_NOTE_LABELS.levels, ...labels?.levels }
  return (
    <div id={id} className="nds-privacy" data-variant={variant} data-level={level} data-tone={privacyTone(level)} role="note" aria-label={lw.region}>
      {createElement(LEVEL_ICON[level], { className: 'nds-privacy-icon', 'aria-hidden': true })}
      <span className="nds-privacy-level">{text ?? levels[level]}</span>
      {whoMore ? (
        <>
          <span className="nds-privacy-sep" aria-hidden>
            ·
          </span>
          <span className="nds-privacy-who">{whoMore}</span>
        </>
      ) : null}
      {law ? (
        <>
          <span className="nds-privacy-sep" aria-hidden>
            ·
          </span>
          <span className="nds-privacy-law">{law}</span>
        </>
      ) : null}
      {recorded ? (
        <>
          <span className="nds-privacy-sep" aria-hidden>
            ·
          </span>
          <span className="nds-privacy-recorded">
            <Eye className="nds-privacy-recorded-icon" aria-hidden />
            {lw.recorded}
          </span>
        </>
      ) : null}
      {action ? <span className="nds-privacy-action">{action}</span> : null}
    </div>
  )
}
