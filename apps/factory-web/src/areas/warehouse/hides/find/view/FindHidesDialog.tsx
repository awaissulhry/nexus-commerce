'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Bookmark, Search } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, SegmentedControl, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { Uom } from '../../../../_shared/stock/api'
import { quantity } from '../../../../_shared/stock/model'
import { areaWords } from '../../dashboard/dashboard-model'
import { HidesMessages, useHideWords } from '../../words'
import { chosenFigure, findHeldKey, mixesShades, reserveHeldKey, rowsOf, shownUnit, type FindDialogActions, type FindDialogModel, type FindRow } from '../find-model'
import { areaUnitsFor } from '../use-find'
import '../find.css'

export type { FindDialogActions, FindDialogModel } from '../find-model'

/**
 * Find hides for a job (B-W2b-131; SCM-257, SCM-206; design warehouse.hides pop-up hd-find, the band's primary action):
 * for a work order (its leather and the area it still needs) or by an article and the area needed, with a shade group and
 * a minimum grade; the answer as ONE list on the shared list frame — the proposed shade lot first with its hides chosen and
 * the running area, the other lots below with the shade warning, the out-of-shade hides apart — and the hides chosen
 * against the need ("11 hides · 46.20 of 44.00 m² ✓"). "Reserve N hides" reserves them whole for the work order; mixing
 * shades is refused unless a person with inventory.shade.override gives the reason. Esc closes.
 */
export function FindHidesDialog({ model, actions }: { model: FindDialogModel; actions?: FindDialogActions }) {
  return (
    <HidesMessages>
      <Dialog model={model} actions={actions} />
    </HidesMessages>
  )
}

function Dialog({ model, actions }: { model: FindDialogModel; actions?: FindDialogActions }) {
  const t = useHideWords()
  const locale = useLocale()
  const unit = (uom: Uom) => t(`stock:uom.${uom}`)
  const say = (phrase: { key: string; params?: Readonly<Record<string, string | number>> }) => t(phrase.key, phrase.params)
  const [query, setQuery] = useState(model.workOrderQuery)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (query === model.workOrderQuery) return
    const timer = setTimeout(() => latest.current?.onWorkOrderQuery?.(query), 300)
    return () => clearTimeout(timer)
  }, [query, model.workOrderQuery])

  const draft = model.draft
  const answer = model.result?.value ?? null
  const rows = useMemo(() => (answer ? rowsOf(answer) : []), [answer])
  const base = (answer?.item.baseUom ?? model.articles.value?.find((option) => option.key === draft.articleKey)?.uom ?? null) as Uom | null
  const figure = answer ? chosenFigure(answer, model.chosen) : null
  const mixing = answer ? mixesShades(answer, model.chosen) : false
  const findHeld = findHeldKey(model)
  const reserveHeld = reserveHeldKey(model)
  const close = () => actions?.onClose?.()
  const set = (next: Partial<typeof draft>) => actions?.onDraft?.({ ...draft, ...next })
  const shadeGroups = answer ? [...new Map(answer.lots.filter((lot) => lot.shadeGroupId).map((lot) => [lot.shadeGroupId!, lot.shadeLabel ?? lot.lotCode])).entries()] : []

  const columns = useMemo<ColDef<FindRow>[]>(() => {
    const HideCell = ({ data }: ICellRendererParams<FindRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-wl-code">{data.hideCode}</span>
          <span className="fw-st-sub">{data.remnant ? t('find.remnant', { code: data.remnant.code }) : t(`stock:hideState.${data.state}`)}</span>
        </span>
      ) : null
    const LotCell = ({ data }: ICellRendererParams<FindRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-hd-find-line nowrap">
            <span className="fw-wl-code">{data.lotCode}</span>
            {data.apart ? <Tag tone="danger">{t('find.tag.outOfShade')}</Tag> : data.proposedLot ? <Tag tone="success">{t('find.tag.proposed')}</Tag> : data.shadeWarning ? <Tag tone="warning">{t('find.tag.mixes')}</Tag> : null}
          </span>
          <span className="fw-st-sub">{[data.shadeLabel ? t('find.shade', { shade: data.shadeLabel }) : t('find.unsorted'), data.ordersOwn ? t('find.tag.ordersOwn') : null].filter(Boolean).join(' · ')}</span>
        </span>
      ) : null
    const LeftCell = ({ data }: ICellRendererParams<FindRow>) => (data ? <span className="fw-st-num">{base ? areaWords(data.left, base, unit, locale) : quantity(data.left, locale)}</span> : null)
    const RunningCell = ({ data }: ICellRendererParams<FindRow>) => (data ? <span className="fw-st-num">{data.apart ? '—' : base ? `${quantity(data.running, locale)} ${unit(base)}` : quantity(data.running, locale)}</span> : null)
    return [
      { colId: 'hide', headerName: t('find.col.hide'), minWidth: 150, flex: 1, cellRenderer: HideCell },
      { colId: 'lot', headerName: t('find.col.lot'), minWidth: 210, flex: 1.4, cellRenderer: LotCell },
      { colId: 'grade', headerName: t('find.col.grade'), field: 'grade', minWidth: 80, flex: 0.5, valueFormatter: (params) => (params.value as string | null) ?? '—' },
      { colId: 'left', headerName: t('find.col.left'), minWidth: 150, flex: 1, type: 'rightAligned', cellRenderer: LeftCell },
      { colId: 'running', headerName: t('find.col.running'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: RunningCell },
      { colId: 'place', headerName: t('find.col.place'), minWidth: 120, flex: 0.8, valueGetter: (params: { data?: FindRow }) => params.data?.locationCodes.join(', ') || '—' },
    ]
  }, [t, locale, base])

  if (model.done) {
    return (
      <Modal
        open
        onClose={close}
        size="md"
        title={t('find.title')}
        footer={
          <Button size="sm" variant="primary" onClick={close}>
            {t('find.close')}
          </Button>
        }
      >
        <Banner tone="success" title={t('find.done', { count: model.done.count, workOrder: model.done.workOrder })} />
      </Modal>
    )
  }

  const workOrderField = (required: boolean) => (
    <Field label={t(draft.mode === 'workOrder' ? 'find.workOrder' : 'find.reserveFor')} required={required}>
      {model.can.workOrders ? (
        <div className="fw-hd-find-pick">
          <Input type="search" size="sm" leadingIcon={<Search size={13} aria-hidden />} aria-label={t('find.searchWorkOrders')} placeholder={t('find.searchWorkOrders')} value={query} onChange={(event) => setQuery(event.target.value)} />
          {model.workOrders.problem ? (
            <span className="fw-hd-find-hint">{t('find.workOrdersFailed')}</span>
          ) : model.workOrders.value === null ? (
            <span className="fw-hd-find-hint" role="status">
              <Spinner size={12} /> {t('find.searching')}
            </span>
          ) : (
            <Select size="sm" aria-label={t('find.workOrder')} value={draft.workOrderId ?? ''} onChange={(event) => set({ workOrderId: event.target.value || null })}>
              <option value="">{model.workOrders.value.length === 0 ? t('find.noWorkOrders') : t('find.pickWorkOrder')}</option>
              {model.workOrders.value.map((order) => (
                <option key={order.id} value={order.id}>
                  {`${order.number} · ${order.styleCode} · ${t('find.pieces', { count: order.pieces })}`}
                </option>
              ))}
            </Select>
          )}
        </div>
      ) : (
        <span className="fw-hd-find-hint">{t('find.noRightWorkOrders')}</span>
      )}
    </Field>
  )

  return (
    <Modal
      open
      onClose={close}
      size="xl"
      title={t('find.title')}
      subtitle={t('find.subtitle')}
      footer={
        <>
          <Button size="sm" onClick={close}>
            {t('stock:common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={reserveHeld ? t(reserveHeld) : null} onClick={() => actions?.onReserve?.()}>
            {model.posting ? <Spinner size={12} /> : <Bookmark size={13} aria-hidden />} {t('find.reserve', { count: model.chosen.length })}
          </Button>
        </>
      }
    >
      <div className="fw-hd-find">
        {model.problem && <Banner tone="danger" title={say(model.problem)} />}
        <SegmentedControl
          size="sm"
          ariaLabel={t('find.modeLabel')}
          value={draft.mode}
          onChange={(next) => set({ mode: next === 'article' ? 'article' : 'workOrder' })}
          options={[
            { value: 'workOrder', label: t('find.mode.workOrder'), disabled: !model.can.workOrders, title: model.can.workOrders ? undefined : t('find.noRightWorkOrders') },
            { value: 'article', label: t('find.mode.article') },
          ]}
        />
        <div className="fw-hd-find-fields">
          {!model.siteId && model.sites.length > 1 && (
            <Field label={t('stock:common.site')} required>
              <Select size="sm" value={model.siteId ?? ''} onChange={(event) => actions?.onSite?.(event.target.value || null)}>
                <option value="">{t('find.pickSite')}</option>
                {model.sites.map((site) => (
                  <option key={site.id} value={site.id}>{`${site.code} · ${site.name}`}</option>
                ))}
              </Select>
            </Field>
          )}
          {draft.mode === 'workOrder' && workOrderField(true)}
          {(draft.mode === 'article' || !!draft.articleKey || model.result?.problem === 'find.problem.whichLeather' || (answer?.leathers.length ?? 0) > 1) && (
            <Field label={t(draft.mode === 'article' ? 'find.article' : 'find.leather')} required={draft.mode === 'article'}>
              {model.articles.problem ? (
                <span className="fw-hd-find-hint">{t('find.articlesFailed')}</span>
              ) : model.articles.value === null ? (
                <span className="fw-hd-find-hint" role="status">
                  <Spinner size={12} /> {t('find.searching')}
                </span>
              ) : (
                <Select size="sm" value={draft.articleKey ?? ''} onChange={(event) => set({ articleKey: event.target.value || null })}>
                  <option value="">{model.articles.value.length === 0 ? t('find.noArticles') : t('find.pickArticle')}</option>
                  {model.articles.value.map((option) => (
                    <option key={option.key} value={option.key}>
                      {`${option.label} · ${t('dash.hides', { count: option.hides })}`}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label={t('find.area')} hint={draft.mode === 'workOrder' ? t('find.areaHintWorkOrder') : t('find.areaHint')} error={draft.area.trim() !== '' && findHeld === 'find.held.area' ? t('find.held.area') : undefined}>
            <span className="fw-hd-find-area">
              <Input size="sm" inputMode="decimal" value={draft.area} onChange={(event) => set({ area: event.target.value })} aria-label={t('find.area')} />
              <Select size="sm" aria-label={t('find.unit')} value={shownUnit(draft, model.articles.value, answer)} onChange={(event) => set({ uom: event.target.value as typeof draft.uom })}>
                {areaUnitsFor(base).map((uom) => (
                  <option key={uom} value={uom}>
                    {unit(uom)}
                  </option>
                ))}
              </Select>
            </span>
          </Field>
          <Field label={t('find.shadeGroup')} hint={answer ? undefined : t('find.shadeGroupHint')}>
            <Select size="sm" value={draft.shadeGroupId ?? ''} onChange={(event) => set({ shadeGroupId: event.target.value || null })}>
              <option value="">{t('find.anyShade')}</option>
              {shadeGroups.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('find.minGrade')}>
            {model.grades === null ? (
              <span className="fw-hd-find-hint">{t('find.gradesHeld')}</span>
            ) : (
              <Select size="sm" value={draft.minGradeId ?? ''} onChange={(event) => set({ minGradeId: event.target.value || null })}>
                <option value="">{t('find.anyGrade')}</option>
                {(model.grades.value ?? []).map((grade) => (
                  <option key={grade.id} value={grade.id}>
                    {`${grade.code} · ${locale === 'en' ? grade.labelEn : grade.labelIt}`}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="fw-hd-find-go">
            <Button size="sm" variant={answer ? 'secondary' : 'primary'} heldReason={findHeld ? t(findHeld) : null} onClick={() => actions?.onFind?.()}>
              <Search size={13} aria-hidden /> {t('find.find')}
            </Button>
          </div>
        </div>

        {model.result === null ? (
          <p className="fw-hd-find-hint">{t('find.intro')}</p>
        ) : model.result.problem ? (
          <EmptyState
            title={t('find.failed')}
            description={t(model.result.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('lots:rec.retry')}
              </Button>
            }
          />
        ) : !answer ? (
          <p className="fw-hd-find-hint" role="status">
            <Spinner size={12} /> {t('find.searching')}
          </p>
        ) : (
          <>
            <div className="fw-hd-find-summary" role="status">
              <span>
                {answer.workOrder
                  ? t('find.forWorkOrder', { number: answer.workOrder.number, article: `${answer.item.code}${answer.colour ? ` · ${answer.colour.name}` : ''}` })
                  : t('find.forArticle', { article: `${answer.item.code} · ${answer.item.name}${answer.colour ? ` · ${answer.colour.name}` : ''}` })}
              </span>
              <span>{answer.need.baseArea && base ? t('find.need', { area: areaWords(answer.need.baseArea, base, unit, locale) }) : t('find.noNeed')}</span>
              {answer.ordersShadeLots.length > 0 && <span>{t('find.cutFrom', { lots: answer.ordersShadeLots.map((lot) => (lot.shadeLabel ? `${lot.lotCode} (${lot.shadeLabel})` : lot.lotCode)).join(', ') })}</span>}
              <span>{t(`find.rule.${answer.rule}`)}</span>
            </div>
            <ListFrame<FindRow>
              listKey={null}
              label={t('find.listLabel')}
              rows={rows}
              rowId={(row) => row.hideId}
              columns={columns}
              count={t('find.count', { count: rows.length })}
              selection={{ selected: model.chosen, onChange: (ids) => actions?.onChosen?.(ids), actions: <span className="fw-st-sub">{figure && base ? (figure.need === null ? t('find.chosen', { hides: t('dash.hides', { count: figure.count }), area: areaWords(figure.area, base, unit, locale) }) : t(figure.covers ? 'find.covers' : 'find.short', { hides: t('dash.hides', { count: figure.count }), area: quantity(figure.area, locale), need: areaWords(figure.need, base, unit, locale), short: `${quantity(figure.short ?? 0, locale)} ${unit(base)}` })) : null}</span> }}
              state={rows.length === 0 ? <EmptyState title={t('find.none')} description={t('find.noneBody')} /> : undefined}
              cards={null}
            />
            {figure && base && (
              <p className={figure.covers === false ? 'fw-hd-find-figure short' : 'fw-hd-find-figure'} role="status">
                {figure.need === null
                  ? t('find.chosen', { hides: t('dash.hides', { count: figure.count }), area: areaWords(figure.area, base, unit, locale) })
                  : figure.covers
                    ? t('find.covers', { hides: t('dash.hides', { count: figure.count }), area: `${quantity(figure.area, locale)}`, need: areaWords(figure.need, base, unit, locale) })
                    : t('find.short', { hides: t('dash.hides', { count: figure.count }), area: `${quantity(figure.area, locale)}`, need: areaWords(figure.need, base, unit, locale), short: `${quantity(figure.short ?? 0, locale)} ${unit(base)}` })}
              </p>
            )}
            {mixing && (model.can.override ? <Banner tone="warning" title={t('find.mixWarning')} /> : <Banner tone="warning" title={t('find.mixHeld')} />)}
            {draft.mode === 'article' && workOrderField(true)}
            {mixing && model.can.override && (
              <Field label={t('find.overrideReason')} required hint={t('find.overrideHint')}>
                <Textarea value={model.overrideReason} onChange={(event) => actions?.onOverrideReason?.(event.target.value)} limit={500} rows={2} />
              </Field>
            )}
            <Field label={t('find.note')}>
              <Textarea value={model.note} onChange={(event) => actions?.onNote?.(event.target.value)} limit={500} rows={2} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  )
}
