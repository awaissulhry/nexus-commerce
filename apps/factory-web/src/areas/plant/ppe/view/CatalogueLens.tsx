'use client'

import { useEffect, useMemo } from 'react'
import { Archive, PackagePlus, Plus, Shirt } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { CATALOGUE_LAW } from '@nexus/factory-domain/safety/ppe/rules'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { PpeItem } from '../api'
import { categoryMark, ITEM_STATUSES, itemName, type ItemStatus } from '../model'
import type { PpePageActions, PpePageModel } from '../view-model'
import { moneyOf, PAGE_KEYS, SectionFailed, SectionHead, SectionLoading, useWords } from './parts'

/**
 * Catalogue (design sec catalogue; QHS-259; D.Lgs. 81/2008 art. 77 c.1): the company's PPE items — Item · category (I / II /
 * III) · standard · sizes · life (months) · supplier · unit cost (the cost grain only; "Hidden: Unit cost" in Columns ▾
 * otherwise) · in role kits · handed over — as the list frame; Enter (or the name) opens the PPE item dialog; Archive N over
 * the rows chosen (an item a role kit names cannot be chosen: said on its box). Empty: Start from common items. "Instruction
 * needed" is Later in the design: no column until it is built.
 */
export function CatalogueLens({ model, actions, onHelp }: { model: PpePageModel; actions?: PpePageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const ds = useDsWords()
  const locale = useLocale()
  const { address, can } = model
  const answer = model.items.status === 'ready' ? model.items.value : null
  const rows = answer?.items ?? null
  const canManage = can.manage && (answer?.canAdd ?? true)
  const selected = model.selected ?? []
  useEffect(() => {
    if (rows && selected.some((id) => !rows.some((row) => row.id === id))) actions?.onSelected?.(selected.filter((id) => rows.some((row) => row.id === id)))
  }, [rows, selected, actions])
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))

  const columns = useMemo<ColDef<PpeItem>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<PpeItem>) =>
      data ? (
        <span className="fw-ppe-cell">
          <span>{itemName(data, locale)}</span>
          <span className="fw-ppe-muted fw-ppe-code">{data.code}</span>
        </span>
      ) : null
    return [
      { colId: 'name', headerName: t('catalogue.col.item'), minWidth: 200, flex: 1.5, valueGetter: (params) => (params.data ? itemName(params.data, locale) : ''), cellRenderer: NameCell },
      { colId: 'category', headerName: t('catalogue.col.category'), minWidth: 110, flex: 0.5, valueGetter: (params) => (params.data ? categoryMark(params.data.category) : ''), headerTooltip: t('catalogue.categoryHint') },
      { colId: 'standard', headerName: t('catalogue.col.standard'), minWidth: 150, flex: 0.9, valueGetter: (params) => (params.data ? (params.data.standard ?? '—') : '') },
      { colId: 'sizes', headerName: t('catalogue.col.sizes'), minWidth: 150, flex: 0.9, valueGetter: (params) => (params.data ? (params.data.sizes.join(', ') || t('catalogue.oneSize')) : '') },
      { colId: 'life', headerName: t('catalogue.col.life'), minWidth: 110, flex: 0.5, valueGetter: (params) => (params.data ? (params.data.lifeMonths === null ? t('catalogue.whenWorn') : t('catalogue.months', { count: params.data.lifeMonths })) : '') },
      { colId: 'supplier', headerName: t('catalogue.col.supplier'), minWidth: 160, flex: 0.9, valueGetter: (params) => (params.data ? (params.data.supplier?.name ?? '—') : '') },
      ...(can.cost ? [{ colId: 'unitCost', headerName: t('catalogue.col.unitCost'), minWidth: 130, flex: 0.5, type: 'numericColumn', valueGetter: (params: { data?: PpeItem }) => (params.data ? moneyOf(params.data.unitCost, locale) : '') } as ColDef<PpeItem>] : []),
      { colId: 'inKits', headerName: t('catalogue.col.inKits'), minWidth: 140, flex: 0.4, type: 'numericColumn', valueGetter: (params) => params.data?.inKits ?? null },
      { colId: 'issued', headerName: t('catalogue.col.issued'), minWidth: 130, flex: 0.4, type: 'numericColumn', valueGetter: (params) => params.data?.issued ?? null },
      ...(address.status !== 'ACTIVE' ? [{ colId: 'status', headerName: t('catalogue.col.status'), minWidth: 110, flex: 0.5, valueGetter: (params: { data?: PpeItem }) => (params.data ? t(`itemStatus.${params.data.status}`) : '') } as ColDef<PpeItem>] : []),
    ]
  }, [t, locale, can.cost, address.status])

  const filters = (
    <span className="fw-ppe-row">
      <Input size="sm" type="search" value={address.q} placeholder={t('catalogue.search')} aria-label={t('catalogue.search')} onChange={(event) => actions?.onAddress?.({ q: event.target.value })} />
      <Select size="sm" value={address.status} aria-label={t('catalogue.statusFilter')} onChange={(event) => actions?.onAddress?.({ status: event.target.value as ItemStatus })}>
        {ITEM_STATUSES.map((status) => (
          <option key={status} value={status}>
            {t(`catalogue.status.${status}`)}
          </option>
        ))}
      </Select>
    </span>
  )

  const head = (
    <SectionHead id="fw-ppe-catalogue" title={t('catalogue.title')} note={<LawRef law={answer?.law.catalogue ?? CATALOGUE_LAW} plain={t('law.catalogue')} labels={ds.lawRef} />}>
      <span className="fw-ppe-muted">{t('catalogue.instructionLater')}</span>
    </SectionHead>
  )

  if (model.items.status === 'error') {
    return (
      <>
        {head}
        <SectionFailed title={t('catalogue.failed')} problem={model.items.problem} onRetry={() => actions?.onRetry?.('catalogue')} />
      </>
    )
  }
  if (!answer || !rows) {
    return (
      <>
        {head}
        <SectionLoading rows={6} />
      </>
    )
  }

  const filtered = address.q !== '' || address.status !== 'ACTIVE'
  const commonHeld = !canManage ? t('held.manage') : !model.companyId ? t('held.company') : model.commonBusy ? t('held.busy') : null
  return (
    <>
      {head}
      <ListFrame<PpeItem>
        label={t('catalogue.label')}
        title={t('catalogue.title')}
        listKey="plant.ppe.4"
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('catalogue.count', { count: rows.length })}
        search={filters}
        withheld={can.cost ? [] : [{ label: t('catalogue.col.unitCost'), reason: t('catalogue.costHidden') }]}
        selection={
          canManage
            ? {
                selected,
                onChange: (ids) => actions?.onSelected?.(ids),
                actions: (
                  <Button size="sm" variant="primary" aria-label={t('bulk.archive', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneArchivable') : null} onClick={() => actions?.onArchiveMany?.(picked.map((row) => row.id))}>
                    <Archive size={13} aria-hidden /> <SelectionLabel>{t('bulk.archive', { count: picked.length })}</SelectionLabel>
                  </Button>
                ),
              }
            : undefined
        }
        isRowSelectable={canManage ? (row) => (row.status !== 'ACTIVE' ? t('held.archivedRow') : row.inKits > 0 ? t('refusal.IN_KIT') : null) : undefined}
        keys={PAGE_KEYS(t)}
        onHelp={onHelp}
        onOpen={(row) => actions?.onAddress?.({ item: row.id })}
        more={answer.complete ? null : { label: t('catalogue.more'), onMore: () => undefined, held: t('catalogue.moreHeld') }}
        state={
          rows.length === 0 ? (
            filtered ? (
              <EmptyState icon={<Shirt size={22} aria-hidden />} title={t('catalogue.noneFiltered')} description={t('common.noneFilteredHint')} />
            ) : (
              <EmptyState
                icon={<Shirt size={22} aria-hidden />}
                title={t('catalogue.emptyTitle')}
                description={t('catalogue.empty')}
                action={
                  <span className="fw-ppe-row">
                    <Button size="sm" variant="primary" heldReason={commonHeld} onClick={() => actions?.onCommon?.()}>
                      {model.commonBusy ? <Spinner size={12} /> : <PackagePlus size={13} aria-hidden />} {t('catalogue.common')}
                    </Button>
                    <Button size="sm" heldReason={canManage ? null : t('held.manage')} onClick={() => actions?.onAddress?.({ item: 'new' })}>
                      <Plus size={13} aria-hidden /> {t('band.newItem')}
                    </Button>
                  </span>
                }
              />
            )
          ) : undefined
        }
        cards={{ fields: { name: { role: 'title' }, category: { role: 'subtitle' } } }}
      />
    </>
  )
}
