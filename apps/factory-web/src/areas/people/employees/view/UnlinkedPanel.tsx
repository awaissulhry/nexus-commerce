'use client'

import { useMemo, useState } from 'react'
import { UserPlus } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef } from '@nexus/ui/grid'
import { Button, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import type { UnlinkedWorker } from '../../_shared/api'
import { languageText, useWords } from '../../_shared/parts'
import type { EmployeesListActions, EmployeesListModel } from '../view-model'

/**
 * The tile "Floor workers with no employee record" (design people.employees sec:tiles, sec:grid empty "Link them"): the
 * active floor sign-ins (Admin › Users) that no employee record holds yet, on the shared list frame. Select → "Make N
 * employee records" makes each from its worker (names read from the floor name, the worker's code and the day it was
 * added: one person, one record) — the record then says what is missing.
 */
export function UnlinkedPanel({ model, actions }: { model: EmployeesListModel; actions?: EmployeesListActions }) {
  const t = useWords()
  const locale = useLocale()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const items = model.unlinked.items
  const picked = (items ?? []).filter((worker) => selected.includes(worker.id))
  const held = model.can.manageEmployees ? null : t('held.noManageEmployees')
  const columns = useMemo<ColDef<UnlinkedWorker>[]>(
    () => [
      { colId: 'name', headerName: t('col.floorName'), minWidth: 200, flex: 1, valueGetter: (params) => params.data?.displayName ?? '' },
      { colId: 'site', headerName: t('col.site'), minWidth: 110, flex: 0.5, valueGetter: (params) => (params.data ? `${params.data.site.code} · ${params.data.site.name}` : '') },
      { colId: 'code', headerName: t('col.code'), minWidth: 110, flex: 0.5, valueGetter: (params) => params.data?.employeeCode ?? '—', cellClass: 'fw-pp-code' },
      { colId: 'language', headerName: t('col.language'), minWidth: 100, flex: 0.4, valueGetter: (params) => (params.data ? languageText(t, params.data.locale) : '') },
      { colId: 'added', headerName: t('col.added'), minWidth: 120, flex: 0.5, valueGetter: (params) => (params.data ? formatDate(params.data.createdAt, { locale, timeZone: model.timeZone }) : '') },
    ],
    [t, locale, model.timeZone],
  )
  const state = model.unlinked.problem ? (
    <EmptyState title={t('unlinked.failed')} description={t(model.unlinked.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    <EmptyState title={t('unlinked.none')} description={t('unlinked.noneBody')} />
  ) : undefined
  return (
    <section className="fw-pp-stack" aria-label={t('tile.UNLINKED_WORKERS')}>
      <p className="fw-pp-hint">{t('unlinked.intro')}</p>
      <ListFrame<UnlinkedWorker>
        label={t('unlinked.tableLabel')}
        listKey="people.employees.unlinked"
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t(model.unlinked.complete ? 'list.count' : 'unlinked.countMore', { count: items.length }) : '—'}
        tools={
          <>
            <Button size="sm" variant="quiet" aria-label={t('list.tileChipClear', { tile: t('tile.UNLINKED_WORKERS') })} onClick={() => actions?.onTile?.(null)}>
              <Tag tone="info">{t('tile.UNLINKED_WORKERS')} ✕</Tag>
            </Button>
            <ScopeSiteChip model={model.scope} />
          </>
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" variant="primary" aria-label={t('unlinked.makeCount', { count: picked.length })} heldReason={held} onClick={() => actions?.onLink?.(picked)}>
              <UserPlus size={13} aria-hidden /> <SelectionLabel>{t('unlinked.makeCount', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        state={state}
        cards={{}}
      />
    </section>
  )
}
