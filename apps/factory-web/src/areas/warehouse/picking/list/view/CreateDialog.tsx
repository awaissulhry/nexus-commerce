'use client'

import { useMemo } from 'react'
import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { CreateResult, PickRow } from '../../api'
import { createHeld, READINESS_TONE, resultPhrase } from '../../model'
import { say, useQty, useReadinessWord, useWords } from '../../parts'
import type { CreateModel, PickingListActions } from '../../view-model'

/**
 * pop:pk-create — "Create pick lists" (design warehouse.picking, band primary): the released work orders without a pick
 * list, by cut date; tick them (the shared list frame: select-all, shift range, x; a work order on hold or already with
 * its pick list cannot be ticked, its box says why) and "Create 4 pick lists" reserves what each still needs, oldest
 * stock first, in that order (so the one cut first is served first when material is short). Then each work order's
 * outcome in words: reserved, already reserved, refused (on hold, not released, the stock taken meanwhile) and what
 * stays short.
 */
export function CreateDialog({ model, timeZone, actions }: { model: CreateModel; timeZone: string; actions?: PickingListActions }) {
  const t = useWords()
  const locale = useLocale()
  const qty = useQty()
  const word = useReadinessWord()
  const place = { locale, timeZone }
  const rows = model.choices.items
  const columns = useMemo<ColDef<PickRow>[]>(
    () => [
      {
        colId: 'number',
        headerName: t('col.workOrder'),
        minWidth: 130,
        flex: 0.9,
        cellRenderer: ({ data }: ICellRendererParams<PickRow>) =>
          data ? (
            <span className="fw-st-cell">
              <span className="fw-pk-code">{data.workOrder.number}</span>
              <span className="fw-st-sub">{data.workOrder.style.code}</span>
            </span>
          ) : null,
      },
      {
        colId: 'cut',
        headerName: t('col.cutDate'),
        minWidth: 110,
        flex: 0.7,
        cellRenderer: ({ data }: ICellRendererParams<PickRow>) => (data ? <span className="fw-st-num">{data.cutDate ? formatDate(`${data.cutDate}T12:00:00Z`, place) : '—'}</span> : null),
      },
      {
        colId: 'readiness',
        headerName: t('col.readiness'),
        minWidth: 140,
        flex: 0.8,
        cellRenderer: ({ data }: ICellRendererParams<PickRow>) => (data ? <Pill tone={READINESS_TONE[data.readiness.word]}>{word(data.readiness.word, data.readiness.date)}</Pill> : null),
      },
      {
        colId: 'lines',
        headerName: t('col.lines'),
        minWidth: 100,
        flex: 0.5,
        type: 'rightAligned',
        cellRenderer: ({ data }: ICellRendererParams<PickRow>) => (data ? <span className="fw-st-num">{t('list.lines', { picked: data.lines.picked, all: data.lines.all })}</span> : null),
      },
    ],
    [t, locale, timeZone],
  )
  const picked = model.picked
  const held = model.busy ? t('create.busy') : picked.length === 0 ? t('create.heldNone') : null
  const close = () => actions?.onCloseCreate?.()
  return (
    <Modal
      open
      onClose={close}
      title={t('create.title')}
      subtitle={t('create.subtitle')}
      size="lg"
      footer={
        model.results ? (
          <Button size="sm" variant="primary" onClick={close}>
            {t('create.done')}
          </Button>
        ) : (
          <>
            <Button size="sm" variant="secondary" onClick={close}>
              {t('stock:common.cancel')}
            </Button>
            <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onConfirmCreate?.()}>
              {model.busy ? <Spinner size={12} /> : null} {t('create.go', { count: picked.length })}
            </Button>
          </>
        )
      }
    >
      <div className="fw-pk-dialog">
        {model.problem && <Banner tone="danger" title={say(t, model.problem) ?? ''} />}
        {model.results ? (
          <Results results={model.results} qty={qty} />
        ) : (
          <>
            {model.sites.length > 1 && (
              <Select size="sm" aria-label={t('stock:common.site')} value={model.siteId ?? ''} onChange={(event) => actions?.onCreateSite?.(event.target.value || null)}>
                <option value="">{t('stock:common.allSites')}</option>
                {model.sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {`${site.code} · ${site.name}`}
                  </option>
                ))}
              </Select>
            )}
            <p>{t('create.body')}</p>
            <ListFrame<PickRow>
              label={t('create.tableLabel')}
              rows={model.choices.problem ? [] : rows}
              rowId={(row) => row.workOrder.id}
              columns={columns}
              count={rows ? t('create.count', { count: rows.length }) : '—'}
              selection={{ selected: picked, onChange: (ids) => actions?.onPick?.(ids), actions: <SelectionLabel>{t('create.picked', { count: picked.length })}</SelectionLabel> }}
              isRowSelectable={(row) => {
                const why = createHeld(row)
                return why ? t(why.key) : null
              }}
              listKey={null}
              state={
                model.choices.problem ? (
                  <EmptyState title={t('list.failed')} description={t(`stock:${model.choices.problem}`)} />
                ) : rows && rows.length === 0 ? (
                  <EmptyState title={t('create.empty')} description={t('create.emptyBody')} />
                ) : undefined
              }
            />
          </>
        )}
      </div>
    </Modal>
  )
}

function Results({ results, qty }: { results: readonly CreateResult[]; qty: ReturnType<typeof useQty> }) {
  const t = useWords()
  const created = results.filter((result) => result.outcome === 'CREATED').length
  return (
    <>
      <Banner tone={created === results.length ? 'success' : created > 0 ? 'warning' : 'danger'} title={t('create.summary', { created, count: results.length })} />
      <SummaryTable
        label={t('create.resultsLabel')}
        columns={[t('col.workOrder'), t('create.col.outcome'), t('create.col.short')]}
        widths={['20%', '50%', '30%']}
        stackOnPhone
        rows={results.map((result) => ({
          id: result.workOrderId,
          cells: [
            <span key="n" className="fw-pk-code">{result.number ?? '—'}</span>,
            <span key="o" className={result.outcome === 'REFUSED' ? 'fw-pk-held' : undefined}>{say(t, resultPhrase(result))}</span>,
            <span key="s">{result.short.length === 0 ? '—' : result.short.map((line) => `${[line.itemCode, line.colourCode].filter(Boolean).join(' ')} ${qty(line.quantity, line.baseUom)}`).join(', ')}</span>,
          ],
        }))}
      />
    </>
  )
}
