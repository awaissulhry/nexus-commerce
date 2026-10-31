'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { AlarmClock, Clock, RefreshCw } from 'lucide-react'
import { DateTimeField, Field, Modal } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { pickedProblem, snoozeOptions, type SnoozeChoice } from '../snooze'
import './snooze.css'

export interface SnoozeDialogProps {
  /** What is snoozed, in words ("SEED-SO-0002", "Call the tannery"). */
  what: string
  /** The moment the choices are worked out from (the page's clock). */
  now: number
  /** The thing snoozed can wait "until something changes on its record" (an alert row, a notification). */
  untilChange: boolean
  /** The host's words for that last choice when its "change" is another event (B-W2a-70: "After the next run"). */
  untilChangeLabel?: string
  /** The API's limit for it, in days. */
  maxDays: number
  /** Why snoozing is held now (offline, busy), or null. */
  held?: string | null
  /** `until` null: until something changes. Resolves true when it was snoozed (the dialog then closes itself). */
  onSnooze: (until: string | null) => Promise<boolean> | void
  onClose: () => void
}

/**
 * "Snooze until" (design home.today popup `snooze`, W2a; the same for a notification's H and a task): the fixed choices
 * as buttons (↑ / ↓ between them, Enter snoozes), "Pick a date" with the DS DateTimeField, "Until something changes on
 * the record" where there is one to watch. A centred modal rather than the design's popover beside a row: the row may
 * sit in a grid or a list the keyboard drives, and the modal is the same everywhere. Every time is the site's.
 */
export function SnoozeDialog(props: SnoozeDialogProps) {
  return (
    <WithMessages namespaces={['home']}>
      <Snooze {...props} />
    </WithMessages>
  )
}

function Snooze({ what, now, untilChange, untilChangeLabel, maxDays, held = null, onSnooze, onClose }: SnoozeDialogProps) {
  const t = useT('home')
  const locale = useLocale()
  const options = useMemo(() => snoozeOptions(now, { untilChange }), [now, untilChange])
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState('')
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  const fieldId = useId()
  useEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [])

  const go = async (until: string | null) => {
    if (held || busy) return
    setBusy(true)
    try {
      const done = await onSnooze(until)
      if (done !== false) onClose()
    } finally {
      setBusy(false)
    }
  }
  const words = (choice: SnoozeChoice, until: string | null) => {
    if (choice === 'LATER_TODAY' && until) return t('today.snooze.laterToday', { time: formatTime(until, { locale }) })
    if (choice === 'TOMORROW' && until) return t('today.snooze.tomorrow', { time: formatTime(until, { locale }) })
    if (choice === 'MONDAY' && until) return t('today.snooze.monday', { time: formatTime(until, { locale }) })
    if (choice === 'PICK') return t('today.snooze.pick')
    return untilChangeLabel ?? t('today.snooze.untilChange')
  }
  const onListKey = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const at = buttons.findIndex((button) => button === document.activeElement)
    const next = event.key === 'ArrowDown' ? Math.min(buttons.length - 1, at + 1) : Math.max(0, at - 1)
    event.preventDefault()
    buttons[next]?.focus()
  }
  const pickHeld = held ?? (busy ? t('today.actions.held.busy') : null) ?? (() => {
    const problem = pickedProblem(picked, now, maxDays)
    return problem ? t(problem, { count: maxDays }) : null
  })()
  const max = new Date(now + maxDays * 86_400_000).toISOString()

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('today.snooze.title', { what })}
      footer={
        <span className="fw-snooze-buttons">
          <Button variant="secondary" onClick={onClose}>
            {t('today.snooze.cancel')}
          </Button>
          {picking && (
            <Button variant="primary" heldReason={pickHeld} onClick={() => void go(new Date(picked).toISOString())}>
              <AlarmClock size={14} aria-hidden /> {t('today.snooze.confirm')}
            </Button>
          )}
        </span>
      }
    >
      <div className="fw-snooze">
        <p className="fw-snooze-muted">{t('today.snooze.body')}</p>
        <ul ref={listRef} className="fw-snooze-list" aria-label={t('today.snooze.choices')} onKeyDown={onListKey}>
          {options.map((option) => (
            <li key={option.choice}>
              <Button
                variant={option.choice === 'PICK' && picking ? 'tonal' : 'secondary'}
                wrap
                heldReason={option.choice === 'PICK' ? null : (held ?? (busy ? t('today.actions.held.busy') : null))}
                onClick={() => (option.choice === 'PICK' ? setPicking(true) : void go(option.until))}
              >
                {option.choice === 'UNTIL_CHANGE' ? <RefreshCw size={14} aria-hidden /> : <Clock size={14} aria-hidden />}
                <span>{words(option.choice, option.until)}</span>
                {option.until && <span className="fw-snooze-when">{formatDateTime(option.until, { locale })}</span>}
              </Button>
            </li>
          ))}
        </ul>
        {picking && (
          <Field label={t('today.snooze.pickLabel')} hint={t('today.snooze.pickHint', { count: maxDays })} htmlFor={fieldId}>
            <DateTimeField id={fieldId} value={picked} onChange={setPicked} min={new Date(now).toISOString()} max={max} defaultTime="08:00" locale={INTL_LOCALE[locale]} ariaLabel={t('today.snooze.pickLabel')} />
          </Field>
        )}
      </div>
    </Modal>
  )
}
