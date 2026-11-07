'use client'

import { useState, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Menu, MultiSelect } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Input, NumberStepper, SegmentedControl, Skeleton, Spinner, Toggle } from '@nexus/ui/primitives'
import type { AttendanceSettings } from '@nexus/factory-domain/people/attendance/rules'
import { EditModeBar, Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { OfficeScope } from '../../../../shell/scope/scope-model'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import { KeysModal, LiveLine, NoPeopleAccess, useWords } from '../../_shared/parts'
import type { Limits, RuleAction, RuleKind, RuleSource } from '../api'
import { exampleOf, isChecked, lawHours, LIMIT_ORDER, limitHeld, limitsChanged, ROUNDING_CHOICES, roundingChanges, roundingHeld, SETTINGS_NAMESPACES, type LimitDraft, type SettingsCan } from '../model'
import { AbsenceCard, CodeDialog, type AbsenceState, type CodesActions } from './AbsenceCard'
import { ConsultantDialog, PayrollCard, ReviewCard, type PayrollActions, type PayrollState, type ReviewActions, type ReviewState } from './PayrollCard'
import { GateDialogs, PrivacyCard, type PrivacyActions, type PrivacyState } from './PrivacyCard'
import '../settings.css'

/** A section's read: its own loading and its own failure (the other sections keep working). */
export type Section<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

/** A failed save, in the words of whichever catalogue owns them. */
export type SettingsProblem = { ns: 'settings' | 'people'; words: { key: string; params?: Readonly<Record<string, string | number>> } }

export interface SettingsModel {
  prefix: string
  scope: OfficeScope
  can: SettingsCan
  asOf: string | null
  live: 'connecting' | 'live' | 'offline'
  /** Someone else changed these settings: "Changed by someone else · Reload". */
  changedElsewhere: boolean
  done: { key: string; params?: Record<string, string | number> } | null
  rounding: { read: Section<{ version: number | null; values: AttendanceSettings }>; draft: AttendanceSettings | null; busy: boolean; problem: SettingsProblem | null }
  absence: AbsenceState
  limits: { read: Section<Limits>; drafts: Record<string, LimitDraft>; busy: boolean; problem: SettingsProblem | null; scopeName: string | null; waitingScope: boolean }
  privacy: PrivacyState
  /** B-W2b-89: the labour consultant, the payroll code, the printer of statements. */
  payroll: PayrollState
  /** B-W2b-89: the standard review's two numbers. */
  review: ReviewState
  leaving: { busy: boolean } | null
}

export interface SettingsActions {
  onRetry?: (section: 'rounding' | 'absence' | 'limits' | 'privacy') => void
  onReload?: () => void
  onDismissDone?: () => void
  onRounding?: (change: Partial<AttendanceSettings>) => void
  onRoundingSave?: () => void
  onRoundingDiscard?: () => void
  onLimit?: (kind: RuleKind, change: Partial<LimitDraft>) => void
  onLimitsSave?: () => void
  onLimitsDiscard?: () => void
  onLimitArchive?: (kind: RuleKind) => void
  codes?: CodesActions
  privacy?: PrivacyActions
  payroll?: PayrollActions
  review?: ReviewActions
  onLeaveSave?: () => void
  onLeaveDiscard?: () => void
  onLeaveStay?: () => void
}

export function useSettingsWords() {
  return useT('people-settings')
}

/** A role in the page's language: a ready-made role by its words, a custom one by its own name. */
export function useRoleName(): (role: { key: string; name: string }) => string {
  const admin = useT('admin')
  return (role) => {
    const key = `roles.system.${role.key}.name`
    const word = admin(key)
    return word === key ? role.name : word
  }
}

export function useSaid(): (problem: SettingsProblem | null) => string | null {
  const t = useSettingsWords()
  const people = useWords()
  return (problem) => (problem ? (problem.ns === 'settings' ? t(problem.words.key, problem.words.params) : people(problem.words.key, problem.words.params)) : null)
}

/** A section's frame: its loading and its failure in its own shape; the page never draws a failure as empty. */
export function SectionState<T>({ read, title, onRetry, lines = 5, children }: { read: Section<T>; title: string; onRetry?: () => void; lines?: number; children: (value: T) => ReactNode }) {
  const t = useSettingsWords()
  const people = useWords()
  if (read.status === 'ready') return <>{children(read.value)}</>
  if (read.status === 'loading') {
    return (
      <div className="fw-ps-stack" aria-busy="true">
        <p className="fw-ps-hint" role="status">
          <Spinner size={14} /> {t('section.loading', { section: title })}
        </p>
        {Array.from({ length: lines }, (_, index) => (
          <Skeleton key={index} height={22} />
        ))}
      </div>
    )
  }
  return (
    <EmptyState
      title={t('section.failed', { section: title })}
      description={people(read.problem)}
      action={
        <Button size="sm" onClick={onRetry}>
          {people('common.retry')}
        </Button>
      }
    />
  )
}

export function CardHead({ title, purpose, side }: { title: string; purpose: string; side?: ReactNode }) {
  return (
    <div className="fw-ps-cardhead">
      <div>
        <h2>{title}</h2>
        <p className="fw-ps-hint">{purpose}</p>
      </div>
      {side}
    </div>
  )
}

/**
 * SCR-265 — People › People settings: rounding, tolerance and grace with its worked example; absence codes on the shared
 * list frame with the Absence code dialog; working-time limits with the law beside each; payroll and statements and the
 * standard review limits (B-W2b-89); the privacy of people data with the legal gates. Each section reads and fails on its
 * own, and is absent without its right. One model, nothing fetched.
 */
export function SettingsView({ model, actions }: { model: SettingsModel; actions?: SettingsActions }) {
  return (
    <WithMessages namespaces={SETTINGS_NAMESPACES}>
      <Page model={model} {...(actions ? { actions } : {})} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: SettingsModel; actions?: SettingsActions }) {
  const t = useSettingsWords()
  const { can } = model
  const [help, setHelp] = useState(false)
  if (!can.privacy && !can.attendance && !can.limits && !can.payroll && !can.review) return <NoPeopleAccess permission="people.privacy.view" />
  const history = `${model.prefix}/people/settings/history`
  return (
    <div className="fw-pp">
      <div className="fw-pp-head">
        <LiveLine asOf={model.asOf} live={model.live} />
        <span className="fw-pp-actions">
          <ScopeSiteChip model={model.scope} />
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[...(can.audit ? [{ id: 'history', label: t('band.history'), href: history, target: '_blank' as const }] : [{ id: 'history', label: t('band.history'), disabled: true, description: t('held.noAudit') }]), { id: 'keys', label: t('keys.title'), onSelect: () => setHelp(true) }]}
          />
        </span>
      </div>
      {model.changedElsewhere && (
        <Banner
          tone="warning"
          title={t('band.changedElsewhere')}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              {t('band.reload')}
            </Button>
          }
        />
      )}
      {model.done && (
        <Banner
          tone="success"
          title={t(model.done.key, model.done.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissDone?.()}>
              {t('common.close')}
            </Button>
          }
        />
      )}
      <div className="fw-ps-grid">
        {can.attendance && <RoundingCard model={model} actions={actions} />}
        {can.limits && <LimitsCard model={model} actions={actions} />}
      </div>
      {(can.payroll || can.review) && (
        <div className="fw-ps-grid">
          {can.payroll && <PayrollCard model={model} {...(actions?.payroll ? { actions: actions.payroll } : {})} />}
          {can.review && <ReviewCard model={model} {...(actions?.review ? { actions: actions.review } : {})} />}
        </div>
      )}
      {can.attendance && <AbsenceCard model={model} {...(actions?.codes ? { actions: actions.codes } : {})} onRetry={() => actions?.onRetry?.('absence')} />}
      {can.privacy && <PrivacyCard model={model} {...(actions?.privacy ? { actions: actions.privacy } : {})} onRetry={() => actions?.onRetry?.('privacy')} />}
      <CodeDialog model={model} {...(actions?.codes ? { actions: actions.codes } : {})} />
      <GateDialogs model={model} {...(actions?.privacy ? { actions: actions.privacy } : {})} />
      <ConsultantDialog model={model} {...(actions?.payroll ? { actions: actions.payroll } : {})} />
      {help && <KeysModal own={[{ keys: ['⌘', 'S'], does: t('keys.save') }]} onClose={() => setHelp(false)} />}
      {model.leaving && (
        <Modal
          open
          onClose={() => actions?.onLeaveStay?.()}
          title={t('leave.title')}
          size="sm"
          footer={
            <>
              <Button variant="quiet" onClick={() => actions?.onLeaveStay?.()}>
                {t('leave.stay')}
              </Button>
              <Button onClick={() => actions?.onLeaveDiscard?.()}>{t('leave.discard')}</Button>
              <Button variant="primary" disabled={model.leaving.busy} onClick={() => actions?.onLeaveSave?.()}>
                {t('leave.save')}
              </Button>
            </>
          }
        >
          <p>{t('leave.body')}</p>
        </Modal>
      )}
    </div>
  )
}

// ---- rounding -----------------------------------------------------------------------------------------------------------------

function RoundingCard({ model, actions }: { model: SettingsModel; actions?: SettingsActions }) {
  const t = useSettingsWords()
  const say = useSaid()
  const { read, draft, busy, problem } = model.rounding
  const manage = model.can.manageAttendance
  return (
    <Card padded>
      <div className="fw-ps-stack">
        <CardHead title={t('rounding.title')} purpose={t('rounding.purpose')} />
        <SectionState read={read} title={t('rounding.title')} onRetry={() => actions?.onRetry?.('rounding')}>
          {(value) => {
            const values = draft ?? value.values
            const change = (patch: Partial<AttendanceSettings>) => actions?.onRounding?.(patch)
            const changes = roundingChanges(value.values, values)
            const held = roundingHeld(values)
            return (
              <>
                {problem && <Banner tone="danger" title={say(problem) ?? ''} />}
                <div className="fw-ps-fields">
                  <Field label={t('rounding.early')} hint={t('rounding.earlyHint')}>
                    <Toggle checked={values.earlyClockInFromShiftStart} disabled={!manage} aria-label={t('rounding.early')} onChange={(next) => change({ earlyClockInFromShiftStart: next })} />
                  </Field>
                  <Field label={t('rounding.fixedBreaks')} hint={t('rounding.fixedBreaksHint')}>
                    <Toggle checked={values.fixedBreaks} disabled={!manage} aria-label={t('rounding.fixedBreaks')} onChange={(next) => change({ fixedBreaks: next })} />
                  </Field>
                  <Field label={t('rounding.grace')}>
                    <NumberStepper value={values.lateGraceMinutes} min={0} max={60} suffix={t('common.min')} disabled={!manage} onChange={(next) => change({ lateGraceMinutes: next })} />
                  </Field>
                  <Field label={t('rounding.unit')}>
                    <NumberStepper value={values.overtimeUnitMinutes} min={1} max={60} suffix={t('common.min')} disabled={!manage} onChange={(next) => change({ overtimeUnitMinutes: next })} />
                  </Field>
                  <Field label={t('rounding.round')}>
                    <SegmentedControl ariaLabel={t('rounding.round')} value={String(values.roundingMinutes)} disabled={!manage} onChange={(next) => change({ roundingMinutes: Number(next) })} options={ROUNDING_CHOICES.map((choice) => ({ value: String(choice), label: choice === 0 ? t('rounding.roundNone') : t('rounding.roundMinutes', { count: choice }) }))} size="sm" />
                  </Field>
                  <Field label={t('rounding.auto')} hint={t('rounding.autoHint')}>
                    <span className="fw-ps-row">
                      <Toggle checked={values.autoClockOutAfterMinutes !== null} disabled={!manage} aria-label={t('rounding.autoToggle')} onChange={(next) => change({ autoClockOutAfterMinutes: next ? 15 : null })} />
                      {values.autoClockOutAfterMinutes !== null && <NumberStepper value={values.autoClockOutAfterMinutes} min={0} max={720} step={5} suffix={t('common.min')} disabled={!manage} onChange={(next) => change({ autoClockOutAfterMinutes: next })} />}
                    </span>
                  </Field>
                </div>
                <div className="fw-ps-example">
                  <h3>{t('rounding.example')}</h3>
                  <ul>
                    {exampleOf(values).map((line) => (
                      <li key={line.key}>{t(line.key, line.params)}</li>
                    ))}
                  </ul>
                </div>
                {!manage && <p className="fw-ps-hint">{t('held.noAttendance')}</p>}
                {changes > 0 && <EditModeBar message={t('card.unsaved')} count={changes} busy={busy} applyHeldReason={held ? t(held) : null} saveShortcut onDiscard={() => actions?.onRoundingDiscard?.()} onApply={() => actions?.onRoundingSave?.()} />}
              </>
            )
          }}
        </SectionState>
      </div>
    </Card>
  )
}

// ---- working-time limits ------------------------------------------------------------------------------------------------------

function LimitsCard({ model, actions }: { model: SettingsModel; actions?: SettingsActions }) {
  const t = useSettingsWords()
  const say = useSaid()
  const ds = useDsWords()
  const roleName = useRoleName()
  const { read, drafts, busy, problem, scopeName } = model.limits
  return (
    <Card padded>
      <div className="fw-ps-stack">
        <CardHead title={t('limits.title')} purpose={t('limits.purpose')} side={<span className="fw-ps-hint">{scopeName ? t('limits.forSite', { name: scopeName }) : t('limits.forCompany')}</span>} />
        <SectionState read={read} title={t('limits.title')} lines={8} onRetry={() => actions?.onRetry?.('limits')}>
          {(value) => {
            const changed = limitsChanged(value.limits, drafts)
            const manage = model.can.manageLimits && value.canManage
            const firstHeld = changed.map(limitHeld).find(Boolean) ?? null
            return (
              <>
                {problem && <Banner tone="danger" title={say(problem) ?? ''} />}
                {model.limits.waitingScope && <Banner tone="info" title={t('limits.waitingScope')} />}
                {!manage && <p className="fw-ps-hint">{t('held.noLimits')}</p>}
                <div className="fw-ps-limits">
                  {LIMIT_ORDER.map((kind) => {
                    const entry = value.limits.find((item) => item.kind === kind)
                    const draft = drafts[kind]
                    if (!entry || !draft) return null
                    const held = limitHeld(draft)
                    const set = (patch: Partial<LimitDraft>) => actions?.onLimit?.(kind, patch)
                    return (
                      <section key={kind} className="fw-ps-limit" aria-labelledby={`fw-ps-limit-${kind}`}>
                        <div className="fw-ps-cardhead">
                          <h3 id={`fw-ps-limit-${kind}`}>{t(`limits.kind.${kind}`)}</h3>
                          <span className="fw-ps-row">
                            <LawRef law={entry.law.legalReference} plain={t('limits.lawValue', { hours: lawHours(kind) })} labels={ds.lawRef} />
                            {!isChecked(kind) && <span className="fw-ps-hint">{t('limits.notChecked')}</span>}
                          </span>
                        </div>
                        <div className="fw-ps-fields">
                          <Field label={t(`limits.value.${kind}`)} error={held === 'limits.problem.limitMinutes' ? t(held) : undefined}>
                            <NumberStepper value={draft.hours} min={0.5} step={kind === 'OVERTIME_YEARLY_CAP' ? 10 : 0.5} suffix={t('common.hours')} disabled={!manage} onChange={(next) => set({ hours: next })} />
                          </Field>
                          {kind === 'WEEKLY_AVERAGE' && (
                            <Field label={t('limits.months')} error={held === 'limits.problem.referenceMonths' ? t(held) : undefined}>
                              <NumberStepper value={draft.referenceMonths ?? 4} min={1} max={12} suffix={t('common.months')} disabled={!manage} onChange={(next) => set({ referenceMonths: next })} />
                            </Field>
                          )}
                          {kind === 'BREAK_AFTER' && (
                            <Field label={t('limits.break')} error={held === 'limits.problem.breakMinutes' ? t(held) : undefined}>
                              <NumberStepper value={draft.breakMinutes ?? 10} min={1} max={120} suffix={t('common.min')} disabled={!manage} onChange={(next) => set({ breakMinutes: next })} />
                            </Field>
                          )}
                          <Field label={t('limits.action')}>
                            <SegmentedControl ariaLabel={t('limits.action')} value={draft.action} disabled={!manage} onChange={(next) => set({ action: next as RuleAction })} options={[{ value: 'WARN', label: t('limits.WARN') }, { value: 'BLOCK', label: t('limits.BLOCK') }]} size="sm" />
                          </Field>
                          <Field label={t('limits.source')}>
                            <SegmentedControl ariaLabel={t('limits.source')} value={draft.source} disabled={!manage} onChange={(next) => set({ source: next as RuleSource, ...(next === 'LAW' ? { legalReference: entry.law.legalReference } : {}) })} options={[{ value: 'LAW', label: t('limits.LAW') }, { value: 'CCNL', label: t('limits.CCNL') }]} size="sm" />
                          </Field>
                          {draft.source === 'CCNL' && (
                            <Field label={t('limits.reference')} error={held === 'limits.problem.legalReference' ? t(held) : undefined}>
                              <Input size="sm" value={draft.legalReference} maxLength={120} disabled={!manage} onChange={(event) => set({ legalReference: event.target.value })} />
                            </Field>
                          )}
                        </div>
                        <Field label={t('limits.alerted')}>
                          {manage ? (
                            <MultiSelect ariaLabel={t('limits.alerted')} size="sm" searchable searchPlaceholder={t('limits.alertedSearch')} placeholder={t('limits.alertedNone')} options={value.roles.map((role) => ({ value: role.key, label: roleName(role) }))} value={draft.alertRoles} onChange={(next) => set({ alertRoles: next })} formatLabel={(keys) => (keys.length === 0 ? t('limits.alertedNone') : keys.map((key) => roleName({ key, name: value.roles.find((role) => role.key === key)?.name ?? key })).join(', '))} />
                          ) : (
                            <p className="fw-ps-value">{draft.alertRoles.length === 0 ? t('limits.alertedNone') : draft.alertRoles.map((key) => roleName({ key, name: value.roles.find((role) => role.key === key)?.name ?? key })).join(', ')}</p>
                          )}
                        </Field>
                        {entry.own && manage && (
                          <Button size="sm" variant="quiet" disabled={busy} onClick={() => actions?.onLimitArchive?.(kind)}>
                            {t(model.limits.scopeName ? 'limits.useCompany' : 'limits.useLaw')}
                          </Button>
                        )}
                      </section>
                    )
                  })}
                </div>
                {changed.length > 0 && <EditModeBar message={t('card.unsaved')} count={changed.length} busy={busy} applyHeldReason={firstHeld ? t(firstHeld) : null} saveShortcut onDiscard={() => actions?.onLimitsDiscard?.()} onApply={() => actions?.onLimitsSave?.()} />}
              </>
            )
          }}
        </SectionState>
      </div>
    </Card>
  )
}

