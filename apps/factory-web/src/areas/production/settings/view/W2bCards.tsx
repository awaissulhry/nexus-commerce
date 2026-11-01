'use client'

import { useEffect, useMemo, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Banner, Card, Field } from '@nexus/ui/components'
import { Button, Input, NumberStepper, RadioCard, SegmentedControl, Skeleton, Spinner, Toggle } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../lib/i18n/ds-parts'
import { BUNDLE_CODE_MODES, FLOOR_RULE_MODES, type FloorRuleMode } from '@nexus/factory-domain/production/settings/floor-rules'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { BundleRules, FloorRules } from '../w2b-api'
import { checksChange, checksDraftOf, checksHeld, couponsChange, couponsDraftOf, couponsHeld, fullMissing, LIMITS, type ChecksDraft, type CouponsDraft } from '../w2b-model'
import type { FloorRulesActions, FloorRulesModel } from './FloorRulesView'

/**
 * The W2b form sections of Floor rules & codes (B-W2b-58): Floor rules per site (design fr-rules, MES-294: the sequence and
 * the quantity guard, scrap above a limit of pieces waiting for the team leader (MES-128); the rules the same at every
 * site for now — undo window, tablet clock, offline — and idle sign-out as the tablets' settings keep it), Bundle codes
 * (fr-bundle, MES-067 and MES-168: one bundle code at every operation, or a coupon per operation; the hours after which a
 * bundle with no scan is stuck), and the note above the reason lists (fr-reasons, MES-293: the full floor lists). Each
 * form shows the DS EditModeBar while it holds changes (⌘S applies the one being changed); a viewer reads the rules as text.
 */

function Loading({ title }: { title: string }) {
  return (
    <Card padded>
      <section className="fw-fr-section" aria-busy="true">
        <h2 className="fw-fr-title">{title}</h2>
        <Skeleton height={160} />
      </section>
    </Card>
  )
}

function Failed({ title, problem, onRetry }: { title: string; problem: string; onRetry?: () => void }) {
  const t = useT('floor-rules')
  return (
    <Card padded>
      <section className="fw-fr-section">
        <h2 className="fw-fr-title">{title}</h2>
        <Banner tone="danger" title={t(problem)} action={onRetry ? <Button size="sm" onClick={onRetry}>{t('fr.retry')}</Button> : undefined} />
      </section>
    </Card>
  )
}

// ---- Floor rules per site -----------------------------------------------------------------------------------------------------

export function FloorChecksCard({ model, actions }: { model: FloorRulesModel; actions?: FloorRulesActions }) {
  const t = useT('floor-rules')
  const part = model.floor
  if (!part || (!part.value && !part.problem)) return <Loading title={t('fr.checks.title')} />
  if (!part.value) return <Failed title={t('fr.checks.title')} problem={part.problem ?? 'fr.problem.read'} onRetry={actions?.onRetry} />
  return <ChecksForm key={`${part.value.site.id}:${part.value.version ?? 0}`} model={model} actions={actions} rules={part.value} />
}

function ChecksForm({ model, actions, rules }: { model: FloorRulesModel; actions?: FloorRulesActions; rules: FloorRules }) {
  const t = useT('floor-rules')
  const locale = useLocale()
  const saved = useMemo(() => checksDraftOf(rules), [rules])
  const [draft, setDraft] = useState<ChecksDraft>(model.checksDraft ?? saved)
  useEffect(() => setDraft(model.checksDraft ?? saved), [model.checksDraft, saved])
  const change = checksChange(rules, draft)
  const busy = model.busy === 'checks'
  const held = checksHeld(draft, busy)
  const editable = model.can.manage && rules.canManage
  const set = (patch: Partial<ChecksDraft>) => setDraft((current) => ({ ...current, ...patch }))
  const modeOptions = (rule: 'sequence' | 'quantity') => FLOOR_RULE_MODES.map((mode) => ({ value: mode, label: t(`fr.checks.${rule}.${mode}.label`) }))
  const fixed = rules.fixed
  const idle = rules.idleSignOut

  return (
    <Card padded>
      <section className="fw-fr-section" aria-labelledby="fr-checks">
        <h2 id="fr-checks" className="fw-fr-title">
          {t('fr.checks.title')}
        </h2>
        <p className="fw-fr-sub">{rules.isDefault ? t('fr.checks.introDefault') : t('fr.checks.intro')}</p>

        {editable ? (
          <div className="fw-fr-form-grid">
            <Field label={t('fr.checks.sequence.title')} hint={t(`fr.checks.sequence.${draft.skippedOperationRule}.body`)}>
              <SegmentedControl size="sm" ariaLabel={t('fr.checks.sequence.title')} value={draft.skippedOperationRule} disabled={busy} options={modeOptions('sequence')} onChange={(value) => set({ skippedOperationRule: value as FloorRuleMode })} />
            </Field>
            <Field label={t('fr.checks.quantity.title')} hint={t(`fr.checks.quantity.${draft.quantityGuard}.body`)}>
              <SegmentedControl size="sm" ariaLabel={t('fr.checks.quantity.title')} value={draft.quantityGuard} disabled={busy} options={modeOptions('quantity')} onChange={(value) => set({ quantityGuard: value as FloorRuleMode })} />
            </Field>
            <Field label={t('fr.checks.scrap.title')} hint={draft.limitOn ? t('fr.checks.scrap.onHint', { count: draft.limit === '' ? 0 : draft.limit }) : t('fr.checks.scrap.offHint')}>
              <span className="fw-fr-row">
                <Toggle checked={draft.limitOn} disabled={busy} aria-label={t('fr.checks.scrap.toggle')} onChange={(limitOn) => set({ limitOn })} />
                <span>{t(draft.limitOn ? 'fr.checks.scrap.on' : 'fr.checks.scrap.off')}</span>
                {draft.limitOn && (
                  <NumberStepper value={draft.limit} min={1} max={LIMITS.scrap} size="sm" suffix={t('fr.checks.scrap.suffix')} decrementLabel={t('fr.checks.scrap.less')} incrementLabel={t('fr.checks.scrap.more')} onChange={(limit) => set({ limit })} />
                )}
              </span>
            </Field>
            {change.count > 0 && (
              <Field label={t('fr.checks.reason')} hint={t('fr.checks.reasonHint')}>
                <Input value={draft.reason} maxLength={LIMITS.reason} disabled={busy} onChange={(event) => set({ reason: event.target.value })} />
              </Field>
            )}
          </div>
        ) : (
          <ul className="fw-fr-list">
            <li>{t('fr.checks.read.sequence', { mode: t(`fr.checks.sequence.${rules.checks.skippedOperationRule}.label`) })}</li>
            <li>{t('fr.checks.read.quantity', { mode: t(`fr.checks.quantity.${rules.checks.quantityGuard}.label`) })}</li>
            <li>{rules.checks.scrapApprovalLimit === null ? t('fr.checks.read.noLimit') : t('fr.checks.read.limit', { count: rules.checks.scrapApprovalLimit })}</li>
          </ul>
        )}
        {model.can.cost && <p className="fw-fr-sub">{t('fr.checks.scrap.noValue')}</p>}

        <h3 className="fw-fr-subtitle">{t('fr.checks.same.title')}</h3>
        <ul className="fw-fr-list">
          <li>{t('fr.checks.same.undo', { seconds: fixed.undoWindowSeconds })}</li>
          <li>{t('fr.checks.same.idle', { minutes: idle.idleMinutes })}</li>
          <li>{t('fr.checks.same.clock', { minutes: Math.round(fixed.clockOffSeconds / 60), hours: Math.round(fixed.clockFlagSeconds / 3600) })}</li>
          <li>{fixed.offlineMaxHours === null && fixed.offlineMaxActions === null ? t('fr.checks.same.offlineNone') : t('fr.checks.same.offline', { hours: fixed.offlineMaxHours ?? 0, actions: fixed.offlineMaxActions ?? 0 })}</li>
        </ul>
        <p className="fw-fr-sub">{t('fr.checks.same.where')}</p>

        {editable ? (
          change.count > 0 || (draft.limitOn && draft.limit === '') ? (
            <EditModeBar
              count={Math.max(1, change.count)}
              onDiscard={() => setDraft(saved)}
              onApply={() => actions?.onChecks?.(draft)}
              applyLabel={t('fr.save.apply')}
              applyHeldReason={held ? t(held) : null}
              busy={busy}
              saveShortcut
            />
          ) : (
            <p className="fw-fr-sub">{rules.updatedAt ? t('fr.save.lastChange', { when: formatDateTime(rules.updatedAt, { locale, timeZone: model.timeZone }) }) : t('fr.save.default')}</p>
          )
        ) : (
          <p className="fw-fr-sub">{t('fr.viewOnly')}</p>
        )}
      </section>
    </Card>
  )
}

// ---- Bundle codes ---------------------------------------------------------------------------------------------------------------

export function CouponsCard({ model, actions }: { model: FloorRulesModel; actions?: FloorRulesActions }) {
  const t = useT('floor-rules')
  const part = model.coupons
  if (!part || (!part.value && !part.problem)) return <Loading title={t('fr.coupons.title')} />
  if (!part.value) return <Failed title={t('fr.coupons.title')} problem={part.problem ?? 'fr.problem.read'} onRetry={actions?.onRetry} />
  return <CouponsForm key={`${part.value.site.id}:${part.value.version ?? 0}`} model={model} actions={actions} rules={part.value} />
}

function CouponsForm({ model, actions, rules }: { model: FloorRulesModel; actions?: FloorRulesActions; rules: BundleRules }) {
  const t = useT('floor-rules')
  const saved = useMemo(() => couponsDraftOf(rules), [rules])
  const [draft, setDraft] = useState<CouponsDraft>(model.couponsDraft ?? saved)
  useEffect(() => setDraft(model.couponsDraft ?? saved), [model.couponsDraft, saved])
  const change = couponsChange(rules, draft)
  const busy = model.busy === 'coupons'
  const held = couponsHeld(draft, busy)
  const editable = model.can.manage
  const set = (patch: Partial<CouponsDraft>) => setDraft((current) => ({ ...current, ...patch }))

  return (
    <Card padded>
      <section className="fw-fr-section" aria-labelledby="fr-coupons">
        <h2 id="fr-coupons" className="fw-fr-title">
          {t('fr.coupons.title')}
        </h2>
        <p className="fw-fr-sub">{t('fr.coupons.intro')}</p>
        {editable ? (
          <>
            <div className="fw-fr-radios" role="radiogroup" aria-label={t('fr.coupons.title')}>
              {BUNDLE_CODE_MODES.map((mode) => (
                <RadioCard
                  key={mode}
                  name="fr-coupons"
                  value={mode}
                  checked={draft.mode === mode}
                  selected={draft.mode === mode}
                  disabled={busy}
                  onChange={() => set({ mode })}
                  title={t(`fr.coupons.${mode}.title`)}
                  description={t(`fr.coupons.${mode}.body`)}
                />
              ))}
            </div>
            <Field label={t('fr.coupons.stuck')} hint={t('fr.coupons.stuckHint', { min: LIMITS.stuckMin, max: LIMITS.stuckMax })}>
              <NumberStepper value={draft.stuckHours} min={LIMITS.stuckMin} max={LIMITS.stuckMax} size="sm" suffix={t('fr.coupons.hours')} decrementLabel={t('fr.coupons.less')} incrementLabel={t('fr.coupons.more')} onChange={(stuckHours) => set({ stuckHours })} />
            </Field>
            {draft.mode !== rules.bundleCodeMode && <p className="fw-fr-sub">{t(draft.mode === 'COUPON_PER_OPERATION' ? 'fr.coupons.toCoupons' : 'fr.coupons.toOne')}</p>}
          </>
        ) : (
          <ul className="fw-fr-list">
            <li>{t(`fr.coupons.${rules.bundleCodeMode}.title`)}</li>
            <li>{t('fr.coupons.read.stuck', { count: rules.stuckBundleHours })}</li>
          </ul>
        )}
        {editable ? (
          change.count > 0 ? (
            <EditModeBar count={change.count} onDiscard={() => setDraft(saved)} onApply={() => actions?.onCoupons?.(draft)} applyLabel={t('fr.save.apply')} applyHeldReason={held ? t(held) : null} busy={busy} saveShortcut />
          ) : null
        ) : (
          <p className="fw-fr-sub">{t('fr.viewOnly')}</p>
        )}
      </section>
    </Card>
  )
}

// ---- the full reason lists ------------------------------------------------------------------------------------------------------

export function FullListsNote({ model, actions }: { model: FloorRulesModel; actions?: FloorRulesActions }) {
  const t = useT('floor-rules')
  const part = model.full
  if (!part?.value) return part?.problem ? <p className="fw-fr-sub">{t(part.problem)}</p> : null
  const missing = fullMissing(part.value)
  const busy = model.busy === 'full'
  if (missing.total === 0) return <p className="fw-fr-sub">{t('fr.full.complete')}</p>
  const held = !part.value.canManage ? t('fr.full.held') : busy ? t('fr.busy') : null
  return (
    <Banner
      tone="info"
      title={t('fr.full.title', { count: missing.total })}
      action={
        <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onFullLists?.()}>
          {busy ? <Spinner size={13} /> : <Sparkles size={13} aria-hidden />} {t('fr.full.add', { count: missing.total })}
        </Button>
      }
    >
      {missing.lists.map((entry) => t('fr.full.part', { list: t(`fr.full.list.${entry.list}`), count: entry.count })).join(' · ')}
    </Banner>
  )
}
