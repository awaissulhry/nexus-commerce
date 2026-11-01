'use client'

import { useEffect, useState } from 'react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, Skeleton, Tag } from '@nexus/ui/primitives'
import { DateField, FileDropzone, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useRoleWords } from '../../shared/view/parts'
import type { TwoFactorRole } from '../api'
import { drillFormErrors, drillPreview, grouped, keyWord, refusalWords, type Dialog, type DrillForm } from '../model'

export interface DrillActions {
  onDrillChange?: (patch: Partial<DrillForm>, evidence?: File | null) => void
  onDrillSave?: () => void
  onDialogClose?: () => void
}

export interface TwoFactorActions {
  onTwoFactorReason?: (reason: string) => void
  onTwoFactorSave?: () => void
  onDialogClose?: () => void
}

type DrillDialogModel = Extract<Dialog, { kind: 'drill' }>

const pad = (n: number) => String(n).padStart(2, '0')
/** An instant as the viewer's local day and time (`yyyy-mm-dd`, `HH:MM`). */
function localParts(value: string): { day: string; time: string } {
  if (value === '') return { day: '', time: '' }
  const at = new Date(value)
  return { day: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`, time: `${pad(at.getHours())}:${pad(at.getMinutes())}` }
}

/**
 * A moment as a day and a time in the viewer's own words (DS DateField with the page's placeholder, and a time input
 * the browser draws in its language). Stands in for the DS DateTimeField, whose placeholder and names are English only
 * (DS gap). The value is an ISO instant, '' while no day is chosen; a day without a time is its 09:00.
 */
export function DayTimeField({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  const t = useT('admin-security')
  const locale = useLocale()
  const parts = localParts(value)
  const emit = (day: string, time: string) => onChange(day === '' ? '' : new Date(`${day}T${time || '09:00'}`).toISOString())
  return (
    <span className="fw-sec-moment">
      <DateField value={parts.day} onChange={(day) => emit(day, parts.time)} locale={INTL_LOCALE[locale]} ariaLabel={t('sec.moment.day', { label })} placeholder={t('sec.moment.pickDay')} />
      <Input type="time" size="sm" value={parts.time} onChange={(event) => emit(parts.day, event.target.value)} aria-label={t('sec.moment.time', { label })} disabled={parts.day === ''} />
    </span>
  )
}
type TwoFactorDialogModel = Extract<Dialog, { kind: 'twoFactor' }>

/**
 * "Record a restore drill" (design admin.security pop:drill): the day, where the backup was restored (never production),
 * the backup's time, the restored copy's fingerprint line, how long it took, notes and the evidence file. Before saving,
 * this database's fingerprint at the backup's time stands beside the pasted one, key by key, with the result it would
 * give. ⌘S saves; Esc closes. The API compares again on its own (never the page's comparison).
 */
export function DrillDialog({ dialog, actions }: { dialog: DrillDialogModel; actions?: DrillActions }) {
  const t = useT('admin-security')
  const locale = useLocale()
  const [now] = useState(() => new Date())
  const errors = drillFormErrors(dialog.form, now)
  const shown = (field: keyof DrillForm) => (dialog.tried && errors[field] ? t(errors[field]!) : undefined)
  const preview = drillPreview(dialog.form, dialog.source.state === 'ok' ? dialog.source.value : null)
  const held = Object.keys(errors).length > 0 ? t('sec.drill.heldFix') : dialog.busy ? t('sec.drill.saving') : null
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        actions?.onDrillSave?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions])
  return (
    <Modal
      open
      onClose={() => actions?.onDialogClose?.()}
      title={t('sec.drill.dialog.title')}
      subtitle={t('sec.drill.dialog.hint')}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onDialogClose?.()}>{t('sec.cancel')}</Button>
          <Button variant="primary" heldReason={dialog.tried ? held : dialog.busy ? t('sec.drill.saving') : null} onClick={() => actions?.onDrillSave?.()}>
            {t('sec.drill.save')}
          </Button>
        </>
      }
    >
      <div className="fw-adm-modal-body">
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        <div className="fw-adm-form">
          <Field label={t('sec.drill.field.day')} required error={shown('drilledOn')}>
            <DateField value={dialog.form.drilledOn} onChange={(value) => actions?.onDrillChange?.({ drilledOn: value })} locale={INTL_LOCALE[locale]} ariaLabel={t('sec.drill.field.day')} placeholder={t('sec.moment.pickDay')} />
          </Field>
          <Field label={t('sec.drill.field.environment')} required hint={t('sec.drill.field.environmentHint')} error={shown('environment')}>
            <Input value={dialog.form.environment} onChange={(event) => actions?.onDrillChange?.({ environment: event.target.value })} placeholder={t('sec.drill.field.environmentPlaceholder')} />
          </Field>
          <Field label={t('sec.drill.field.backupAt')} required hint={t('sec.drill.field.backupAtHint')} error={shown('backupAt')}>
            <DayTimeField value={dialog.form.backupAt} onChange={(value) => actions?.onDrillChange?.({ backupAt: value })} label={t('sec.drill.field.backupAt')} />
          </Field>
          <Field label={t('sec.drill.field.duration')} hint={t('sec.drill.field.durationHint')} error={shown('durationMinutes')}>
            <Input inputMode="numeric" value={dialog.form.durationMinutes} onChange={(event) => actions?.onDrillChange?.({ durationMinutes: event.target.value })} />
          </Field>
          <div className="fw-adm-form-wide">
            <Field label={t('sec.drill.field.restored')} required hint={t('sec.drill.field.restoredHint')} error={shown('restored')}>
              <Textarea rows={2} value={dialog.form.restored} onChange={(event) => actions?.onDrillChange?.({ restored: event.target.value })} placeholder="NXF1 orders=… invoices=… stockMoves=… parties=… files=…" spellCheck={false} />
            </Field>
          </div>
        </div>
        <div className="fw-sec-compare" aria-live="polite">
          <h3 className="fw-sec-sub">{t('sec.drill.compare.title')}</h3>
          {dialog.form.backupAt === '' ? (
            <p className="fw-adm-hint">{t('sec.drill.compare.needBackup')}</p>
          ) : dialog.source.state === 'loading' ? (
            <Skeleton height={60} />
          ) : dialog.source.state === 'failed' ? (
            <p className="fw-adm-hint">{t('sec.drill.compare.failed')}</p>
          ) : !preview ? (
            <p className="fw-adm-hint">{t('sec.drill.compare.needLine')}</p>
          ) : (
            <>
              <p className="fw-sec-fact">
                <Pill tone={preview.result === 'PASSED' ? 'success' : 'danger'}>{t(`sec.drill.would.${preview.result}`)}</Pill>
                {dialog.source.state === 'ok' && <span className="fw-adm-hint">{t('sec.drill.compare.asOf', { time: formatDateTime(dialog.source.value.asOf, { locale }) })}</span>}
              </p>
              <SummaryTable
                label={t('sec.drill.compare.title')}
                density="compact"
                stackOnPhone
                columns={[t('sec.drill.compare.key'), t('sec.drill.compare.here'), t('sec.drill.compare.copy'), t('sec.drill.compare.match')]}
                rows={preview.checks.map((check) => ({
                  id: check.key,
                  cells: [
                    t(keyWord(check.key)),
                    <code key="here" className="fw-sec-code">{grouped(check.source)}</code>,
                    <code key="copy" className="fw-sec-code">{grouped(check.restored)}</code>,
                    <Tag key="match" tone={check.match ? 'success' : 'danger'}>{t(check.match ? 'sec.drill.compare.same' : 'sec.drill.compare.differs')}</Tag>,
                  ],
                }))}
              />
            </>
          )}
        </div>
        <Field label={t('sec.drill.field.notes')} error={shown('notes')}>
          <Textarea rows={3} value={dialog.form.notes} onChange={(event) => actions?.onDrillChange?.({ notes: event.target.value })} />
        </Field>
        <Field label={t('sec.drill.field.evidence')} hint={t('sec.drill.field.evidenceHint')}>
          {dialog.form.evidence ? (
            <span className="fw-sec-fact">
              <Tag>{dialog.form.evidence.name}</Tag>
              <Button size="sm" variant="quiet" onClick={() => actions?.onDrillChange?.({ evidence: null }, null)}>
                {t('sec.drill.field.evidenceRemove')}
              </Button>
            </span>
          ) : (
            <FileDropzone accept=".pdf,.png,.jpg,.jpeg,.txt,.csv" maxBytes={25 * 1024 * 1024} onFiles={(files) => files[0] && actions?.onDrillChange?.({ evidence: { name: files[0].name, size: files[0].size } }, files[0])} hint={t('sec.drill.field.evidenceTypes')} />
          )}
        </Field>
      </div>
    </Modal>
  )
}

/**
 * Ask (or stop asking) two-factor of the ticked roles: who it affects before saving (asked at their next sign-in, never
 * mid-session: open sessions keep the role until they end), what it would refuse, in the page's words; the save asks
 * for a fresh code (roles.manage).
 */
export function TwoFactorDialog({ dialog, roles, actions }: { dialog: TwoFactorDialogModel; roles: readonly TwoFactorRole[]; actions?: TwoFactorActions }) {
  const t = useT('admin-security')
  const words = useRoleWords()
  const named = dialog.changes.map((change) => roles.find((role) => role.id === change.roleId)).filter((role): role is TwoFactorRole => !!role)
  const preview = dialog.preview.state === 'ok' ? dialog.preview.value : null
  const refusals = preview ? refusalWords(preview, dialog.changes, roles) : []
  const held = dialog.preview.state !== 'ok' ? t('sec.tf.dialog.waiting') : refusals.length > 0 ? t('sec.tf.dialog.refused') : dialog.busy ? t('sec.tf.dialog.saving') : null
  return (
    <Modal
      open
      onClose={() => actions?.onDialogClose?.()}
      title={t(dialog.requireMfa ? 'sec.tf.dialog.askTitle' : 'sec.tf.dialog.stopTitle', { count: named.length })}
      subtitle={named.map((role) => words.name(role)).join(' · ')}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialogClose?.()}>{t('sec.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onTwoFactorSave?.()}>
            {t(dialog.requireMfa ? 'sec.tf.dialog.ask' : 'sec.tf.dialog.stop')}
          </Button>
        </>
      }
    >
      <div className="fw-adm-modal-body">
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        {refusals.map((refusal, index) => (
          <Banner key={index} tone="warning" title={refusal.role ? t('sec.tf.dialog.refusalOf', { role: refusal.role }) : t('sec.tf.dialog.refusalAll')}>
            {t(refusal.key)}
          </Banner>
        ))}
        {dialog.preview.state === 'loading' && <Skeleton height={60} />}
        {dialog.preview.state === 'failed' && <p className="fw-adm-hint">{t('sec.tf.dialog.previewFailed')}</p>}
        {preview && (
          <>
            <p className="fw-adm-intro">{t(dialog.requireMfa ? 'sec.tf.dialog.askBody' : 'sec.tf.dialog.stopBody', { count: preview.affected.length })}</p>
            {preview.affected.length > 0 && (
              <ul className="fw-sec-people">
                {preview.affected.map((person) => (
                  <li key={person.userId}>
                    <span>{person.name ?? t('sec.tf.dialog.someone')}</span>
                    {dialog.requireMfa && <Tag tone="warning">{t('sec.tf.dialog.notSetUp')}</Tag>}
                  </li>
                ))}
              </ul>
            )}
            {dialog.requireMfa && preview.openSessions > 0 && <p className="fw-adm-hint">{t('sec.tf.dialog.openSessions', { count: preview.openSessions })}</p>}
            {!dialog.requireMfa && <p className="fw-adm-hint">{t('sec.tf.dialog.stopWarn')}</p>}
          </>
        )}
        <Field label={t('sec.tf.dialog.reason')} hint={t('sec.tf.dialog.reasonHint')}>
          <Input value={dialog.reason} onChange={(event) => actions?.onTwoFactorReason?.(event.target.value)} />
        </Field>
        <p className="fw-adm-hint">{t('sec.tf.dialog.code')}</p>
      </div>
    </Modal>
  )
}
