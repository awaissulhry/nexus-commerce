'use client'

import { Banner, Card } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../../lib/i18n/provider'
import type { PriceAgainstCostRow } from '../api'
import { flagOf, marginBarOf } from '../model'
import '../cost.css'

/**
 * owb-pd5b step 5.3 (S4; design plan § 5zh "Price against cost"; prototype cost.js prodCostTab › prices, mbarH) — one row for each agreed
 * price of the product (customer · material · from how many pieces · price · cost · earned · margin), a bar with the target mark, the
 * words "under the target" / "under the cost", and the lowest price that keeps the target. The page says the margin is a share of the
 * PRICE. Read with the price AND the cost grain (the server refuses otherwise; the card then says so). Small cards in a narrow room.
 */

export interface PriceCardModel {
  readonly state: 'reading' | 'failed' | 'ready'
  readonly problem: string | null
  readonly targetPct: string
  readonly rows: readonly PriceAgainstCostRow[]
  readonly lowest: string | null
  readonly money: (amount: string | null | undefined) => string
}

const pct = (value: string | null): string => (value === null ? '—' : `${Number(value) < 0 ? '− ' : ''}${Math.abs(Math.round(Number(value) * 10) / 10)} %`)

export function PriceCard({ model, onRetry }: { model: PriceCardModel; onRetry: () => void }) {
  const t = useT('products-cost')
  const target = Number(model.targetPct)
  return (
    <Card
      header={t('price.title')}
      headingLevel={2}
      description={model.state === 'ready' ? (model.rows.length === 0 ? t('price.none') : model.lowest === null ? t('price.lowestUnknown', { target }) : t('price.lowest', { target, amount: model.money(model.lowest) })) : undefined}
    >
      {model.state === 'reading' && <Skeleton height={80} />}
      {model.state === 'failed' && (
        <Banner
          tone={model.problem === 'problem.forbidden' ? 'info' : 'danger'}
          title={model.problem === 'problem.forbidden' ? t('price.noGrains') : t('price.failed')}
          action={
            model.problem === 'problem.forbidden' ? undefined : (
              <Button size="sm" onClick={onRetry}>
                {t('common.retry')}
              </Button>
            )
          }
        />
      )}
      {model.state === 'ready' && model.rows.length > 0 && (
        <div className="fw-ct-body">
          <div className="fw-ct-scroll">
            <table className="fw-ct-table" aria-label={t('price.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('price.col.customer')}</th>
                  <th scope="col">{t('price.col.material')}</th>
                  <th scope="col" className="fw-ct-num">
                    {t('price.col.pieces')}
                  </th>
                  <th scope="col" className="fw-ct-num">
                    {t('price.col.price')}
                  </th>
                  <th scope="col" className="fw-ct-num">
                    {t('price.col.cost')}
                  </th>
                  <th scope="col" className="fw-ct-num">
                    {t('price.col.earned')}
                  </th>
                  <th scope="col" className="fw-ct-num">
                    {t('price.col.margin')}
                  </th>
                  <th scope="col">{t('price.col.against')}</th>
                </tr>
              </thead>
              <tbody>
                {model.rows.map((row, index) => {
                  const flag = flagOf(row.flag)
                  const bar = marginBarOf(row.marginPct, model.targetPct)
                  return (
                    <tr key={`${row.customer.id}:${row.material ?? ''}:${row.minQty}:${index}`}>
                      <td>
                        <b>{row.customer.code}</b> {row.customer.name}
                      </td>
                      <td data-label={t('price.col.material')}>{row.material ?? '—'}</td>
                      <td className="fw-ct-num" data-label={t('price.col.pieces')}>
                        {t('price.fromPieces', { count: row.minQty })}
                      </td>
                      <td className="fw-ct-num" data-label={t('price.col.price')}>
                        {model.money(row.price)}
                      </td>
                      <td className="fw-ct-num" data-label={t('price.col.cost')}>
                        {row.cost === null ? t('price.costUnknown') : model.money(row.cost)}
                      </td>
                      <td className="fw-ct-num" data-label={t('price.col.earned')}>
                        {row.earned === null ? '—' : `${Number(row.earned) < 0 ? '− ' : ''}${model.money(String(Math.abs(Number(row.earned))))}`}
                      </td>
                      <td className="fw-ct-num" data-label={t('price.col.margin')}>
                        <b>{pct(row.marginPct)}</b>
                      </td>
                      <td data-label={t('price.col.against')}>
                        <span className="fw-ct-name">
                          <span className="fw-ct-mbar" data-flag={row.flag ?? undefined} role="img" aria-label={t('price.barLabel', { margin: pct(row.marginPct), target })}>
                            <i style={{ width: `${bar.fill}%` }} />
                            <b style={{ insetInlineStart: `${bar.mark}%` }} />
                          </span>
                          <Tag tone={flag.tone}>{t(flag.key, { target })}</Tag>
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="fw-ct-hint">{t('price.share', { target })}</p>
        </div>
      )}
    </Card>
  )
}
