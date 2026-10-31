'use client'

import { useEffect } from 'react'
import { Banner, Field, Modal } from '@nexus/ui/components'
import { Button, Kbd, RadioCard, Skeleton, Textarea } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Read } from '../../_shared/model'
import type { HoldSettingsAnswer } from '../api'
import { settingsChanged, settingsHeld, settingsInForceKey, settingsLoosens, settingsSourceKey, type HoldSettingsDraft } from '../model'

/**
 * Who releases holds (B-W2b-17; design quality.settings qs-sod "A hold is released by someone other than the person who
 * placed it: on / off", qs-loosen "Confirm a looser rule"): the company's rule in force and where it comes from, then the
 * choice — someone else releases (B-W2a-26's rule), the person who placed it may release it too, or (a company) follow the
 * rule set for every company. Letting the placer release is the looser rule: it asks why, and the office's fresh code at
 * Save (the page's step-up). Without quality.settings.manage the dialog reads the rule and Save is held with the reason.
 * Fetches nothing: HoldsPage reads GET /quality/holds/settings and saves PUT /quality/holds/settings.
 */
export function HoldSettingsDialog({
  open,
  answer,
  draft,
  busy,
  problem,
  lines,
  companyName,
  onDraft,
  onSave,
  onRetry,
  onClose,
}: {
  open: boolean
  answer: Read<HoldSettingsAnswer> | null
  draft: HoldSettingsDraft | null
  busy: boolean
  problem: string | null
  lines?: readonly string[]
  companyName: string
  onDraft: (draft: HoldSettingsDraft) => void
  onSave: () => void
  onRetry?: () => void
  onClose: () => void
}) {
  const t = useT('holds')
  const q = useT('quality')
  const locale = useLocale()
  const value = answer?.value ?? null
  const held = settingsHeld(value, draft, busy)
  const loosens = value && draft ? settingsLoosens(value.settings, draft) : false
  const changed = value && draft ? settingsChanged(value.settings, draft) : false
  const isCompany = value?.settings.companyId !== null

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
        event.preventDefault()
        onSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!open) return null
  const may = value?.mayChange ?? false
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('settings.title')}
      subtitle={companyName ? t('settings.subtitle', { company: companyName }) : undefined}
      footer={
        <span className="fw-q-actions">
          <Button variant="secondary" onClick={onClose}>
            {may ? q('common.cancel') : q('common.close')}
          </Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={onSave}>
            {loosens ? t('settings.saveLoosen') : t('settings.save')} <Kbd>⌘↵</Kbd>
          </Button>
        </span>
      }
    >
      <div className="fw-q-stack">
        {answer?.problem ? (
          <Banner
            tone="danger"
            title={t('settings.failed')}
            action={
              onRetry ? (
                <Button size="sm" onClick={onRetry}>
                  {q('common.retry')}
                </Button>
              ) : undefined
            }
          >
            {q(answer.problem)}
          </Banner>
        ) : value === null ? (
          <Skeleton height={120} />
        ) : (
          <>
            <Banner tone="info" title={t('settings.inForce.title', { rule: t(settingsInForceKey(value.settings)) })}>
              {t(settingsSourceKey(value.settings))}
              {value.settings.own ? ` ${t('settings.savedAt', { at: formatDateTime(value.settings.own.updatedAt, { locale }) })}` : ''}
            </Banner>
            {!may && <p className="fw-q-hint">{t('settings.held.noRight')}</p>}
            {draft && (
              <fieldset className="fw-q-choices" disabled={!may}>
                <legend className="fw-q-section-title">
                  <strong>{t('settings.question')}</strong>
                </legend>
                <RadioCard name="hold-release" checked={draft.choice === false} selected={draft.choice === false} onChange={() => onDraft({ ...draft, choice: false })} title={t('settings.choice.someoneElse')} description={t('settings.choice.someoneElseHint')} />
                <RadioCard name="hold-release" checked={draft.choice === true} selected={draft.choice === true} onChange={() => onDraft({ ...draft, choice: true })} title={t('settings.choice.placerMay')} description={t('settings.choice.placerMayHint')} />
                {isCompany && <RadioCard name="hold-release" checked={draft.choice === null} selected={draft.choice === null} onChange={() => onDraft({ ...draft, choice: null })} title={t('settings.choice.follow')} description={t('settings.choice.followHint')} />}
              </fieldset>
            )}
            <p className="fw-q-hint">{t('settings.makerStays')}</p>
            {may && draft && changed && loosens && (
              <Field label={t('settings.reason')} hint={t('settings.reasonHint')} required>
                <Textarea rows={2} value={draft.reason} onChange={(event) => onDraft({ ...draft, reason: event.target.value })} />
              </Field>
            )}
            {may && draft && changed && !loosens && <p className="fw-q-hint">{t('settings.tightens')}</p>}
          </>
        )}
        {problem && (
          <Banner tone="danger" title={t(problem)}>
            {lines && lines.length > 0 && (
              <ul className="fw-q-lines">
                {lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </Banner>
        )}
      </div>
    </Modal>
  )
}
