'use client'

import { useEffect, useMemo, useState } from 'react'
import { Banner, Card, Field } from '@nexus/ui/components'
import { Button, Input, RadioCard, Select, Skeleton, Toggle } from '@nexus/ui/primitives'
import { areaIn } from '@nexus/factory-domain/inventory/hides/area'
import { EditModeBar } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { CuttingRules, LeatherTolerance } from './api'
import { AREA_UOMS, areaOf, CUTTING_NAMESPACES, cuttingChange, cuttingDraftOf, cuttingHeld, SHADE_RULES, toleranceChange, toleranceDraftOf, toleranceHeld, type CuttingDraft, type ToleranceDraft } from './model'

/**
 * The Cutting card of Floor rules & codes (B-W2b-219; Production › Settings, the Floor rules tab; follow-ups of B-W2b-100,
 * -103, -132): the site's shade rule (one shade lot per order, per garment, or none), the photo of the hide on the table
 * before its first cut, and the smallest remnant kept (a smaller leftover is waste); beside it, the leather area tolerance
 * of the site's company where a purchase order line names none (Purchasing settings' value: purchasing.view reads it,
 * purchasing.manage changes it). Each form shows the DS EditModeBar while it holds changes (⌘S applies the one being
 * changed); a viewer reads the rules as text. Fetches nothing (./CuttingRules.tsx does).
 */

export interface Part<T> {
  readonly value: T | null
  readonly problem: string | null
}

export interface CuttingModel {
  readonly rules: Part<CuttingRules>
  /** null: the person cannot read purchasing settings (the card is not shown). */
  readonly tolerance: Part<LeatherTolerance> | null
  /** production.settings.manage (the API also answers canManage per site). */
  readonly canManage: boolean
  /** The site's floor rules version as the page holds it (one row with the other parts). */
  readonly version: number | null
  readonly busy: 'rules' | 'tolerance' | null
  readonly notice: { readonly tone: 'success' | 'danger'; readonly key: string } | null
  readonly timeZone: string
  /** Design cases: a draft shown as typed. */
  readonly draft?: CuttingDraft
  readonly toleranceDraft?: ToleranceDraft
}

export interface CuttingActions {
  onApply?: (draft: CuttingDraft) => void
  onTolerance?: (draft: ToleranceDraft) => void
  onRetry?: () => void
  onDismiss?: () => void
}

export function CuttingRulesView({ model, actions }: { model: CuttingModel; actions?: CuttingActions }) {
  return (
    <WithMessages namespaces={CUTTING_NAMESPACES}>
      <div className="fw-fr-wide">
        <RulesCard model={model} actions={actions} />
        {model.tolerance && <ToleranceCard model={model} part={model.tolerance} actions={actions} />}
      </div>
    </WithMessages>
  )
}

function Waiting({ title, problem, onRetry }: { title: string; problem: string | null; onRetry?: () => void }) {
  const t = useT('production-cutting-rules')
  return (
    <Card padded>
      <section className="fw-fr-section" aria-busy={problem ? undefined : 'true'}>
        <h2 className="fw-fr-title">{title}</h2>
        {problem ? <Banner tone="danger" title={t(problem)} action={onRetry ? <Button size="sm" onClick={onRetry}>{t('cr.retry')}</Button> : undefined} /> : <Skeleton height={160} />}
      </section>
    </Card>
  )
}

// ---- Cutting ------------------------------------------------------------------------------------------------------------------

function RulesCard({ model, actions }: { model: CuttingModel; actions?: CuttingActions }) {
  const t = useT('production-cutting-rules')
  const part = model.rules
  if (!part.value) return <Waiting title={t('cr.title')} problem={part.problem} onRetry={actions?.onRetry} />
  return <RulesForm key={`${part.value.site.id}:${part.value.version ?? 0}`} model={model} actions={actions} rules={part.value} />
}

const UNIT: Readonly<Record<string, string>> = { M2: 'm²', DM2: 'dm²', FT2: 'ft²' }

function RulesForm({ model, actions, rules }: { model: CuttingModel; actions?: CuttingActions; rules: CuttingRules }) {
  const t = useT('production-cutting-rules')
  const locale = useLocale()
  const saved = useMemo(() => cuttingDraftOf(rules), [rules])
  const [draft, setDraft] = useState<CuttingDraft>(model.draft ?? saved)
  useEffect(() => setDraft(model.draft ?? saved), [model.draft, saved])
  const change = cuttingChange(rules, draft, model.version ?? rules.version)
  const busy = model.busy === 'rules'
  const held = cuttingHeld(draft, busy)
  const editable = model.canManage && rules.canManage
  const set = (patch: Partial<CuttingDraft>) => setDraft((current) => ({ ...current, ...patch }))
  const typed = areaOf(draft.minimumArea)
  const other = draft.minimumUom === 'FT2' ? 'M2' : 'FT2'
  const otherWords = typed !== null ? `${areaIn(typed, draft.minimumUom, other).toFixed(2)} ${UNIT[other]}` : null
  const minimum = rules.rules.minimumRemnant

  return (
    <Card padded>
      <section className="fw-fr-section" aria-labelledby="cr-cutting">
        <h2 id="cr-cutting" className="fw-fr-title">
          {t('cr.title')}
        </h2>
        <p className="fw-fr-sub">{rules.isDefault ? t('cr.introDefault') : t('cr.intro')}</p>
        {model.notice && <Banner tone={model.notice.tone} title={t(model.notice.key)} onDismiss={actions?.onDismiss} />}

        {editable ? (
          <>
            <h3 className="fw-fr-subtitle">{t('cr.shade.title')}</h3>
            <div className="fw-fr-radios" role="radiogroup" aria-label={t('cr.shade.title')}>
              {SHADE_RULES.map((rule) => (
                <RadioCard key={rule} name="cr-shade" value={rule} checked={draft.shadeRule === rule} selected={draft.shadeRule === rule} disabled={busy} onChange={() => set({ shadeRule: rule })} title={t(`cr.shade.${rule}.title`)} description={t(`cr.shade.${rule}.body`)} />
              ))}
            </div>
            <div className="fw-fr-form-grid">
              <Field label={t('cr.photo.title')} hint={t(draft.hidePhotoRequired ? 'cr.photo.onHint' : 'cr.photo.offHint')}>
                <span className="fw-fr-row">
                  <Toggle checked={draft.hidePhotoRequired} disabled={busy} aria-label={t('cr.photo.toggle')} onChange={(hidePhotoRequired) => set({ hidePhotoRequired })} />
                  <span>{t(draft.hidePhotoRequired ? 'cr.photo.on' : 'cr.photo.off')}</span>
                </span>
              </Field>
              <Field label={t('cr.remnant.title')} hint={otherWords ? t('cr.remnant.hint', { other: otherWords }) : t('cr.remnant.hintNone')} error={held === 'cr.held.area' || held === 'cr.held.tooLarge' ? t(held) : undefined}>
                <span className="fw-fr-row">
                  <Input value={draft.minimumArea} inputMode="decimal" size="sm" maxLength={12} disabled={busy} aria-label={t('cr.remnant.area')} onChange={(event) => set({ minimumArea: event.target.value })} />
                  <Select value={draft.minimumUom} size="sm" disabled={busy} aria-label={t('cr.remnant.unit')} onChange={(event) => set({ minimumUom: event.target.value as CuttingDraft['minimumUom'] })}>
                    {AREA_UOMS.map((uom) => (
                      <option key={uom} value={uom}>
                        {UNIT[uom]}
                      </option>
                    ))}
                  </Select>
                </span>
              </Field>
              {change.count > 0 && (
                <Field label={t('cr.reason')} hint={t('cr.reasonHint')}>
                  <Input value={draft.reason} maxLength={500} disabled={busy} onChange={(event) => set({ reason: event.target.value })} />
                </Field>
              )}
            </div>
            {draft.shadeRule !== rules.rules.shadeRule && <p className="fw-fr-sub">{t('cr.fromNow')}</p>}
          </>
        ) : (
          <ul className="fw-fr-list">
            <li>{t('cr.read.shade', { rule: t(`cr.shade.${rules.rules.shadeRule}.title`) })}</li>
            <li>{t(rules.rules.hidePhotoRequired ? 'cr.read.photoOn' : 'cr.read.photoOff')}</li>
            <li>{t('cr.read.remnant', { area: `${areaOf(minimum.area) ? Number(minimum.area).toLocaleString(locale) : minimum.area} ${UNIT[minimum.uom]}` })}</li>
          </ul>
        )}

        {editable ? (
          change.count > 0 ? (
            <EditModeBar count={change.count} onDiscard={() => setDraft(saved)} onApply={() => actions?.onApply?.(draft)} applyLabel={t('cr.apply')} applyHeldReason={held ? t(held) : null} busy={busy} saveShortcut />
          ) : (
            <p className="fw-fr-sub">{rules.updatedAt && !rules.isDefault ? t('cr.lastChange', { when: formatDateTime(rules.updatedAt, { locale, timeZone: model.timeZone }) }) : t('cr.default')}</p>
          )
        ) : (
          <p className="fw-fr-sub">{t('cr.viewOnly')}</p>
        )}
      </section>
    </Card>
  )
}

// ---- Leather area tolerance -------------------------------------------------------------------------------------------------------

function ToleranceCard({ model, part, actions }: { model: CuttingModel; part: Part<LeatherTolerance>; actions?: CuttingActions }) {
  const t = useT('production-cutting-rules')
  if (!part.value) return <Waiting title={t('cr.tolerance.title')} problem={part.problem} onRetry={actions?.onRetry} />
  return <ToleranceForm key={`${part.value.companyId}:${part.value.company?.version ?? 0}`} model={model} actions={actions} tolerance={part.value} />
}

function ToleranceForm({ model, actions, tolerance }: { model: CuttingModel; actions?: CuttingActions; tolerance: LeatherTolerance }) {
  const t = useT('production-cutting-rules')
  const locale = useLocale()
  const saved = useMemo(() => toleranceDraftOf(tolerance), [tolerance])
  const [draft, setDraft] = useState<ToleranceDraft>(model.toleranceDraft ?? saved)
  useEffect(() => setDraft(model.toleranceDraft ?? saved), [model.toleranceDraft, saved])
  const change = toleranceChange(tolerance, draft)
  const busy = model.busy === 'tolerance'
  const held = toleranceHeld(draft, busy)
  const percent = (value: string) => Number(value).toLocaleString(locale, { maximumFractionDigits: 2 })
  const inherited = tolerance.tenant?.percent != null ? t('cr.tolerance.fromTenant', { percent: percent(tolerance.tenant.percent) }) : t('cr.tolerance.fromDefault')

  return (
    <Card padded>
      <section className="fw-fr-section" aria-labelledby="cr-tolerance">
        <h2 id="cr-tolerance" className="fw-fr-title">
          {t('cr.tolerance.title')}
        </h2>
        <p className="fw-fr-sub">{t('cr.tolerance.intro')}</p>
        <p className="fw-fr-sub">{t(`cr.tolerance.now.${tolerance.from}`, { percent: percent(tolerance.percent) })}</p>
        {tolerance.mayChange ? (
          <div className="fw-fr-form-grid">
            <Field label={t('cr.tolerance.own')} hint={draft.own ? t('cr.tolerance.ownHint') : inherited}>
              <span className="fw-fr-row">
                <Toggle checked={draft.own} disabled={busy} aria-label={t('cr.tolerance.own')} onChange={(own) => setDraft((current) => ({ ...current, own }))} />
                {draft.own && <Input value={draft.percent} inputMode="decimal" size="sm" suffix="%" maxLength={6} disabled={busy} aria-label={t('cr.tolerance.percent')} onChange={(event) => setDraft((current) => ({ ...current, percent: event.target.value }))} />}
              </span>
            </Field>
          </div>
        ) : (
          <p className="fw-fr-sub">{t('cr.tolerance.viewOnly')}</p>
        )}
        {tolerance.mayChange && change && <EditModeBar count={1} onDiscard={() => setDraft(saved)} onApply={() => actions?.onTolerance?.(draft)} applyLabel={t('cr.apply')} applyHeldReason={held ? t(held) : null} busy={busy} />}
      </section>
    </Card>
  )
}
