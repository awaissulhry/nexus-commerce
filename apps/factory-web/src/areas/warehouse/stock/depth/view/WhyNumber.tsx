'use client'

import Link from 'next/link'
import { Banner, SummaryTable } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { quantity, signed } from '../../../../_shared/stock/model'
import type { Why } from '../api'
import { DEPTH_NAMESPACE, movesAddressOfLink, type Loaded } from '../model'

/**
 * "Why is it 84,20 m²?" (design warehouse.stock pop:st-why; composed in the app: the design's WhyNumber is new) — the
 * content of the popover a quantity opens: the formula in words, a small table by reason with signed sums and "adds up
 * to 84,20 m² ✓" (or the gap in words, a bug), the last five moves (day, reason, quantity, document) and "Open all 23
 * moves" (Movements filtered to the stock key, explained). Reads nothing: the container answers `state`.
 */
export function WhyNumber({ state, prefix, onRetry }: { state: Loaded<Why> | null; prefix: string; onRetry?: () => void }) {
  const t = useT(DEPTH_NAMESPACE)
  const s = useT('stock')
  const locale = useLocale()
  if (!state || state.status === 'loading')
    return (
      <div className="fw-wd-why" aria-busy="true">
        <p className="fw-wd-muted" role="status">
          {t('wd.why.loading')}
        </p>
        <Skeleton height={96} />
      </div>
    )
  if (state.status === 'error')
    return (
      <div className="fw-wd-why">
        <Banner
          tone="danger"
          title={s(state.problem)}
          action={
            onRetry ? (
              <Button size="sm" onClick={onRetry}>
                {s('problem.retry')}
              </Button>
            ) : undefined
          }
        />
      </div>
    )
  const why = state.value
  const unit = s(`uom.${why.uom}`)
  const q = (value: string) => quantity(value, locale)
  const day = (value: string) => formatDate(`${value}T12:00:00Z`, { locale, timeZone: 'UTC' })
  const docHref = (doc: NonNullable<Why['last'][number]['document']>) => `${prefix}${doc.type === 'GoodsReceipt' ? `/warehouse/receipts/${encodeURIComponent(doc.id)}` : recordAddress({ type: 'WorkOrder', id: doc.id }, OFFICE_PAGES)}`
  const what = [why.item.code, why.colour?.code, why.lot?.code, why.hide?.code, why.location?.code].filter(Boolean).join(' · ')
  return (
    <div className="fw-wd-why">
      <h3 className="fw-wd-h3">{t('wd.why.title', { quantity: q(why.onHandNow), unit })}</h3>
      <p className="fw-wd-muted" title={what}>
        {what}
      </p>
      <p className="fw-wd-muted">{t('wd.why.formula')}</p>
      <SummaryTable
        label={t('wd.why.tableLabel')}
        density="compact"
        columns={[t('wd.why.col.reason'), t('wd.why.col.moves'), t('wd.why.col.net')]}
        align={['left', 'right', 'right']}
        rows={[
          ...(why.period.from ? [{ id: 'start', cells: [t('wd.why.startOn', { day: day(why.period.from) }), '', `${q(why.start)} ${unit}`] }] : []),
          ...why.steps.map((step) => ({
            id: step.reason,
            cells: [
              <Link key="r" className="fw-st-link" href={movesAddressOfLink(prefix, step.link, { why: '1' })}>
                {s(`reason.${step.reason}`)}
              </Link>,
              String(step.moves),
              `${signed(step.net, locale)} ${unit}`,
            ],
          })),
          { id: 'sum', cells: [<b key="s">{t('wd.why.sum')}</b>, String(why.moves), <b key="n">{`${q(why.sum)} ${unit}`}</b>] },
        ]}
      />
      {why.addsUp ? <Banner tone="success" title={t('wd.why.addsUp', { quantity: q(why.end), unit })} /> : <Banner tone="danger" title={t('wd.why.gap', { gap: signed(why.gap, locale), unit })} />}
      {why.last.length > 0 && (
        <>
          <h4 className="fw-wd-h4">{t('wd.why.last', { count: why.last.length })}</h4>
          <ul className="fw-wd-moves">
            {why.last.map((move) => (
              <li key={move.id}>
                <span className="fw-st-num">{day(move.postingDay)}</span>
                <span>{s(`reason.${move.reason}`)}</span>
                <span className="fw-st-num">{`${signed(move.delta, locale)} ${unit}`}</span>
                {move.document ? (
                  <Link className="fw-st-link" href={docHref(move.document)}>
                    {move.document.number}
                  </Link>
                ) : (
                  <span className="fw-wd-muted">{move.reference ?? ''}</span>
                )}
                {move.backDated && <span className="fw-wd-muted">{t('wd.why.backDated')}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <Link className="fw-st-link" href={movesAddressOfLink(prefix, why.allMoves, { why: '1' })}>
        {t('wd.why.allMoves', { count: why.moves })}
      </Link>
    </div>
  )
}
