'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { CalendarClock, ExternalLink } from 'lucide-react'
import { Card, Field } from '@nexus/ui/components'
import { NumberStepper, Pill, SegmentedControl, Skeleton } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { accountingHref, auditHref, BACK_DATING_LIMITS, daysAfter, daysChanged, daysLoosens, daysProblem, followedDays, reasonProblem, rulesHeld, type DaysDraft, type InForce, type LimitMode } from '../model'
import type { WarehouseSettingsActions, WarehouseSettingsModel } from '../view-model'
import { CardDescription, CardFailed, NS, ReasonField, SourceWords, ViewOnly } from './parts'

/** "7 days back", "the same day only", "no limit" — a back-dating limit in words. */
export function useDaysWords() {
  const t = useT(NS)
  return (days: number | null) => (days === null ? t('posting.noLimit') : days === 0 ? t('posting.sameDay') : t('posting.days', { count: days }))
}

/**
 * sec:ws-posting — Posting dates (SCM-196; B-W2b-314's API): how many days back a move may be dated (0 to 366), a company's
 * own or as every company; every company's: a limit or none. What applies once saved, today's earliest posting date, and
 * where closed months live (Finance › Accounting & export: a closed month refuses a date inside it whatever this says). A
 * floor move always counts on the day it is entered. More days back, or no limit, widens what one person can do: Save asks
 * the reason, then a fresh code. EditModeBar, ⌘S.
 */
export function PostingCard({ model, actions, shortcut }: { model: WarehouseSettingsModel; actions?: WarehouseSettingsActions; shortcut: boolean }) {
  const t = useT(NS)
  const locale = useLocale()
  const daysWords = useDaysWords()
  const view = model.rules.value
  const draft = model.daysDraft
  const scope = model.address.scope
  const isCompany = scope === 'company'
  const held = rulesHeld({ may: view ? view.mayChange : null, scope, offline: model.live === 'offline', busy: model.busy !== null })

  const applies = (inForce: InForce<number | null> | undefined): ReactNode => {
    if (inForce === undefined) return <span className="fw-whs-sub">{t('common.notKnown')}</span>
    return (
      <span className="fw-whs-inforce">
        <Pill tone="info">{daysWords(inForce.value)}</Pill>
        <SourceWords source={inForce.source} scope={scope} />
      </span>
    )
  }

  const body = (): ReactNode => {
    if (model.rules.problem) return <CardFailed title={t('posting.failed')} problem={model.rules.problem} onRetry={actions?.onRetryRules} />
    if (!view || !draft) return <Skeleton height={300} />
    const changed = daysChanged(view, draft)
    const loosens = daysLoosens(view, draft, scope, model.tenantRules)
    const asked = loosens || model.reasonAsked.includes('posting')
    const reason = model.reasons.posting
    const after = daysAfter(draft, scope, view, model.tenantRules)
    const followed = followedDays(scope, view, model.tenantRules)
    const problem = changed ? (daysProblem(draft) ?? (asked ? reasonProblem(reason) : null)) : null
    const disabled = model.busy !== null || !view.mayChange
    const set = (next: Partial<DaysDraft>) => actions?.onDays?.({ ...draft, ...next })
    const pd = view.postingDates
    return (
      <div className="fw-whs-stack">
        {view.mayChange ? (
          <>
            <SegmentedControl
              size="sm"
              ariaLabel={t('posting.modeLabel')}
              value={draft.mode}
              disabled={disabled}
              onChange={(value) => set({ mode: value as LimitMode })}
              options={
                isCompany
                  ? [
                      { value: 'OWN', label: t('posting.mode.OWN') },
                      { value: 'FOLLOW', label: t('posting.mode.FOLLOW') },
                    ]
                  : [
                      { value: 'OWN', label: t('posting.mode.LIMIT') },
                      { value: 'NONE', label: t('posting.mode.NONE') },
                    ]
              }
            />
            {draft.mode === 'OWN' ? (
              <Field label={t('posting.daysLabel')} hint={t('posting.daysHint', { min: BACK_DATING_LIMITS.min, max: BACK_DATING_LIMITS.max })} required error={changed && daysProblem(draft) ? t(daysProblem(draft)!) : undefined}>
                <span className="fw-whs-stepper">
                  <NumberStepper value={draft.days} min={BACK_DATING_LIMITS.min} max={BACK_DATING_LIMITS.max} step={1} size="sm" suffix={t('posting.daysSuffix')} disabled={disabled} placeholder={t('posting.daysPlaceholder')} decrementLabel={t('common.less')} incrementLabel={t('common.more')} aria-label={t('posting.daysLabel')} onChange={(days) => set({ days })} />
                </span>
              </Field>
            ) : (
              <p className="fw-whs-hint">{isCompany ? t('posting.followHint', { days: followed ? daysWords(followed.value) : t('common.notKnown') }) : t('posting.noneHint')}</p>
            )}
          </>
        ) : (
          <p className="fw-whs-held">{t(isCompany ? 'held.noRight' : 'held.noRightAll')}</p>
        )}
        <div className="fw-whs-inforce-row">
          <span className="fw-whs-sub">{t(changed ? 'common.appliesOnceSaved' : 'common.appliesNow')}</span>
          {applies(changed ? after : { value: pd.inForce.days, source: pd.inForce.source })}
        </div>
        <p className="fw-whs-hint">
          <CalendarClock size={14} aria-hidden /> {pd.earliest ? t('posting.window', { today: formatDate(pd.today, { locale }), earliest: formatDate(pd.earliest, { locale }) }) : t('posting.windowOpen', { today: formatDate(pd.today, { locale }) })}
        </p>
        {view.mayChange && model.live === 'offline' && <p className="fw-whs-held">{t('held.offline')}</p>}
        {loosens && (
          <p className="fw-whs-warn" role="note">
            {t('posting.loosens')}
          </p>
        )}
        {changed && asked && <ReasonField id="whs-posting-reason" value={reason} label={t('reason.label')} hint={t('reason.hint')} shown={reason.length > 0 || model.reasonAsked.includes('posting')} disabled={model.busy !== null} onChange={(text) => actions?.onReason?.('posting', text)} />}
        <ul className="fw-whs-notes">
          <li>
            {t('posting.closed')}{' '}
            <Link className="fw-whs-link" href={accountingHref(model.prefix)}>
              {t('posting.closedLink')} <ExternalLink size={12} aria-hidden />
            </Link>
          </li>
          <li>{t('posting.floor')}</li>
          <li>{t('posting.future')}</li>
        </ul>
        {changed && (
          <EditModeBar
            count={1}
            busy={model.busy === 'posting'}
            applyHeldReason={problem ? t(problem) : held && held !== 'held.busy' ? t(held) : null}
            applyLabel={t(loosens ? 'common.saveWithCode' : 'common.save')}
            onDiscard={() => actions?.onDiscard?.('posting')}
            onApply={() => actions?.onApply?.('posting')}
            saveShortcut={shortcut}
          />
        )}
      </div>
    )
  }

  return (
    <Card
      header={t('posting.title')}
      description={<CardDescription text={t('posting.description')} changed={view ? model.changed.posting : undefined} href={model.can.audit && model.rowId ? auditHref(model.prefix, 'InventorySettings', model.rowId) : null} />}
      headerAction={view && !view.mayChange ? <ViewOnly reason={t(isCompany ? 'held.noRight' : 'held.noRightAll')} /> : undefined}
      headingLevel={2}
      className="fw-whs-card"
    >
      {body()}
    </Card>
  )
}
