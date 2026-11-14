'use client'

import type { ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button, Pill, SegmentedControl, Select, Skeleton } from '@nexus/ui/primitives'
import type { GuestPeriodKind } from '@nexus/factory-domain/accounting/guest/periods'
import { Countdown } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { dayWords, NS, type PeriodOption } from '../model'
import { ExportsList, InvoicesList, RegistersList, type ListsActions, type ListsModel } from './Lists'
import '../accountant.css'

/**
 * SCR-268 — the accountant's room (design portal.guest.accountant; FIN-158, PLT-022): Your access said at rest (whose books,
 * who gave it, until when, every download recorded; the time left once it ends soon), the Period (month, quarter or year;
 * the months not handed over yet and the locked ones marked), the Accounting exports, the E-invoices, VAT and registers
 * (what the exports hold besides the journals: the VAT registers, Intrastat, the year-end stock pack), and Ask finance (the frame's conversation, given as
 * `children`). Read-only: the band's primary is "Download period (zip)". No amount on screen.
 */

export interface AccessModel {
  firm: string
  company: string
  givenBy: string | null
  /** ISO instant; null for an office preview. */
  accessUntil: string | null
  endsSoon: boolean
  preview: boolean
  /** The read's clock (the Countdown's first render). */
  now: number
}

export interface PeriodPanelModel {
  kind: GuestPeriodKind
  value: string
  options: readonly PeriodOption[]
  /** Kinds with at least one choice. */
  kinds: readonly GuestPeriodKind[]
  months: readonly { month: string; label: string; shared: boolean; lock: { level: 'SOFT' | 'HARD'; lockedAt: string } | null }[] | null
}

export interface AccountantViewModel {
  /** The overview's read. */
  state: 'loading' | 'error' | 'ready'
  slow: boolean
  access: AccessModel | null
  /** null: nothing handed over yet. */
  period: PeriodPanelModel | null
  /** The period's read: refused = not handed over (or another refusal, by key). */
  read: { state: 'loading' | 'error' | 'ready' | 'refused'; refusal: string | null }
  lists: ListsModel
  notice: { key: string; params?: Readonly<Record<string, string | number>>; tone: 'info' | 'success' | 'warning' | 'danger' } | null
}

export interface AccountantActions extends ListsActions {
  onRetryOverview?: () => void
  onKind?: (kind: GuestPeriodKind) => void
  onPeriod?: (value: string) => void
  onDismissNotice?: () => void
}

export function AccountantView({ model, actions, children }: { model: AccountantViewModel; actions?: AccountantActions; children?: ReactNode }) {
  const t = useT(NS)
  if (model.state === 'error') {
    return (
      <div className="fw-pacc">
        <EmptyState title={t('state.failed')} description={t('state.failedBody')} action={<Button size="sm" onClick={() => actions?.onRetryOverview?.()}>{t('state.retry')}</Button>} />
      </div>
    )
  }
  if (model.state === 'loading') {
    return (
      <div className="fw-pacc" aria-busy="true">
        <Skeleton height={72} />
        <Skeleton height={56} />
        <Skeleton height={220} />
        {model.slow ? <p className="fw-pacc-sub">{t('state.slow')}</p> : null}
      </div>
    )
  }
  return (
    <div className="fw-pacc">
      {model.notice ? (
        <Banner tone={model.notice.tone} title={t(model.notice.key, model.notice.params)} action={<Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>{t('notice.hide')}</Button>} />
      ) : null}
      {model.access ? <AccessPanel access={model.access} /> : null}
      {model.period ? <PeriodPanel period={model.period} actions={actions} /> : <EmptyState title={t('period.noneYet')} description={t('period.noneYetBody')} />}
      {model.period ? <PeriodBody model={model} actions={actions} /> : null}
      <section className="fw-pacc-section fw-pacc-ask" id="messages" aria-label={t('ask.title')}>
        {children}
      </section>
    </div>
  )
}

function AccessPanel({ access }: { access: AccessModel }) {
  const t = useT(NS)
  const locale = useLocale()
  const until = access.accessUntil ? dayWords(access.accessUntil, locale) : null
  const body = access.preview
    ? t('access.preview', { firm: access.firm, company: access.company })
    : access.givenBy
      ? t('access.body', { firm: access.firm, name: access.givenBy, date: until ?? '—', company: access.company })
      : t('access.bodyNoName', { firm: access.firm, date: until ?? '—', company: access.company })
  return (
    <section className="fw-pacc-section" aria-labelledby="fw-pacc-access">
      <Banner tone={access.preview ? 'warning' : access.endsSoon ? 'warning' : 'info'} title={<span id="fw-pacc-access">{t('access.title')}</span>}>
        <p className="fw-pacc-text">{body}</p>
        {access.endsSoon && access.accessUntil ? (
          <p className="fw-pacc-text">
            {t('access.endsSoon')} <Countdown to={access.accessUntil} now={access.now} announce={false} />
          </p>
        ) : null}
      </Banner>
    </section>
  )
}

function PeriodPanel({ period, actions }: { period: PeriodPanelModel; actions?: AccountantActions }) {
  const t = useT(NS)
  const locale = useLocale()
  const missing = period.months?.filter((month) => !month.shared).length ?? 0
  return (
    <section className="fw-pacc-section fw-pacc-period" aria-labelledby="fw-pacc-period">
      <div className="fw-pacc-head">
        <h2 id="fw-pacc-period" className="fw-pacc-h2">
          {t('period.title')}
        </h2>
        <p className="fw-pacc-sub">{t('period.hint')}</p>
      </div>
      <div className="fw-pacc-picker">
        <SegmentedControl
          size="sm"
          ariaLabel={t('period.kindLabel')}
          value={period.kind}
          onChange={(value) => actions?.onKind?.(value as GuestPeriodKind)}
          options={(['MONTH', 'QUARTER', 'YEAR'] as const).map((kind) => ({ value: kind, label: t(`period.kind.${kind}`), disabled: !period.kinds.includes(kind) }))}
        />
        <label className="fw-pacc-select">
          <span className="fw-pacc-sub">{t('period.choose')}</span>
          <Select size="sm" value={period.value} onChange={(event) => actions?.onPeriod?.(event.target.value)} aria-label={t('period.choose')}>
            {period.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {period.months ? (
        <ul className="fw-pacc-months" aria-label={t('period.months')}>
          {period.months.map((month) => (
            <li key={month.month} className="fw-pacc-month">
              <span className="fw-pacc-monthname">{month.label}</span>
              {month.shared ? <Pill tone="success">{t('period.shared')}</Pill> : <Pill tone="neutral">{t('period.notShared')}</Pill>}
              {month.lock ? (
                <Pill tone={month.lock.level === 'HARD' ? 'info' : 'warning'}>
                  <Lock size={12} aria-hidden /> {t(`period.locked.${month.lock.level}`, { date: dayWords(month.lock.lockedAt, locale) })}
                </Pill>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {missing > 0 ? <p className="fw-pacc-sub">{t('period.someMissing', { count: missing })}</p> : null}
    </section>
  )
}

function PeriodBody({ model, actions }: { model: AccountantViewModel; actions?: AccountantActions }) {
  const t = useT(NS)
  if (model.read.state === 'refused') {
    return (
      <section className="fw-pacc-section">
        <EmptyState title={t('period.refusedTitle')} description={t(model.read.refusal ?? 'refusal.generic')} />
      </section>
    )
  }
  return (
    <>
      <ExportsList model={model.lists} actions={actions} />
      <InvoicesList model={model.lists} actions={actions} />
      <RegistersList model={model.lists} actions={actions} />
    </>
  )
}

/** The page a person who is not an accountant reaches by a typed address. */
export function AccountantClosedView({ model }: { model: { homeHref: string } }) {
  const t = useT(NS)
  return (
    <div className="fw-pacc">
      <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} action={<Button asChild size="sm"><a href={model.homeHref}>{t('noAccess.home')}</a></Button>} />
    </div>
  )
}
