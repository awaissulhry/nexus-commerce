'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Calculator } from 'lucide-react'
import { Banner, Card, DetailPopover, EmptyState } from '@nexus/ui/components'
import { SelectionLabel, SizeGridView, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Select, Skeleton } from '@nexus/ui/primitives'
import { Combobox } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { Atp, AtpCell } from '../api'
import { ATP_DEFAULT_WEEKS, ATP_WEEK_CHOICES, atpRows, calcFromAtp, dayWords, sizeGridOf, sourcesInWeek, weekLabel, weekShown, type AtpRow, type Words } from '../model'
import type { PromiseActions, PromiseModel } from '../view-model'
import { sizeGridCopy } from './grid-copy'

/**
 * Available to promise (design planning.promise sec:atp): for stock styles, what can still be promised per size, colour and
 * week — stock + planned receipts − committed, never promising away a later commitment. Pick a style (DS Combobox of the
 * site's stock styles; the warehouse is the site in the band) and the weeks; the DS SizeGridView shows one week's colour ×
 * size; "Week by week" is the same on the shared list frame (a colourway's total, then its sizes), each cell the trigger of a
 * DS DetailPopover with what makes it (receipts, committed, cumulative, short, and the work orders, planned orders and order
 * lines behind it). Ticked sizes of one colour open the Promise calculator with them.
 */
export function AtpSection({ model, actions, words }: { model: PromiseModel; actions?: PromiseActions; words: Words }) {
  const { t, locale } = words
  const styles = model.styles.status === 'ready' ? model.styles.value : []
  const options = styles.map((entry) => ({ value: entry.id, label: `${entry.code} · ${entry.name}${entry.makeToStock ? '' : ` (${t('atp.notStock')})`}` }))
  const atp = model.atp?.status === 'ready' ? model.atp.value : null
  const weeks = model.controls.weeks ?? ATP_DEFAULT_WEEKS

  let body: ReactNode
  if (model.styles.status === 'error') {
    body = (
      <Card padded>
        <EmptyState
          title={t('atp.stylesError')}
          description={t(model.styles.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.('styles')}>
              {t('common.retry')}
            </Button>
          }
        />
      </Card>
    )
  } else if (!model.controls.style) {
    body = (
      <Card padded>
        <EmptyState title={t('atp.pick')} description={model.styles.status === 'ready' && styles.length === 0 ? t('atp.noStyles') : t('atp.pickBody')} />
      </Card>
    )
  } else if (!model.atp || model.atp.status === 'loading') {
    body = (
      <div className="fw-pdt-atp-loading" aria-busy="true">
        <Skeleton height={28} />
        <Skeleton height={28} />
        <Skeleton height={28} />
      </div>
    )
  } else if (model.atp.status === 'error') {
    body = (
      <Card padded>
        <EmptyState
          title={t('atp.error')}
          description={t(model.atp.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.('atp')}>
              {t('common.retry')}
            </Button>
          }
        />
      </Card>
    )
  } else if (atp && atp.empty) {
    body = (
      <Card padded>
        <EmptyState title={t('atp.empty')} description={t('atp.emptyBody', { style: atp.style.code })} />
      </Card>
    )
  } else if (atp) {
    body = <AtpGrids atp={atp} model={model} actions={actions} words={words} />
  }

  return (
    <div className="fw-pdt-atp">
      <div className="fw-pdt-atp-controls">
        <span className="fw-pdt-atp-style">
          {model.styles.status === 'loading' ? (
            <Skeleton width={260} height={32} />
          ) : (
            <>
              <span id="fw-pdt-atp-style-label" className="nds-vh">
                {t('atp.styleLabel')}
              </span>
              <Combobox options={options} value={model.controls.style ?? undefined} placeholder={t('atp.stylePick')} labelledBy="fw-pdt-atp-style-label" onChange={(value) => actions?.onStyle?.(value || null)} />
            </>
          )}
        </span>
        <Select size="sm" aria-label={t('atp.weeks')} value={String(weeks)} onChange={(event) => actions?.onWeeks?.(Number(event.target.value) === ATP_DEFAULT_WEEKS ? null : Number(event.target.value))}>
          {ATP_WEEK_CHOICES.map((count) => (
            <option key={count} value={String(count)}>
              {t('atp.weeksCount', { count })}
            </option>
          ))}
        </Select>
        {atp && <span className="fw-pdt-hint">{t('atp.asOf', { day: dayWords(atp.today, locale, true) })}</span>}
      </div>
      {atp && !atp.stockStyle && !atp.empty && <Banner tone="info" title={t('atp.notStockStyle')} />}
      {body}
    </div>
  )
}

function AtpGrids({ atp, model, actions, words }: { atp: Atp; model: PromiseModel; actions?: PromiseActions; words: Words }) {
  const { t, locale } = words
  const week = weekShown(atp, model.controls.week)
  const grid = useMemo(() => (week ? sizeGridOf(atp, week) : null), [atp, week])
  const rows = useMemo(() => atpRows(atp), [atp])
  const [selected, setSelected] = useState<readonly string[]>(model.selectedAtp ?? [])
  const rowsKey = rows.map((row) => row.key).join(',')
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const picked = rows.filter((row) => selected.includes(row.key))
  const calcForm = calcFromAtp(picked, atp.style.id)
  const weekRange = atp.weeks.find((entry) => entry.key === week)
  const copy = useMemo(() => sizeGridCopy(t, t('atp.gridCaption', { week: week ? weekLabel(week, t) : '' })), [t, week])

  const NameCell = ({ data: row }: ICellRendererParams<AtpRow>) =>
    row ? (
      row.kind === 'colour' ? (
        <span className="fw-pdt-cell">
          <b className="fw-pdt-ellipsis">{row.colourway.name}</b>
          <span className="fw-pdt-sub">{t('atp.colourTotal')}</span>
        </span>
      ) : (
        <span className="fw-pdt-cell fw-pdt-atp-size">
          <span>{t('atp.size', { size: row.size ?? '' })}</span>
          <span className="fw-pdt-sub fw-pdt-ellipsis">{[row.size$?.sku, row.size$?.strategy ? t(`strategy.${row.size$.strategy}`) : t('strategy.none')].filter(Boolean).join(' · ')}</span>
        </span>
      )
    ) : null
  const WeekCell = (key: string, index: number) =>
    function Cell({ data: row }: ICellRendererParams<AtpRow>) {
      if (!row) return null
      const cell = row.line.cells.find((entry) => entry.key === key)
      if (!cell) return null
      return <AtpCellPopover row={row} cell={cell} first={index === 0} words={words} />
    }
  const columns: ColDef<AtpRow>[] = [
    { colId: 'name', headerName: t('atp.col.name'), minWidth: 170, flex: 1.4, sortable: false, suppressHeaderMenuButton: true, pinned: 'left', cellRenderer: NameCell },
    { colId: 'onHand', headerName: t('atp.col.onHand'), minWidth: 90, flex: 0.6, sortable: false, suppressHeaderMenuButton: true, type: 'numericColumn', valueGetter: (params) => (params.data ? params.data.line.onHand : '') },
    ...atp.weeks.map(
      (entry, index): ColDef<AtpRow> => ({
        colId: `w:${entry.key}`,
        headerName: index === 0 ? t('atp.thisWeek') : weekLabel(entry.key, t),
        headerTooltip: `${dayWords(entry.from, locale)} – ${dayWords(entry.to, locale)}`,
        minWidth: 84,
        flex: 0.6,
        sortable: false,
        suppressHeaderMenuButton: true,
        cellRenderer: WeekCell(entry.key, index),
      }),
    ),
    { colId: 'later', headerName: t('atp.col.later'), headerTooltip: t('atp.col.laterHint'), minWidth: 130, flex: 0.8, sortable: false, suppressHeaderMenuButton: true, valueGetter: (params) => (params.data ? t('atp.later', { receipts: params.data.line.later.receipts, committed: params.data.line.later.committed }) : '') },
  ]

  return (
    <div className="fw-pdt-atp">
      {grid && week && (
        <Card padded>
          <div className="fw-pdt-atp-week">
            <h3 className="fw-pdt-h3">{t('atp.gridTitle', { style: `${atp.style.code} · ${atp.style.name}` })}</h3>
            <Select size="sm" aria-label={t('atp.weekPick')} value={week} onChange={(event) => actions?.onWeek?.(event.target.value)}>
              {atp.weeks.map((entry, index) => (
                <option key={entry.key} value={entry.key}>
                  {index === 0 ? t('atp.thisWeek') : weekLabel(entry.key, t)} · {dayWords(entry.from, locale)}–{dayWords(entry.to, locale)}
                </option>
              ))}
            </Select>
          </div>
          <SizeGridView colours={grid.colours} sizes={grid.sizes} value={grid.value} caption={t('atp.gridCaption', { week: weekRange ? `${weekLabel(weekRange.key, t)} (${dayWords(weekRange.from, locale)}–${dayWords(weekRange.to, locale)})` : '' })} showCaption locale={INTL_LOCALE[locale]} copy={copy} />
          <p className="fw-pdt-hint">{t('atp.gridHint')}</p>
        </Card>
      )}
      <ListFrame<AtpRow>
        label={t('atp.weekly')}
        title={t('atp.weekly')}
        listKey="planning.promise.atp"
        rows={rows}
        rowId={(row) => row.key}
        columns={columns}
        count={t('atp.count', { count: rows.filter((row) => row.kind === 'size').length, colours: atp.colourways.length })}
        cards={null}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" variant="primary" aria-label={t('atp.bulkCalc', { count: picked.length })} heldReason={calcForm ? null : t('atp.held.oneColour')} onClick={() => calcForm && actions?.onCalculator?.(true, calcForm)}>
              <Calculator size={13} aria-hidden /> <SelectionLabel>{t('atp.bulkCalc', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        isRowSelectable={(row) => (row.kind === 'colour' ? t('atp.held.colourRow') : null)}
      />
    </div>
  )
}

function AtpCellPopover({ row, cell, first, words }: { row: AtpRow; cell: AtpCell; first: boolean; words: Words }) {
  const { t, locale } = words
  const name = row.kind === 'colour' ? row.colourway.name : `${row.colourway.name} · ${t('atp.size', { size: row.size ?? '' })}`
  const when = `${dayWords(cell.from, locale)}–${dayWords(cell.to, locale)}`
  const sources = row.size$ ? sourcesInWeek(row.size$.sources, cell, first) : []
  const tone = cell.short > 0 ? ' short' : cell.available === 0 ? ' zero' : ''
  return (
    <DetailPopover
      trigger={<span className={`fw-pdt-num${tone}`}>{cell.available}</span>}
      triggerLabel={t('atp.cellLabel', { what: name, week: when, count: cell.available })}
      triggerClassName="fw-pdt-trigger"
      label={t('atp.popTitle', { what: name, week: when })}
      hoverDelay={0}
    >
      <div className="fw-pdt-pop">
        <b>
          {name} · {when}
        </b>
        <dl className="fw-pdt-dl">
          <dt>{t('atp.pop.available')}</dt>
          <dd>{cell.available}</dd>
          <dt>{t('atp.pop.receipts')}</dt>
          <dd>{cell.receipts}</dd>
          <dt>{t('atp.pop.committed')}</dt>
          <dd>{cell.committed}</dd>
          <dt>{t('atp.pop.cumulative')}</dt>
          <dd>{cell.cumulative}</dd>
          {cell.short > 0 && (
            <>
              <dt>{t('atp.pop.short')}</dt>
              <dd className="fw-pdt-late">{cell.short}</dd>
            </>
          )}
        </dl>
        <p className="fw-pdt-hint">{t('atp.pop.rule')}</p>
        {sources.length > 0 && (
          <ul className="fw-pdt-pop-list">
            {sources.map((source) => (
              <li key={`${source.kind}:${source.id}`} className="fw-pdt-pop-row">
                <span>{t(`atp.source.${source.kind}`, { number: source.number, count: source.pieces })}</span>
                <span className="fw-pdt-sub">{source.date ? dayWords(source.date, locale, true) : t('atp.source.noDay')}</span>
              </li>
            ))}
          </ul>
        )}
        {row.kind === 'size' && sources.length === 0 && <p className="fw-pdt-hint">{t('atp.pop.noSources')}</p>}
      </div>
    </DetailPopover>
  )
}
