'use client'

import { useMemo } from 'react'
import { Archive, MapPin, MoreHorizontal, Plus } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { useT } from '../../../../lib/i18n/provider'
import { AccountCard, type CardState } from '../../../shared/account/view/AccountCard'
import { defaultHeld, removeHeld, type AddressRow } from '../model'

/**
 * SCR-188's delivery addresses on the shared list frame (sec:addresses; SAL-079; Owner rule 2026-10-29: select-all, shift
 * range, x / Space, bulk actions while rows are selected, the keys in the footer's one icon; cards on a phone): name,
 * address, contact, the default mark, our check (approved, waiting for our check, not accepted with the reason). The admin
 * adds one (it waits for our check), makes one the default (only a checked one), removes one or several. A waiting or
 * refused address is never offered for an order. The colleagues list is the shared one
 * (../../../shared/account/view/ColleaguesSection.tsx, lifted by B-W2b-193).
 */

// ── Delivery addresses ───────────────────────────────────────────────────────────────────────────────────────────────────
export interface AddressesModel {
  state: CardState
  rows: readonly (AddressRow & { addedWords: string; checkedWords: string | null })[]
  canManage: boolean
  selected: readonly string[]
  readOnly: boolean
  /** An address opened from a notification (`?address=`): its row is marked. */
  focusId?: string | null
}

export interface AddressesActions {
  onSelected?: (ids: string[]) => void
  onAdd?: () => void
  onDefault?: (row: AddressRow) => void
  onRemove?: (rows: readonly AddressRow[]) => void
  onRetry?: () => void
  onHelp?: () => void
}

type AddressLine = AddressesModel['rows'][number]

export function AddressesSection({ model, slow, actions }: { model: AddressesModel; slow?: boolean; actions?: AddressesActions }) {
  const t = useT('portal-account')
  const manage = model.canManage && !model.readOnly
  const columns = useMemo<ColDef<AddressLine>[]>(() => {
    const AddressCell = ({ data }: ICellRendererParams<AddressLine>) =>
      data ? (
        <span className="fw-pacc-cell fw-pacc-cell-stack">
          <span className="fw-pacc-strong">
            {data.name ?? data.line}
            {data.isDefault ? (
              <>
                {' '}
                <Pill tone="info">{t('addresses.default')}</Pill>
              </>
            ) : null}
          </span>
          {data.name ? <span className="fw-pacc-muted">{data.line}</span> : null}
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<AddressLine>) =>
      data ? (
        <span className="fw-pacc-cell fw-pacc-cell-stack">
          <Pill tone={data.tone}>{t(`addresses.state.${data.state}`)}</Pill>
          {data.reason ? <span className="fw-pacc-muted">{t('addresses.reason', { reason: data.reason })}</span> : data.checkedWords ? <span className="fw-pacc-muted">{data.checkedWords}</span> : null}
        </span>
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<AddressLine>) => {
      if (!data) return null
      const asDefault = defaultHeld(data)
      const remove = removeHeld(data)
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('addresses.rowMenu', { name: data.name ?? data.line }) }}
          items={[
            { id: 'default', label: t('addresses.makeDefault'), disabled: asDefault !== null, ...(asDefault ? { description: t(asDefault) } : {}), onSelect: () => actions?.onDefault?.(data) },
            { id: 'remove', label: t('addresses.remove'), tone: 'danger', disabled: remove !== null, ...(remove ? { description: t(remove) } : {}), onSelect: () => actions?.onRemove?.([data]) },
          ]}
        />
      )
    }
    const list: ColDef<AddressLine>[] = [
      { colId: 'address', headerName: t('addresses.col.address'), minWidth: 260, flex: 2, valueGetter: (params) => (params.data ? [params.data.name, params.data.line].filter(Boolean).join(' — ') : ''), cellRenderer: AddressCell, autoHeight: true },
      { colId: 'contact', headerName: t('addresses.col.contact'), minWidth: 160, flex: 1, valueGetter: (params) => params.data?.contact ?? '—' },
      { colId: 'status', headerName: t('addresses.col.status'), minWidth: 200, flex: 1.2, valueGetter: (params) => (params.data ? t(`addresses.state.${params.data.state}`) : ''), cellRenderer: StatusCell, autoHeight: true },
      { colId: 'added', headerName: t('addresses.col.added'), minWidth: 150, flex: 0.9, valueGetter: (params) => params.data?.addedWords ?? '' },
    ]
    if (manage) list.push({ colId: 'more', headerName: t('addresses.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell })
    return list
  }, [t, manage, actions])
  const picked = model.rows.filter((row) => model.selected.includes(row.id))
  const empty =
    model.state === 'ready' && model.rows.length === 0 ? (
      <EmptyState
        icon={<MapPin size={22} aria-hidden />}
        title={t('addresses.empty')}
        description={manage ? t('addresses.emptyHint') : undefined}
        action={
          manage ? (
            <Button size="sm" variant="primary" onClick={() => actions?.onAdd?.()}>
              <Plus size={14} aria-hidden /> {t('addresses.add')}
            </Button>
          ) : undefined
        }
      />
    ) : undefined
  const waiting = model.rows.filter((row) => row.state === 'WAITING').length
  return (
    <AccountCard
      id="addresses"
      title={t('addresses.title')}
      description={manage ? t('addresses.subtitleAdmin') : t('addresses.subtitle')}
      state={model.state}
      slow={slow}
      failed={t('addresses.failed')}
      onRetry={actions?.onRetry}
      action={
        manage ? (
          <Button size="sm" onClick={() => actions?.onAdd?.()}>
            <Plus size={14} aria-hidden /> {t('addresses.add')}
          </Button>
        ) : undefined
      }
    >
      <ListFrame<AddressLine>
        label={t('addresses.tableLabel')}
        listKey={null}
        rows={model.rows}
        rowId={(row) => row.id}
        columns={columns}
        count={waiting > 0 ? `${t('addresses.count', { count: model.rows.length })} · ${t('addresses.waitingCount', { count: waiting })}` : t('addresses.count', { count: model.rows.length })}
        {...(manage
          ? {
              selection: {
                selected: model.selected,
                onChange: (ids: string[]) => actions?.onSelected?.(ids),
                actions: (
                  <Button size="sm" variant="danger-outline" aria-label={t('addresses.removeN', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneChosen') : null} onClick={() => actions?.onRemove?.(picked)}>
                    <Archive size={13} aria-hidden /> <SelectionLabel>{t('addresses.removeN', { count: picked.length })}</SelectionLabel>
                  </Button>
                ),
              },
              isRowSelectable: (row: AddressLine) => {
                const held = removeHeld(row)
                return held ? t(held) : null
              },
            }
          : {})}
        onHelp={actions?.onHelp}
        {...(model.focusId ? { focusRow: Math.max(0, model.rows.findIndex((row) => row.id === model.focusId)) } : {})}
        state={empty}
        cards={{ fields: { address: { role: 'title' }, status: { role: 'subtitle' } } }}
      />
    </AccountCard>
  )
}
