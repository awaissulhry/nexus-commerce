'use client'

import { BarList } from '@nexus/ui/charts/bar-list/index'
import { EmptyState, Heatmap, KeyValue } from '@nexus/ui/components'
import { Select } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Returns } from '../api'
import { ALSO_BY, countText, groupName, pctText, reasonWords, valueText, type AlsoBy } from '../model'
import { Head, NAMESPACE, stateOf } from './Parts'
import type { ReportsActions, ReportsModel } from './types'

type Props = { model: ReportsModel; actions?: ReportsActions | undefined }

const groupsOf = (answer: Returns, by: AlsoBy) => (by === 'style' ? answer.styles : by === 'size' ? answer.sizes : by === 'colour' ? answer.colours : answer.customers)

/**
 * Return reasons (design sec returns, SAL-458: "Returns by reason group, model, size, colour, customer"; "Bars by reason",
 * "Heatmap model × size"; "Click → Returns filtered"): the lines of the returns asked for in the period — pieces by reason (the
 * RETURN list's words; reason groups do not exist yet, said below), then by style, size, colour or customer, and the most
 * returned styles by size; each bar and each cell opens the return lines behind it. The return rate is the pieces asked back ÷
 * the pieces shipped in the period; credits only with the price grain.
 */
export function ReturnsPanel({ model, actions }: Props) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const ds = useDsWords()
  const read = model.returns
  const day = (date: string) => formatDate(`${date}T12:00:00Z`, { locale })
  const head = (
    <Head id="slr-returns" title={t('section.returns')} hint={t('returns.hint', { from: day(model.range.from), to: day(model.range.to) })}>
      <Select size="sm" value={model.address.also} aria-label={t('returns.also')} onChange={(event) => actions?.onAddress?.({ also: event.target.value as AlsoBy })}>
        {ALSO_BY.map((by) => (
          <option key={by} value={by}>
            {t(`returns.alsoOption.${by}`)}
          </option>
        ))}
      </Select>
    </Head>
  )
  const waiting = stateOf(read, t('returns.failed'), () => actions?.onRetry?.('returns'), { axes: t('returns.axes') })
  if (waiting || read.status !== 'ready') {
    return (
      <section className="fw-slr-panel" aria-labelledby="slr-returns">
        {head}
        {waiting}
      </section>
    )
  }
  const answer = read.value
  if (!answer.sight.returns) {
    return (
      <section className="fw-slr-panel" aria-labelledby="slr-returns">
        {head}
        <EmptyState title={t('returns.outside')} description={t('returns.outsideBody')} />
      </section>
    )
  }
  if (answer.all.pieces === 0) {
    return (
      <section className="fw-slr-panel" aria-labelledby="slr-returns">
        {head}
        <EmptyState title={t('returns.empty')} description={t('returns.emptyHint')} />
      </section>
    )
  }
  const price = answer.sight.values
  const pieces = (value: number) => t('common.pieces', { count: value })
  const words = { none: t('returns.unknown'), fees: t('intake.fees') }
  const also = model.address.also
  const map = answer.heatmap
  const styleLabels = map.styles.map((style) => style.code || words.none)
  const sizeLabels = map.sizes.map((size) => (size === 'none' ? t('returns.noSize') : size))
  return (
    <section className="fw-slr-panel" aria-labelledby="slr-returns">
      {head}
      <KeyValue
        columns={price ? 2 : 3}
        items={[
          { label: t('returns.kv.pieces'), value: countText(answer.all.pieces, locale), hint: t('returns.kv.piecesHint', { returns: answer.all.returns, lines: answer.all.lines }) },
          { label: t('returns.kv.rate'), value: pctText(answer.returnRatePct, locale), hint: answer.shipped === null ? t('returns.kv.rateOutside') : t('returns.kv.rateHint', { shipped: countText(answer.shipped, locale) }) },
          { label: t('returns.kv.reasons'), value: countText(answer.reasons.length, locale), hint: answer.reasons[0] ? t('returns.kv.top', { reason: reasonWords(answer.reasons[0], locale) }) : '—' },
          ...(price ? [{ label: t('returns.kv.credited'), value: valueText(answer.all, locale), hint: t('returns.kv.creditedHint') }] : []),
        ]}
      />
      <div className="fw-slr-pair">
        <div className="fw-slr-part">
          <h3 className="fw-slr-h3">{t('returns.byReason')}</h3>
          <BarList
            labels={ds.barList}
            label={t('returns.byReason')}
            format={(value) => pieces(value)}
            items={answer.reasons.map((reason) => ({ id: reason.key, label: reasonWords(reason, locale), value: reason.figures.pieces, sub: t('returns.barSub', { returns: reason.figures.returns, lines: reason.figures.lines }), tone: 'danger' as const }))}
            onPick={(key) => actions?.onDrill?.({ section: 'returns', by: 'reason', key })}
          />
          <p className="fw-slr-muted">{t('returns.noGroups')}</p>
        </div>
        <div className="fw-slr-part">
          <h3 className="fw-slr-h3">{t(`returns.alsoTitle.${also}`)}</h3>
          <BarList
            labels={ds.barList}
            label={t(`returns.alsoTitle.${also}`)}
            format={(value) => pieces(value)}
            items={groupsOf(answer, also).map((group) => ({ id: group.key, label: also === 'size' ? (group.key === 'none' ? t('returns.noSize') : group.key) : groupName(group, words), value: group.figures.pieces, sub: t('returns.barSub', { returns: group.figures.returns, lines: group.figures.lines }) }))}
            onPick={(key) => actions?.onDrill?.({ section: 'returns', by: also, key })}
          />
        </div>
      </div>
      {map.styles.length > 0 && map.sizes.length > 0 ? (
        <div className="fw-slr-part">
          <h3 className="fw-slr-h3">{t('returns.heatTitle')}</h3>
          <div className="fw-slr-heat">
            <Heatmap
              data={map.cells}
              rowLabels={styleLabels}
              colLabels={sizeLabels}
              labelWidth={120}
              label={t('returns.heatTitle')}
              emptyLabel={t('returns.heatNone')}
              format={(value) => pieces(value)}
              cellWords={(row, col, value) => (value === null ? t('returns.heatCellNone', { style: styleLabels[row] ?? '', size: sizeLabels[col] ?? '' }) : t('returns.heatCell', { style: styleLabels[row] ?? '', size: sizeLabels[col] ?? '', count: value }))}
              onCellClick={(row, col) => actions?.onDrill?.({ section: 'returns', by: 'style', key: map.styles[row]!.key, size: map.sizes[col]! })}
            />
          </div>
        </div>
      ) : null}
      <p className="fw-slr-muted">{[t('returns.definition'), price ? null : t('common.noPrice'), answer.complete ? null : t('common.incomplete')].filter(Boolean).join(' ')}</p>
    </section>
  )
}
