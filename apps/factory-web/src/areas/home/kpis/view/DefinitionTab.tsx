'use client'

import Link from 'next/link'
import { ArrowRight, BookOpenText, Gauge } from 'lucide-react'
import { Banner, Card, KeyValue, MetricStrip, Sparkline, SummaryTable } from '@nexus/ui/components'
import { Button, SegmentedControl } from '@nexus/ui/primitives'
import { AsOf } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import {
  changeLine,
  isKnownMeasure,
  ownerOf,
  ownerText,
  periodChoices,
  periodText,
  problemOf,
  problemText,
  recordsLinkOf,
  recordWordKey,
  sourceListOf,
  sparkValues,
  statusOf,
  valueNumber,
  valueText,
  versionsAtHand,
  wordsOf,
} from '../model'
import type { KpiActions, KpiModel } from './KpiView'

/**
 * SCR-470 › Definition (design home.kpis rec:KPI/definition): "In words" — what it means and what it does not, the formula,
 * what it counts in, the rights its value needs, its owner, the records it is computed from (each opens its list), the facts
 * it reads and the period rules — beside "Now": the value in my scope over the period kind chosen (the KPI's own by
 * default), the change from the period before (never good or bad by colour), 12 periods as a sparkline and a table, as
 * of when (stale after 3 hours) and the records behind it. A draft waiting, a version naming other facts than its
 * calculation, a KPI not installed or withdrawn each say so in one banner with what the owner can do.
 */
export function DefinitionTab({ model, actions }: { model: KpiModel; actions?: KpiActions }) {
  const t = useT('home-kpis')
  const locale = useLocale()
  const record = model.record.value!
  const words = wordsOf(record, locale)
  const status = statusOf(record)
  const hand = versionsAtHand(record)
  const version = record.shown
  const unit = version?.unit ?? record.calculation?.unit ?? 'COUNT'
  const grain = record.calculation?.grain ?? version?.grain ?? null
  const records = version?.sourceRecords ?? []
  const facts = version?.measureKeys ?? record.calculation?.measures ?? []
  const value = record.value
  const periods = value.periods
  const current = periods.at(-1) ?? null
  const previous = periods.at(-2) ?? null
  const problem = problemOf(value, grain)
  const text = problem ? null : valueText(unit, value.value, value.currency, t, locale)
  const change = previous && !problem ? changeLine(unit, current?.value ?? null, { value: previous.value, label: periodText(previous, t, locale) }, value.currency, t, locale) : null
  const link = recordsLinkOf(record.key, record.calculation, value.period, model.built)
  const kind = model.address.period ?? record.calculation?.period ?? null
  const busy = model.busy ?? null
  const held = model.can.manage ? (busy ? t('held.busy') : null) : t('held.ownerOnly')

  const banners = (
    <>
      {status.kind === 'NOT_INSTALLED' && (
        <Banner
          tone="info"
          title={t('banner.notInstalled')}
          action={
            model.can.manage ? (
              <Button size="sm" variant="primary" heldReason={held ?? undefined} onClick={() => actions?.onAsk?.('install')}>
                {t('banner.install')}
              </Button>
            ) : undefined
          }
        >
          {t(model.can.manage ? 'banner.notInstalledOwner' : 'banner.notInstalledBody')}
        </Banner>
      )}
      {hand.draft && (
        <Banner
          tone="info"
          title={t('banner.draft', { version: hand.draft.kpiVersion })}
          action={
            <span className="fw-kpi-actions">
              <Button size="sm" heldReason={held ?? undefined} onClick={() => actions?.onEditDraft?.()}>
                {t('banner.editDraft')}
              </Button>
              <Button size="sm" variant="primary" heldReason={held ?? undefined} onClick={() => actions?.onAsk?.('activate')}>
                {t('banner.activate')}
              </Button>
              <Button size="sm" variant="danger" heldReason={held ?? undefined} onClick={() => actions?.onAsk?.('delete')}>
                {t('banner.deleteDraft')}
              </Button>
            </span>
          }
        >
          {hand.draft.changeNote ? t('banner.draftNote', { note: hand.draft.changeNote }) : t('banner.draftBody')}
          {!model.can.manage && ` ${t('banner.draftReader')}`}
        </Banner>
      )}
      {record.measuresDiffer && (
        <Banner
          tone="warning"
          title={t('banner.differs')}
          action={
            model.can.manage && !hand.draft ? (
              <Button size="sm" heldReason={held ?? undefined} onClick={() => actions?.onNewVersion?.()}>
                {t('kpi.newVersion')}
              </Button>
            ) : undefined
          }
        >
          {t('banner.differsBody', { facts: (record.calculation?.measures ?? []).map((key) => (isKnownMeasure(key) ? t(`measure.${key}`) : key)).join(' · ') })}
        </Banner>
      )}
      {status.kind === 'WITHDRAWN' && version?.endedAt && (
        <Banner tone="neutral" title={t('banner.withdrawn', { day: formatDate(version.endedAt, { locale }) })}>
          {t('banner.withdrawnBody')}
        </Banner>
      )}
    </>
  )

  const factWords = facts.map((key) => (isKnownMeasure(key) ? t(`measure.${key}`) : key))
  const sourceItems = records.map((name) => {
    const href = sourceListOf(name, model.built)
    const label = recordWordKey(name) ? t(recordWordKey(name)!) : name
    return (
      <li key={name}>
        {href ? (
          <Link className="fw-kpi-link" href={`${model.prefix}${href}`}>
            {label}
          </Link>
        ) : (
          <span className={recordWordKey(name) ? undefined : 'fw-kpi-code'}>{label}</span>
        )}
      </li>
    )
  })

  const spark = sparkValues(unit, value)
  const tableRows = [...periods].reverse().map((period) => ({
    id: period.key,
    cells: [periodText(period, t, locale), valueText(unit, period.value, value.currency, t, locale) ?? (problem ? problemText(problem, t) : t('problem.NO_VALUE'))],
  }))

  return (
    <div className="fw-kpi-stack">
      {banners}
      <div className="fw-kpi-split">
        <Card padded>
          <section className="fw-kpi-card" aria-labelledby="fw-kpi-words">
            <h2 id="fw-kpi-words" className="fw-kpi-h">
              <BookOpenText size={16} aria-hidden /> {t('words.title')}
            </h2>
            <p className="fw-kpi-text">{words.definition}</p>
            <div className="fw-kpi-head">
              <h3 className="fw-kpi-h3">{t('words.formula')}</h3>
              <p className="fw-kpi-formula">{words.formula}</p>
            </div>
            <KeyValue
              columns={2}
              labelCase="sentence"
              items={[
                { label: t('words.unit'), value: t(`unit.${unit}`) },
                { label: t('words.rights'), value: grain ? t('words.needs', { grain: t(`grain.${grain.toLowerCase()}`) }) : t('grain.none') },
                { label: t('words.owner'), value: ownerText(ownerOf(record), t) },
                {
                  label: t('words.period'),
                  value: record.calculation ? t(`periodKind.${record.calculation.period}`) : t('words.noCalculation'),
                  hint: record.calculation ? t(`calc.${record.calculation.kind}`) : undefined,
                },
                { label: t('words.records'), value: sourceItems.length > 0 ? <ul className="fw-kpi-list">{sourceItems}</ul> : t('words.none') },
                {
                  label: t('words.facts'),
                  value:
                    factWords.length > 0 ? (
                      <ul className="fw-kpi-list">
                        {facts.map((key, index) => (
                          <li key={key} className={isKnownMeasure(key) ? undefined : 'fw-kpi-code'}>
                            {factWords[index]}
                            {!isKnownMeasure(key) && ` · ${t('words.notBuilt')}`}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      t('words.none')
                    ),
                },
              ]}
            />
            <p className="fw-kpi-muted">{t('words.periodRules')}</p>
            {version && (
              <p className="fw-kpi-muted">
                {t('words.version', { version: version.kpiVersion, state: t(`state.${version.state}`) })}
                {version.activatedAt ? ` · ${t('words.since', { day: formatDate(version.activatedAt, { locale }) })}` : ''}
              </p>
            )}
          </section>
        </Card>

        <Card padded>
          <section className="fw-kpi-card" aria-labelledby="fw-kpi-now">
            <div className="fw-kpi-row fw-kpi-row--between">
              <h2 id="fw-kpi-now" className="fw-kpi-h">
                <Gauge size={16} aria-hidden /> {t('now.title')}
              </h2>
              {record.calculation && kind && (
                <SegmentedControl
                  size="sm"
                  wrap
                  ariaLabel={t('now.periodKind')}
                  value={kind}
                  options={periodChoices(model.withCompany).map((choice) => ({ value: choice, label: t(`periodKindShort.${choice}`) }))}
                  onChange={(next) => actions?.onAddress?.({ ...model.address, period: next === record.calculation?.period ? null : (next as typeof kind) })}
                />
              )}
            </div>
            <MetricStrip
              minTileWidth={220}
              metrics={[
                {
                  label: current ? periodText(current, t, locale) : t('now.current'),
                  value: text ?? problemText(problem ?? { key: 'problem.NO_VALUE' }, t),
                  hint: value.asOf ? (
                    <>
                      {t('now.asOf')} <AsOf at={value.asOf} now={model.now} />
                    </>
                  ) : (
                    t('now.neverBuilt')
                  ),
                  ...(change ? { delta: { value: change, tone: 'neutral' as const } } : {}),
                  ...(link && !problem ? { href: `${model.prefix}${link.href}` } : {}),
                },
              ]}
            />
            {value.stale && <p className="fw-kpi-muted">{t('now.stale')}</p>}
            {value.live && <p className="fw-kpi-muted">{t('now.live')}</p>}
            {value.missingDays > 0 && <p className="fw-kpi-muted">{t('now.missingDays', { count: value.missingDays })}</p>}
            {value.converted.length > 0 && <p className="fw-kpi-muted">{t('now.converted', { currencies: value.converted.join(', ') })}</p>}
            {periods.length > 1 && !problem && (
              <div className="fw-kpi-spark">
                <Sparkline
                  fluid
                  height={48}
                  shape="line"
                  label={t('now.sparkLabel', { count: periods.length, kind: t(`periodKind.${periods[0]!.kind}`) })}
                  values={spark}
                  format={(n) => valueText(unit, unit === 'MONEY' ? String(Math.round(n * 100)) : String(n), value.currency, t, locale) ?? String(n)}
                  emptyLabel={t('now.sparkEmpty')}
                  domain={unit === 'PERCENT' || spark.every((n) => n === null || n >= 0) ? [0, null] : undefined}
                />
                <span className="fw-kpi-muted">{t('now.sparkCaption', { count: periods.length })}</span>
              </div>
            )}
            {periods.length > 0 && !problem && <SummaryTable label={t('now.tableLabel')} columns={[t('now.colPeriod'), t('now.colValue')]} rows={tableRows} align={['left', 'right']} density="compact" />}
            {link ? (
              <Button size="sm" asChild>
                <Link href={`${model.prefix}${link.href}`}>
                  {t(`now.open.${link.kind}`)} <ArrowRight size={14} aria-hidden />
                </Link>
              </Button>
            ) : record.calculation?.drill ? (
              <p className="fw-kpi-muted">{t('now.noRecordsPage')}</p>
            ) : null}
            {valueNumber(unit, value.value) !== null && unit === 'MONEY' && value.currency && <p className="fw-kpi-muted">{t('now.currency', { currency: value.currency })}</p>}
          </section>
        </Card>
      </div>
    </div>
  )
}
