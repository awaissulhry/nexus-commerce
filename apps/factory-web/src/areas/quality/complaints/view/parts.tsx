'use client'

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { QualityMessages } from '../../_shared/parts'
import type { ComplaintCategory, ComplaintSeverity, ComplaintStatus, SafetyAlert } from '../api'
import { alertGarment, answerDueWords, CATEGORY_TONE, dayAt, recordHref, SEVERITY_TONE, STATUS_TONE, type Translate, type Words } from '../model'
import '../complaints.css'

/**
 * View parts every Complaints screen shares (B-W2a-65): the catalogue (`complaints` + the shared `quality`, `lists`,
 * `records`), the words of a status, a category and a severity (each says its state in words: never colour alone), the
 * answer due in words, the safety banner (design cmp-safety: one alert at a time, "n more", never timed out), the
 * owner's acknowledgement dialog, and the keys list behind `?`. Composed from DS parts; nothing here fetches.
 */

export function ComplaintsMessages({ children }: { children?: ReactNode }) {
  return <QualityMessages namespaces={['complaints']}>{children}</QualityMessages>
}

/** The screen's words (`complaints`); a `quality:` key reads the shared quality catalogue (the kinds of a failed call). */
export function useWords(): Translate {
  const t = useT('complaints')
  const q = useT('quality')
  return useMemo<Translate>(() => (key, params) => (key.startsWith('quality:') ? q(key.slice(8), params) : t(key, params)), [t, q])
}

export const say = (t: Translate, words: Words | null | undefined): string => (words ? t(words.key, words.params) : '')

export function StatusPill({ status }: { status: ComplaintStatus }) {
  const t = useWords()
  return <Pill tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Pill>
}

export function CategoryTag({ category }: { category: ComplaintCategory | null }) {
  const t = useWords()
  if (!category) return <span className="fw-q-hint">{t('category.none')}</span>
  return (
    <Tag tone={CATEGORY_TONE[category]}>
      {category === 'SAFETY' && <ShieldAlert size={11} aria-hidden />} {t(`category.${category}`)}
    </Tag>
  )
}

export function SeverityTag({ severity }: { severity: ComplaintSeverity | null }) {
  const t = useWords()
  if (!severity) return <span className="fw-q-hint">—</span>
  return <Tag tone={SEVERITY_TONE[severity]}>{t(`severity.${severity}`)}</Tag>
}

/** The answer due: the day and how it stands ("in 2 days", "3 days overdue"); "—" before triage. */
export function DueText({ row, today }: { row: { status: ComplaintStatus; answerDueOn: string | null }; today: string }) {
  const t = useWords()
  const locale = useLocale()
  const due = answerDueWords(row, today)
  if (!row.answerDueOn || !due) return <span className="fw-q-hint">—</span>
  return (
    <span className="fw-q-cell">
      <span className="fw-q-num">{formatDate(dayAt(row.answerDueOn), { locale })}</span>
      <span className={`fw-q-hint fw-cmp-due-${due.tone}`}>{say(t, due.words)}</span>
    </span>
  )
}

export function DayText({ value }: { value: string | null }) {
  const locale = useLocale()
  if (!value) return <span className="fw-q-hint">—</span>
  return <time dateTime={value}>{formatDate(value, { locale })}</time>
}

export function InstantText({ value }: { value: string | null }) {
  const locale = useLocale()
  if (!value) return <span className="fw-q-hint">—</span>
  return <time dateTime={value}>{formatDateTime(value, { locale })}</time>
}

// ---- the safety banner -----------------------------------------------------------------------------------------------------

/**
 * The safety banner (design cmp-safety; QHS-115): a safety complaint the owner has not acknowledged yet. One at a time
 * (the oldest), "n more" walks the others; it stays until acknowledged (no timer, no dismiss). Acknowledge stays
 * focusable and says why when the person is not the owner.
 */
export function SafetyBanner({
  alerts,
  more,
  prefix,
  acknowledgeHeld,
  onAcknowledge,
}: {
  alerts: readonly SafetyAlert[]
  more: number
  prefix: string
  /** A message key: why this person may not acknowledge (null: may). */
  acknowledgeHeld: string | null
  onAcknowledge?: (alert: SafetyAlert) => void
}) {
  const t = useWords()
  const locale = useLocale()
  const [index, setIndex] = useState(0)
  const ids = alerts.map((alert) => alert.id).join(',')
  useEffect(() => setIndex(0), [ids])
  if (alerts.length === 0) return null
  const at = Math.min(index, alerts.length - 1)
  const alert = alerts[at]!
  const others = alerts.length - 1 + more
  return (
    <Banner
      tone="danger"
      icon={<ShieldAlert size={18} aria-hidden />}
      title={t('banner.title', { number: alert.number, summary: alert.summary, garment: say(t, alertGarment(alert)) })}
      action={
        <span className="fw-q-actions">
          <Button size="sm" variant="primary" heldReason={acknowledgeHeld ? t(acknowledgeHeld) : null} onClick={() => onAcknowledge?.(alert)}>
            {t('banner.acknowledge')}
          </Button>
          <Button size="sm" asChild>
            <Link href={recordHref(prefix, alert.id)}>{t('banner.open')}</Link>
          </Button>
          {others > 0 && (
            <Button size="sm" variant="quiet" onClick={() => setIndex((at + 1) % alerts.length)} aria-label={t('banner.nextLabel')}>
              {t('banner.more', { count: others })}
            </Button>
          )}
        </span>
      }
    >
      {t('banner.body', { time: formatDateTime(alert.raisedAt, { locale }) })}
    </Banner>
  )
}

// ---- the owner's acknowledgement -----------------------------------------------------------------------------------------------

/** The owner acknowledges a safety alert (design: Acknowledge · Open), with an optional note of how they were told. */
export function AcknowledgeDialog({
  open,
  number,
  busy,
  problem,
  onConfirm,
  onClose,
}: {
  open: boolean
  number: string
  busy: boolean
  problem: string | null
  onConfirm: (note: string | null) => void
  onClose: () => void
}) {
  const t = useWords()
  const [note, setNote] = useState('')
  const id = useId()
  useEffect(() => {
    if (open) setNote('')
  }, [open])
  if (!open) return null
  return (
    <Modal
      open
      onClose={onClose}
      title={t('ack.title', { number })}
      size="sm"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={busy ? t('common.working') : null} onClick={() => onConfirm(note.trim() || null)}>
            {busy ? <Spinner size={12} /> : null} {t('ack.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-q-stack">
        <p className="fw-q-intro">{t('ack.body')}</p>
        {problem && <Banner tone="danger" title={t(problem)} />}
        <Field label={t('ack.note')} hint={t('ack.noteHint')} htmlFor={id}>
          <Textarea id={id} rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

// ---- keys --------------------------------------------------------------------------------------------------------------------

/** `?` and the footer's "All shortcuts": every key of the screen (its own first, then the list frame's). */
export function KeysModal({ own, withSelection = true, onClose }: { own: readonly ListKey[]; withSelection?: boolean; onClose: () => void }) {
  const t = useWords()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <dl className="fw-q-keymap">
        {listKeys(own, withSelection).map((entry) => (
          <div key={`${entry.keys.join('+')}-${entry.does}`}>
            <dt>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</dt>
            <dd>{entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}

/** A key the page answers while the focus is on the page (not typing, not in a menu or a dialog). */
export function isPageKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  const target = event.target as HTMLElement | null
  if (!target) return true
  if (target.isContentEditable) return false
  return !target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]')
}
