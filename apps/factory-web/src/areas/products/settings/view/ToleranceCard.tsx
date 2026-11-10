'use client'

import type { ReactNode } from 'react'
import { Card, Field, SummaryTable } from '@nexus/ui/components'
import { Input, Pill, RadioCard, Select, Skeleton } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { auditHref, changeHeld, ITEM_KINDS, percentText, TOLERANCES, toleranceChanged, toleranceHeld, tolerancePreview, toleranceProblems, type ItemKind, type KindChoice, type ToleranceDraft, type ToleranceInForce } from '../model'
import type { ProductSettingsActions, ProductSettingsModel } from '../view-model'
import { CardDescription, CardFailed, Source, ViewOnly } from './parts'

/** "Warns above 3 %" / "Must match" with where it comes from. */
function ToleranceWords({ value, kindOwn }: { value: ToleranceInForce; kindOwn?: boolean }) {
  const t = useT('products-settings')
  const locale = useLocale()
  const words = value.rule === 'WARN_ABOVE' ? t('tolerance.warnAbove', { percent: percentText(value.percent, locale) }) : t(`tolerance.rule.${value.rule}`)
  return (
    <span className="fw-pst-inforce">
      <Pill tone={value.rule === 'MATCH' ? 'warning' : value.rule === 'WARN_ABOVE' ? 'info' : 'neutral'}>{words}</Pill>
      <Source source={value.source} />
      {kindOwn === false && <span className="fw-pst-sub">· {t('tolerance.general')}</span>}
    </span>
  )
}

/**
 * psettings.tolerance — Consumption tolerance (PRD-105): the general rule (must match · may differ · warn above a percent,
 * or follow every company / the default) as radio cards, then one row per material kind (its own rule, or none) with what
 * applies once saved (factory-domain's toleranceFor, as the cutting table reads it). EditModeBar (⌘S); a percent that is not
 * one holds Save with why. A reader sees what applies as text.
 */
export function ToleranceCard({ model, actions, shortcut }: { model: ProductSettingsModel; actions?: ProductSettingsActions; shortcut: boolean }) {
  const t = useT('products-settings')
  const locale = useLocale()
  const settings = model.settings.value
  const isCompany = model.address.scope === 'company'
  const tenant = isCompany ? model.tenant.value : settings
  const draft = model.tolerance
  const held = changeHeld(settings, model.address.scope, model.busy !== null, model.live === 'offline')
  // Offline the choices stay (kept on this page); Save is held with why.
  const editable = !!settings && settings.mayChange
  const problem = model.settings.problem ?? (isCompany ? model.tenant.problem : null)
  const body = (): ReactNode => {
    if (problem) return <CardFailed title={t('tolerance.failed')} problem={problem} onRetry={actions?.onRetry} />
    if (!settings || !draft || (isCompany && !tenant)) return <Skeleton height={360} />
    const preview = tolerancePreview(model.address.scope, draft, tenant)
    const changed = toleranceChanged(settings, draft, locale)
    const problems = toleranceProblems(draft)
    const count = (changed.general ? 1 : 0) + changed.kinds.length
    const disabled = model.busy !== null
    const set = (next: ToleranceDraft) => actions?.onTolerance?.(next)
    const setKind = (kind: ItemKind, entry: { rule: KindChoice; percent: string }) => set({ ...draft, byKind: { ...draft.byKind, [kind]: entry } })
    // What a company or every company follows when it keeps no general rule.
    const followed = isCompany && tenant ? tenant.tolerance : null
    if (!editable) {
      return (
        <div className="fw-pst-stack">
          {!settings.mayChange && <p className="fw-pst-held">{t(isCompany ? 'held.noRight' : 'held.noRightAll')}</p>}
          {settings.mayChange && model.live === 'offline' && <p className="fw-pst-held">{t('held.offline')}</p>}
          <div className="fw-pst-inforce-row">
            <span className="fw-pst-question">{t('tolerance.generalLabel')}</span>
            <ToleranceWords value={{ rule: settings.tolerance.rule, percent: settings.tolerance.percent, source: settings.tolerance.source, byKind: false }} />
          </div>
          <div className="fw-pst-table">
            <SummaryTable
              label={t('tolerance.table')}
              columns={[t('tolerance.col.kind'), t('tolerance.col.inForce')]}
              align={['left', 'left']}
              stackOnPhone
              rows={settings.tolerance.byKind.map((row) => ({ id: row.kind, cells: [t(`itemKind.${row.kind}`), <ToleranceWords key="w" value={row} kindOwn={row.byKind} />] }))}
            />
          </div>
        </div>
      )
    }
    return (
      <div className="fw-pst-stack">
        {model.live === 'offline' && <p className="fw-pst-held">{t('held.offline')}</p>}
        <fieldset className="fw-pst-choices" disabled={disabled}>
          <legend className="fw-pst-question">{t('tolerance.generalLabel')}</legend>
          {TOLERANCES.map((rule) => (
            <RadioCard
              key={rule}
              name="pst-tolerance"
              checked={draft.rule === rule}
              selected={draft.rule === rule}
              onChange={() => set({ ...draft, rule })}
              title={t(`tolerance.rule.${rule}`)}
              description={t(`tolerance.ruleHint.${rule}`)}
            />
          ))}
          <RadioCard
            name="pst-tolerance"
            checked={draft.rule === null}
            selected={draft.rule === null}
            onChange={() => set({ ...draft, rule: null })}
            title={t(isCompany ? 'tolerance.follow' : 'tolerance.default')}
            description={
              isCompany
                ? followed
                  ? t('tolerance.followNow', { rule: followed.rule === 'WARN_ABOVE' ? t('tolerance.warnAbove', { percent: percentText(followed.percent, locale) }) : t(`tolerance.rule.${followed.rule}`) })
                  : undefined
                : t('tolerance.defaultHint')
            }
          />
        </fieldset>
        {draft.rule === 'WARN_ABOVE' && (
          <div className="fw-pst-narrow">
            <Field label={t('tolerance.percent')} hint={t('tolerance.percentHint')} error={problems.general ? t(problems.general) : undefined}>
              <Input size="sm" inputMode="decimal" value={draft.percent} disabled={disabled} suffix="%" onChange={(event) => set({ ...draft, percent: event.target.value })} />
            </Field>
          </div>
        )}
        <div className="fw-pst-inforce-row">
          <span className="fw-pst-sub">{t('tolerance.applies')}</span>
          <ToleranceWords value={preview.general} />
        </div>
        <div className="fw-pst-table">
          <SummaryTable
            label={t('tolerance.table')}
            columns={[t('tolerance.col.kind'), t('tolerance.col.own'), t('tolerance.col.percent'), t('tolerance.col.inForce')]}
            align={['left', 'left', 'left', 'left']}
            widths={['16%', '30%', '18%', '36%']}
            stackOnPhone
            rows={ITEM_KINDS.map((kind) => {
              const entry = draft.byKind[kind]
              const kindWords = t(`itemKind.${kind}`)
              const error = problems.kinds[kind]
              return {
                id: kind,
                cells: [
                  <span key="k" className="fw-pst-state">
                    <strong>{kindWords}</strong>
                    {changed.kinds.includes(kind) && <span className="fw-pst-sub">{t('rules.changed')}</span>}
                  </span>,
                  <Select key="r" size="sm" value={entry.rule} disabled={disabled} aria-label={t('tolerance.ownOf', { kind: kindWords })} onChange={(event) => setKind(kind, { ...entry, rule: event.target.value as KindChoice })}>
                    <option value="NONE">{t('tolerance.none')}</option>
                    {TOLERANCES.map((rule) => (
                      <option key={rule} value={rule}>
                        {t(`tolerance.rule.${rule}`)}
                      </option>
                    ))}
                  </Select>,
                  entry.rule === 'WARN_ABOVE' ? (
                    <span key="p" className="fw-pst-percent">
                      <Input size="sm" inputMode="decimal" value={entry.percent} disabled={disabled} suffix="%" aria-invalid={!!error} aria-label={t('tolerance.percentOf', { kind: kindWords })} onChange={(event) => setKind(kind, { ...entry, percent: event.target.value })} />
                      {error && <span className="fw-pst-problem">{t(error)}</span>}
                    </span>
                  ) : (
                    <span key="p" className="fw-pst-sub">—</span>
                  ),
                  <ToleranceWords key="w" value={preview.kinds[kind]} kindOwn={preview.kinds[kind].byKind} />,
                ],
              }
            })}
          />
        </div>
        <p className="fw-pst-hint">{t('tolerance.where')}</p>
        {count > 0 && (
          <EditModeBar
            count={count}
            busy={model.busy === 'tolerance'}
            applyHeldReason={(() => {
              const first = toleranceHeld(draft)
              return first ? t(first) : held && held !== 'held.busy' ? t(held) : null
            })()}
            applyLabel={t('tolerance.apply')}
            onDiscard={() => actions?.onDiscardTolerance?.()}
            onApply={() => actions?.onApplyTolerance?.()}
            saveShortcut={shortcut}
          />
        )}
      </div>
    )
  }
  return (
    <Card
      header={t('tolerance.title')}
      description={<CardDescription text={t('tolerance.description')} changed={model.changed.tolerance} href={model.can.audit && settings?.exists && model.rowId ? auditHref(model.prefix, 'ProductSettings', model.rowId) : null} />}
      headerAction={settings && !editable ? <ViewOnly reason={t(held ?? 'held.noRight')} /> : undefined}
      headingLevel={2}
      className="fw-pst-card"
    >
      {body()}
    </Card>
  )
}
