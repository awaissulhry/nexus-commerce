'use client'

import Link from 'next/link'
import { Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import type { WhereUsedView } from '@nexus/factory-domain/sales/mtm/where-used'
import { ExtrasMessages, useExtras } from '../../../../../sales/mtm/photos/words'
import type { TemplateView } from '../../api'
import { ridersHref } from '../../model'
import { useWords } from '../../parts'

/**
 * Measurement template › Where used (design template.whereused: "Styles that use it and rider profiles measured with it"): the
 * styles measured with it and how many are made to measure, the rider profile revisions measured for its garment type, and the
 * way to those riders (Sales › Made-to-measure with its garment type). B-W2b-371 (XF2:04), beyond counts: each style measured with
 * it (its code to the style, name, season, state, made to measure or not) and the open orders whose made-to-measure units it
 * serves (the order, the customer, each unit's line, style and colourway, base size, the revision it is made to and its review, the
 * rider for a reader of measurements); the orders held with why for someone who reads no orders. Fetches nothing.
 */
export function WhereUsedTab({ prefix, template, whereUsed, onRetry }: { prefix: string; template: TemplateView; whereUsed: { readonly value: WhereUsedView | null; readonly problem: string | null } | null; onRetry?: () => void }) {
  const { t } = useWords()
  const used = template.styles.measured > 0 || template.profiles > 0
  return (
    <div className="fw-lib-stack">
      <Card padded>
        <section className="fw-lib-stack" aria-labelledby="mtt-used">
          <h2 id="mtt-used" className="fw-lib-title">
            {t('used.title')}
          </h2>
          {!used ? (
            <EmptyState
              title={t('used.empty')}
              description={t('used.emptyBody', { code: template.code })}
              action={
                <Button size="sm" asChild>
                  <Link href={ridersHref(prefix, template.code)}>{t('used.openRiders', { code: template.code })}</Link>
                </Button>
              }
            />
          ) : (
            <>
              <dl className="fw-mtt-facts">
                <div className="fw-lib-readfield">
                  <dt className="fw-lib-readfield-label">{t('used.styles')}</dt>
                  <dd className="fw-lib-readfield-value">{t('used.stylesValue', { count: template.styles.measured, mtm: template.styles.madeToMeasure })}</dd>
                </div>
                <div className="fw-lib-readfield">
                  <dt className="fw-lib-readfield-label">{t('used.profiles')}</dt>
                  <dd className="fw-lib-readfield-value">{t('used.profilesValue', { count: template.profiles })}</dd>
                </div>
              </dl>
              <p className="fw-lib-hint">{t('used.kept')}</p>
              <Link className="fw-lib-link" href={ridersHref(prefix, template.code)}>
                {t('used.openRiders', { code: template.code })}
              </Link>
            </>
          )}
        </section>
      </Card>
      {whereUsed && (
        <ExtrasMessages>
          <Lists prefix={prefix} code={template.code} whereUsed={whereUsed} onRetry={onRetry} />
        </ExtrasMessages>
      )}
    </div>
  )
}

function Lists({ prefix, code, whereUsed, onRetry }: { prefix: string; code: string; whereUsed: { readonly value: WhereUsedView | null; readonly problem: string | null }; onRetry?: () => void }) {
  const { t } = useExtras()
  if (whereUsed.problem)
    return (
      <Card padded>
        <EmptyState
          title={t('whereUsed.failed')}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {t('whereUsed.retry')}
            </Button>
          }
        />
      </Card>
    )
  const value = whereUsed.value
  if (!value)
    return (
      <Card padded aria-busy="true">
        <p className="fw-lib-hint" role="status">
          {t('whereUsed.reading')}
        </p>
        <Skeleton height={22} />
        <Skeleton height={22} />
      </Card>
    )
  return (
    <>
      <Card padded>
        <section className="fw-lib-stack" aria-labelledby="mtx-styles">
          <h2 id="mtx-styles" className="fw-lib-title">
            {t('whereUsed.styles', { code })}
          </h2>
          {value.styles.length === 0 ? (
            <p className="fw-lib-hint">{t('whereUsed.noStyles', { code })}</p>
          ) : (
            <SummaryTable
              label={t('whereUsed.styles', { code })}
              stackOnPhone
              columns={[t('whereUsed.col.style'), t('whereUsed.col.name'), t('whereUsed.col.season'), t('whereUsed.col.state'), t('whereUsed.col.mtm')]}
              widths={['18%', '32%', '14%', '18%', undefined]}
              rows={value.styles.map((style) => ({
                id: style.id,
                cells: [
                  <Link key="s" className="fw-lib-link" href={`${prefix}/products/styles/${encodeURIComponent(style.id)}`}>
                    {style.code}
                  </Link>,
                  style.name,
                  style.season ?? '—',
                  t(`lifecycle.${style.lifecycle}`),
                  <Tag key="m" tone={style.madeToMeasure ? 'success' : 'neutral'}>
                    {t(style.madeToMeasure ? 'whereUsed.mtmYes' : 'whereUsed.mtmNo')}
                  </Tag>,
                ],
              }))}
            />
          )}
        </section>
      </Card>
      <Card padded>
        <section className="fw-lib-stack" aria-labelledby="mtx-orders">
          <h2 id="mtx-orders" className="fw-lib-title">
            {t('whereUsed.orders', { code })}
          </h2>
          {value.orders === null ? (
            <p className="fw-lib-hint">{t('whereUsed.ordersHeld')}</p>
          ) : value.orders.length === 0 ? (
            <p className="fw-lib-hint">{t('whereUsed.noOrders', { code })}</p>
          ) : (
            <>
              <SummaryTable
                label={t('whereUsed.orders', { code })}
                stackOnPhone
                columns={[t('whereUsed.col.order'), t('whereUsed.col.customer'), t('whereUsed.col.status'), t('whereUsed.col.units')]}
                widths={['16%', '24%', '16%', undefined]}
                rows={value.orders.map((order) => ({
                  id: order.id,
                  cells: [
                    <Link key="o" className="fw-lib-link" href={`${prefix}/sales/orders/${encodeURIComponent(order.id)}`}>
                      {order.number}
                    </Link>,
                    `${order.customer.name} · ${order.customer.code}`,
                    t(`status.${order.status}`),
                    <ul key="u" className="fw-lib-list">
                      {order.units.map((unit) => (
                        <li key={unit.lineId}>
                          {t('whereUsed.unit', { seq: unit.seq, style: unit.style.code, colourway: unit.colourway, size: unit.baseSize ?? '—', revision: unit.profile.revision, review: t(`review.${unit.profile.review}`) })}
                          {unit.rider ? ` · ${unit.rider}` : ''}
                        </li>
                      ))}
                    </ul>,
                  ],
                }))}
              />
              {value.moreOrders && <p className="fw-lib-hint">{t('whereUsed.moreOrders')}</p>}
            </>
          )}
        </section>
      </Card>
    </>
  )
}
