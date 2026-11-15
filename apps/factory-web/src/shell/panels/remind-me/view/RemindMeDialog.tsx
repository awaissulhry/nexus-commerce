'use client'

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AlarmClock, Clock, RefreshCw } from 'lucide-react'
import { Field } from '@nexus/ui/components'
import { Button, Textarea } from '@nexus/ui/primitives'
import { REMINDER_LIMITS, type ReminderKind } from '@nexus/factory-domain/reminders/rules'
import { DateTimeField, Modal } from '../../../../lib/i18n/ds-parts'
import { formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { noteProblem, pickedProblem, remindOptions, type RemindChoice } from '../model'
import '../remind-me.css'

export interface RemindMeDialogProps {
  /** What it reminds of, in words ("PO-2026-0031"). */
  what: string
  /** About one message of the record's thread (the words say so). */
  aboutMessage?: boolean
  /** The moment the choices are worked out from. */
  now: number
  /** Why setting is held now (offline): a message key of `home-mywork`, or null. */
  held?: string | null
  /** A problem of the last try (a message key of `home-mywork`), or null. */
  problem?: string | null
  /** Resolves true when it was set (the dialog then closes itself). */
  onSet: (ask: { readonly kind: ReminderKind; readonly remindAt: string | null; readonly note: string | null }) => Promise<boolean> | void
  onClose: () => void
}

/**
 * Remind me (design shell.panels popup remind-me, W2b; COL-041): "Later today 16:00 · Tomorrow 08:00 · Monday 08:00 · Pick a date ·
 * When something changes. It comes back to Today then." The person's note first (optional), then the choices as buttons (↑ / ↓
 * between them, Enter sets), "Pick a date" with the DS DateTimeField and Set reminder. A centred modal, as Today's "Snooze until":
 * the same everywhere a reminder is set (the record's ⋯, a message, Coming up). Every time is the site's.
 */
export function RemindMeDialog(props: RemindMeDialogProps) {
  return (
    <WithMessages namespaces={['home-mywork']}>
      <RemindMe {...props} />
    </WithMessages>
  )
}

function RemindMe({ what, aboutMessage = false, now, held = null, problem = null, onSet, onClose }: RemindMeDialogProps) {
  const t = useT('home-mywork')
  const locale = useLocale()
  const options = useMemo(() => remindOptions(now), [now])
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  const noteId = useId()
  const pickId = useId()
  useEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [])

  const noteHeld = noteProblem(note)
  const setHeld = (held ? t(held) : null) ?? (busy ? t('remind.held.busy') : null) ?? (noteHeld ? t(noteHeld, { count: REMINDER_LIMITS.note }) : null)
  const go = async (kind: ReminderKind, remindAt: string | null) => {
    if (setHeld) return
    setBusy(true)
    try {
      const done = await onSet({ kind, remindAt, note: note.trim() === '' ? null : note })
      if (done !== false) onClose()
    } finally {
      setBusy(false)
    }
  }
  const words = (choice: RemindChoice, at: string | null) => {
    if (choice === 'LATER_TODAY' && at) return t('remind.laterToday', { time: formatTime(at, { locale }) })
    if (choice === 'TOMORROW' && at) return t('remind.tomorrow', { time: formatTime(at, { locale }) })
    if (choice === 'MONDAY' && at) return t('remind.monday', { time: formatTime(at, { locale }) })
    if (choice === 'PICK') return t('remind.pick')
    return t('remind.onChange')
  }
  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const at = buttons.findIndex((button) => button === document.activeElement)
    const next = event.key === 'ArrowDown' ? Math.min(buttons.length - 1, at + 1) : Math.max(0, at - 1)
    event.preventDefault()
    buttons[next]?.focus()
  }
  const pickHeld = setHeld ?? (() => {
    const found = pickedProblem(picked, now)
    return found ? t(found, { count: REMINDER_LIMITS.maxDays }) : null
  })()

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t(aboutMessage ? 'remind.titleMessage' : 'remind.title', { what })}
      footer={
        <span className="fw-remind-buttons">
          <Button variant="secondary" onClick={onClose}>
            {t('remind.cancel')}
          </Button>
          {picking && (
            <Button variant="primary" heldReason={pickHeld} onClick={() => void go('AT_TIME', new Date(picked).toISOString())}>
              <AlarmClock size={14} aria-hidden /> {t('remind.set')}
            </Button>
          )}
        </span>
      }
    >
      <div className="fw-remind">
        <p className="fw-remind-muted">{t('remind.body')}</p>
        {problem && (
          <p className="fw-remind-problem" role="alert">
            {t(problem)}
          </p>
        )}
        <Field label={t('remind.note')} hint={t('remind.noteHint', { count: REMINDER_LIMITS.note })} htmlFor={noteId} error={noteHeld ? t(noteHeld, { count: REMINDER_LIMITS.note }) : undefined}>
          <Textarea id={noteId} value={note} rows={2} onChange={(event) => setNote(event.target.value)} placeholder={t('remind.notePlaceholder')} />
        </Field>
        <ul ref={listRef} className="fw-remind-list" aria-label={t('remind.choices')} onKeyDown={onListKey}>
          {options.map((option) => (
            <li key={option.choice}>
              <Button
                variant={option.choice === 'PICK' && picking ? 'tonal' : 'secondary'}
                wrap
                heldReason={option.choice === 'PICK' ? null : setHeld}
                onClick={() => (option.choice === 'PICK' ? setPicking(true) : void go(option.kind, option.remindAt))}
              >
                {option.kind === 'ON_CHANGE' ? <RefreshCw size={14} aria-hidden /> : <Clock size={14} aria-hidden />}
                <span>{words(option.choice, option.remindAt)}</span>
                {option.remindAt && <span className="fw-remind-when">{formatDateTime(option.remindAt, { locale })}</span>}
              </Button>
            </li>
          ))}
        </ul>
        {picking && (
          <Field label={t('remind.pickLabel')} hint={t('remind.pickHint', { count: REMINDER_LIMITS.maxDays })} htmlFor={pickId}>
            <DateTimeField
              id={pickId}
              value={picked}
              onChange={setPicked}
              min={new Date(now).toISOString()}
              max={new Date(now + REMINDER_LIMITS.maxDays * 86_400_000).toISOString()}
              defaultTime="08:00"
              locale={INTL_LOCALE[locale]}
              ariaLabel={t('remind.pickLabel')}
            />
          </Field>
        )}
        <p className="fw-remind-muted">{t('remind.comesBack')}</p>
      </div>
    </Modal>
  )
}
