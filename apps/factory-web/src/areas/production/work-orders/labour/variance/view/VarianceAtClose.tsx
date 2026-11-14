'use client'

import { Banner, Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { COSTING_NAMESPACE, decimalText, quantityText, signedMoney, unitCostText } from '../../../../../finance/costing/model'
import type { VarianceLine } from '../../../close/api'
import { CLOSE_NS, reasonKey } from '../../../close/model'
import { FiguresTable } from '../../../close/view/CloseParts'
import type { StoredClose } from '../api'
import { earlierCloses, entriesOf, explainedOf, lineUnit, liveClose, orderedLines, varianceState, type VarianceModel } from '../model'

/**
 * SCR-461 — Variance at close on the work order's Labour & cost tab (design production.workorders rec:labour wo-cost:
 * "W2b variance at close (MES-012)"; FIN-030, FIN-034). A completed work order: the split the close would write now
 * (each category, per material where it has one, standard against actual, the amount; what the lines leave goes to the
 * closing entry; rework and lot size not split, in words), or "Waits for the accountant…" while the company's figures for
 * the accountant are off. A closed one: planned against actual at the close, the reason, the lines it wrote and its closing
 * entry — or that it was closed as a status only. The closes taken back stay as history (who, when, undone or reopened
 * and why, inside this one record). Inside the cost section: it needs the cost grain like the rest of it. Per work order,
 * category and material: never per person, never wages.
 */
export function VarianceAtClose({ model, onRetry }: { model: VarianceModel; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={[CLOSE_NS, COSTING_NAMESPACE]}>
      <Variance model={model} onRetry={onRetry} />
    </WithMessages>
  )
}

function Variance({ model, onRetry }: { model: VarianceModel; onRetry?: () => void }) {
  const t = useT(CLOSE_NS)
  const locale = useLocale()
  const state = varianceState(model)
  const head = (tag: { tone: 'neutral' | 'info' | 'success' | 'warning'; key: string } | null) => (
    <div className="fw-fco-section-head">
      <h2 className="fw-fco-h2">{t('variance.title')}</h2>
      {tag && <Tag tone={tag.tone}>{t(tag.key)}</Tag>}
    </div>
  )
  if (state === 'notYet') {
    return (
      <Card padded className="fw-fco-card">
        {head(null)}
        <p className="fw-fco-muted">{t('variance.notYet')}</p>
      </Card>
    )
  }
  if (state === 'loading') {
    return (
      <Card padded className="fw-fco-card" aria-busy="true">
        {head(null)}
        <p className="fw-fco-muted" role="status">
          <Spinner size={14} /> {t('variance.loading')}
        </p>
      </Card>
    )
  }
  if (state === 'failed') {
    return (
      <Card padded className="fw-fco-card">
        <EmptyState
          title={t('variance.failed')}
          description={t(model.closes?.problem ?? model.preview?.problem ?? 'problem.internal')}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      </Card>
    )
  }
  const closes = model.closes!.value!
  const currency = closes.currency
  const earlier = earlierCloses(closes)
  if (state === 'preview' || state === 'previewWaits') {
    const split = model.preview!.split!
    return (
      <Card padded className="fw-fco-card">
        {head({ tone: 'info', key: 'variance.tag.preview' })}
        <p className="fw-fco-muted">{t('variance.previewBody')}</p>
        {state === 'previewWaits' && (
          <Banner tone="warning" title={t('waits.title')}>
            {t('waits.preview')}
          </Banner>
        )}
        {split.lines.length === 0 ? <p className="fw-fco-muted">{t(split.basis ? 'variance.noLines' : 'variance.noBasis')}</p> : <Lines lines={split.lines} currency={currency} />}
        <ul className="fw-fco-notes">
          <li>{t('variance.balance', { amount: signedMoney(split.balance ?? null, currency, locale) })}</li>
          <li>{t('variance.explained', { amount: signedMoney(split.explained ?? null, currency, locale) })}</li>
          <li>{t('variance.closing', { amount: signedMoney(split.closing ?? null, currency, locale) })}</li>
          {split.notSplit.map((entry) => (
            <li key={`${entry.category ?? 'none'}-${entry.code}`}>{t(`notSplit.${entry.code}`)}</li>
          ))}
        </ul>
        <p className="fw-fco-muted">{t('variance.unverified')}</p>
        {earlier.length > 0 && <History closes={earlier} />}
      </Card>
    )
  }
  const live = liveClose(closes)!
  const entries = entriesOf(live)
  const explained = explainedOf(live.lines)
  return (
    <Card padded className="fw-fco-card">
      {head(state === 'settled' ? { tone: 'success', key: 'variance.tag.settled' } : { tone: 'warning', key: 'variance.tag.statusOnly' })}
      <p className="fw-fco-muted">
        {t('variance.closedAt', { date: formatDate(live.closedAt, { locale }), time: formatTime(live.closedAt, { locale }), name: live.closedBy.name })}
        {live.reasonCode ? ` ${t('closed.reason', { reason: t(reasonKey(live.reasonCode)) })}` : ''}
      </p>
      <FiguresTable figures={live.figures} beyond={live.beyond} tolerancePct={live.tolerancePct} />
      {state === 'statusOnly' ? (
        <Banner tone="warning" title={t('waits.title')}>
          {t('waits.closed')}
        </Banner>
      ) : (
        <>
          {live.lines.length === 0 ? <p className="fw-fco-muted">{t('variance.noLines')}</p> : <Lines lines={live.lines} currency={currency} />}
          <ul className="fw-fco-notes">
            <li>{t('variance.explained', { amount: signedMoney(explained, currency, locale) })}</li>
            <li>{t('variance.closing', { amount: signedMoney(live.closing ?? null, currency, locale) })}</li>
            <li>{t('variance.entries', { count: entries.written })}</li>
          </ul>
          <p className="fw-fco-muted">{t('variance.unverified')}</p>
        </>
      )}
      {earlier.length > 0 && <History closes={earlier} />}
    </Card>
  )
}

function Lines({ lines, currency }: { lines: readonly VarianceLine[]; currency: string }) {
  const t = useT(CLOSE_NS)
  const locale = useLocale()
  const side = (line: VarianceLine, quantity: string | null, unitCost: string | null | undefined) => {
    const unit = lineUnit(line)
    const amount = quantity === null ? '—' : unit === 'MIN' ? t('figure.minutes', { minutes: decimalText(quantity, locale, 1) }) : unit === 'PCS' ? t('figure.garments', { count: Math.round(Number(quantity)) }) : quantityText(quantity, unit, locale)
    return (
      <span className="fw-fco-cell">
        <span className="fw-fco-num">{amount}</span>
        {unitCost ? <span className="nds-summary-sub">{t('variance.atCost', { cost: unitCostText(unitCost, currency, locale) })}</span> : null}
      </span>
    )
  }
  return (
    <SummaryTable
      label={t('variance.linesLabel')}
      columns={[t('variance.col.category'), t('variance.col.material'), t('variance.col.standard'), t('variance.col.actual'), t('variance.col.amount')]}
      align={[undefined, undefined, 'right', 'right', 'right']}
      widths={['24%', '26%', undefined, undefined, '16%']}
      stackOnPhone
      rows={orderedLines(lines).map((line, index) => ({
        id: line.id ?? `${line.category}-${line.item?.id ?? 'none'}-${index}`,
        cells: [
          t(`category.${line.category}`),
          line.item ? `${line.item.code} · ${line.item.name}` : t('variance.noMaterial'),
          side(line, line.standardQuantity, line.standardUnitCost),
          side(line, line.actualQuantity, line.actualUnitCost),
          <span key="amount" className="fw-fco-inline">
            <span className="fw-fco-num">{signedMoney(line.amount ?? null, currency, locale)}</span>
            {typeof line.amount === 'number' && line.amount !== 0 && <Pill tone={line.amount > 0 ? 'warning' : 'success'}>{t(line.amount > 0 ? 'variance.over' : 'variance.under')}</Pill>}
          </span>,
        ],
      }))}
    />
  )
}

function History({ closes }: { closes: readonly StoredClose[] }) {
  const t = useT(CLOSE_NS)
  const locale = useLocale()
  const when = (instant: string) => `${formatDate(instant, { locale })} ${formatTime(instant, { locale })}`
  return (
    <>
      <h3 className="fw-fco-h3">{t('history.title')}</h3>
      <SummaryTable
        label={t('history.title')}
        columns={[t('history.col.closed'), t('history.col.takenBack'), t('history.col.why')]}
        align={[undefined, undefined, 'left']}
        stackOnPhone
        rows={closes.map((close) => ({
          id: close.id,
          cells: [
            t('history.by', { when: when(close.closedAt), name: close.closedBy.name }),
            close.undoneAt ? t(close.reopenReason ? 'history.reopened' : 'history.undone', { when: when(close.undoneAt), name: close.undoneBy?.name ?? '—' }) : '—',
            close.reopenReason ?? t('history.undoneWhy'),
          ],
        }))}
      />
    </>
  )
}
