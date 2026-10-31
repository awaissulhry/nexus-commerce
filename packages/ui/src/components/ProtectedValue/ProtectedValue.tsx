'use client'

/**
 * ProtectedValue — a field for special-category data (B-W2b-28, design part ProtectedValue): a fitness judgement, the
 * details of an injury. "Restricted" to others; for an entitled role the value behind Show, with a "view recorded"
 * mark; every open writes a view log (the app's read does, on the server).
 *
 *   <ProtectedValue label="Giudizio di idoneità" allowed={can.health} value={judgement} onOpen={readJudgement}
 *                   opening={reading} failed={readFailed} recordedAt={viewedAt} onHide={() => setJudgement(undefined)}
 *                   restrictedReason="Solo HR e sicurezza lo vedono" labels={ds.protectedValue} />
 *
 * - Not entitled: a lock, "Restricted" and who may see it. The page never holds the value.
 * - Entitled: Show (and "Opening it is recorded" under it) → `onOpen`; the app reads the value, the server logs the
 *   view, and the app passes `value` and `recordedAt`. Hide gives `onHide`; the next Show is a new read and a new log.
 * - Opening: Show held while it reads. Failed: the words and Try again, never an empty field.
 * - The open value is announced politely, once.
 */
import type { ReactNode } from 'react'
import { Eye, EyeOff, Lock } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { Button } from '../../primitives/Button'
import { PROTECTED_VALUE_LABELS, type ProtectedValueLabels } from './ProtectedValueLabels'
import { protectedValueView } from './protectedValueModel'
import './protectedValue.css'

export interface ProtectedValueProps {
  /** The field's name ("Giudizio di idoneità"). */
  label: string
  /** The person holds a role that may see it. */
  allowed: boolean
  /** The value once read. `undefined`: not opened. */
  value?: ReactNode
  /** Reads the value (the server writes the view log). */
  onOpen?: () => void
  opening?: boolean
  failed?: boolean
  /** The time of this view, written in the page's language. */
  recordedAt?: string
  /** Who may see it, for the people who may not ("Only HR and safety roles"). */
  restrictedReason?: string
  /** Forgets the value. */
  onHide?: () => void
  labels?: Partial<ProtectedValueLabels>
  id?: string
}

export function ProtectedValue({ label, allowed, value, onOpen, opening, failed, recordedAt, restrictedReason, onHide, labels, id }: ProtectedValueProps) {
  const lw = mergeLabels(PROTECTED_VALUE_LABELS, labels)
  const view = protectedValueView({ allowed, value, opening, failed })
  return (
    <div id={id} className="nds-protected" data-view={view}>
      <div className="nds-protected-label">{label}</div>
      <div className="nds-protected-body" aria-live="polite">
        {view === 'restricted' ? (
          <span className="nds-protected-restricted">
            <Lock className="nds-protected-icon" aria-hidden />
            <span className="nds-protected-word">{lw.restricted}</span>
            {restrictedReason ? <span className="nds-protected-note">{restrictedReason}</span> : null}
          </span>
        ) : view === 'open' ? (
          <>
            <div className="nds-protected-value">{value}</div>
            <span className="nds-protected-mark">
              <Eye className="nds-protected-icon" aria-hidden />
              {recordedAt ? lw.recordedAt(recordedAt) : lw.recorded}
            </span>
            {onHide ? (
              <Button size="sm" variant="quiet" onClick={onHide}>
                <EyeOff size={14} aria-hidden />
                {lw.hide}
              </Button>
            ) : null}
          </>
        ) : view === 'failed' ? (
          <span className="nds-protected-failed">
            <span className="nds-protected-word">{lw.failed}</span>
            {onOpen ? (
              <Button size="sm" onClick={onOpen}>
                {lw.retry}
              </Button>
            ) : null}
          </span>
        ) : (
          <span className="nds-protected-closed">
            <Button size="sm" onClick={onOpen} heldReason={view === 'opening' ? lw.opening : null}>
              <Eye size={14} aria-hidden />
              {view === 'opening' ? lw.opening : lw.show}
            </Button>
            <span className="nds-protected-note">{lw.showNote}</span>
          </span>
        )}
      </div>
    </div>
  )
}
