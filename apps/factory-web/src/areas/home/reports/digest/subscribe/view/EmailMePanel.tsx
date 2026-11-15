'use client'

import { Mail, MailX } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { ReportFilter } from '../../../api'
import { reportWordKey } from '../../../model'
import { daysWords, NAMESPACE, WEEKDAYS, type Loaded } from '../../model'
import type { ReportSubscription } from '../api'
import { draftChanges, emailMeHeld, type EmailMeDraft } from '../model'
import '../../digest.css'

/** "E-mail me this" on a report's Schedule tab (follow-up DG1:01; design home.reports rec:Report › Schedule). */
export interface EmailMeModel {
  readonly reportKey: string
  /** The report's filters (its About), each with its choices (a site filter: the sites I reach). */
  readonly filters: readonly ReportFilter[]
  /** My e-mail of this report (null: none yet). */
  readonly mine: Loaded<ReportSubscription | null>
  readonly draft: EmailMeDraft | null
  readonly busy: 'save' | 'pause' | 'stop' | null
  readonly offline: boolean
  readonly notice: { readonly key: string; readonly tone: 'success' | 'danger' } | null
}

export interface EmailMeActions {
  onDraft?: (change: Partial<EmailMeDraft>) => void
  onToggleDay?: (day: number) => void
  onFilter?: (key: string, value: string | null) => void
  onSave?: () => void
  onPause?: (active: boolean) => void
  onStop?: () => void
  onRetry?: () => void
}

/**
 * SCR-641 — "E-mail me this" for any report (B-W2b-435; DG1:01 "report subscriptions for any report, not only the daily production
 * report"): the report comes to me by e-mail on the weekdays and at the time I choose (my company's clock), in my language, with
 * the filters I choose — run as me, with my rights, never sent to anyone else. With none yet: the form and "E-mail me this". With
 * one: on or paused, when it comes, next and last; Save changes (held while nothing changed), Pause / Resume, Stop e-mailing.
 */
export function EmailMePanel({ model, actions }: { model: EmailMeModel; actions?: EmailMeActions }) {
  return (
    <WithMessages namespaces={[NAMESPACE, 'home-reports']}>
      <Panel model={model} actions={actions} />
    </WithMessages>
  )
}

function Panel({ model, actions }: { model: EmailMeModel; actions?: EmailMeActions }) {
  const t = useT(NAMESPACE)
  const tr = useT('home-reports')
  const locale = useLocale()
  if (model.mine.status === 'loading' || (model.mine.status === 'ready' && !model.draft)) {
    return (
      <Card padded aria-busy="true">
        <Skeleton height={18} />
        <Skeleton height={14} />
        <p className="fw-dig-muted" role="status">
          {t('emailMe.loading')}
        </p>
      </Card>
    )
  }
  if (model.mine.status === 'error') {
    return (
      <Card padded>
        <EmptyState
          icon={<Mail size={22} aria-hidden />}
          title={t('emailMe.failed')}
          description={t(model.mine.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('digest.retry')}
            </Button>
          }
        />
      </Card>
    )
  }
  const mine = model.mine.data
  const draft = model.draft!
  const changes = draftChanges(draft, mine, model.filters)
  const heldKey = model.offline ? 'digest.held.offline' : model.busy ? 'digest.held.busy' : emailMeHeld(draft, changes)
  const valueText = (filter: ReportFilter, value: string): string => {
    if (filter.kind === 'period') return tr(`period.${value}`)
    if (filter.kind === 'choice') return tr(reportWordKey(model.reportKey, `choice.${filter.key}.${value}`))
    return filter.choices.find((choice) => choice.value === value)?.label ?? value
  }
  const save = () => {
    if (!heldKey) actions?.onSave?.()
  }
  return (
    <Card padded>
      <section className="fw-dig-stack" aria-labelledby="fw-dig-emailme">
        <div className="fw-dig-row fw-dig-row--between">
          <h2 id="fw-dig-emailme" className="fw-dig-h">
            <span className="fw-dig-title">
              <Mail size={16} aria-hidden /> {t('emailMe.title')}
            </span>
          </h2>
          {mine && <Tag tone={mine.active ? 'success' : 'neutral'}>{t(mine.active ? 'emailMe.state.on' : 'emailMe.state.paused')}</Tag>}
        </div>
        <p className="fw-dig-muted">{t('emailMe.intro')}</p>
        {model.notice && <Banner tone={model.notice.tone} title={t(model.notice.key)} />}
        {mine && (
          <p className="fw-dig-muted">
            {t('emailMe.summary', { days: daysWords(mine.weekdays, t), time: mine.sendTime, zone: mine.timeZone })}
            {mine.nextAt ? ` · ${t('emailMe.next', { at: formatDateTime(mine.nextAt, { locale, timeZone: mine.timeZone }) })}` : ''}
            {` · ${mine.lastSentAt ? t('emailMe.last', { at: formatDateTime(mine.lastSentAt, { locale, timeZone: mine.timeZone }) }) : t('emailMe.neverSent')}`}
          </p>
        )}
        <form
          className="fw-dig-stack"
          aria-label={t('emailMe.form')}
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <div className="fw-dig-form">
            <Field label={t('emailMe.time')} hint={t('emailMe.timeHint')}>
              <Input type="time" step={900} value={draft.sendTime} onChange={(event) => actions?.onDraft?.({ sendTime: event.target.value })} />
            </Field>
            <Field label={t('digest.form.language')}>
              <Select value={draft.locale} onChange={(event) => actions?.onDraft?.({ locale: event.target.value === 'en' ? 'en' : 'it' })}>
                <option value="it">{t('digest.language.it')}</option>
                <option value="en">{t('digest.language.en')}</option>
              </Select>
            </Field>
            {model.filters.map((filter) => (
              <Field key={filter.key} label={tr(reportWordKey(model.reportKey, `filter.${filter.key}`))}>
                <Select value={draft.filters[filter.key] ?? ''} onChange={(event) => actions?.onFilter?.(filter.key, event.target.value || null)}>
                  {(filter.default === null || filter.kind === 'site') && <option value="">{filter.kind === 'site' ? tr('filters.allSites') : tr('filters.any')}</option>}
                  {filter.default !== null && filter.kind !== 'site' && <option value="">{t('emailMe.reportDefault', { value: valueText(filter, filter.default) })}</option>}
                  {filter.choices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {valueText(filter, choice.value)}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
          </div>
          <fieldset className="fw-dig-fieldset">
            <legend className="fw-dig-legend">{t('digest.form.days')}</legend>
            <div className="fw-dig-checks">
              {WEEKDAYS.map((day) => (
                <Checkbox key={day} label={t(`digest.day.${day}`)} checked={draft.weekdays.includes(day)} onChange={() => actions?.onToggleDay?.(day)} />
              ))}
            </div>
          </fieldset>
          <div className="fw-dig-row">
            <Button size="sm" variant="primary" type="submit" heldReason={heldKey ? t(heldKey) : null}>
              {model.busy === 'save' ? <Spinner size={12} /> : <Mail size={14} aria-hidden />} {mine ? t('emailMe.save') : t('emailMe.go')}
            </Button>
            {mine && (
              <Button size="sm" onClick={() => actions?.onPause?.(!mine.active)} heldReason={model.offline ? t('digest.held.offline') : model.busy ? t('digest.held.busy') : null}>
                {model.busy === 'pause' ? <Spinner size={12} /> : null} {mine.active ? t('emailMe.pause') : t('emailMe.resume')}
              </Button>
            )}
            {mine && (
              <Button size="sm" tone="danger" onClick={() => actions?.onStop?.()} heldReason={model.offline ? t('digest.held.offline') : model.busy ? t('digest.held.busy') : null}>
                {model.busy === 'stop' ? <Spinner size={12} /> : <MailX size={14} aria-hidden />} {t('emailMe.stop')}
              </Button>
            )}
          </div>
        </form>
        <p className="fw-dig-muted">{t('emailMe.rights')}</p>
      </section>
    </Card>
  )
}
