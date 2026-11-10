'use client'

import { useState } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select } from '@nexus/ui/primitives'
import { DateField, Modal, ReviewChangesPanel, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { decimalText, minutesText } from '../../../styles/model'
import type { OperationMinutesView } from '../api'
import { MAX_REASON, minDayOf, pendingOf, previewOf, proposedChanges, proposeDraftOf, proposeHeld, proposeProblems, TIME_SOURCES, type MinutesActions, type MinutesModel, type ProposeDraft, type ProposeField, type TimeSource } from '../model'
import { ImpactCard } from './ImpactCard'

/**
 * Propose SMV change (B-W2b-235; design products.operations pop:operations.smvChange, PRD-113): old → new SMV built from the
 * basic time and the personal, fatigue and delay allowances (factory-domain's own rule, so the new SMV shown is the one
 * stored), where the time comes from, the first day it applies (from today, never before an approved version's day), the
 * reason, the routings and piece rates it reaches. "Send for approval" (⌘↵) makes a PROPOSED version a second person
 * decides; while one waits, this one may replace it (said first). It fetches nothing.
 */
export function ProposeDialog({ view, model, actions }: { view: OperationMinutesView; model: MinutesModel; actions?: MinutesActions }) {
  const t = useT('products-operations-depth')
  const tl = useT('library')
  const locale = useLocale()
  const [draft, setDraft] = useState<ProposeDraft>(() => model.draft ?? proposeDraftOf(view, locale))
  const [tried, setTried] = useState(!!model.draft)
  const set = (patch: Partial<ProposeDraft>) => {
    setTried(true)
    setDraft((current) => ({ ...current, ...patch }))
  }
  const pending = pendingOf(view)
  const preview = previewOf(draft)
  const problems = proposeProblems(draft, view)
  const held = model.offline ? 'offline.held' : proposeHeld(draft, view, model.busy)
  const min = minDayOf(view)
  const day = (value: string | null) => (value ? formatDate(value, { locale }) : '—')
  const show = (field: ProposeField) => (tried && problems[field] ? t(problems[field]!) : undefined)
  const close = () => actions?.onDialog?.(null)
  const send = () => {
    setTried(true)
    if (held) return
    void actions?.onPropose?.(draft)
  }
  const value = (kind: 'minutes' | 'percent' | 'day', text: string | null) => (text === null ? '—' : kind === 'day' ? day(text) : kind === 'percent' ? t('pct', { value: decimalText(text, locale, 4) }) : t('min', { minutes: minutesText(text, locale) }))
  const changes = proposedChanges(draft, view)
    .filter((change) => change.id === 'smv' || change.id === 'day' || change.now !== change.next)
    .map((change) => ({ id: change.id, what: t(change.what), now: value(change.kind, change.now), next: value(change.kind, change.next) }))
  const refused = model.refused

  return (
    <Modal
      open
      onClose={close}
      size="lg"
      title={t('propose.title', { code: view.operation.code })}
      subtitle={view.operation.name}
      footer={
        <>
          <Button onClick={close}>{tl('common.back')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={send} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('propose.send')}
          </Button>
        </>
      }
    >
      <div
        className="fw-opd-stack"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            send()
          }
        }}
      >
        <p className="fw-opd-hint">{view.governed ? t('propose.introGoverned') : t('propose.introFirst')}</p>
        {pending && (
          <Banner tone="warning" title={t('propose.pending', { number: pending.number, minutes: minutesText(pending.standardMinutes, locale), day: day(pending.effectiveFrom), name: pending.proposedBy.name })}>
            <Checkbox label={t('propose.replace', { number: pending.number })} checked={draft.replace} onChange={(event) => set({ replace: event.target.checked })} />
          </Banner>
        )}
        <div className="fw-opd-form">
          <Field label={t('propose.basic')} required hint={t('propose.basicHint')} error={show('basic')}>
            <Input inputMode="decimal" autoFocus value={draft.basic} suffix={t('minUnit')} onChange={(event) => set({ basic: event.target.value })} />
          </Field>
          <Field label={t('propose.personal')} hint={t('propose.allowanceHint')} error={show('personal')}>
            <Input inputMode="decimal" value={draft.personal} suffix="%" onChange={(event) => set({ personal: event.target.value })} />
          </Field>
          <Field label={t('propose.fatigue')} error={show('fatigue')}>
            <Input inputMode="decimal" value={draft.fatigue} suffix="%" onChange={(event) => set({ fatigue: event.target.value })} />
          </Field>
          <Field label={t('propose.delay')} error={show('delay')}>
            <Input inputMode="decimal" value={draft.delay} suffix="%" onChange={(event) => set({ delay: event.target.value })} />
          </Field>
        </div>
        <p className="fw-opd-sum" aria-live="polite">
          <span>{t('propose.newSmv')}</span>
          <span className="fw-opd-big">{preview.ok ? t('min', { minutes: minutesText(preview.minutes.standardMinutes, locale) }) : '—'}</span>
          <span className="fw-opd-hint">{t('propose.was', { minutes: minutesText(view.current.standardMinutes, locale) })}</span>
        </p>
        <div className="fw-opd-form">
          <Field label={t('propose.source')} error={show('source')}>
            <Select value={draft.source} onChange={(event) => set({ source: event.target.value as TimeSource })}>
              {TIME_SOURCES.map((source) => (
                <option key={source} value={source}>
                  {t(`source.${source}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('propose.effectiveFrom')} required hint={min === view.today ? t('propose.dayHint') : t('propose.dayHintApproved', { day: day(min) })} error={show('effectiveFrom')}>
            <DateField value={draft.effectiveFrom} min={min} locale={INTL_LOCALE[locale]} onChange={(next) => set({ effectiveFrom: next })} />
          </Field>
          <div className="fw-opd-span">
            <Field label={t('propose.reason')} required hint={t('propose.reasonHint')} error={show('reason')}>
              <Textarea value={draft.reason} rows={2} maxLength={MAX_REASON} onChange={(event) => set({ reason: event.target.value })} />
            </Field>
          </div>
        </div>
        {tried && problems.same && <p className="fw-opd-hint fw-opd-warn">{t(problems.same)}</p>}
        <ReviewChangesPanel label={t('propose.reviewLabel')} changes={changes} ack={false} onAckChange={() => undefined} warnings={draft.effectiveFrom === view.today ? [t('propose.today')] : [t('propose.later', { day: day(draft.effectiveFrom) })]} />
        <ImpactCard view={view} compact />
        {refused && (
          <Banner tone="danger" title={refusalTitle(refused.key, t, tl)}>
            {refused.messages.length > 0 && (
              <ul className="fw-opd-list">
                {refused.messages.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )}
          </Banner>
        )}
      </div>
    </Modal>
  )
}

/** A refused write in words: the library's problem words (moved, forbidden …), with our own for a waiting proposal. */
export function refusalTitle(key: string, t: (key: string) => string, tl: (key: string) => string): string {
  if (key === 'problem.write.forbidden') return t('refused.forbidden')
  if (key === 'problem.write.state') return t('refused.state')
  return tl(key)
}
