'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { MessageSquare, PackageCheck, ShoppingCart, Split } from 'lucide-react'
import { Banner, KeyValue } from '@nexus/ui/components'
import { BarList } from '@nexus/ui/charts/bar-list/index'
import { SizeGridView } from '@nexus/ui/grid/size-grid/index'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { DetailModal } from '../../../../lib/i18n/ds-parts'
import { useDsLabels } from '../../../../lib/i18n/ds-labels'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { quantity } from '../../../_shared/buying/model'
import type { NeedRow } from '../api'
import { area, feasibilityTone, gradeMixWords, lotWords, pct, shadeOptions, sizesWords, splitWords, type ShadeOption, type Words } from '../model'
import type { LeatherActions, LeatherModel } from '../view-model'

const OPTION_ICONS: Record<ShadeOption, typeof Split> = { reserve: PackageCheck, split: Split, buy: ShoppingCart, ask: MessageSquare }

/**
 * Can this order be cut from one shade? (design planning.leather pop:shade, opened by the feasibility pill or Enter; J / K the
 * next and previous order of the list, as every Office detail): the order line and what is left to find, the area by size and
 * part (the design's expanded row), the free lots by shade with their area (the order's own reserved part stacked), and the
 * options with their effect — reserve the hides of one lot, split by garment (whole sizes per lot), buy the area that
 * completes the best lot (What to buy & make's Draft PO), ask the customer (a note on the order for Sales). Each option is
 * its own action on its own route, held with the reason when the person may not do it.
 */
export function ShadeDrawer({ model, actions, words, row, order }: { model: LeatherModel; actions?: LeatherActions; words: Words; row: NeedRow | null; order: readonly string[] }) {
  const { t, locale } = words
  const ds = useDsLabels()
  const current = model.controls.open!
  const uom = row?.item.baseUom ?? ''
  const options = row ? shadeOptions(row, model.can) : []
  const grid = useMemo(() => {
    if (!row) return null
    const sizes = row.sizes.map((size) => ({ key: size.size, label: size.size }))
    const colours = row.parts.map((part) => ({ key: part.part, label: part.part }))
    const value = Object.fromEntries(row.parts.map((part) => [part.part, Object.fromEntries(part.sizes.map((size) => [size.size, Math.round(Number(size.area))]))]))
    return { sizes, colours, value }
  }, [row])

  const effect = (option: ShadeOption): string => {
    if (!row) return ''
    if (option === 'reserve') return t('option.reserveEffect', { count: row.proposal?.count ?? 0, area: area(row.proposal?.area ?? '0', uom, words), lot: lotWords(row.best, uom, words) })
    if (option === 'split') return t('option.splitEffect', { split: splitWords(row, words) })
    if (option === 'buy') return t('option.buyEffect', { area: area(row.buy?.area ?? '0', uom, words), hides: row.buy?.hides ?? '—', shade: row.buy?.shadeLabel ?? t('lot.anyShade'), lot: row.buy?.lotCode ?? '—' })
    return t('option.askEffect', { order: row.order.number })
  }

  return (
    <DetailModal
      open
      onClose={() => actions?.onOpen?.(null)}
      title={t('shade.title')}
      subtitle={row ? `${row.order.number} · ${t('row.line', { seq: row.orderLine.seq })} · ${row.style.code} · ${row.colourway?.name ?? '—'}` : undefined}
      loading={!row && model.need.status === 'loading'}
      error={!row && model.need.status !== 'loading' ? t('shade.gone') : undefined}
      nav={{ ids: order, current, onGo: (id) => actions?.onOpen?.(id), noun: t('shade.noun') }}
      meta={row ? <Pill tone={feasibilityTone(row)}>{t(`feasibility.${row.feasibility}`)}</Pill> : undefined}
    >
      {row && (
        <div className="fw-lp-drawer">
          {model.drawerNotice && <Banner tone={model.drawerNotice.tone} title={t(model.drawerNotice.key, model.drawerNotice.params)} />}
          <p className="fw-lp-text">{t(`shade.why.${row.feasibility}`)}</p>
          <KeyValue
            items={[
              { label: t('shade.leather'), value: `${row.item.code}${row.colour ? ` · ${row.colour.name}` : ''}` },
              { label: t('shade.sizes'), value: sizesWords(row, words) },
              { label: t('shade.area'), value: `${area(row.area, uom, words)} · ${row.lossPct === null ? t('row.lossUnknown') : t('row.loss', { loss: pct(row.lossPct, words) })}` },
              { label: t('shade.toFind'), value: `${area(row.toFind, uom, words)}${row.hides !== null ? ` · ${t('row.hides', { count: row.hides })}` : ''}` },
              { label: t('shade.held'), value: row.heldLots.length === 0 ? t('shade.heldNone') : row.heldLots.map((held) => lotWords(held, uom, words)).join(', ') },
              { label: t('shade.grades'), value: gradeMixWords(row, words) },
            ]}
          />
          {grid && grid.colours.length > 0 && (
            <div className="fw-lp-grid">
              <h3 className="fw-lp-h3">{t('shade.bySize', { unit: words.unit(uom) })}</h3>
              <SizeGridView colours={grid.colours} sizes={grid.sizes} value={grid.value} caption={t('shade.bySize', { unit: words.unit(uom) })} locale={INTL_LOCALE[locale]} copy={{ colourHeader: t('shade.part'), totalHeader: t('shade.total') }} />
            </div>
          )}
          <div>
            <h3 className="fw-lp-h3">{t('shade.lots')}</h3>
            <BarList
              labels={ds.barList}
              label={t('shade.lots')}
              format={(value) => `${quantity(String(value), locale)} ${words.unit(uom)}`}
              keys={[
                { id: 'free', label: t('shade.free'), tone: 'neutral' },
                { id: 'held', label: t('shade.reservedHere'), tone: 'info' },
              ]}
              items={row.lots.map((lot) => {
                const held = lot.ordersOwn ? Number(row.reserved) : 0
                return {
                  id: lot.key,
                  label: lot.shadeLabel ? `${lot.lotCode} · ${t('lot.shade', { shade: lot.shadeLabel })}` : lot.lotCode,
                  sub: lot.ordersOwn ? t('shade.own', { count: lot.count }) : t('shade.hidesFree', { count: lot.count }),
                  value: Number(lot.free) + held,
                  valueText: area(lot.free, uom, words),
                  parts: { free: Number(lot.free), held },
                  tone: Number(lot.free) + held >= Number(row.toFind) && Number(row.toFind) > 0 ? 'success' : 'neutral',
                }
              })}
            />
          </div>
          <div className="fw-lp-options">
            <h3 className="fw-lp-h3">{t('shade.options')}</h3>
            {options.length === 0 && <p className="fw-lp-hint">{t('shade.noOptions')}</p>}
            {options.map(({ option, held }) => {
              const Icon = OPTION_ICONS[option]
              const busy = model.acting === option
              return (
                <div key={option} className="fw-lp-option">
                  <span className="fw-lp-cell">
                    <span className="fw-lp-strong">{t(`option.${option}`)}</span>
                    <span className="fw-lp-sub">{effect(option)}</span>
                  </span>
                  <Button size="sm" variant={option === 'reserve' || (option === 'split' && row.feasibility === 'SPLIT') || (option === 'buy' && row.feasibility === 'MUST_BUY') ? 'primary' : 'secondary'} heldReason={held ? t(held) : model.acting ? t('held.busy') : null} onClick={() => actions?.onChoose?.(row.id, option)}>
                    {busy ? <Spinner size={12} /> : <Icon size={13} aria-hidden />} {t(`option.${option}Do`)}
                  </Button>
                </div>
              )
            })}
          </div>
          <p className="fw-lp-hint">
            {t('shade.links')}{' '}
            <Link className="fw-lp-link" href={`${model.prefix}/sales/orders/${row.order.id}`}>
              {row.order.number}
            </Link>
            {row.workOrders.map((workOrder) => (
              <span key={workOrder.id}>
                {' · '}
                <Link className="fw-lp-link" href={`${model.prefix}/production/work-orders/${workOrder.id}`}>
                  {workOrder.number}
                </Link>
              </span>
            ))}
            {' · '}
            <Link className="fw-lp-link" href={`${model.prefix}/planning/mrp?site=${model.siteId ?? ''}&line=${row.requirement.id}`}>
              {t('shade.mrpLine')}
            </Link>
          </p>
        </div>
      )}
    </DetailModal>
  )
}
