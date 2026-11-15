'use client'

import Link from 'next/link'
import { Hourglass } from 'lucide-react'
import { BarList } from '@nexus/ui/charts/bar-list/index'
import { Banner, Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { AsOf, useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatNumber } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { WipAgeing } from '../api'
import { bandTone, BANDS, byLine, oldWaiting } from '../model'
import '../wip-ageing.css'

/** Production › Reports › WIP ageing's model (design production.reports `prr-wip`). */
export interface WipAgeingModel {
  readonly read: { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: string } | { readonly status: 'ready'; readonly data: WipAgeing }
  /** The site's code (the report's site). */
  readonly site: string
  /** The work order pages (company prefix applied), by record id; absent: no link. */
  readonly hrefs: Readonly<Record<string, string>>
  readonly now: number
}

export interface WipAgeingActions {
  onRetry?: () => void
}

/**
 * SCR-643 — WIP ageing (B-W2b-435; design production.reports `prr-wip` "Units in each stage and how long they waited, by line",
 * ANA-015): per line, its stages as stacked bars — the garments waiting at each operation, split by how long since their work
 * order was last reported (0–2, 3–5, 6–10, over 10 days; DS BarList: the value written, the parts named, never colour alone) —
 * then the work orders that waited longest. The metric layer's WIP drill (the same reader as the KPIs), now: no history of
 * stages is kept. Garments, work orders and days only; never per person or station. One view model, nothing fetched.
 */
export function WipAgeingPanel({ model, actions }: { model: WipAgeingModel; actions?: WipAgeingActions }) {
  return (
    <WithMessages namespaces={['home-digest']}>
      <Panel model={model} actions={actions} />
    </WithMessages>
  )
}

function Panel({ model, actions }: { model: WipAgeingModel; actions?: WipAgeingActions }) {
  const t = useT('home-digest')
  const locale = useLocale()
  const ds = useDsWords()
  const read = model.read
  const keys = BANDS.map((band) => ({ id: band, label: t(`wip.band.${band}`), tone: band === 'D11_PLUS' ? ('danger' as const) : band === 'D6_10' ? ('warning' as const) : band === 'D3_5' ? ('info' as const) : ('neutral' as const) }))
  const pieces = (value: number) => t('wip.pieces', { count: value, value: formatNumber(value, locale) })
  return (
    <Card padded>
      <section className="fw-wip" aria-labelledby="fw-wip-h">
        <div className="fw-wip-head">
          <h2 id="fw-wip-h" className="fw-wip-h">
            <Hourglass size={16} aria-hidden /> {t('wip.title')}
          </h2>
          {read.status === 'ready' && <AsOf at={read.data.asOf} now={model.now} />}
        </div>
        <p className="fw-wip-muted">{t('wip.intro', { site: model.site })}</p>
        {read.status === 'loading' ? (
          <div className="fw-wip-stack" aria-busy="true">
            <Skeleton height={20} />
            <Skeleton height={20} />
            <Skeleton height={20} />
            <p className="fw-wip-muted" role="status">
              {t('wip.loading')}
            </p>
          </div>
        ) : read.status === 'error' ? (
          <Banner tone="warning" title={t('wip.failed')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('digest.retry')}</Button>}>
            {t(read.problem)}
          </Banner>
        ) : read.data.stages.length === 0 ? (
          <EmptyState icon={<Hourglass size={22} aria-hidden />} title={t('wip.empty')} description={t('wip.emptyBody')} />
        ) : (
          <>
            <p className="fw-wip-row">
              <strong>{t('wip.overall', { workOrders: read.data.overall.workOrders, waiting: formatNumber(read.data.overall.waiting, locale) })}</strong>
              {oldWaiting(read.data) > 0 && <Tag tone="danger">{t('wip.old', { count: oldWaiting(read.data) })}</Tag>}
            </p>
            <div className="fw-wip-lines">
              {byLine(read.data).map((group) => (
                <div key={group.line?.id ?? 'none'} className="fw-wip-line">
                  <h3 className="fw-wip-h3">{group.line ? t('wip.line', { code: group.line.code, name: group.line.name }) : t('wip.noLine')}</h3>
                  <BarList
                    labels={ds.barList}
                    label={group.line ? t('wip.line', { code: group.line.code, name: group.line.name }) : t('wip.noLine')}
                    format={pieces}
                    keys={keys}
                    items={group.stages.map((stage) => ({ id: stage.code, label: `${stage.code} · ${stage.name}`, value: stage.waiting, sub: t('wip.workOrders', { count: stage.workOrders }), parts: stage.ageing }))}
                  />
                </div>
              ))}
            </div>
            <h3 className="fw-wip-h3">{t('wip.longest')}</h3>
            <SummaryTable
              label={t('wip.longest')}
              stackOnPhone
              columns={[t('wip.col.workOrder'), t('wip.col.line'), t('wip.col.stages'), t('wip.col.waited')]}
              rows={read.data.rows.slice(0, 5).map((row) => ({
                id: row.record.id,
                cells: [
                  model.hrefs[row.record.id] ? (
                    <Link key="wo" href={model.hrefs[row.record.id]!}>
                      {row.record.label}
                    </Link>
                  ) : (
                    row.record.label
                  ),
                  row.line ? row.line.code : t('wip.noLine'),
                  row.stages.length > 0 ? row.stages.map((stage) => `${stage.code} (${stage.waiting})`).join(', ') : t('wip.noStage'),
                  <Tag key="band" tone={bandTone(row.band)}>
                    {t('wip.days', { count: row.waitedDays })}
                  </Tag>,
                ],
              }))}
            />
            <p className="fw-wip-muted">{t('wip.foot')}</p>
          </>
        )}
      </section>
    </Card>
  )
}
