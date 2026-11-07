'use client'

import { FileText, GraduationCap } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import type { DueCellValue } from '../api'
import { TrainingDue, useDay, useTrainingWords } from './parts'

/**
 * Cell detail of a safety course (design people.skills pop:cell "History · certificate · next due · actions", for the Safety
 * column group; B-W2b-146): what stands for this person and course — the DueCell, the record it rests on, the language
 * check (art. 37 c.13), whether the role sheet asks it — then "Certificate (PDF)" in a new tab and "Record training" for
 * this person and course. The history of a person's records is on their Skills & training tab.
 */
export function CoursePopoverBody({ title, person, cell, today, certificateHref, canRecord, onRecord, onClose }: { title: string; person: string; cell: DueCellValue | null; today: string; certificateHref: string | null; canRecord: boolean; onRecord?: (() => void) | undefined; onClose?: (() => void) | undefined }) {
  const t = useTrainingWords()
  const day = useDay()
  const record = cell?.record ?? null
  return (
    <div className="fw-sk-pop">
      <h3 className="fw-sk-pop-title">{title}</h3>
      <p className="fw-sk-pop-person">{person}</p>
      {cell ? <TrainingDue cell={cell} today={today} /> : <p className="fw-sk-hint">{t('cell.notAsked')}</p>}
      <ul className="fw-sk-plain">
        {record && <li>{t('cell.completed', { date: day(record.completedOn) })}</li>}
        {record && <li>{record.validUntil ? t('cell.validUntil', { date: day(record.validUntil) }) : t('cell.noExpiry')}</li>}
        {record && !record.languageChecked && <li>{t('cell.languageNotChecked')}</li>}
        {cell?.state === 'NEEDED' && cell.neededBy && <li>{t('cell.neededBy', { date: day(cell.neededBy) })}</li>}
        {cell?.lastResult === 'FAILED' && <li>{t('cell.lastFailed')}</li>}
        {cell?.required && <li>{t('cell.required')}</li>}
      </ul>
      <span className="fw-sk-row">
        <Button size="sm" variant="primary" heldReason={canRecord ? null : t('held.record')} onClick={() => {
          onClose?.()
          onRecord?.()
        }}>
          <GraduationCap size={13} aria-hidden /> {t('cell.record')}
        </Button>
        {record && certificateHref ? (
          <Button size="sm" asChild>
            <a href={certificateHref} target="_blank" rel="noopener noreferrer">
              <FileText size={13} aria-hidden /> {t('cell.certificate')}
            </a>
          </Button>
        ) : (
          <Button size="sm" heldReason={t('held.noRecord')}>
            <FileText size={13} aria-hidden /> {t('cell.certificate')}
          </Button>
        )}
      </span>
    </div>
  )
}
