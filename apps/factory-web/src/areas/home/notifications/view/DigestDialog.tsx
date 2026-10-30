'use client'

import { useEffect, useId, useState } from 'react'
import { Mail } from 'lucide-react'
import { Banner, Field, Modal } from '@nexus/ui/components'
import { Button, Checkbox, Select, Skeleton, Toggle } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { digestProblem, digestTimes, NOTIFICATION_CATEGORIES, type Digest, type DigestDraft, type Loaded } from '../model'

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const

/**
 * "Preferences" (design home.notifications band; the W2b matrix's stand-in): my daily digest by e-mail — OFF until I
 * turn it on (quiet defaults, PLT-142), the time, the days and the kinds it carries. Nothing else is ever e-mailed in
 * W2a; the full matrix (each kind by app, e-mail or push; instant or daily) comes with W2b, and the dialog says so.
 */
export function DigestDialog({
  digest,
  saving,
  problem,
  held,
  onSave,
  onRetry,
  onClose,
}: {
  digest: Loaded<Digest>
  saving: boolean
  problem: string | null
  /** Why saving is held now (offline), or null. */
  held: string | null
  onSave: (draft: DigestDraft) => void
  onRetry: () => void
  onClose: () => void
}) {
  const t = useT('home-notifications')
  const locale = useLocale()
  const timeId = useId()
  const stored = digest.status === 'ready' ? digest.data : null
  const [draft, setDraft] = useState<DigestDraft | null>(stored ? { on: stored.on, sendTime: stored.sendTime, weekdays: stored.weekdays, categories: stored.categories } : null)
  // A fresh read (after a conflict) replaces the draft with what is stored now: the stored version is what changes.
  const version = stored?.version ?? -1
  useEffect(() => {
    if (stored) setDraft({ on: stored.on, sendTime: stored.sendTime, weekdays: stored.weekdays, categories: stored.categories })
  }, [version])

  const toggle = <T,>(list: readonly T[], value: T, on: boolean): T[] => (on ? [...new Set([...list, value])] : list.filter((entry) => entry !== value))
  const wrong = draft ? digestProblem(draft) : null
  const saveHeld = held ? t(held) : saving ? t('held.busy') : wrong ? t(wrong) : null

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('digest.title')}
      footer={
        <span className="fw-ntf-buttons">
          <Button variant="secondary" onClick={onClose}>
            {t('digest.cancel')}
          </Button>
          {draft && (
            <Button variant="primary" heldReason={saveHeld} onClick={() => draft && onSave(draft)}>
              {t('digest.save')}
            </Button>
          )}
        </span>
      }
    >
      <div className="fw-ntf-dialog">
        <p className="fw-ntf-muted">{t('digest.body')}</p>
        {digest.status === 'loading' ? (
          <div aria-busy="true" className="fw-ntf-dialog">
            <Skeleton height={28} />
            <Skeleton height={28} />
          </div>
        ) : digest.status === 'error' ? (
          <Banner tone="danger" title={t(digest.problem)} action={<Button size="sm" onClick={onRetry}>{t('retry')}</Button>} />
        ) : draft ? (
          <>
            {problem && <Banner tone="warning" title={t(problem)} />}
            <label className="fw-ntf-switch">
              <Toggle checked={draft.on} onChange={(on) => setDraft({ ...draft, on })} aria-label={t('digest.on')} />
              <span>
                <Mail size={14} aria-hidden /> {t(draft.on ? 'digest.onWords' : 'digest.offWords')}
              </span>
            </label>
            <Field label={t('digest.time')} hint={t('digest.timeHint')} htmlFor={timeId}>
              <Select id={timeId} value={draft.sendTime} onChange={(event) => setDraft({ ...draft, sendTime: event.target.value })}>
                {digestTimes(draft.sendTime).map((time) => (
                  <option key={time} value={time}>
                    {time}
                  </option>
                ))}
              </Select>
            </Field>
            <fieldset className="fw-ntf-fieldset">
              <legend className="fw-ntf-legend">{t('digest.days')}</legend>
              <div className="fw-ntf-checks">
                {WEEKDAYS.map((day) => (
                  <Checkbox key={day} label={t(`digest.day.${day}`)} checked={draft.weekdays.includes(day)} onChange={(event) => setDraft({ ...draft, weekdays: toggle(draft.weekdays, day, event.target.checked).sort((a, b) => a - b) })} />
                ))}
              </div>
            </fieldset>
            <fieldset className="fw-ntf-fieldset">
              <legend className="fw-ntf-legend">{t('digest.kinds')}</legend>
              <div className="fw-ntf-checks">
                {NOTIFICATION_CATEGORIES.map((category) => (
                  <Checkbox key={category} label={t(`category.${category}`)} checked={draft.categories.includes(category)} onChange={(event) => setDraft({ ...draft, categories: toggle(draft.categories, category, event.target.checked) })} />
                ))}
              </div>
            </fieldset>
            <p className="fw-ntf-muted">{stored?.lastSentAt ? t('digest.lastSent', { at: formatDateTime(stored.lastSentAt, { locale }) }) : t('digest.neverSent')}</p>
            <p className="fw-ntf-muted">{t('digest.later')}</p>
          </>
        ) : null}
      </div>
    </Modal>
  )
}
